export interface Article {
	kind: 'post' | 'project';
	id: string;
	title: string;
	description: string;
	date: string;
	tags: string[];
	url: string;
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

export interface Settings {
	baseUrl: string;
	model: string;
	apiKey: string;
}

export interface Session {
	id: string;
	title: string;
	messages: Message[];
	updatedAt: number;
}

export const DEFAULTS: Settings = {
	baseUrl: 'https://api.deepseek.com',
	model: 'deepseek-chat',
	apiKey: '',
};

const SETTINGS_KEY = 'agent-settings';
const SESSIONS_KEY = 'agent-sessions';

export function loadSettings(): Settings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...DEFAULTS };
		return { ...DEFAULTS, ...JSON.parse(raw) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(settings: Settings) {
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

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
