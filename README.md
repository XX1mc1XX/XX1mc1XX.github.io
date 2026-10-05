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
| 灌向量库、图片压缩这类一次性脚本 | `tools/` |

## AI 助手

访客点右上角浮标，页面变成两栏：正文在左自动变窄，助手在右。拖中间边界可调栏宽，
宽度记在本地。助手自带会话历史，也存本地。

打开时先看到一段录好的回放（不消耗额度），看清它能干什么，再直接提问。

**Key 在服务端，访客什么都不用填**。浏览器打自家的 `/api/chat`，
由 `public/_worker.js` 添上 Key 再转发给模型。Key 只从 Pages 的环境变量读，
不会出现在任何返回给浏览器的内容里。

站点本身是静态的。`_worker.js` 只用 Advanced Mode 接管四个端点——
对话转发、向量检索、联网搜索、GitHub 搜索——其余请求原样交给静态资源。

助手一开始只取一份内容**目录**（`/articles.json`，十几 KB，页面空闲时预取），
要读全文时才去取对应的单篇（`/articles/<id>.json`）。
早先的做法是把全站正文打包成一份 JSON，827KB，每个访客每开一个页面都会下载一遍。

## 站内搜索与灌数据

站内语义搜索走 Cloudflare Vectorize（索引 `blog-content`，Workers AI 的 bge-m3 向量化）。
灌数据不经 Worker，直接跑脚本：

```bash
npm run build                  # 先出构建产物，脚本读 dist/
python tools/ingest.py         # 灌全部（内容没变的自动跳过）
python tools/ingest.py --count # 查库里有多少向量
python tools/clean_vectors.py --dry   # 比对库里和陈旧块，只报告不删
```

凭据放 `.env.local`（不进仓库）：`CF_ACCOUNT_ID` + `VECTORIZE_API_TOKEN`，
注意变量名是 `VECTORIZE_API_TOKEN` 而不是 `CF_API_TOKEN`。

| 文件 | 作用 |
|---|---|
| `src/lib/articles.ts` | 「已发布文章」的唯一查询口径；构建时收集内容目录 |
| `src/pages/articles.json.ts` | 目录端点 `/articles.json`（只有标题摘要） |
| `src/pages/articles/[id].json.ts` | 单篇全文 `/articles/<id>.json`，助手读到哪篇取哪篇 |
| `src/components/agent/tools.ts` | 工具定义（5 个）+ 系统提示词 |
| `src/components/agent/llm.ts` | 流式 SSE 解析 + agent 工具调用循环 |
| `src/components/agent/types.ts` | 会话的本地存储 |
| `src/components/agent/AgentDrawer.tsx` | 面板界面（分栏、拖宽、历史、演示） |
| `src/components/agent/demo.ts` | 面板刚打开时播放的回放脚本 |
| `src/styles/agent.css` | 分栏布局与面板样式 |
| `public/_worker.js` | `/api/*` 四个端点 + 静态资源回落 |

默认连 DeepSeek（见 `_worker.js` 顶部的 `DEFAULT_MODEL`）。换服务商改那里的
`DEFAULT_BASE_URL` / `DEFAULT_MODEL`，或在 Pages 项目里设 `AI_BASE_URL` / `AI_MODEL`
覆盖——只要对方是 OpenAI 兼容协议，代码一行不用动。

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
