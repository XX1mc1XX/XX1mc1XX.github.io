import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Article, Message, Session, ToolCall } from './types';
import { loadSessions, saveSessions, newSession } from './types';
import { runAgent, ApiError } from './llm';
import { demoScript } from './demo';

interface Props {
	articles: Article[];
}

const WIDTH_KEY = 'agent-width';
const OPEN_KEY = 'agent-open';
const HINT_KEY = 'agent-hint-seen';
// 面板最窄也要能放下输入框；往宽不设上限，可以一路拉到满屏
const MIN_WIDTH = 300;

export default function AgentDrawer({ articles }: Props) {
	// 初始值直接读本地存储。放到 useEffect 里再读，首屏和水合后会差一帧，看着就是闪一下
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(OPEN_KEY) === '1';
		} catch {
			return false;
		}
	});
	const [width, setWidth] = useState(() => {
		try {
			return Number(localStorage.getItem(WIDTH_KEY)) || 460;
		} catch {
			return 460;
		}
	});
	const [sessions, setSessions] = useState<Session[]>([]);
	const [activeId, setActiveId] = useState('');
	const [input, setInput] = useState('');
	const [busy, setBusy] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [showDemo, setShowDemo] = useState(true);
	const [error, setError] = useState('');
	const [demoPlaying, setDemoPlaying] = useState(false);
	// 首次访问时给一次提示，说来它到底能干什么。看过就记下来，不再打扰
	const [showHint, setShowHint] = useState(false);

	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const draggingRef = useRef(false);
	// 标记这次展开是不是由 / 快捷键触发的，是的话展开后要把光标送进输入框
	const focusOnOpenRef = useRef(false);

	const active = sessions.find((item) => item.id === activeId);
	const messages = active?.messages ?? [];

	useEffect(() => {
		const stored = loadSessions();
		if (stored.length > 0) {
			setSessions(stored);
			setActiveId(stored[0].id);
			setShowDemo(stored[0].messages.length === 0);
		} else {
			const fresh = newSession();
			setSessions([fresh]);
			setActiveId(fresh.id);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		const node = listRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [messages, open, busy]);

	// 首次访问才弹一次提示。等页面稳下来再出现，一进来就冒出来太吵
	useEffect(() => {
		try {
			if (localStorage.getItem(HINT_KEY) === 'seen') return;
		} catch {
			return;
		}
		const timer = setTimeout(() => setShowHint(true), 2600);
		return () => clearTimeout(timer);
	}, []);

	function dismissHint() {
		setShowHint(false);
		try {
			localStorage.setItem(HINT_KEY, 'seen');
		} catch {
			// 存不进去也无所谓，无非下次再多提示一遍
		}
	}

	// 页面上按 / 直接跳进来提问（ReadingTools 负责派发这个事件）
	useEffect(() => {
		const focus = () => {
			focusOnOpenRef.current = true;
			setOpen(true);
		};
		document.addEventListener('agent:focus', focus);
		return () => document.removeEventListener('agent:focus', focus);
	}, []);

	// 拖左边缘改栏宽
	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			if (!draggingRef.current) return;
			setWidth(Math.max(MIN_WIDTH, window.innerWidth - event.clientX));
		};
		const onUp = () => {
			if (!draggingRef.current) return;
			draggingRef.current = false;
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
			setWidth((current) => {
				localStorage.setItem(WIDTH_KEY, String(current));
				return current;
			});
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		return () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
	}, []);

	// 助手栏宽度写进 CSS 变量，工作区网格的第四列就跟着变，正文实时重排。
	// 面板的显隐也交给这个 class，由 CSS 控制，首屏和水合后不会闪
	useEffect(() => {
		document.documentElement.style.setProperty('--agent-w', open ? `${width}px` : '0px');
		document.documentElement.classList.toggle('agent-open', open);
		localStorage.setItem(OPEN_KEY, open ? '1' : '0');

		// 由 / 唤起的展开，顺手把光标送进输入框。
		// 必须挨着上面那行：早一步面板还是 display:none，聚焦不了
		if (open && focusOnOpenRef.current) {
			focusOnOpenRef.current = false;
			inputRef.current?.focus();
		}
	}, [open, width]);

	function persist(next: Session[]) {
		setSessions(next);
		saveSessions(next);
	}

	function patchActive(fn: (session: Session) => Session) {
		setSessions((current) => {
			const next = current.map((item) => (item.id === activeId ? fn(item) : item));
			saveSessions(next);
			return next;
		});
	}

	function startNewSession() {
		const fresh = newSession();
		persist([fresh, ...sessions]);
		setActiveId(fresh.id);
		setShowDemo(true);
		setError('');
		setShowHistory(false);
	}

	function removeSession(id: string) {
		const next = sessions.filter((item) => item.id !== id);
		if (next.length === 0) {
			const fresh = newSession();
			persist([fresh]);
			setActiveId(fresh.id);
		} else {
			persist(next);
			if (id === activeId) setActiveId(next[0].id);
		}
	}

	async function send(question: string) {
		if (!question.trim() || busy) return;

		setError('');
		setShowDemo(false);
		setInput('');
		setBusy(true);

		const history = messages.map((item) => ({ role: item.role, content: item.content }));

		patchActive((session) => ({
			...session,
			title: session.messages.length === 0 ? question.slice(0, 24) : session.title,
			updatedAt: Date.now(),
			messages: [...session.messages, { role: 'user', content: question }, { role: 'assistant', content: '', tools: [] }],
		}));

		const controller = new AbortController();
		abortRef.current = controller;

		const patchLast = (fn: (message: Message) => Message) => {
			patchActive((session) => {
				const list = [...session.messages];
				list[list.length - 1] = fn(list[list.length - 1]);
				return { ...session, messages: list };
			});
		};

		try {
			const result = await runAgent({
				question,
				articles,
				history,
				signal: controller.signal,
				onDelta: (text) => patchLast((message) => ({ ...message, content: message.content + text })),
				onToolStart: (name, args) =>
					patchLast((message) => ({
						...message,
						tools: [...(message.tools ?? []), { name, args, result: '' }],
					})),
				onToolEnd: (name, result) =>
					patchLast((message) => {
						const tools = [...(message.tools ?? [])];
						for (let i = tools.length - 1; i >= 0; i -= 1) {
							if (tools[i].name === name && !tools[i].result) {
								tools[i] = { ...tools[i], result };
								break;
							}
						}
						return { ...message, tools };
					}),
			});

			patchLast((message) => ({ ...message, content: result.answer || message.content }));
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === 'AbortError') {
				patchLast((message) => ({ ...message, content: message.content || '（已停止）' }));
			} else {
				const text = cause instanceof ApiError ? cause.message : String(cause);
				setError(text);
				patchActive((session) => ({ ...session, messages: session.messages.slice(0, -1) }));
			}
		} finally {
			abortRef.current = null;
			setBusy(false);
		}
	}

	async function playDemo() {
		if (demoPlaying) return;
		setDemoPlaying(true);
		patchActive((session) => ({ ...session, messages: [] }));

		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		patchActive((session) => ({
			...session,
			messages: [{ role: 'user', content: demoScript.question }],
		}));
		await wait(450);

		patchActive((session) => ({
			...session,
			messages: [...session.messages, { role: 'assistant', content: '', tools: [] }],
		}));

		for (const tool of demoScript.tools) {
			await wait(650);
			patchActive((session) => {
				const list = [...session.messages];
				const last = list[list.length - 1];
				list[list.length - 1] = {
					...last,
					tools: [...(last.tools ?? []), { name: tool.name, args: tool.args, result: '' }],
				};
				return { ...session, messages: list };
			});
			await wait(550);
			patchActive((session) => {
				const list = [...session.messages];
				const last = list[list.length - 1];
				const tools = [...(last.tools ?? [])];
				tools[tools.length - 1] = { ...tools[tools.length - 1], result: tool.note };
				list[list.length - 1] = { ...last, tools };
				return { ...session, messages: list };
			});
		}

		await wait(550);
		const chars = demoScript.answer.split('');
		for (let i = 0; i < chars.length; i += 3) {
			const slice = chars.slice(i, i + 3).join('');
			patchActive((session) => {
				const list = [...session.messages];
				const last = list[list.length - 1];
				list[list.length - 1] = { ...last, content: last.content + slice };
				return { ...session, messages: list };
			});
			await wait(10);
		}

		setDemoPlaying(false);
	}

	const suggestions = useMemo(
		() => ['ZyClear 的图像链路怎么做的？', '你做过哪些项目？', 'AI 那一层为什么要把工具调用切回主线程？'],
		[],
	);

	return (
		<>
			<button
				class="agent-fab"
				type="button"
				title="问 AI 助手"
				onClick={() => {
					dismissHint();
					setOpen(true);
				}}
			>
				<ChatMark />
				<span class="agent-fab__label">问 AI</span>
			</button>

			{showHint && !open && (
				<div class="agent-hint">
					<button class="agent-hint__close" type="button" title="知道了" onClick={dismissHint}>
						×
					</button>
					它能读本站的文章，然后回答关于这些内容的问题。
					<br />
					<br />
					点开先看一遍演示，不用填任何东西。
				</div>
			)}

			<aside class="agent-panel">
				<div class="agent-resizer" onPointerDown={(event) => {
					event.preventDefault();
					draggingRef.current = true;
					document.body.style.userSelect = 'none';
					document.body.style.cursor = 'col-resize';
				}} title="拖动调整宽度" />

				<header class="agent-head">
					<span class="agent-head__title">
						<ChatMark />
						AI 助手
					</span>
					<div class="agent-head__actions">
						<button
							class="agent-icon-btn"
							type="button"
							title="历史记录"
							onClick={() => setShowHistory((value) => !value)}
						>
							⏱
						</button>
						<button class="agent-icon-btn" type="button" title="新会话" onClick={startNewSession}>
							＋
						</button>
						<button class="agent-icon-btn" type="button" title="收起" onClick={() => setOpen(false)}>
							×
						</button>
					</div>
				</header>

				{showHistory && (
					<div class="agent-history">
						{sessions.map((session) => (
							<div class={`agent-history__row${session.id === activeId ? ' agent-history__row--active' : ''}`}>
								<button
									class="agent-history__open"
									type="button"
									onClick={() => {
										setActiveId(session.id);
										setShowHistory(false);
										setShowDemo(session.messages.length === 0);
										setError('');
									}}
								>
									<span class="agent-history__title">{session.title}</span>
									<span class="agent-history__time">{formatTime(session.updatedAt)}</span>
								</button>
								<button
									class="agent-icon-btn agent-history__del"
									type="button"
									title="删除"
									onClick={() => removeSession(session.id)}
								>
									×
								</button>
							</div>
						))}
					</div>
				)}

				<div class="agent-body" ref={listRef}>
					{showDemo && messages.length === 0 && (
						<div class="agent-demo">
							<p class="agent-demo__lead">
								这是一个能读本站文章的 AI 助手。它自己决定读哪一篇，再基于原文回答。
							</p>
							<button class="agent-demo__play" type="button" disabled={demoPlaying} onClick={playDemo}>
								{demoPlaying ? '播放中…' : '▶ 看一遍它怎么工作'}
							</button>
							<p class="agent-demo__note">
								下面是录好的回放。想自己提问，直接在下面的输入框里打字，不用填任何东西。
							</p>
						</div>
					)}

					{messages.map((message) => (
						<div class={`agent-msg agent-msg--${message.role}`}>
							{(message.tools ?? []).map((tool) => (
								<ToolLine tool={tool} key={`${tool.name}-${tool.args.id ?? ''}`} />
							))}
							{message.content && (
								<>
									<div
										class="agent-msg__text"
										dangerouslySetInnerHTML={{ __html: markdownToHtml(message.content) }}
									/>
									{busy && message === messages[messages.length - 1] && message.role === 'assistant' && (
										<span class="agent-caret" />
									)}
								</>
							)}
						</div>
					))}

					{error && <div class="agent-error">{error}</div>}
				</div>

				{messages.length === 0 && !showDemo && (
					<div class="agent-suggest">
						{suggestions.map((text) => (
							<button class="agent-suggest__item" type="button" onClick={() => send(text)}>
								{text}
							</button>
						))}
					</div>
				)}

				<footer class="agent-foot">
					<textarea
						ref={inputRef}
						class="agent-input"
						rows={2}
						value={input}
						placeholder="问点关于这个站点的事…"
						onInput={(event) => setInput((event.target as HTMLTextAreaElement).value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
								event.preventDefault();
								send(input);
							}
						}}
					/>
					{busy ? (
						<button class="agent-send agent-send--stop" type="button" onClick={() => abortRef.current?.abort()}>
							停止
						</button>
					) : (
						<button class="agent-send" type="button" disabled={!input.trim()} onClick={() => send(input)}>
							发送
						</button>
					)}
				</footer>
			</aside>
		</>
	);
}

// 对话气泡。之前用的星芒太抽象——访客看到不知道那是什么，自然也不会点
function ChatMark() {
	return (
		<svg class="agent-mark" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path
				fill="currentColor"
				d="M2.6 2.4h10.8c.8 0 1.4.6 1.4 1.4v6.2c0 .8-.6 1.4-1.4 1.4H7.3l-3.5 2.5c-.3.2-.8 0-.8-.4v-2.1h-.4c-.8 0-1.4-.6-1.4-1.4V3.8c0-.8.6-1.4 1.4-1.4Z"
			/>
		</svg>
	);
}

function ToolLine({ tool }: { tool: ToolCall }) {
	const args = Object.values(tool.args).filter(Boolean).join(' ');
	const done = tool.result.length > 0;
	return (
		<div class={`agent-tool${done ? ' agent-tool--done' : ''}`}>
			<span class="agent-tool__mark">{done ? '✓' : '⋯'}</span>
			<span class="agent-tool__name">{tool.name}</span>
			{args && <span class="agent-tool__args">{args}</span>}
		</div>
	);
}

function formatTime(stamp: number) {
	const date = new Date(stamp);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 模型吐的是 markdown，交给 marked 解析。手写渲染器试过，坑太多：
// 正则跨行会把相隔很远的两对星号配成一对，代码块也没法正确切块
marked.setOptions({ gfm: true, breaks: true });

// 解析结果过一遍 DOMPurify —— 模型输出的内容不能当可信 HTML 直接塞进页面。
// SSR 阶段没有 window，这时返回空串，等客户端 hydrate 后再渲染
let markedWarned = false;
function markdownToHtml(text: string) {
	if (typeof window === 'undefined') return '';
	try {
		return DOMPurify.sanitize(marked.parse(text, { async: false }));
	} catch (cause) {
		if (!markedWarned) {
			markedWarned = true;
			console.error('[agent] markdown 渲染失败', cause);
		}
		return '';
	}
}
