import type { APIRoute } from 'astro';
import { collectArticle, collectArticleIndex } from '../../utils/articles';

// 一篇一个静态 JSON。助手的 read_article 工具按需取，
// 不用再把全部正文塞进目录里让每个访客都下载一遍
export async function getStaticPaths() {
	const index = await collectArticleIndex();
	return index.map((item) => ({ params: { id: item.id } }));
}

export const GET: APIRoute = async ({ params }) => {
	const article = params.id ? await collectArticle(params.id) : null;
	if (!article) {
		return new Response(JSON.stringify({ error: { message: '没有这篇内容。' } }), {
			status: 404,
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
		});
	}
	return new Response(JSON.stringify(article), {
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
};
