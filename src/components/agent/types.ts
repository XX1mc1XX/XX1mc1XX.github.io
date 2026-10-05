// 目录项：助手一开始拿到的就是这份，不含正文。
// 正文单独成文件，读到哪篇才取哪篇——原来把全文一起塞进 /articles.json，
// 是 827KB（gzip 后 334KB），而访客每打开一个页面都会把它拉一遍
export interface ArticleMeta {
	kind: 'post' | 'project';
	id: string;
	title: string;
	description: string;
	date: string;
	tags: string[];
	url: string;
}

// 带上正文的完整条目，只有 read_article 真的去读某一篇时才会出现
export interface Article extends ArticleMeta {
	body: string;
}

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	result: string;
}

export interface Message {
	role: 'user' | 'assistant';
	content: string;
	tools?: ToolCall[];
}

export interface Session {
	id: string;
	title: string;
	messages: Message[];
	updatedAt: number;
}

const SESSIONS_KEY = 'agent-sessions';

export function newSession(): Session {
	return {
		id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		title: '新会话',
		messages: [],
		updatedAt: Date.now(),
	};
}

// 只留最近 30 个会话，免得 localStorage 被撑爆
export function loadSessions(): Session[] {
	try {
		const raw = localStorage.getItem(SESSIONS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
	} catch {
		return [];
	}
}

export function saveSessions(sessions: Session[]) {
	try {
		localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 30)));
	} catch {
		// 配额满了就先不管，历史记录丢了不影响主流程
	}
}
