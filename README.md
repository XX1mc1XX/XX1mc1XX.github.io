# 个人博客

基于 Astro 的静态站点，配色与排版取自 VS Code 的 Dark+ / Light+ 主题。
右上角带一个能读本站文章的 AI 助手。

## 开发

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # 产物输出到 dist/
npm run preview  # 预览构建产物
```

## 改哪里

| 想改什么 | 文件 |
|---|---|
| 站点名、作者、导航项、技能、简历路径、底部状态栏 | `src/site.config.ts` |
| 配色、字体、排版 | `src/styles/global.css` |
| AI 助手的样式 | `src/styles/agent.css` |
| 顶栏 / 底栏 / 卡片组件 | `src/components/` |
| AI 助手的界面与逻辑 | `src/components/agent/` |
| 页面结构与路由 | `src/pages/` |
| 文章 | `src/content/posts/*.md` |
| 项目 | `src/content/projects/*.md` |

## AI 助手

访客点右上角浮标，页面变成两栏：正文在左自动变窄，助手在右。拖中间边界可调栏宽，
宽度记在本地。助手自带会话历史，也存本地。

打开时先看到一段录好的回放（不消耗 API），看清它能干什么，再自己填 Key 提问。

**为什么访客要自己填 Key**：站点是纯静态的，没有服务端。
请求从访客的浏览器直接发往模型服务商，Key 只存在访客自己的 localStorage 里，
不经过任何服务器。这样站主不承担任何费用，也不用担心 Key 泄漏。

| 文件 | 作用 |
|---|---|
| `src/lib/articles.ts` | 构建时把全部文章转成纯文本，供助手检索 |
| `src/components/agent/tools.ts` | 工具定义（3 个）+ 系统提示词 |
| `src/components/agent/llm.ts` | 流式 SSE 解析 + agent 工具调用循环 |
| `src/components/agent/types.ts` | 设置与会话的本地存储 |
| `src/components/agent/AgentDrawer.tsx` | 面板界面（分栏、拖宽、历史、演示） |
| `src/components/agent/demo.ts` | 未填 Key 时播放的演示脚本 |
| `src/styles/agent.css` | 分栏布局与面板样式 |

默认连 DeepSeek。换服务商在面板的设置里改 Base URL 和模型名即可，
只要对方是 OpenAI 兼容协议就不用改代码。

演示脚本在 `demo.ts` 里，是纯静态文本，改完重新构建就行。


## 写文章

在 `src/content/posts/` 下新建 `.md`，开头写上：

```yaml
---
title: 标题
description: 一句话摘要，列表页会显示
pubDate: 2026-09-28
tags: [Qt, C++]
draft: false
---
```

`draft: true` 的文章不会出现在列表和 RSS 里。

代码块一定要标语言（比如 ` ```cpp `），否则不高亮。

## 加项目

在 `src/content/projects/` 下新建 `.md`：

```yaml
---
title: 项目名
summary: 一句话说明，会显示在卡片上
role: 独立开发
period: 2026
stack: [C++17, Qt6, OpenCV]
repo: https://github.com/you/repo
order: 1
---
```

`order` 越小越靠前。`role`、`period`、`repo` 都可以不写。

## 部署

推到 GitHub 后，在 Cloudflare Pages 里连接该仓库：

| 配置项 | 值 |
|---|---|
| 构建命令 | `npm run build` |
| 输出目录 | `dist` |
| Node 版本 | 22 或更高 |

部署完把 `astro.config.mjs` 里的 `site` 改成真实地址，RSS 里的链接才会是对的。
