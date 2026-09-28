import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const posts = defineCollection({
	loader: glob({ pattern: '**/[^_]*.md', base: './src/content/posts' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		pubDate: z.coerce.date(),
		tags: z.array(z.string()).default([]),
		draft: z.boolean().default(false),
	}),
});

const projects = defineCollection({
	loader: glob({ pattern: '**/[^_]*.md', base: './src/content/projects' }),
	schema: z.object({
		title: z.string(),
		summary: z.string(),
		role: z.string().optional(),
		// YAML 里不加引号的 2026 会被读成数字，这里统一转成字符串
		period: z.coerce.string().optional(),
		stack: z.array(z.string()).default([]),
		repo: z.string().url().optional(),
		// 首页项目卡的排序，数字小的在前
		order: z.number().default(99),
	}),
});

export const collections = { posts, projects };
