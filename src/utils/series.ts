import type { CollectionEntry } from 'astro:content';
import { series, topicsGroup } from '../site.config';

export interface SeriesGroup {
	id: string;
	name: string;
	tagline: string;
	project?: string;
	posts: CollectionEntry<'posts'>[];
}

/**
 * 把文章按 site.config.ts 里的系列分组。
 * 组内保持 site.config 里的 slugs 声明顺序——那是**叙事顺序**，读者该从第 1 篇读起，
 * 所以这里刻意不按 pubDate 排（发布日往往与阅读顺序相反）。
 * 组之间按 site.config 的声明顺序，专题永远排最后（按时间倒序）。
 * 某系列一篇都没有时整组不出现——避免空标题。
 */
export function groupBySeries(posts: CollectionEntry<'posts'>[]): SeriesGroup[] {
	const bySlug = new Map(posts.map((p) => [p.id, p]));
	const claimed = new Set<string>();

	const groups: SeriesGroup[] = series.map((s) => {
		for (const slug of s.slugs) {
			if (bySlug.has(slug)) claimed.add(slug);
		}
		return {
			id: s.id,
			name: s.name,
			tagline: s.tagline,
			project: s.project,
			posts: s.slugs
				.map((slug) => bySlug.get(slug))
				.filter((p): p is CollectionEntry<'posts'> => p !== undefined),
		};
	}).filter((g) => g.posts.length > 0);

	const rest = posts
		.filter((p) => !claimed.has(p.id))
		.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

	if (rest.length > 0) {
		groups.push({
			id: topicsGroup.id,
			name: topicsGroup.name,
			tagline: topicsGroup.tagline,
			posts: rest,
		});
	}

	return groups;
}
