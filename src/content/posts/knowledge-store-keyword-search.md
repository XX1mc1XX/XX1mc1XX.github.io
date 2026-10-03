---
title: 给 Agent 配一个资料柜
description: "用关键词打分而不是向量检索做本地资料柜：为什么工业现场要这样选，以及一个把中文切成乱码的真实缺陷。"
pubDate: 2026-09-28
tags: [C++, RAG, 检索, 架构设计]
---

这一篇讲 `knowledge_store.cpp`，整个项目里最"接地气"的一个模块。

前面几篇把链路搭通了：工具能调、模型能接、循环能转。但那个 Agent 有个硬伤——**它不知道你公司的设备手册**。

模型的全部知识在训练完那一刻就冻结了。你海康相机的 SDK 文档、产线上的操作规程，都是后来才写的，它一次都没见过。你问"3000 系列报 E07 什么意思"，它不会说不知道，它会**编一个听起来很合理的答案**——这是幻觉最常见的出处。

## 一句话说清这个模块

想象你雇了个外部顾问。他什么都懂一点，但没读过你们公司的内部资料。

所以你在办公室里放了一个**资料柜**。他来之前，你先按关键词去柜子里翻几页，**把最相关的几页夹在问题里一起递给他**。

这个套路有个正式名字：**RAG（检索增强生成）**。

但记住这句话比记住名字重要：

> **RAG 不是让模型去查资料，是你提前查好、塞给它。**

模型从头到尾**没碰过你的资料柜**。它收到的只是一个"已经夹好资料的问题包"。这个顺序后面还会反复提到。

## 存什么、怎么找、找到怎么用

三个决定，一次说清。

| 问题 | 本项目的答案 | 为什么不这样会出事 |
|---|---|---|
| **存什么** | 存**片段**，不存整篇 | 一篇手册几万字，模型的上下文窗口塞不进去 |
| **怎么找** | **关键词打分**，不用向量库 | 工业现场常离线，装不了向量库 |
| **找到怎么用** | 拼成一段文本，作为一条 **system 消息**塞进对话记录 | 直接拼进用户问题里，模型分不清哪句是用户说的 |

第三行那个顺序很重要：检索发生在**问模型之前**，结果作为独立的一条 `system` 消息排在用户问题**前面**。`agent.cpp` 里就那几行，前面一篇讲循环时见过——这里说的是它背后那个 `Search()` 到底干了什么。

## 接口：还是那个熟悉的套路

```cpp
class AGENT4CPP_API IKnowledgeStore {
 public:
  virtual ~IKnowledgeStore() = default;
  virtual void Add(DocumentChunk chunk) = 0;
  virtual std::vector<DocumentChunk> Search(const std::string& query, int top_k) const = 0;
  virtual bool Empty() const = 0;
};
```

三个方法就是全部能力：**塞一条、查一次、看看空不空**。

这是整个项目**第三次**出现同一个套路了——`ILLMClient`（模型）、`IHttpClient`（HTTP）、现在的 `IKnowledgeStore`。上层只认抽象接口，下面挂什么实现它不管。这个习惯的价值在这一篇里特别明显，后面讲取舍时你会看到：我敢用"简单但有局限"的检索方案，就是因为**换起来不贵**。

数据这边就一个结构，四个字段：

```cpp
struct AGENT4CPP_API DocumentChunk {
  std::string id;      // "manual.txt#3"（第 4 块）
  std::string source;  // 来自哪个文件
  std::string text;    // 正文
  double score = 0.0;  // 相关性得分（检索时才填）
};
```

## 检索四步

`Search()` 是核心，一共四步：**分词 → 逐块打分 → 排序 → 取前 K**。

![检索四步流程](/images/agent4cpp/lesson11-检索四步.svg)

```cpp
std::vector<DocumentChunk> InMemoryKnowledgeStore::Search(
    const std::string& query, int top_k) const {
  if (top_k <= 0) return {};

  const auto query_tokens = TokenizeForSearch(query);   // ① 查询分词

  std::vector<DocumentChunk> ranked;
  std::shared_lock lock(mutex_);                        // ② 共享锁（读）
  for (const auto& chunk : chunks_) {
    DocumentChunk scored = chunk;                       //    ★ 拷一份再改分
    scored.score = ScoreChunk(scored, query_tokens);
    if (scored.score > 0.0) {                           // ③ 0 分直接丢
      ranked.push_back(std::move(scored));
    }
  }

  std::sort(ranked.begin(), ranked.end(),               // ④ 按分降序
            [](const DocumentChunk& a, const DocumentChunk& b) {
              return a.score > b.score;
            });

  if (static_cast<int>(ranked.size()) > top_k) {
    ranked.resize(static_cast<size_t>(top_k));          // ⑤ 截断到 top_k
  }
  return ranked;
}
```

打分器本身粗暴得有点可爱：

```cpp
double ScoreChunk(const DocumentChunk& chunk,
                  const std::vector<std::string>& query_tokens) {
  const std::string haystack = LowerAscii(chunk.source + " " + chunk.text);
  double score = 0.0;
  for (const auto& token : query_tokens) {
    if (!token.empty() && haystack.find(token) != std::string::npos) {
      score += 1.0;          // 命中一个词 +1 分
    }
  }
  return score;
}
```

**查询里的词，每有一个出现在这块文本里，+1 分。** 就这样。

问"曝光 trigger"，某块两个词都有就是 2 分，只有"曝光"就是 1 分。分数就是排序依据。

这段代码里有三个地方我想单独说：

**`DocumentChunk scored = chunk;` 这个拷贝。** `chunks_` 是柜子的原始数据，`score` 平时是 0。检索**不该改原始数据**——否则第二次检索会看到上次残留的分数。所以拷一份出来打分。不拷贝直接改，是这个模块最容易犯的错。

**`if (scored.score > 0.0)`。** 一个词都没命中的块直接扔掉。不扔会怎样：这些 0 分块会进入候选，然后被 `resize(top_k)` 按**原本的插入顺序**截断——返回一堆完全无关的内容。**这比不返回还糟**，模型会拿着无关内容一本正经地胡说。宁可返回空，`Agent` 那边看到 `context.empty()` 就直接跳过，不塞垃圾。

**`std::shared_lock`。** 和工具注册表一个道理：塞文档是"偶发写"，检索是"高频读"，所以读用共享锁、可以并发。这个选择在这个模块里是**真用得上**的，对比后面会讲。

## 切块：为什么要重叠

整篇手册塞不进上下文窗口，所以要先切成小块（默认每块最多 1200 字符）。

但有个问题：如果关键句子正好被切在边界上，前半在第一块、后半在第二块，检索时**两块都只匹配到半句话**，可能都落选。

留一段重叠（默认 120 字符）就解决了——保证任何一句话至少**完整地**出现在某一块里。

```text
不重叠：  [....关键句子前半][后半....]     ← 两块都匹配不完整
有重叠：  [....关键句子前半]
                   [关键句子前半][后半]   ← 后一块完整包含它
```

切点也不是随便切的，先按长度划一刀，然后**回头找最近的换行符**：

```cpp
size_t end = std::min(start + max_chunk_chars, text.size());
if (end < text.size()) {
  const size_t newline = text.rfind('\n', end);   // 往前找最近的换行
  if (newline != std::string::npos && newline > start) {
    end = newline + 1;      // 切在换行之后，保持整行完整
  }
}
```

别把一行拦腰截断，模型读起来也舒服一点。

有两处防御我是后来补上的，补的原因都是"能死循环"：

```cpp
const size_t overlap = std::min(options.chunk_overlap_chars, max_chunk_chars - 1);
...
start = next_start > start ? next_start : end;   // 必须往前走
```

**重叠必须小于块大小。** 如果 `overlap >= max_chunk_chars`，下一块的起点会跑到这一块起点之前或原地不动——`while (start < text.size())` 永远不进步，**死循环**。

## 实测：跑一遍看结果

`_lab/lab_knowledge.cpp` 里我造了段 4 行的假手册，用 `max_chunk_chars=160, overlap=40` 切一刀，再看检索出了什么。

切出 5 块：

| 块 | 开头 | 说明 |
|---|---|---|
| `#0` | `1. Exposure control` | 完整 |
| `#1` | `icroseconds. Use the...` | `microseconds` 被切断了 |
| `#2` | `.9 means underexposed.` | `0.9` 被切断 |
| `#3` | `es extra wiring.` | `requires` 被切断 |
| `#4` | `�增大曝光值。` | **乱码** |

看最后一行那个 `�`。正常应该是"时增大曝光值"。这个方块背后是后面要专门讲的一个 bug——先记住它。

检索结果：

```text
查询 "曝光"        →  #2, #3, #4   各 1 分    ← 命中 3 块，其中只有 #4 真相关
查询 "trigger"     →  #1, #2       各 1 分    ← 重叠把一行切进了两块
查询 "曝光 trigger" →  #2 得 2 分排第一        ← 多词加分，排序正确工作
查询 "图像有点暗"   →  一条都没命中            ← 死穴
```

三行结果对应三件事：

- **重叠会让关键词重复命中。** "曝光"命中 3 块，精度被重叠稀释了。
- **多词打分能正确排序。** 都含这两个词的那块排到了第一。
- **中文口语查询直接废。** 文档写的是"图像偏暗时"，用户问"图像有点暗"，差两个字就完全匹配不上。

第三条不是小毛病，是这套方案的一个结构性缺陷，下面单独说。

## 我踩过的坑

**以为模型会自己跑去查库。** 我最初的想法是"模型转着转着发现缺资料，再去查知识库"。实际不是——**Agent 提前查好，把资料夹在问题里一起递过去**。模型全程没碰过你的知识库。理解这个顺序，很多事就顺了。

**检索时直接改了原始块。** 没拷贝，直接在 `chunks_` 的元素上写 `score`。跑第一遍看不出问题，第二遍查另一个词就发现分数是上一次的残留。`DocumentChunk scored = chunk;` 那一行是事后加的。

**重叠率设得比块大小还大，程序卡死。** 试参数的时候调了个 `overlap=200, max_chunk_chars=120`，跑起来直接 hang 住。原因是起点不往前走了，`while` 变成死循环。现在用 `std::min` 把重叠卡在 `块大小 - 1` 以内。

**中文块被按字节切开，模型收到乱码。** 这个最隐蔽，也是这个模块最真实的一个缺陷，单独展开。

## 一个真实的缺陷：按字节切中文

切块的底层是这一行：

```cpp
chunk.text = text.substr(start, end - start);   // start/end 都是字节位置
```

`std::string` 本来就是字节序列，按字节切实现最简单。**但中文一个字占 3 个字节。**

如果切点正好落在一个汉字的中间，这个字就被劈成两半：前两个字节留在上一块，最后一个字节进了下一块。两块各自都是**非法的 UTF-8**——模型收到的是乱码。

![切块按字节走：一个汉字被劈成两半](/images/agent4cpp/lesson11-字节切开中文.svg)

上面实测里那个 `�` 就是证据。我把原始字节 dump 出来看过：

```text
b6 e5 a2 9e e5 a4 a7 ...
↑
开头这个孤零零的 b6 是「时」(e6 97 b6) 的最后一个字节
```

"时"的编码是 `e6 97 b6` 三个字节，切点正好切在 `97` 和 `b6` 之间，`b6` 掉进了下一块的开头。

这个 bug 对纯英文文档完全无感（ASCII 一个字节就是一个字符），**文档里一有中文就必然触发**。修法不难：切点确定之后**向前回退到 UTF-8 字符边界**——检查字节高位，如果不是 `10xxxxxx` 就说明它是某个字符的首字节，可以切在那里。

我先把修法记进笔记了，没立刻改——因为改它得连带把切块逻辑重写一遍，我想等把中文分词的问题一起想清楚再动。

## 为什么不用向量数据库

**为什么不接向量数据库。** 这是我最想讲的一个取舍。

行业里 95% 的人做 RAG 是这条路：文档调 embedding 模型变成向量，存进向量库，提问时算余弦相似度取最近的几条。我没这么做，用的是关键词匹配。

| 维度 | 向量检索（主流） | 关键词打分（本项目） |
|---|---|---|
| **依赖** | 要装向量库，或调云端 embedding API | **零依赖**，纯 `std::vector` + 字符串查找 |
| **离线部署** | 麻烦，工业现场常常没网 | **天生离线** |
| **可解释性** | 差。"为什么这段排第一？"——余弦 0.83，等于没说 | **好**。"因为里面有『曝光』这个词"，能解释、能排查 |
| **同义词** | 强。"调亮"和"增大曝光"向量距离很近 | **不认**。"调整"和"设置"就是两个不同的词 |

选它有两个理由。一是**工业软件常常离线部署**，产线上装不了 Milvus 那套东西，embedding 也得本地跑。二是**出问题时工程师要能解释**"为什么检索到了这一段"——关键词法一句话就能说清，向量相似度解释不了。

代价是明确的：**同义词不认，中文分词废**。这个我没打算掩盖。

但我敢用这个"简单但有局限"的方案，根本原因是**换起来不贵**——`IKnowledgeStore` 这个虚接口留好了，将来要换向量库，上层一行都不用改。这才是接口设计的价值：它让"先上一个够用的简单方案"变成一个可逆的决定。

## 中文分词：这套方案真正的死穴

分词就三行：转小写、按空白切、收进数组。

```cpp
std::istringstream input(LowerAscii(text));   // 先全转小写
while (input >> token) {                      // >> 自动按空白切
  tokens.push_back(token);
}
```

`Exposure` 和 `exposure` 要算同一个词，所以先转小写，这个没问题。

问题在"按空白切"。**中文句子没有空格。**

```text
"Exposure Time"  →  [exposure] [time]        ← 2 个词，好用
"曝光"           →  [曝光]                    ← 1 个词（运气好，整串能匹配）
"图像有点暗"      →  [图像有点暗]              ← 整句一个"词"
```

最后一行是关键：`图像有点暗` 要能命中，文档里必须**原样出现这五个字**。文档写"图像偏暗时"，就检索不到。上面实测的最后一行为什么一条都没命中，原因就在这里。

这是这套方案最硬的边界。我的判断是：**它对"术语固定、表达规范"的工业文档够用**（文档和用户都写"曝光时间"），但对口语化提问基本失效。真要做一个能用的中文 RAG，得上分词 + 倒排索引 + BM25，或者干脆上向量库——接口的口子留着。

## 结果怎么拼进问题里

检索出来之后，拼成一段文本，作为一条 `system` 消息塞进对话记录。实测的消息列表长这样：

```text
[0] system   ← 系统提示词
[1] system   ← 知识库检索结果
    Relevant knowledge retrieved for this user request:

    [source: manual.txt, id: manual.txt#0, score: 1]
    1. Exposure control
    The camera exposure time is set in microseconds. Use the set_exposure tool.

    [source: manual.txt, id: manual.txt#1, score: 1]
    icroseconds. Use the set_exposure tool.
    Default exposure is 5000 us. Brightness below 0.9 means underexposed.

    2. Trigger mode

    Use this knowledge when it is relevant. Ignore it if it does not apply.
[2] user     ← 用户的问题
[3] assistant
```

三个点值得记：

**位置在 `[1]`，在 user 之前。** 这就是"问模型之前先检索"的直接证据。

**角色是 `system`，不是 user。** 等于告诉模型"这是背景资料，不是你和我说的话"。

**最后那句 `Ignore it if it does not apply` 必须有。** 检索算法不完美（上面"曝光"命中 3 块就是例子，其中两块并不相关），不明确告诉模型"不相关就忽略"，它会被无关信息带跑——这是 RAG 最典型的翻车方式。

还有个小功能顺便提一下：`AddToolDefinitionsAsKnowledge()` 能把每个工具的"名字 + 描述 + 参数说明"也拼成文本塞进柜子。用户问"怎么让画面亮一点"，模型光看工具名 `set_exposure` 未必反应过来，但如果它能**检索到**这个工具的详细描述（"设置相机曝光时间，调大更亮"），就更容易判断该用哪个。相当于把工具文档也当参考资料一起喂。

## 几个我当时犹豫过的设计

**`shared_mutex` 还是普通 `mutex`。** 这个模块用了 `shared_mutex`（读共享、写独占），但 `Agent` 那边用的是普通 `mutex`。同一个项目里两个选择不一样，理由很具体：知识库是"偶发写 + 高频读"，读读并发划算；而 `Agent` 的 `RunLocked` 全程持锁、每圈都要写 `messages_`，"读多写少"根本不成立，用 `shared_mutex` 纯属白付开销。选锁不是看"哪个高级"，是看读写比例。

**切块的重叠率要不要做成可配。** 现在 120 是写死的。重叠的好处是防边界丢信息，代价是存储翻倍、关键词重复命中。想做成可配，但不同类型的文档该配多少，我还没有数据。先写死一个，等有真实的文档样本再说。

**0 分的块该不该直接丢。** 丢了的好处是不会塞无关内容，坏处是万一用户用词和文档完全对不上（同义词），本该"勉强相关"的块也一起丢了。我选了丢——因为工业场景里"给模型错误资料"比"不给资料"更危险。将来换成向量检索，这条规则也要跟着变，因为向量分数没有"0 分"这种硬边界，得改成"取前 K 个但低于阈值丢弃"，阈值多少要靠数据调。
