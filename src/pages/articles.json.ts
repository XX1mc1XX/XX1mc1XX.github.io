import type { APIRoute } from 'astro';
import { collectArticles } from '../lib/articles';

export const GET: APIRoute = async () => {
	return new Response(JSON.stringify(await collectArticles()), {
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
};
