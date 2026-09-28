// OpenAI 兼容格式的工具定义。换服务商只要还是这个协议，这里不用动。
export const toolDefinitions = [
	{
		type: 'function',
		function: {
			name: 'list_articles',
			description: '列出站点上全部文章的标题、摘要、日期与标签。先调这个了解有哪些内容。',
			parameters: { type: 'object', properties: {}, required: [] },
		},
	},
	{
		type: 'function',
		function: {
			name: 'read_article',
			description: '读取一篇文章或项目页的完整正文。id 从 list_articles 的结果里取。',
			parameters: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description: '文章 id，例如 camera-client-architecture',
					},
				},
				required: ['id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'search_articles',
			description: '按关键词搜索文章正文，返回命中的片段。不确定哪篇相关时用它。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '搜索关键词' },
				},
				required: ['query'],
			},
		},
	},
];

export const systemPrompt = `你是这个个人博客站点上的 AI 助手，代表站主回答访客提问。

站主是 C++ / Qt 工业软件方向的在校生，做过跨品牌工业相机客户端和 C++ Agent 框架。

规则：
- 回答必须基于工具返回的站点内容，不要编造站主的经历、数字或技术细节。
- 涉及具体项目时，先调工具读原文，再作答。宁可多调一次工具，也不要凭印象说。
- 站点里没有的内容，直接说「站点的文章里没有写这个」，然后建议访客看简历或直接联系站主。
- 用中文回答，简洁直接，不要客套话。技术细节可以展开。
- 引用文章时给出路径，例如「详见 /blog/camera-client-architecture/」。`;

export function describeTools(articles: { id: string; title: string; kind: string }[]) {
	const posts = articles.filter((a) => a.kind === 'post');
	const projects = articles.filter((a) => a.kind === 'project');
	return `站点现有 ${posts.length} 篇文章、${projects.length} 个项目页。`;
}
