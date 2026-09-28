// 站点信息集中在这里，改这一个文件就能把站改成你自己的
export const site = {
	// 顶栏左侧显示的名字
	name: 'yourname.dev',

	author: '你的名字',
	tagline: 'C++ / Qt 工业软件方向 · 相机客户端与设备接入',
	email: 'you@example.com',
	github: 'https://github.com/yourname',

	// 简历放 public/ 后在这里填文件名，例如 '/resume.pdf'；留空则不显示下载按钮
	resume: '',

	nav: [
		{ label: '首页', href: '/' },
		{ label: '项目', href: '/projects' },
		{ label: '文章', href: '/blog' },
		{ label: '标签', href: '/tags' },
		{ label: '关于', href: '/about' },
	],

	// 首页技能区块
	skills: [
		{ group: '语言', items: ['C++17', 'Python'] },
		{ group: '框架与库', items: ['Qt 6', 'OpenCV', 'CMake'] },
		{ group: '设备与协议', items: ['海康 MVS', 'GenICam', 'GigE Vision'] },
	],

	statusBar: {
		branch: 'main',
		stack: 'C++17 · Qt6 · OpenCV',
	},
};
