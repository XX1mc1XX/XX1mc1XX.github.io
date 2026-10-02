// OpenAI 兼容格式的工具定义。换服务商只要还是这个协议，这里不用动。
//
// 工具描述是给模型看的说明书，直接决定它会不会乱试。
// 之前的写法只说「这个工具干什么」，没说「什么时候该用」，
// 结果它把三个工具全试一遍才动手回答。
export const toolDefinitions = [
	{
		type: 'function',
		function: {
			name: 'search_articles',
			description:
				'按语义搜索本站内容，返回最相关的几个片段（带原文和出处）。这是默认首选：回答任何具体问题都先用它定位，一个查询就能拿到相关原文，不必先把文章都列出来再逐篇读。',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: '用自然语言描述你要找的内容，一整句话比关键词效果好',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'read_article',
			description:
				'读取一篇文章或项目页的完整正文。只在搜索返回的片段不够用、确实需要看全文细节时调用一次，不要为了「了解更多」把多篇文章逐个读完。',
			parameters: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description: '文章 id，从 search_articles 或 list_articles 的结果里取',
					},
				},
				required: ['id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_articles',
			description:
				'列出本站全部内容的标题与摘要。只在访客问「站上都有什么」这类总览性问题时用；问具体技术问题时不要用它，直接用 search_articles。',
			parameters: { type: 'object', properties: {}, required: [] },
		},
	},
	{
		type: 'function',
		function: {
			name: 'search_web',
			description:
				'联网搜索公开网页，返回标题、链接和摘要。用于回答站点文章之外的问题，比如某项技术的一般做法、某个库的现状。站内问题不要用它，用 search_articles。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '搜索词，用自然语言写一整句效果更好' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'search_github',
			description:
				'搜索 GitHub 上的仓库、代码或用户，返回链接和简介。查开源项目、看某个库有多少人用时用它；注意它搜的是 GitHub，不是全网。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '搜索词，例如「qt industrial camera」' },
					kind: {
						type: 'string',
						enum: ['repositories', 'code', 'users'],
						description: '搜什么，默认 repositories',
					},
				},
				required: ['query'],
			},
		},
	},
];

export const systemPrompt = `你是这个个人博客站点上的 AI 助手，代表站主回答访客提问。

站主是 C++ / Qt 工业软件方向的在校生，做过跨品牌工业相机客户端和 Agent 框架。

## 怎么用工具

1. **先搜索**：任何需要具体信息的问题，第一步就是 search_articles，一个问题搜一到两次。
2. **按需读全文**：只有搜索结果里的片段不足以回答时，才 read_article 读一篇，最多读两篇。
3. **别为了保险多试**：不要先把 list_articles 拉一遍再逐篇读——那要十来次调用，访客要等很久。

搜第一次没搜到相关的，换个说法再搜一次就够；两次都搜不到，就照实说站点里没有。

## 怎么回答

- 只讲工具返回的内容，不编造站主的经历、数字或技术细节。
- 站点里没有的，直接说「站点的文章里没有写这个」，不要拿通用知识硬凑。
- 用中文，直接给结论，不要「好的，让我来帮你分析」这类开场。
- 提到出处时给路径，例如「详见 /blog/camera-client-architecture/」。
- 篇幅按问题来：简单问题两三句话说清，别硬凑结构。`;
