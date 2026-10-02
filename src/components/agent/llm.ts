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

	// 语义检索：交给服务端做向量检索。
	// 好处是「画面有点暗」能命中「亮度偏低」这类字面不重叠的表述——
	// 原来在浏览器里做关键词匹配做不到这一点
	async function search_articles(args: Record<string, unknown>) {
		const query = String(args.query ?? '').trim();
		if (!query) return '搜索关键词为空。';

		try {
			const response = await fetch('/api/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query, topK: 4 }),
			});
			const data = await response.json();
			if (data?.error) return `检索失败：${data.error.message}`;

			const matches: { score: number; title: string; url: string; text: string }[] = data?.matches ?? [];
			if (matches.length === 0) {
				return `没有找到与「${query}」相关的内容。`;
			}
			return matches
				.map((m) => `### ${m.title}（相关度 ${m.score}）\n路径：${m.url}\n${m.text}`)
				.join('\n\n');
		} catch (cause) {
			return `检索失败：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	const impl: Record<string, (args: Record<string, unknown>) => string | Promise<string>> = {
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

	// 轮数放宽到 15，正常问题根本用不到这么多。
	// 只留最后一道闸：最后一轮不再给工具——否则遇到「读遍全站再总结」这种问题，
	// 轮次全花在调工具上，一句答案都产不出来，界面上看就是一片空白
	const MAX_ROUNDS = 15;

	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const isLastRound = round === MAX_ROUNDS - 1;

		// 打自己的中转端点。Key 在服务端，浏览器这里压根不知道它存在
		const response = await fetch('/api/chat', {
			method: 'POST',
			signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messages,
				tools: isLastRound ? undefined : toolDefinitions,
			}),
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
			// 语义检索那个工具要走网络，所以这里必须 await
			const result = handler ? await handler(args) : `没有名为「${slot.name}」的工具。`;
			options.onToolEnd(slot.name, result);

			tools.push({ name: slot.name, args, result });

			messages.push({ role: 'tool', tool_call_id: slot.id, content: result });
		}
	}

	// 兜底：万一模型到最后也没吐出文字，给一句人话，别让界面停在一片空白上
	if (!answer.trim() && tools.length > 0) {
		answer = `（这次调用了 ${tools.length} 次工具但没给出结论。问题问得太宽时容易这样，可以换个更具体的问法，比如直接问某个项目的某个设计。）`;
	}

	return { answer, tools };
}
