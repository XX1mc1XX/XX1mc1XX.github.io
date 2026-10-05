import { getCollection, getEntry, type CollectionEntry } from 'astro:content';
import { site } from '../site.config';
import type { Article, ArticleMeta } from '../components/agent/types';

function toPlainText(markdown: string) {
	return markdown
		// 代码块保留内容但去掉围栏，模型读得懂也不需要多余符号
		.replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => `\n[代码块]\n${code}\n`)
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '· ')
		.replace(/^\s*>\s?/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// 「哪些文章算已发布」只在这里定义一次。
// 之前页面、RSS、语料导出各写一遍 filter+sort，加个 unlisted 字段就得改三处
export async function getPublishedPosts() {
	const posts = await getCollection('posts', ({ data }) => !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

// 文章和项目页的字段名不一样（description/summary、tags/stack），
// 映射只写在下面两个函数里，别处不用再关心
function postToMeta(post: CollectionEntry<'posts'>): ArticleMeta {
	return {
		kind: 'post',
		id: post.id,
		title: post.data.title,
		description: post.data.description,
		date: post.data.pubDate.toISOString().slice(0, 10),
		tags: post.data.tags,
		url: `/blog/${post.id}/`,
	};
}

function projectToMeta(project: CollectionEntry<'projects'>): ArticleMeta {
	return {
		kind: 'project',
		id: project.id,
		title: project.data.title,
		description: project.data.summary,
		date: '',
		tags: project.data.stack,
		url: `/projects/${project.id}/`,
	};
}

// 关于页不是内容集合，正文写死在页面里。不手写一份进来的话，
// 助手回答「这个站主是谁 / 怎么联系」时会说「没找到关于页」
function aboutParts(): { meta: ArticleMeta; body: string } {
	const skills = site.skills.map((row) => `${row.group}：${row.items.join('、')}`).join('\n');
	return {
		meta: {
			kind: 'project',
			id: 'about',
			title: `关于 ${site.author}`,
			description: site.tagline,
			date: '',
			tags: [],
			url: '/about/',
		},
		body: [
			`站主：${site.author}`,
			`方向：${site.tagline}`,
			`邮箱：${site.email}`,
			`GitHub：${site.github}`,
			'',
			'技能：',
			skills,
		].join('\n'),
	};
}

// 构建时收集全部内容的目录：只有元数据，正文一概不带。
// 正文单篇一个文件，助手读到哪篇才取哪篇
export async function collectArticleIndex(): Promise<ArticleMeta[]> {
	const posts = await getPublishedPosts();
	const projects = await getCollection('projects');
	return [...posts.map(postToMeta), ...projects.map(projectToMeta), aboutParts().meta];
}

// 按 id 取单篇。id 不存在返回 null，交给调用方决定是 404 还是让模型换个 id
export async function collectArticle(id: string): Promise<Article | null> {
	if (id === 'about') {
		const { meta, body } = aboutParts();
		return { ...meta, body };
	}

	// 先查目录拿到 kind，再去对应的集合里取。
	// 直接两个集合都试一遍的话，Astro 会给每次落空的 getEntry 打一条
	// 「Entry posts → wovra was not found」的警告，构建日志就没法看了
	const meta = (await collectArticleIndex()).find((item) => item.id === id);
	if (!meta) return null;

	if (meta.kind === 'post') {
		const post = await getEntry('posts', id);
		if (post && !post.data.draft) {
			return { ...postToMeta(post), body: toPlainText(post.body ?? '') };
		}
		return null;
	}

	const project = await getEntry('projects', id);
	if (project) {
		return { ...projectToMeta(project), body: toPlainText(project.body ?? '') };
	}
	return null;
}
