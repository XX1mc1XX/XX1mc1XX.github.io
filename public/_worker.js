// Cloudflare Pages 的 Advanced Mode 入口。
// 放在 public/ 里，构建时会被原样复制到输出目录根，Pages 会自动用它处理请求。
//
// 三件事：
//   /api/chat         把对话请求加上 API Key 转发给模型
//   /api/search       把查询向量化，去 Vectorize 里找语义最近的片段
//   /api/web-search   联网搜索（Tavily，没配 Key 就退回抓 Bing）
//   /api/gh-search    转发 GitHub 搜索
// Key 与令牌都只从服务端环境变量读，不会出现在返还给浏览器的内容里。
// 灌向量库走 tools/ingest.py 直连 Cloudflare REST，不经过这里——
// 原先那个 /api/ingest 端点也已经删掉，少一个能被人撞的门。

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const EMBED_MODEL = '@cf/baai/bge-m3';
const VECTOR_INDEX = 'blog-content';

// 上游挂起时的兜底。没有它，一个卡住的请求会一直占着 Worker 并发，
// 表现是「网站忽然整体变慢」，而日志里什么都看不到。
// 不用 AbortSignal.timeout：compatibility date 由 Pages 项目设置控制，
// 不一定落在支持它的档位上，自己搭一个更稳
function timeoutSignal(ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function fetchWithTimeout(url, init, ms) {
	const t = timeoutSignal(ms);
	try {
		return await fetch(url, { ...init, signal: t.signal });
	} finally {
		t.cancel();
	}
}

// 请求体上限。公开站没有登录，任何拿到链接的人都能打这个端点，
// 不设上限等于把上游额度敞开给人刷
const MAX_CHAT_CHARS = 200000;
const MAX_CHAT_MESSAGES = 60;

// 只覆盖「拿到响应头」这一段。流式回答的 body 不归它管，
// 否则长回答会被拦腰砍断
const CHAT_TIMEOUT = 60000;
// 其余都是等一个完整 JSON 回来，给短一点
const API_TIMEOUT = 20000;
const SCRAPE_TIMEOUT = 15000;

// Pages 项目不支持 Vectorize / Workers AI 的 binding，只能走 REST。
// 所以需要一个长期 API Token（OAuth 那种一天就过期，不能用）
function cfApi(env, path) {
	return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`;
}

function cfHeaders(env) {
	// charset 必须写。少了它，中文会按 Latin-1 编码送出去——
	// 查询向量算错、返回的文本变乱码，两处症状同一个原因
	return {
		'Content-Type': 'application/json; charset=utf-8',
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
	};
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/api/chat') {
			if (request.method !== 'POST') return json({ error: { message: '只接受 POST。' } }, 405);
			return handleChat(request, env);
		}

		if (url.pathname === '/api/search') {
			if (request.method !== 'POST') return json({ error: { message: '只接受 POST。' } }, 405);
			return handleSearch(request, env);
		}

		// 联网搜索。Worker 在海外边缘节点，直连这些源不用任何代理——
		// 而本机（国内）访问 DuckDuckGo、维基是要挂梯子的
		if (url.pathname === '/api/web-search') {
			if (request.method !== 'POST') return json({ error: { message: '只接受 POST。' } }, 405);
			return handleWebSearch(request, env);
		}

		// GitHub 搜索：仓库、代码、用户。官方 API，无 Key 可用（有速率限制）
		if (url.pathname === '/api/gh-search') {
			if (request.method !== 'POST') return json({ error: { message: '只接受 POST。' } }, 405);
			return handleGithubSearch(request, env);
		}

		// 页面、样式、脚本、RSS 全走静态资源
		return env.ASSETS.fetch(request);
	},
};

async function handleChat(request, env) {
	const apiKey = env.AI_API_KEY;
	if (!apiKey) {
		return json({ error: { message: '服务端没有配置模型 Key。' } }, 500);
	}

	// 先按字符数卡一道。Content-Length 是客户端说了算的，
	// 分块传输时甚至没有，所以读出来量才作数
	let raw;
	try {
		raw = await request.text();
	} catch {
		return json({ error: { message: '请求体读不出来。' } }, 400);
	}
	if (raw.length > MAX_CHAT_CHARS) {
		return json({ error: { message: '请求体过大。' } }, 413);
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return json({ error: { message: '请求体不是合法 JSON。' } }, 400);
	}

	if (!payload || !Array.isArray(payload.messages)) {
		return json({ error: { message: '请求体里缺少 messages 数组。' } }, 400);
	}
	if (payload.messages.length > MAX_CHAT_MESSAGES) {
		return json({ error: { message: '对话轮数过多。' } }, 413);
	}

	const baseUrl = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

	let upstream;
	try {
		upstream = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				Authorization: `Bearer ${apiKey}`,
				// 这个网关强制要求会话标识。缺了它，网关返回的是一句
				// 极具误导性的「Model is not supported」，而不是提示缺这个头
				'x-opencode-session': `blog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			},
			body: JSON.stringify({
				model: env.AI_MODEL || DEFAULT_MODEL,
				messages: payload.messages,
				tools: Array.isArray(payload.tools) ? payload.tools : undefined,
				stream: true,
			}),
		}, CHAT_TIMEOUT);
	} catch (cause) {
		// 超时走的是 abort 分支，cause.message 会是一句很费解的英文，改写成人话
		const detail = cause?.name === 'AbortError' ? '模型服务响应超时。' : `连不上模型服务：${cause.message}`;
		return json({ error: { message: detail } }, 502);
	}

	if (!upstream.ok) {
		return new Response(await upstream.text(), {
			status: upstream.status,
			headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
		}, API_TIMEOUT);
	}

	// 流式透传：直接把 body 交出去，不能先读出来再包装，否则就不是流了
	return new Response(upstream.body, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

// 语义检索：把问题向量化，再去向量库里找意思最近的片段。
// 比关键词强的点在于——「画面有点暗」能命中「亮度偏低」，字面上毫无重叠
async function handleSearch(request, env) {
	if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
		return json({ error: { message: '服务端没有配置 Cloudflare 凭据。' } }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: { message: '请求体不是合法 JSON。' } }, 400);
	}

	const query = String(body?.query ?? '').trim();
	if (!query) return json({ error: { message: '缺少 query。' } }, 400);

	const topK = Math.min(Math.max(Number(body?.topK) || 4, 1), 10);

	try {
		const embedded = await fetchWithTimeout(cfApi(env, `/ai/run/${EMBED_MODEL}`), {
			method: 'POST',
			headers: cfHeaders(env),
			body: JSON.stringify({ text: [query] }),
		}, API_TIMEOUT);
		const embedJson = await embedded.json();
		const vector = embedJson?.result?.data?.[0];
		if (!vector) {
			return json({ error: { message: `向量化没返回结果：${JSON.stringify(embedJson).slice(0, 200)}` } }, 502);
		}

		const queried = await fetchWithTimeout(cfApi(env, `/vectorize/v2/indexes/${VECTOR_INDEX}/query`), {
			method: 'POST',
			headers: cfHeaders(env),
			body: JSON.stringify({ vector, topK, returnMetadata: 'all' }),
		}, API_TIMEOUT);
		const queryJson = await queried.json();
		const matches = (queryJson?.result?.matches ?? []).map((m) => ({
			id: m.id,
			score: Number((m.score ?? 0).toFixed(4)),
			title: m.metadata?.title ?? '',
			url: m.metadata?.url ?? '',
			text: m.metadata?.text ?? '',
		}));

		return json({ query, topK, matches });
	} catch (cause) {
		return json({ error: { message: `检索失败：${cause.message}` } }, 502);
	}
}

// 联网搜索。
//
// 先说结论：抓搜索引擎页面这条路**不可靠**，实测过四家——
//   DuckDuckGo（lite / html 两个入口）→ 返回空页或验证页
//   Mojeek、searx.be → 直接给验证码页
//   Bing → 能拿到结果，但多词查询会被截成第一个词（「工业相机 SDK」只搜「工业」）
//
// 所以优先走搜索 API：配了 TAVILY_API_KEY 就用它（每月 1000 次免费，专为 AI 设计）；
// 没配就退回 Bing 抓取，能用但中文长查询效果差
async function handleWebSearch(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: { message: '请求体不是合法 JSON。' } }, 400);
	}

	const query = String(body?.query ?? '').trim();
	if (!query) return json({ error: { message: '缺少 query。' } }, 400);
	if (query.length > 200) return json({ error: { message: '查询太长。' } }, 400);

	const limit = Math.min(Math.max(Number(body?.limit) || 5, 1), 8);

	if (env.TAVILY_API_KEY) {
		return searchViaTavily(query, limit, env.TAVILY_API_KEY);
	}
	return searchViaBing(query, limit);
}

async function searchViaTavily(query, limit, apiKey) {
	try {
		const res = await fetchWithTimeout('https://api.tavily.com/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({
				api_key: apiKey,
				query,
				max_results: limit,
				search_depth: 'basic',
			}),
		}, API_TIMEOUT);
		if (!res.ok) {
			const detail = await res.text();
			return json({ error: { message: `Tavily 返回 ${res.status}：${detail.slice(0, 200)}` } }, 502);
		}
		const data = await res.json();
		const results = (data.results ?? []).map((r) => ({
			title: r.title ?? r.url,
			url: r.url,
			snippet: (r.content ?? '').slice(0, 400),
		}));
		return json({ query, engine: 'tavily', count: results.length, results });
	} catch (cause) {
		return json({ error: { message: `Tavily 搜索失败：${cause.message}` } }, 502);
	}
}

async function searchViaBing(query, limit) {
	try {
		const res = await fetchWithTimeout(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
				Accept: 'text/html,application/xhtml+xml',
				'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			},
		}, SCRAPE_TIMEOUT);
		if (!res.ok) {
			return json({ error: { message: `搜索源返回 ${res.status}` } }, 502);
		}
		const html = await res.text();

		const strip = (s) =>
			s
				.replace(/<[^>]+>/g, '')
				.replace(/&amp;/g, '&')
				.replace(/&quot;/g, '"')
				.replace(/&#x27;|&#39;/g, "'")
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&nbsp;/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();

		const results = [];
		for (const match of html.matchAll(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>)/g)) {
			if (results.length >= limit) break;
			const block = match[0];

			const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
			if (!link) continue;

			const url = decodeBingLink(link[1]);
			if (!/^https?:\/\//.test(url)) continue;

			const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
			results.push({
				title: strip(link[2]) || url,
				url,
				snippet: snippet ? strip(snippet[1]).slice(0, 300) : '',
			});
		}

		return json({ query, engine: 'bing', count: results.length, results });
	} catch (cause) {
		return json({ error: { message: `联网搜索失败：${cause.message}` } }, 502);
	}
}

// Bing 给的跳转地址形如 /ck/a?...&amp;u=a1<base64>&amp;ntb=1，
// 真实 URL 藏在 u= 参数里（a1 后面是 base64url）。
// 注意 href 里的 & 是 HTML 转义过的（&amp;），不先还原就匹配不到 u= 参数
function decodeBingLink(url) {
	const normalized = url.replace(/&amp;/g, '&');
	const match = normalized.match(/[?&]u=a1([^&]+)/);
	if (!match) return normalized;
	try {
		const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new TextDecoder('utf-8').decode(bytes);
	} catch {
		return normalized;
	}
}

// GitHub 搜索：走官方 API，无 Key 也能用（每小时 60 次）
async function handleGithubSearch(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: { message: '请求体不是合法 JSON。' } }, 400);
	}

	const query = String(body?.query ?? '').trim();
	if (!query) return json({ error: { message: '缺少 query。' } }, 400);

	const kind = ['repositories', 'code', 'users'].includes(body?.kind) ? body.kind : 'repositories';
	const limit = Math.min(Math.max(Number(body?.limit) || 5, 1), 10);

	const headers = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'blog-agent',
		'X-GitHub-Api-Version': '2022-11-28',
	};
	// 配了 token 就用，速率限制从 60/小时 提到 5000/小时
	if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

	try {
		const res = await fetchWithTimeout(
			`https://api.github.com/search/${kind}?q=${encodeURIComponent(query)}&per_page=${limit}`,
			{ headers },
			API_TIMEOUT,
		);
		if (!res.ok) {
			const detail = await res.text();
			return json({ error: { message: `GitHub 返回 ${res.status}：${detail.slice(0, 200)}` } }, 502);
		}
		const data = await res.json();

		const results = (data.items ?? []).map((item) => {
			if (kind === 'users') {
				return { title: item.login, url: item.html_url, snippet: item.bio ?? '' };
			}
			if (kind === 'code') {
				return {
					title: item.name,
					url: item.html_url,
					snippet: `${item.repository?.full_name ?? ''} — ${item.path ?? ''}`,
				};
			}
			const topics = (item.topics ?? []).slice(0, 5).join(' ');
			return {
				title: item.full_name,
				url: item.html_url,
				snippet: `${item.description ?? ''}${item.language ? ` [${item.language}]` : ''} ⭐${item.stargazers_count ?? 0} ${topics}`.trim(),
			};
		});

		return json({ query, kind, count: results.length, results });
	} catch (cause) {
		return json({ error: { message: `GitHub 搜索失败：${cause.message}` } }, 502);
	}
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}
