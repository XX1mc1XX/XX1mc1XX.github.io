import type { APIRoute } from 'astro';
import { collectArticleIndex } from '../utils/articles';

// 助手一开始取的就是这份目录，只有标题摘要，几十 KB。
// 正文在 /articles/<id>.json 里，读到哪篇才取哪篇
export const GET: APIRoute = async () => {
	return new Response(JSON.stringify(await collectArticleIndex()), {
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
};
