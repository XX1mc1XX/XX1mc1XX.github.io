---
title: agent4cpp
summary: 从零手写的 C++ Agent 框架。把工具调用、LLM 抽象和推理循环拆成互不依赖的几层。
role: 独立开发
period: 2026
stack: [C++17, CMake, libcurl, LLM 工具调用]
repo: https://github.com/XX1mc1XX/agent4cpp
order: 2
---

一个不依赖任何 Web 框架、不依赖 Python 的 **C++ Agent 运行时**，面向工业桌面软件——现场机器上装不了 Python 环境，但需要让大模型能操作本机设备。

三件事：让模型**能调用本机能力**（工具注册 + JSON Schema 参数）、把模型调用**抽成可换的接口**（Mock / OpenAI 兼容 / 本地模型）、跑一个**会收敛的推理循环**（每轮问模型 → 执行工具 → 结果回灌）。

规模：3,604 行 C++（src 2,054 + include 769 + tests 465 + examples 316）。

## 分层

| 层 | 职责 | 换掉它意味着 |
|---|---|---|
| `Status` | 统一错误码，跨层传递失败原因 | — |
| `Tool` / `ToolRegistry` | 工具描述（名字、用途、参数 Schema）+ 登记处 | 增加一类工具 |
| `ILLMClient` | 模型调用接口 | 从 Mock 换成真模型、或换服务商 |
| `IHttpClient` | HTTP 传输接口 | 从 libcurl 换成别的库 |
| `IKnowledgeStore` | 本地资料检索接口 | 从关键词检索换成向量检索 |
| `Agent` | 推理循环、消息记录、状态 | — |

每一层都只依赖上一层的抽象，不依赖具体实现。

## 三处值得说的设计

### 同一个套路出现了三次

`ILLMClient`、`IHttpClient`、`IKnowledgeStore`——三个能力各自一个纯虚接口，各自有实现：

| 接口 | 实现 |
|---|---|
| `ILLMClient` | `MockLLMClient` / `OpenAICompatibleLLMClient` |
| `IHttpClient` | `CurlHttpClient` |
| `IKnowledgeStore` | `InMemoryKnowledgeStore` |

模式一样：**上层只依赖抽象，具体实现可换**。这不是为了「面向对象好看」——Mock 客户端让整条链路能在没有网络、没有 API Key、不花钱的情况下跑通和写测试，这是实际收益。

### 循环的终止条件只看一个东西

```cpp
// 模型这一轮没有要求调工具，就是它认为可以回答了
if (response.tool_calls.empty()) break;
```

不猜、不发散，只看 `tool_calls` 是不是空。配套两条兜底：

- **步数上限**：转到上限还没停就强制收敛，防止模型在两个工具之间来回横跳
- **工具失败也塞回对话**：失败信息以「可重试」的语义回灌给模型，让它自己纠正，而不是直接把异常抛给用户

### 知识库不上向量数据库

检索走**关键词打分**：查询分词后，每命中一个词加一分，取前 K 个。零依赖、完全离线、每一步都能解释「为什么检索到这段」。

代价也很实在：同义词不认、中文分词粗糙。而且代码里有个真实缺陷——**切块按字节切，中文会被切成非法 UTF-8**。

这件事单独写了一篇：[为什么我没给这个 Agent 接向量数据库](/blog/lightweight-rag-keyword-search/)

## 测试

465 行测试，覆盖跨层的纯逻辑部分。`MockLLMClient` 让整条 Agent 链路可以在没有网络的情况下跑断言——测试里能写「给它这个工具调用序列，它应该在第几轮停」。

## 相关文章

- [为什么我没给这个 Agent 接向量数据库](/blog/lightweight-rag-keyword-search/)
- [让大模型操作工业相机：工具怎么设计、循环跑在哪个线程](/blog/camera-ai-integration/)
