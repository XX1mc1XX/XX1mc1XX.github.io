// 站点信息集中在这里，改这一个文件就能把站改成你自己的
export const site = {
	// 顶栏左侧显示的名字
	name: '徐仁康',

	author: '徐仁康',
	tagline: 'C++ / Qt 上位机 · 工业相机 SDK · 机器视觉 · 工业机器人 · 通用 Agent',
	email: 'xx1mc1xxx@gmail.com',
	github: 'https://github.com/XX1mc1XX',

	// 简历放 public/ 后在这里填文件名，例如 '/resume.pdf'；留空则不显示下载按钮
	resume: '',

	nav: [
		{ label: '首页', href: '/' },
		{ label: '项目', href: '/projects' },
		{ label: '文章', href: '/blog' },
		{ label: '标签', href: '/tags' },
		{ label: '关于', href: '/about' },
	],

	// 技能区块。按干的活分组而不是按「语言/框架/工具」——
	// 面试官想知道你能干什么，不是你有什么工具
	skills: [
		{ group: '编程语言', items: ['C++ 11 / 17', 'Python 3', 'C#'] },
		{
			group: '上位机开发',
			items: ['Qt 5 / 6', '信号槽与多线程', 'Model-View-Delegate', 'QDockWidget 停靠体系', '插件化架构'],
		},
		{ group: '机器视觉', items: ['海康 MVS SDK', 'GenICam / GigE Vision', 'OpenCV', 'PCL 点云'] },
		{ group: '工业机器人', items: ['ROS2', 'Gazebo 仿真'] },
		{ group: 'AI Agent', items: ['Agent 底层原理', 'LLM 工具调用', '本地知识库检索'] },
		{ group: '工程实践', items: ['CMake / qmake', 'Windows / Linux', 'Git / CI-CD', 'CTest', 'Docker'] },
	],

	statusBar: {
		branch: 'main',
		stack: 'C++17 · Qt6 · OpenCV',
	},
};

// 文章系列。首页与文章列表按这个分组，让访客一眼看到有哪几条完整的产出线——
// 而不是一堆按时间平铺、看不出结构的单篇。
// 未列进任何系列的 slug 自动落到「专题」组，所以以后加单篇不用改这里。
export const series = [
	{
		id: 'zyclear',
		name: 'ZyClear 智澈',
		tagline: '跨品牌工业相机客户端：从零搭起六层架构',
		project: '/projects/zyclear',
		slugs: [
			'zyclear-layered-architecture',
			'zyclear-camera-contract',
			'zyclear-factory-adapter',
			'zyclear-multi-camera',
			'zyclear-param-model',
			'zyclear-schema-driven-ui',
			'zyclear-panel-mvd',
			'zyclear-image-pipeline',
			'zyclear-event-bus',
			'zyclear-plugin-system',
			'zyclear-build-and-test',
		],
	},
	{
		id: 'agent4cpp',
		name: 'agent4cpp',
		tagline: '从零手写一个 Agent 框架：循环、工具、上下文',
		project: '/projects/agent4cpp',
		slugs: [
			'agent-loop-from-scratch',
			'agent-framework-skeleton',
			'tool-calling-layer',
			'llm-client-and-logging',
			'knowledge-store-keyword-search',
			'connect-real-device',
			'cli-as-a-shell',
			'testing-the-agent',
		],
	},
	{
		id: 'wovra',
		name: 'Wovra',
		tagline: '长时运行 Agent 运行时的设计复盘：被数据推翻的直觉',
		project: '/projects/wovra',
		slugs: [
			'wovra-three-wrong-assumptions',
			'wovra-cache-discount-tax-base',
			'wovra-multi-agent-freeze',
			'wovra-three-generations',
			'wovra-context-v1-to-v4',
			'wovra-engineering-pitfalls',
		],
	},
];

// 不属于上面任何系列的单篇落到这一组
export const topicsGroup = {
	id: 'topics',
	name: '专题',
	tagline: '单个问题的深入拆解',
};

