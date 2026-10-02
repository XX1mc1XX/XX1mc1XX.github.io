// Cloudflare Pages 的 Advanced Mode 入口。
// 放在 public/ 里，构建时会被原样复制到输出目录根，Pages 会自动用它处理请求。
//
// 三件事：
//   /api/chat   把对话请求加上 API Key 转发给模型
//   /api/search 把查询向量化，去 Vectorize 里找语义最近的片段
//   /api/ingest 把文章切块灌进向量库（一次性，需要令牌）
// Key 与令牌都只从服务端环境变量读，不会出现在返还给浏览器的内容里。

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const EMBED_MODEL = '@cf/baai/bge-m3';
const VECTOR_INDEX = 'blog-content';

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

		if (url.pathname === '/api/ingest') {
			if (request.method !== 'POST') return json({ error: { message: '只接受 POST。' } }, 405);
			return handleIngest(request, env);
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

	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: { message: '请求体不是合法 JSON。' } }, 400);
	}

	if (!payload || !Array.isArray(payload.messages)) {
		return json({ error: { message: '请求体里缺少 messages 数组。' } }, 400);
	}

	const baseUrl = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

	let upstream;
	try {
		upstream = await fetch(`${baseUrl}/chat/completions`, {
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
		});
	} catch (cause) {
		return json({ error: { message: `连不上模型服务：${cause.message}` } }, 502);
	}

	if (!upstream.ok) {
		return new Response(await upstream.text(), {
			status: upstream.status,
			headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
		});
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
		const embedded = await fetch(cfApi(env, `/ai/run/${EMBED_MODEL}`), {
			method: 'POST',
			headers: cfHeaders(env),
			body: JSON.stringify({ text: [query] }),
		});
		const embedJson = await embedded.json();
		const vector = embedJson?.result?.data?.[0];
		if (!vector) {
			return json({ error: { message: `向量化没返回结果：${JSON.stringify(embedJson).slice(0, 200)}` } }, 502);
		}

		const queried = await fetch(cfApi(env, `/vectorize/v2/indexes/${VECTOR_INDEX}/query`), {
			method: 'POST',
			headers: cfHeaders(env),
			body: JSON.stringify({ vector, topK, returnMetadata: 'all' }),
		});
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

// 一次性把文章灌进向量库。用令牌保护，否则谁都能往里塞垃圾。
// 内容更新后重新调一次即可（用同一批 id，会覆盖）
async function handleIngest(request, env) {
	if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
		return json({ error: { message: '服务端没有配置 Cloudflare 凭据。' } }, 500);
	}

	const token = env.INGEST_TOKEN;
	if (!token || request.headers.get('x-ingest-token') !== token) {
		return json({ error: { message: '令牌不对。' } }, 401);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: { message: '请求体不是合法 JSON。' } }, 400);
	}

	const chunks = Array.isArray(body?.chunks) ? body.chunks : null;
	if (!chunks || chunks.length === 0) {
		return json({ error: { message: '缺少 chunks 数组。' } }, 400);
	}
	if (chunks.length > 200) {
		return json({ error: { message: '一次最多 200 块。' } }, 400);
	}

	try {
		// bge-m3 单次能吃的条数有限，分批
		const vectors = [];
		const BATCH = 10;
		for (let i = 0; i < chunks.length; i += BATCH) {
			const slice = chunks.slice(i, i + BATCH);
			const res = await fetch(cfApi(env, `/ai/run/${EMBED_MODEL}`), {
				method: 'POST',
				headers: cfHeaders(env),
				body: JSON.stringify({ text: slice.map((c) => c.text) }),
			});
			const data = (await res.json())?.result?.data ?? [];
			slice.forEach((chunk, j) => {
				if (!data[j]) return;
				vectors.push({
					id: String(chunk.id),
					values: data[j],
					metadata: {
						title: String(chunk.title ?? '').slice(0, 200),
						url: String(chunk.url ?? '').slice(0, 300),
						text: String(chunk.text ?? '').slice(0, 2000),
					},
				});
			});
		}

		// Vectorize 的 upsert 收 NDJSON，不是 JSON 数组
		const res = await fetch(cfApi(env, `/vectorize/v2/indexes/${VECTOR_INDEX}/upsert`), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-ndjson; charset=utf-8',
				Authorization: `Bearer ${env.CF_API_TOKEN}`,
			},
			body: vectors.map((v) => JSON.stringify(v)).join('\n'),
		});
		if (!res.ok) {
			return json({ error: { message: `灌入失败 ${res.status}：${(await res.text()).slice(0, 300)}` } }, 502);
		}

		return json({ ok: true, received: chunks.length, upserted: vectors.length });
	} catch (cause) {
		return json({ error: { message: `灌数据失败：${cause.message}` } }, 502);
	}
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}
