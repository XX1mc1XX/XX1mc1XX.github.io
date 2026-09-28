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

	// 首页技能区块。按干的活分组，比按「语言/框架/工具」那种分法有信息量
	skills: [
		{ group: '上位机开发', items: ['C++17', 'Qt 6', 'CMake', 'MSVC'] },
		{ group: '机器视觉', items: ['OpenCV', '2D / 3D 处理', '相机标定'] },
		{ group: '工业设备', items: ['海康 MVS', 'GenICam', 'GigE Vision'] },
		{ group: '工业机器人', items: ['ROS2', '机械臂仿真'] },
		{ group: 'AI 集成', items: ['Agent 框架', 'LLM 工具调用'] },
	],

	statusBar: {
		branch: 'main',
		stack: 'C++17 · Qt6 · OpenCV',
	},
};
