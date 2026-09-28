// 访客没填 Key 时先放这一段，让他看到这个东西能干什么。
// 内容是预先写好的，不消耗任何 API。
export const demoScript: { question: string; tools: { name: string; args: string; note: string }[]; answer: string } = {
	question: '你这个相机客户端是怎么做到换品牌不用改代码的？',
	tools: [
		{
			name: 'list_articles',
			args: '{}',
			note: '先看看站点上有哪些文章',
		},
		{
			name: 'read_article',
			args: '{ "id": "camera-client-architecture" }',
			note: '读架构那篇的全文',
		},
	],
	answer: `靠分层把品牌差异收进一个抽屉里。

关键有三点：

**一是依赖方向单向。** 交互层只凭序列号寻址，门面层不认识任何具体适配器，
只有实现层知道海康 MVS 的存在。所以新增品牌时，门面和界面一行都不用改。

**二是三条约束能被 grep 当场验证。** 比如「门面与契约层不得依赖任何具体适配器」，
跑一句 \`grep -rn "HikCamera.h" src/CameraInterface/\` 期望无输出。
约束能验证，才不会三个月后烂掉。

**三是可选项降级。** 海康 SDK 的导入库不随仓库分发，找不到时适配器整体不参与编译，
程序退化成纯虚拟相机形态依然能构建成功——CI 上没有硬件也能跑全部测试。

所以新增品牌的成本是：实现 17 个纯虚方法 + 工厂里加一行注册。详见 /blog/camera-client-architecture/`,
};
