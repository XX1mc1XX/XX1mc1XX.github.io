---
title: 测试与验收：把测不了的部分隔离掉
description: "把不确定的那一格换掉，整条链路就全都能测了。假模型守逻辑、真模型守契约，两条路都要走。"
pubDate: 2026-09-20
tags: [C++, 测试, Agent, 架构设计]
---

这一篇讲 `tests/` 下那 6 个测试，以及最后那次真模型验收。

它跟前面几篇不太一样，前面都在讲"怎么把功能做出来"，这篇讲"怎么确认它真的对"。而且这里有一个绕不过去的矛盾：**Agent 框架里最核心的那一环——模型——输出是不确定的**。你没法断言"模型会说什么"。

我先说结论，这也是整篇的主线：**把不确定的那一部分隔离掉，剩下的全都能测。**

## 先分清哪些能测、哪些测不了

这套框架跑一次，链路上会经过这些东西：

| 环节 | 能不能测 | 为什么 |
|---|---|---|
| `Status` 错误码 | 能 | 纯函数，输入输出完全确定 |
| 日志落盘 | 能 | 写文件、查文件，确定 |
| 工具注册 / 查找 / 参数校验 / Schema | 能 | 纯逻辑，不碰网络 |
| 循环的收敛与 `max_steps` 兜底 | 能 | 分支跳转，确定 |
| 并发调用 | 能 | 线程调度不确定，但"结果对不对"确定 |
| **模型返回什么内容** | **不能** | 同一个问题，两次回答可能不一样 |

看这张表，规律很清楚：**凡是"我的代码"决定的行为，都确定；凡是"模型"决定的行为，都不确定。**

按这个规律切一刀，不确定的就只剩一个东西——`Chat()` 的返回值。那把它换掉不就行了。

## 隔离点选在哪

换成什么？换成一个"你让它说什么、它就说什么"的假模型。

这个替换点能成立，靠的是前面几篇里的一个设计：模型那层是个接口，真模型和假模型是同一个接口的两个实现。

```cpp
class ILLMClient {
 public:
  virtual ~ILLMClient() = default;
  virtual ChatResponse Chat(const ChatRequest& request) = 0;   // 唯一的插口
};
```

`Agent` 里持有的是一根 `std::shared_ptr<ILLMClient>`，它**只认这个接口，不认背后是谁**——真模型也好、假模型也好，对它来说完全一样。

把这条链路摊开看，替换发生在哪一步就很清楚了：

![不确定性只在模型那一格，把它换掉](/images/agent4cpp/lesson14-可测边界.svg)

假模型长这样，核心就一个队列：

```cpp
class MockLLMClient : public ILLMClient {
 public:
  void PushResponse(ChatResponse response);       // 预先排一句台词
  ChatResponse Chat(const ChatRequest& request) override {
    last_request_ = request;                      // 顺手把请求留一份
    if (next_ < scripted_responses_.size()) {
      return scripted_responses_[next_++];        // 按顺序念台词
    }
    return ChatResponse{Status::Internal("mock script exhausted"), "", std::nullopt};
  }
  const ChatRequest& last_request() const { return last_request_; }
 private:
  std::vector<ChatResponse> scripted_responses_;
  std::size_t next_ = 0;
};
```

它是**确定**的：排好三句台词，回答顺序就是三句，一模一样。

这一换之后，整条链路（自然语言 → 工具调用 → 设备执行 → 结果回灌）就都能在离线、无 Key、不花钱的情况下跑断言了——因为每一环的输入输出都是我们自己给的。

顺带还白捡一个好处，这个后面会重点讲：`last_request_`。

## 6 个测试各管一段

6 个测试文件，加起来约 460 行，都放在 `tests/`。

| 测试 | 管哪一段 | 验证什么 |
|---|---|---|
| `core_smoke_test` | `Status` | 最小冒烟：错误码能转成字符串 |
| `log_test` | 日志 | 日志真的落盘了、带了源文件名 |
| **`tool_registry_test`** | 工具层 | 注册 / 调用 / 校验 / Schema / 并发（**最全的一个**） |
| **`agent_runtime_test`** | Agent 循环 | 循环 / Reset / 异步 / RAG（**用假模型**） |
| `knowledge_store_test` | 知识库 | 检索打分、读文件、工具知识 |
| `interactive_cli_test` | CLI | 命令流程（喂假输入） |

有个共同约定：**`main()` 返回 0 算通过，非 0 算失败**。`CTest` 就认这个，不需要引 GoogleTest 这类框架。

这个选择我犹豫过。GoogleTest 有更漂亮的输出、有断言宏。但六个总共几百行的小测试，为了断言宏拉进一整个框架，代价是编译变慢、依赖变多。`main` 返回码够用，我就用了它。**这是取舍，不是它更好。**

## 三个测试里真正值钱的东西

### 把 Schema 的字符串格式锁死

工具那层的测试里，有一段我在断言 Schema 的**字符串长什么样**：

```cpp
if (schemas.find("\"type\":\"function\"") == std::string::npos ||
    schemas.find("\"name\":\"set_exposure\"") == std::string::npos ||
    schemas.find("\"parameters\"") == std::string::npos) {
  std::cerr << "tool schemas should use OpenAI function-calling format\n";
  return 1;
}
```

看着很笨——不去解析 JSON，直接查子串。

**为什么这么做**：这段 Schema 是**发给模型**的。模型不解析你的 C++ 对象，它只看字符串。格式错一个字符，模型那边就不认这个工具。这是**格式契约**，不是内部实现——内部实现可以随便改，这个契约不能破。

所以我用最笨的办法把它钉死。哪天有人重构了 `BuildOpenAIToolSchema`，只要输出的字符串变了，这个测试立刻红。

### 用假模型喂台词，测循环

`agent_runtime_test` 是整个测试集里我最想讲的一个。它测"循环"，办法是给假模型排两句台词：

```cpp
auto llm = std::make_shared<agent4cpp::MockLLMClient>();
llm->PushResponse(ChatResponse{Status::Ok(), "I will inspect exposure first.",
                               ToolCall{"call_1", "get_exposure", "{}"}});   // 第 1 轮：要工具
llm->PushResponse(ChatResponse{Status::Ok(), "Exposure is currently 5000 us.",
                               std::nullopt});                              // 第 2 轮：不要工具 → 停

agent4cpp::Agent agent(agent4cpp::AgentConfig{}, &registry, llm);
const auto response = agent.Run("The image looks dark.");
```

第一句要工具、第二句不要工具——**一个两轮的循环，就这样被脚本化了**。

这一下能断言的东西就多了：循环真的转了两圈、`transcript` 里真的有那次的工具观测、最终答复就是第二句台词。**全是确定的断言**，因为台词是我们自己排的。

### 反查"Agent 到底发了什么给模型"

这个是假模型最被低估的地方。

真模型的请求你**看不到**——你不知道 Agent 到底把哪几条消息拼进去发出去了。假模型有一根 `last_request_`，测试可以把它翻出来看。

RAG 那个测试就是靠这个验的：

```cpp
for (const auto& message : rag_llm->last_request().messages) {
  if (message.role == agent4cpp::ChatRole::kSystem &&
      message.content.find("Exposure controls image brightness") != std::string::npos) {
    found_knowledge_context = true;   // 知识片段确实出现在了发给模型的请求里
    break;
  }
}
```

它验的是"知识库检索出来的那段文字，到底有没有真的夹进请求"。这个功能在 `Agent` 内部，光看 `Run()` 的返回值根本看不出来——返回值里只有最终答复。必须能反查请求，才测得了它。

**"把不确定的换成确定的"是个很朴素的想法，"换成确定的东西之后还能反查"才是它真正的价值。**

### 循环的兜底怎么测

`max_steps` 那条兜底路径，同样用假模型测。排一串**永远要工具**的台词，Agent 就会一路转到底：

```cpp
for (int i = 0; i < 20; ++i) {                     // 排得比 max_steps 多
  llm->PushResponse(ChatResponse{Status::Ok(), "", ToolCall{"c", "set_exposure", "{}"}});
}
agent4cpp::Agent agent(agent4cpp::AgentConfig{}, &registry, llm);
agent4cpp::AgentConfig config;
config.max_steps = 3;                              // 只给 3 步预算
```

断言的是三件事：返回值是 `kFailedPrecondition`、`transcript` 的总步数没超过 3、**假模型的台词没被念完**（说明循环是被 `max_steps` 砍断的，不是自己停的）。

```cpp
if (response.status.code() != int(agent4cpp::StatusCode::kFailedPrecondition) ||
    response.transcript.size() > 3 ||        // 步数没超预算
    llm->served_count() >= 20) {             // 台词还剩着 → 循环确实被砍断了
  std::cerr << "max_steps guard did not fire as expected\n";
  return 1;
}
```

最后那条是关键。前两条只能说明"返回了错误"，第三条才证明"它真的停在了预算上，没有偷偷多转"。

## 并发那段是活证据

工具层测试里有一段八个线程同时 `Call`：

```cpp
std::vector<std::future<agent4cpp::ToolResult>> futures;
for (int index = 0; index < 8; ++index) {
  futures.push_back(std::async(std::launch::async, [&registry]() {
    return registry.Call("set_exposure", R"({"exposure_us":8000})");
  }));
}
```

八个线程一起调，每个都要拿到正确结果。这验的是 `shared_mutex` 那套读并发设计——讲工具层那篇里我用普通 `mutex` 和 `shared_mutex` 对比过，这里是它的执行证据。

平心而论，这个测试**不是**严格的并发正确性测试。它跑出来要么全对、要么崩，但它没法保证一定触发数据竞争。真正的竞态要跑几十万次、或者上 ThreadSanitizer 才容易抓到。它更像一个"活证据"：证明并发这条路是通的、没崩。这个边界我心里清楚。

## 为什么假模型测过了还要跑真模型

这是这一篇里我最想强调的一步。**假模型测过了不等于能交付。**

假模型证明的是"循环逻辑对"——因为这个逻辑是我写的，台词也是我给的。它证明不了的另一件事是：**真模型会不会按你设计的 Schema 和提示词来**。

举个具体的：我把参数名起成 `exposure_us`，假模型我让它传 `{"exposure_us": 8000}`，当然通过。可真实模型看到这个 Schema 会不会照办？描述写得够不够清楚？它会不会自作主张传个 `{"exposure_us": "8000"}`（字符串）？这些**只有真模型能回答**。

所以最后那步验收是：换个真模型，跑完整链路。

```powershell
# API Key 走环境变量 OPENAI_API_KEY
bin\agent4cpp_openai_camera_cli.exe --base-url https://api.deepseek.com/v1 --model deepseek-chat
agent4cpp > 画面有点暗
```

期望看到的是：模型自己调 `get_camera_status` → 自己判断偏暗 → 自己调 `set_exposure` → 用中文总结。**没有任何一行代码提示它该这么做**，全靠 Schema 和提示词把它引导到位。

一张表能说清这两步的分工：

| | 假模型测试 | 真模型验收 |
|---|---|---|
| 环境 | 离线、无 Key、0 花费 | 要联网、要 Key、花钱 |
| 跑多少遍 | 每次改代码都跑 | 交付前跑一次 |
| 证明什么 | **逻辑**对（循环、校验、错误分支） | **Schema 和提示词在真模型上有效** |
| 证明不了什么 | 真模型认不认你的设计 | 长任务会不会不收敛 |

两个都需要，缺一个都不算验完。

真模型跑不通的时候，头三个该查的是这些——它们全都不是逻辑问题：

| 症状 | 查什么 |
|---|---|
| 程序起不来 / 报找不到符号 | `libcurl.dll`、`curl-ca-bundle.crt` 在不在 exe 旁边 |
| 报 401 / 认证失败 | `OPENAI_API_KEY` 设了没（要设成环境变量） |
| 报 404 / 找不到接口 | `base_url` 对不对，有的服务要 `/v1` 结尾 |

这三样我在讲模型接入那篇里都踩过，写在这里是提醒自己：**真模型验收失败，先查环境，再查代码。**

## 我踩过的坑

集中说一下。

**以为"模型不确定"就等于"没得测"。** 我一开始真的这么想过，觉得核心那环测不了，那测试也就只能盖盖边角。后来想明白：不确定的只有 `Chat()` 的返回值这一个点，把它换掉，整条链路就都确定了。想通这一点之后，测试才真的写得下去。

**写完假模型测试就以为验收结束了。** 全绿之后我很踏实，觉得可以交了。直到第一次换真模型跑——它把我一个参数描述理解错了。假模型永远不会做这件事，因为它只会念我写的台词。

**没做 `last_request()`，RAG 那功能等于没测。** 一开始我觉得"反正输出看着是对的"。但 RAG 那段知识片段夹没夹进去，从 `Run()` 的返回值里根本看不出来。加上 `last_request()` 之后，测试才真的碰到那个功能。

**断言 Schema 时想去解析 JSON。** 试过先把 Schema 解析成对象、再逐字段比。写出来又长又脆——解析器本身出问题就把测试带偏了。后来退回最简单的一招：查子串。契约是字符串，就用字符串的方式断言。

**以为八个线程的测试能证明并发正确。** 它一次跑全绿，我就觉得并发没问题了。后来意识到它只是个"活证据"——能证明没崩，证明不了没竞态。真正的竞态得靠 TSan 或者海量重复。

**真模型跑不通，第一个怀疑自己代码写错了。** 查了半天逻辑，其实问题在 `libcurl.dll` 和 `curl-ca-bundle.crt` 没放在 exe 旁边。这类环境问题看着像代码问题，很浪费时间。后来固定查三样：dll 在不在、`OPENAI_API_KEY` 设没设、`base_url` 的 `/v1` 结尾对不对。

## 几个我当时犹豫过的设计

**为什么每个测试自己写 `main`，不用测试框架。**
想过上 GoogleTest。放弃的原因是这批测试太小、太独立，断言宏带来的可读性提升抵不过多一个依赖的成本。代价是失败输出的信息量不如框架——我得自己 `std::cerr` 打一句说明为什么失败，像上面 Schema 那段那样。这个代价我接受。

**`main` 返回码这个约定是不是太土。**
是有点土，但它换来的是零依赖。`CTest` 直接吃返回码，CMake 里配一下就行。土的东西往往活得久。

**假模型的台词为什么排成队列，而不是按请求内容返回。**
按请求匹配更"聪明"，能做更复杂的场景。但队列有个无法替代的好处：**它逼你把流程想清楚**——第几轮该要工具、第几轮该停，你在排台词的时候就得想明白。而且断言更硬：如果 Agent 多发了一轮请求，队列会直接空掉、报错。这个失败信号比"返回了预期外的值"清楚得多。

**为什么不再上更重的验证（TSan、fuzz、覆盖率）。**
想过。但这是个小框架，现在这 6 个测试已经盖住了"改动会不会踩坏别的"这个最实际的需求。TSan 抓竞态是真的有价值，我在并发那段也承认了现有测试的边界。留作下一步，不是没想到。

## 收个尾

把这套测试跑一遍：

```powershell
cmake -S . -B build
cmake --build build --config Debug --parallel
ctest --test-dir build -C Debug --output-on-failure
```

实测输出：

```text
1/6 Test #1: agent4cpp_core_smoke_test ........   Passed    0.04 sec
2/6 Test #2: agent4cpp_log_test ...............   Passed    0.04 sec
3/6 Test #3: agent4cpp_tool_registry_test .....   Passed    0.04 sec
4/6 Test #4: agent4cpp_agent_runtime_test .....   Passed    0.04 sec
5/6 Test #5: agent4cpp_knowledge_store_test ...   Passed    0.03 sec
6/6 Test #6: agent4cpp_interactive_cli_test ...   Passed    0.03 sec

100% tests passed, 0 tests failed out of 6
```

六个全绿，总耗时 0.22 秒。**离线、无 Key、不花钱。**

整条链路上真正不确定的只有一格——模型那一格。这一篇做的所有事情，就是先承认它测不了，再把它换成一个确定的东西，然后把剩下每一格都验到底。

再看一眼那张图：

![验收的两条路：假模型守逻辑，真模型守契约](/images/agent4cpp/lesson14-两条验收路.svg)

下面这条是每次改代码都跑的，上面那条是交付前跑一次的。两把锁锁的是不同的东西。
