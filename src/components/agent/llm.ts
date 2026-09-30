import type { Article, ToolCall } from './types';
import { toolDefinitions, systemPrompt } from './tools';

interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

export class ApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ApiError';
	}
}

// 工具全部在客户端跑，数据就是构建时导出的那份 JSON
export function createToolRunner(articles: Article[]) {
	const byId = new Map(articles.map((item) => [item.id, item]));

	function list_articles() {
		const posts = articles.filter((item) => item.kind === 'post');
		const projects = articles.filter((item) => item.kind === 'project');
		const line = (item: Article) =>
			`- ${item.id} ｜ ${item.title} ｜ ${item.description}`;
		return [
			'## 文章',
			...posts.map(line),
			'',
			'## 项目',
			...projects.map(line),
		].join('\n');
	}

	function read_article(args: Record<string, unknown>) {
		const id = String(args.id ?? '');
		const item = byId.get(id);
		if (!item) {
			return `没有找到 id 为「${id}」的内容。可用 id：${[...byId.keys()].join(', ')}`;
		}
		const head = `# ${item.title}\n路径：${item.url}\n摘要：${item.description}\n\n`;
		return head + item.body.slice(0, 12000);
	}

	function search_articles(args: Record<string, unknown>) {
		const query = String(args.query ?? '').trim();
		if (!query) return '搜索关键词为空。';

		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const hits: string[] = [];

		for (const item of articles) {
			const haystack = `${item.title}\n${item.description}\n${item.body}`.toLowerCase();
			const first = terms.find((term) => haystack.includes(term));
			if (!first) continue;

			const at = haystack.indexOf(first);
			const start = Math.max(0, at - 300);
			const snippet = item.body.slice(start, start + 700).replace(/\s+/g, ' ');
			hits.push(`### ${item.title}（${item.id}）\n…${snippet}…`);
			if (hits.length >= 4) break;
		}

		return hits.length > 0 ? hits.join('\n\n') : `没有找到与「${query}」相关的内容。`;
	}

	const impl: Record<string, (args: Record<string, unknown>) => string> = {
		list_articles,
		read_article,
		search_articles,
	};

	return { impl, write: (args: Record<string, unknown>) => String(args.query ?? args.id ?? '') };
}

// 从 SSE 流里逐块取 delta
async function* streamDeltas(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new ApiError('响应没有可读的流。');

	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const payload = trimmed.slice(5).trim();
			if (payload === '[DONE]') return;
			try {
				yield JSON.parse(payload);
			} catch {
				// 半截的 JSON 跳过，下一轮补齐
			}
		}
	}
}

export interface RunOptions {
	question: string;
	articles: Article[];
	history?: ChatMessage[];
	signal?: AbortSignal;
	onDelta: (text: string) => void;
	onToolStart: (name: string, args: Record<string, unknown>) => void;
	onToolEnd: (name: string, result: string) => void;
}

// agent 主循环：问模型 → 它要调工具就调 → 结果回灌 → 再问，直到它不再调工具
export async function runAgent(options: RunOptions): Promise<{ answer: string; tools: ToolCall[] }> {
	const { question, articles, history = [], signal } = options;
	const runner = createToolRunner(articles);

	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		...history,
		{ role: 'user', content: question },
	];

	const tools: ToolCall[] = [];
	let answer = '';

	// 最多让模型连续调 5 轮工具，防止它绕不出来
	for (let round = 0; round < 5; round += 1) {
		// 打自己的中转端点。Key 在服务端，浏览器这里压根不知道它存在
		const response = await fetch('/api/chat', {
			method: 'POST',
			signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ messages, tools: toolDefinitions }),
		});

		if (!response.ok) {
			const detail = await response.text();
			let hint = detail.slice(0, 300);
			try {
				const parsed = JSON.parse(detail);
				hint = parsed?.error?.message ?? hint;
			} catch {
				// 保持原文
			}
			if (response.status === 401) {
				throw new ApiError('Key 被拒绝（401）。检查一下 Key 有没有复制完整。');
			}
			if (response.status === 402) {
				throw new ApiError('账户余额不足（402）。');
			}
			throw new ApiError(`请求失败（${response.status}）：${hint}`);
		}

		let text = '';
		const pending = new Map<number, { id: string; name: string; args: string }>();

		for await (const chunk of streamDeltas(response)) {
			const delta = chunk?.choices?.[0]?.delta;
			if (!delta) continue;

			if (delta.content) {
				text += delta.content;
				options.onDelta(delta.content);
			}

			for (const call of delta.tool_calls ?? []) {
				const index = call.index ?? 0;
				const slot = pending.get(index) ?? { id: '', name: '', args: '' };
				if (call.id) slot.id = call.id;
				if (call.function?.name) slot.name += call.function.name;
				if (call.function?.arguments) slot.args += call.function.arguments;
				pending.set(index, slot);
			}
		}

		if (pending.size === 0) {
			answer = text;
			break;
		}

		messages.push({
			role: 'assistant',
			content: text || null,
			tool_calls: [...pending.values()].map((slot) => ({
				id: slot.id,
				type: 'function' as const,
				function: { name: slot.name, arguments: slot.args },
			})),
		});

		for (const slot of pending.values()) {
			let args: Record<string, unknown> = {};
			try {
				args = slot.args ? JSON.parse(slot.args) : {};
			} catch {
				args = {};
			}

			options.onToolStart(slot.name, args);
			const handler = runner.impl[slot.name];
			const result = handler ? handler(args) : `没有名为「${slot.name}」的工具。`;
			options.onToolEnd(slot.name, result);

			tools.push({ name: slot.name, args, result });

			messages.push({ role: 'tool', tool_call_id: slot.id, content: result });
		}
	}

	return { answer, tools };
}
