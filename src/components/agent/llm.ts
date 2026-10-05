import type { Article, ArticleMeta, ToolCall } from './types';
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

// 工具全部在客户端跑。手里只有目录（标题+摘要），正文按需去 /articles/<id>.json 取
export function createToolRunner(articles: ArticleMeta[]) {
	const byId = new Map(articles.map((item) => [item.id, item]));

	// 次数闸门。模型（尤其轻量档）不太遵守「搜两次就够了」这类口头约束，
	// 实测问一个站上没有的东西它会连搜十次。与其反复调提示词，不如用代码兜住——
	// 每次调用都告诉它「已经用掉几次」，超了就直接把结论推给它
	const budget: Record<string, number> = {
		search_articles: 0,
		read_article: 0,
		list_articles: 0,
		search_web: 0,
		search_github: 0,
	};
	const LIMIT: Record<string, number> = {
		search_articles: 3,
		read_article: 2,
		list_articles: 1,
		search_web: 2,
		search_github: 2,
	};

	function overBudget(name: string): string | null {
		budget[name] = (budget[name] ?? 0) + 1;
		const limit = LIMIT[name] ?? 1;
		if (budget[name] <= limit) return null;
		return [
			`【${name} 已调用 ${budget[name]} 次，超出上限 ${limit} 次，这次不再执行。】`,
			'现在必须基于已经拿到的内容给出回答。',
			'如果确实找不到对应信息，就直接说明「站点的文章里没有写这个」，不要继续搜。',
		].join('');
	}

	function list_articles() {
		const gate = overBudget('list_articles');
		if (gate) return gate;

		const posts = articles.filter((item) => item.kind === 'post');
		const projects = articles.filter((item) => item.kind === 'project');
		const line = (item: ArticleMeta) =>
			`- ${item.id} ｜ ${item.title} ｜ ${item.description}`;
		return [
			'## 文章',
			...posts.map(line),
			'',
			'## 项目',
			...projects.map(line),
		].join('\n');
	}

	// 正文不在手上，得去取。多一次本地 CDN 上的请求，
	// 换来的是每个访客少下载 334KB（gzip）
	async function read_article(args: Record<string, unknown>) {
		const gate = overBudget('read_article');
		if (gate) return gate;

		const id = String(args.id ?? '');
		if (!byId.has(id)) {
			return `没有找到 id 为「${id}」的内容。可用 id：${[...byId.keys()].join(', ')}`;
		}

		try {
			const response = await fetch(`/articles/${encodeURIComponent(id)}.json`);
			if (!response.ok) return `读取「${id}」失败（${response.status}）。`;
			const item = (await response.json()) as Article;
			const head = `# ${item.title}\n路径：${item.url}\n摘要：${item.description}\n\n`;
			return head + item.body.slice(0, 12000);
		} catch (cause) {
			return `读取「${id}」失败：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	// 语义检索：交给服务端做向量检索。
	// 好处是「画面有点暗」能命中「亮度偏低」这类字面不重叠的表述——
	// 原来在浏览器里做关键词匹配做不到这一点
	async function search_articles(args: Record<string, unknown>) {
		const gate = overBudget('search_articles');
		if (gate) return gate;

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

	// 联网搜索。请求发到自家 Worker，由它去抓 DuckDuckGo ——
	// 浏览器直接抓会被 CORS 挡住，而且本机在国内还得挂梯子
	async function search_web(args: Record<string, unknown>) {
		const query = String(args.query ?? '').trim();
		if (!query) return '搜索词为空。';

		try {
			const response = await fetch('/api/web-search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json; charset=utf-8' },
				body: JSON.stringify({ query, limit: 5 }),
			});
			const data = await response.json();
			if (data?.error) return `联网搜索失败：${data.error.message}`;

			const results: { title: string; url: string; snippet: string }[] = data?.results ?? [];
			if (results.length === 0) return `联网没搜到「${query}」的结果。`;
			return results.map((r) => `### ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
		} catch (cause) {
			return `联网搜索失败：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	// GitHub 搜索，同样走自家 Worker 转发
	async function search_github(args: Record<string, unknown>) {
		const query = String(args.query ?? '').trim();
		if (!query) return '搜索词为空。';

		try {
			const response = await fetch('/api/gh-search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json; charset=utf-8' },
				body: JSON.stringify({ query, kind: args.kind, limit: 5 }),
			});
			const data = await response.json();
			if (data?.error) return `GitHub 搜索失败：${data.error.message}`;

			const results: { title: string; url: string; snippet: string }[] = data?.results ?? [];
			if (results.length === 0) return `GitHub 上没搜到「${query}」。`;
			return results.map((r) => `### ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
		} catch (cause) {
			return `GitHub 搜索失败：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	const impl: Record<string, (args: Record<string, unknown>) => string | Promise<string>> = {
		list_articles,
		read_article,
		search_articles,
		search_web,
		search_github,
	};

	// 用掉额度的工具直接从清单里摘掉——只靠「调用后返回超限提示」不够，
	// 模型照样会一调再调；不给它这个选项，它才会去写答案
	function remainingTools() {
		const available = toolDefinitions.filter((def) => {
			const name = def.function.name;
			return (budget[name] ?? 0) < (LIMIT[name] ?? 1);
		});
		return available.length > 0 ? available : undefined;
	}

	return { impl, remainingTools };
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
	articles: ArticleMeta[];
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
				// 每一轮都重新算一遍可用工具：用掉额度的会被摘掉，
				// 模型看不到也就不会再调，只能去写答案
				tools: isLastRound ? undefined : runner.remainingTools(),
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
