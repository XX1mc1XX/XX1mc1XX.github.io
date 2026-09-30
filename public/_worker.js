// Cloudflare Pages 的 Advanced Mode 入口。
// 放在 public/ 里，构建时会被原样复制到输出目录根，Pages 会自动用它处理请求。
//
// 职责只有一件：把 /api/chat 的请求加上 API Key 转发给模型。其余请求原样交给静态资源。
// Key 存在 Pages 的服务端环境变量里，这里读一下就用，永远不会出现在返还给浏览器的内容中。

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/api/chat') {
			if (request.method !== 'POST') {
				return json({ error: { message: '这个端点只接受 POST。' } }, 405);
			}
			return handleChat(request, env);
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
				'Content-Type': 'application/json',
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
		// 上游的错误体里不含 Key，原样带回去，前端才好显示「余额不足」这类提示
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

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
