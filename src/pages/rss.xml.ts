import type { APIRoute } from 'astro';
import { site } from '../site.config';
import { getPublishedPosts } from '../utils/articles';

function escapeXml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export const GET: APIRoute = async ({ site: siteUrl }) => {
	const posts = await getPublishedPosts();

	const origin = siteUrl ?? new URL('https://example.pages.dev');
	const url = (path: string) => new URL(path, origin).href;

	const items = posts
		.map(
			(post) => `<item>
			<title>${escapeXml(post.data.title)}</title>
			<link>${url(`/blog/${post.id}/`)}</link>
			<guid>${url(`/blog/${post.id}/`)}</guid>
			<description>${escapeXml(post.data.description)}</description>
			<pubDate>${post.data.pubDate.toUTCString()}</pubDate>
		</item>`,
		)
		.join('\n\t\t');

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
	<channel>
		<title>${escapeXml(site.name)}</title>
		<description>${escapeXml(site.tagline)}</description>
		<link>${origin.href}</link>
		<atom:link href="${url('/rss.xml')}" rel="self" type="application/rss+xml" />
		${items}
	</channel>
</rss>
`;

	return new Response(xml, {
		headers: { 'Content-Type': 'application/xml; charset=utf-8' },
	});
};
