---
title: 手写一个 Agent 循环
description: "近 300 行的函数，真正的逻辑只有 5 行。程序里没有一行代码判断「任务完成了没有」——这个判断只能交给模型。"
pubDate: 2026-10-02
tags: [C++, LLM, Agent, 架构设计]
---

这一篇讲整个项目最核心的那个文件：`agent.cpp` 里的 `RunLocked()`。

前面几篇我们准备好了零件——工具怎么描述、怎么注册、怎么执行，模型客户端怎么接。但这些零件**没有一个在统筹**：工具登记处不会自己去问模型，模型也不会自己去执行工具，它只会输出一段文字说"我要调 set_exposure"。

`RunLocked()` 就是那个统筹者。它是唯一知道"要转圈、什么时候停"的地方。

先说一句可能让你意外的话：**这个函数将近 300 行，但真正的逻辑只有 5 行**，剩下的全是在处理各种各样的意外情况。所以我打算先把那 5 行说清楚，再带你走一遍那些"意外"是怎么处理的。

## 最反直觉的一点

我先把这个说在前面，因为它跟我一开始的直觉是反的。

程序里**没有一行代码判断"任务完成了没有"**。

没有 `if (曝光调好了)`，没有 `if (亮度 > 0.9)`，也没有任何类似的东西。

"完没完"这件事**完全由模型判断**，代码只认一个信号——**它还要不要工具**。

我最初写的时候绕了很久：总觉得程序应该知道什么时候该停。后来想明白了——**程序根本没法知道**。曝光该调到多少才算"调好了"？这需要领域知识，而这个知识在模型那边，不在代码里。硬要在代码里判断，就得给每个任务配一套规则，那这套框架就没有通用性了。

所以最后的做法是：把"完没完"的判断权交出去，代码只负责"它还要工具，我就给；它不要了，我就返回"。

## 循环本体

抛开所有异常处理，这个循环长这样：

![Agent 循环：整个项目的心脏](/images/agent4cpp/lesson10-Agent循环.svg)

五个动作：**问模型 → 它还要工具吗 → 要就执行 → 把结果塞回记录 → 回到第一步再问**。它不要工具了，就是它说完了，把答复返回，结束。

就这些。下面所有的代码都是在处理这 5 步里可能出的岔子。

## 头文件：能拧什么、拿回什么、状态放哪

先看 `agent.h`，它只回答三个问题。

### 能拧什么：`AgentConfig`

```cpp
struct AGENT4CPP_API AgentConfig {
  std::string system_prompt = "You are an industrial C++ desktop software assistant...";
  int max_steps = 8;                                    // 防死循环
  const IKnowledgeStore* knowledge_store = nullptr;     // 可选
  int knowledge_top_k = 3;
};
```

四个字段里有两个值得说。

**`max_steps = 8`** 是防止模型不收敛的兜底，后面单独讲。

**`knowledge_store` 用的是裸指针** `const IKnowledgeStore*`，这里我犹豫过用什么类型：

- 引用做不到——它**可以为空**（不配知识库就是 `nullptr`）
- `unique_ptr` 也不对——它表达了"拥有"，但 Agent **不负责销毁**这个知识库，生命周期由宿主程序管

"不拥有 + 可空"这两个语义叠在一起，只有裸指针合适。

### 拿回什么：`AgentResponse`

```cpp
struct AGENT4CPP_API AgentResponse {
  Status status;                        // 这次对话成没成
  std::string content;                  // 模型最终给用户的答复
  std::vector<ChatMessage> transcript;  // 完整对话记录（含中间的工具调用）
};
```

那个 `transcript` 我强烈建议你打印出来看。它把"模型要调什么工具、传什么参数、工具返回什么"**全程留痕**——调试的时候，出问题到底出在哪一步，看它一目了然。这个项目里所有的日志都是从它来的。

### 三个公开方法

| 方法 | 干什么 | 什么时候用 |
|---|---|---|
| `Run(user_input)` | 同步跑，当前线程等结果 | 命令行场景 |
| `RunAsync(user_input)` | 异步跑，立刻返回 `future` | **界面必须用这个** |
| `Reset()` | 清空记录，开新日志，放回系统提示词 | 用户开新话题 |

`RunAsync` 那条我踩过：最早界面上用的是同步 `Run`，结果模型一思考就是十几秒，**整个界面冻住**。后来换成异步，才好。

### 状态放哪：成员变量

```cpp
const ToolRegistry* registry_;            // 不拥有 + 可空
std::shared_ptr<ILLMClient> llm_client_;  // 可能和别处共享
std::vector<ChatMessage> messages_;       // 整个循环的「记忆」
mutable std::mutex mutex_;                // 保护 messages_
```

`messages_` 为什么是成员变量而不是局部变量？因为它要**跨多次 Run 保留**。用户连着问几句话，上下文得延续。如果每次 Run 都从零开始，用户说"再调暗一点"，模型根本不知道"再"指的是什么。

`mutex_` 为什么标 `mutable`？因为 `transcript()` 是个 `const` 方法，但它**也要读锁**。`const` 方法里改不了普通成员，所以锁必须是 `mutable` 的。这个坑我在写工具注册表的时候就踩过一次，这里第二次遇到。

## 一行一行走 RunLocked

下面按执行顺序走。我会尽量说清楚**每段为什么这么写**，以及**不这么写会怎样**。

### 进来先检查零件齐不齐

```cpp
if (registry_ == nullptr) {
  return AgentResponse{Status::InvalidArgument("tool registry is null"), "", messages_};
}
if (llm_client_ == nullptr) {
  return AgentResponse{Status::InvalidArgument("llm client is null"), "", messages_};
}
```

工具登记处和模型客户端是循环的必需品，缺一个就跑不起来。

**早点检查比转到一半空指针崩了好**——这两件事的出错现场不一样：空指针崩在循环深处，而传入 null 的现场在 `Run` 的调用方。后者好查得多。

### 知识库检索：在问模型之前

```cpp
if (config_.knowledge_store != nullptr &&
    config_.knowledge_top_k > 0 &&
    !config_.knowledge_store->Empty()) {
  const auto knowledge = config_.knowledge_store->Search(user_input, config_.knowledge_top_k);
  const std::string context = BuildKnowledgeContext(knowledge);
  if (!context.empty()) {
    messages_.push_back(ChatMessage{ChatRole::kSystem, context, ""});
  }
}
```

如果配了知识库，**先**拿用户的问题去检索，把查到的资料拼成一段文本，作为一条 `system` 消息塞进对话记录。三个条件都满足才做。

**这个顺序我一开始搞错了。** 我最初的想法是"模型转着转着发现缺资料，再去查知识库"。实际不是这样——**Agent 提前查好，把资料夹在问题里一起递给模型**。模型从头到尾没碰过你的知识库，它收到的只是一个"已经整理好的问题包"。

这个套路叫 RAG（检索增强生成）。理解了"提前查好塞进去"这个顺序，后面很多东西就顺了。

还有个小细节：拼出来的那段文本末尾有一句

```cpp
output << "\nUse this knowledge when it is relevant. Ignore it if it does not apply.";
```

**为什么要加这句**：检索出来的片段**可能跟问题无关**（检索算法不完美）。如果不明确告诉模型"不相关就忽略"，它会被无关信息带跑——这是 RAG 最典型的翻车方式。

### 用户这句话进记录

```cpp
AGENT4CPP_LOG_INFO("user input: " + user_input);
messages_.push_back(ChatMessage{ChatRole::kUser, std::move(user_input), ""});
```

注意这里是"**先加进记录，再问模型**"，不是把用户的话原样转手发出去。**所有东西都先落到 `messages_` 这个数组里，发的时候整个数组一起发。**

`std::move` 是因为 `user_input` 是按值传进来的，后面不再用它，直接把内部缓冲区搬进 vector，省一次字符串拷贝。

### 进核心循环

```cpp
for (int step = 0; step < config_.max_steps; ++step) {
```

下面是一圈里发生的事情。

### ① 问模型

```cpp
ChatResponse llm_response = llm_client_->Chat(
    ChatRequest{messages_, registry_->ListTools()});

if (!llm_response.status.ok()) {
  return AgentResponse{llm_response.status, "", messages_};
}
```

把**当前全部对话记录**和**全部工具清单**一起发给模型。

**注意是"全量发"，不是只发新增那几条。** 因为模型**是无状态的**——你不重发，它就不记得之前聊过什么。这一点我花了一点时间才真正接受：每次请求都是一次独立的、完整的世界快照。

模型那边出错（网络断、Key 错）就直接返回，不硬转。

### ② 把模型的回复存进记录

同一条消息，按角色要拼成不同的形状——助手这一侧又分三种情况：

![同一条消息，按角色写成不同形状](/images/agent4cpp/lesson09-消息形状.svg)

所以我这行是这样写的：

```cpp
messages_.push_back(ChatMessage{ChatRole::kAssistant, llm_response.content,
                                "",                                  // 注意这个空字符串
                                llm_response.tool_call,
                                llm_response.reasoning_content});
```

这里有个**我踩过的坑**：`reasoning_content` 一定要存。

它是思考模型（DeepSeek-R1 那一类）的思维链。**下一轮请求必须原样把它传回去**，否则长对话会开始报 400。我最早没存，前三轮好好的，第四轮突然报错，查了半天才发现是这个。

第三个参数是空的 `tool_call_id`——因为这条是 **assistant 说的**，不是工具返回的，所以没有 id。

### ③ 判断：唯一的正常出口

```cpp
if (!llm_response.tool_call.has_value()) {
  AGENT4CPP_LOG_INFO("assistant final answer: " + llm_response.content);
  return AgentResponse{Status::Ok(), llm_response.content, messages_};
}
```

看模型这轮**要没要工具**。没要，就说明它说完了，返回它的答复，循环结束。

**这是整个循环唯一的正常出口。** 回到开头那句话——代码里没有一行判断"任务完成没有"，只认"有没有 `tool_call`"这一个信号。

### ④ 执行工具

```cpp
const ToolCall& tool_call = *llm_response.tool_call;
ToolResult tool_result = registry_->Call(tool_call.name, tool_call.arguments_json);
```

模型点了哪个工具、传了什么参数，就调 `registry_->Call` 执行。里面会先校验参数、按名字找到工具、再调用那个 C++ 函数。

**真正碰设备的就是这一步。** 模型从头到尾没碰过你的相机——它只是输出了一段文字说"我要调 set_exposure，参数 10000"。是这里把这个"意图"翻译成真实的 C++ 函数调用。

这一点我觉得是整个架构里最重要的：**大模型不能执行任何代码，它只会输出文本，执行是 C++ 这侧做的**。对工业软件来说这就是安全边界——模型只能从你注册过的工具里挑，挑不出范围。

### ⑤ 把工具结果塞回去

```cpp
std::ostringstream observation;
observation << "status=" << tool_result.status.ToString();   // 失败状态也带上
if (!tool_result.content.empty()) {
  observation << "\ncontent=" << tool_result.content;
}
observation << "\npayload=" << tool_result.payload_json;

messages_.push_back(ChatMessage{ChatRole::kTool, observation.str(), tool_call.id});
```

把执行结果拼成一段"观测值"，作为一条 `kTool` 消息塞回记录，然后**回到 ①，再问一次**。

这里有三个决定，每个我都想了一下：

**失败也照样塞回去。** 这是"让模型自我修正"的根——它看到 `status=INVALID_ARGUMENT`，下一轮就知道改参数。我最早写的是"失败就中断循环"，结果用户体验很差：一次参数写错，整个对话就断了，用户得重新说一遍。改成失败也回灌之后，模型自己就改过来了。

**必须带 `tool_call_id`。** 模型靠这个 id 知道"这条结果对应哪次调用"。模型**可能一轮点好几个工具**，没有 id 就乱套了。

**三样都带**（`status` / `content` / `payload`）：

| 字段 | 给模型的作用 |
|---|---|
| `status` | 成没成——失败了它才知道要换方法 |
| `content` | 一句人话说明，模型写总结时会用 |
| `payload` | 结构化 JSON，模型做推理主要靠它 |

### ⑥ 兜底：转满了还没停

```cpp
AGENT4CPP_LOG_ERROR("agent reached max_steps before final answer");
return AgentResponse{
    Status(StatusCode::kFailedPrecondition,
           "agent reached max_steps before producing a final answer"),
    "", messages_};
```

循环转满还没停，返回错误。

**为什么必须有这个**：模型有概率**反复调同一个工具不收敛**。比如一直查相机状态，每次看到"亮度 0.5"都觉得"我再查一次确认"，能查二十次。没这个上限就是死循环。

**为什么错误码选 `kFailedPrecondition` 而不是 `kInternal`**：语义是"**在当前限制下没法完成任务**"——这是外部条件（步数预算）不满足，不是程序内部 bug。错误码选错，调用方就没法正确决定"该重试还是该修 bug"。

## 我踩过的坑

集中说一下，这些比代码本身更值得记。

**以为程序要知道"任务完成没有"。** 绕了很久才接受：这个判断只能交给模型。代码硬要判断，就失去了通用性。

**知识库检索的顺序搞反了。** 我最初以为是"模型转着转着去查库"，实际是"Agent 提前查好塞进问题里"。

**`reasoning_content` 忘了回传。** 前三轮正常，第四轮突然 400。查了很久。

**工具失败就中断循环。** 用户体验很差，改成失败也回灌之后，模型能自己改。

**忘记带 `tool_call_id`。** 模型一轮点多个工具的时候，结果对不上号。

**界面上用了同步 `Run`。** 模型一思考十几秒，界面整个冻住。必须用 `RunAsync`。

**`mutex_` 忘了标 `mutable`。** 在 `const` 方法里读锁，编译不过。这个坑写工具注册表时踩过一次，这里是第二次。

**`max_steps` 设成 8 是个折中，两种情况下都不理想**：简单问答本来 1 圈就够，异常时最多白打 8 次 API；复杂任务（比如多相机标定）8 圈可能真不够。更好的做法可能是按任务类型给不同预算，或者用"总 token 预算"代替"步数预算"——因为贵的是 token 不是步数。这一点我留着没改，因为现在还没有足够的实际数据来定这个阈值。

## 怎么确认它真的在工作

跑一次之后，把 `transcript` 打出来看。下面是 `lab_agent.exe` 真实跑出来的 7 条记录——循环转了三圈，每圈加两条：

![对话记录是这么一圈圈长起来的](/images/agent4cpp/lesson10-对话记录增长.svg)

最后那条**没有 `tool_call`**，循环就停在那。如果转满 8 圈还没停，日志里会有 `agent reached max_steps before final answer`——看到这句，说明模型没收敛，得回头看看工具描述是不是写得不够清楚。

## 几个我当时犹豫过的设计

**终止条件为什么只看 `tool_call`，不做别的判断。**
因为一旦开始自己判断"完没完"，就得给每类任务配规则，通用性就没了。代价是模型说"完成"不等于真的完成——工业场景要求确定性的时候（比如"必须确认曝光真的改成 10000"），这个方案不够，得另外加结果校验或者人工确认。这是当前方案的边界，我知道它在哪。

**为什么每轮发全量消息。**
因为模型无状态。这不是一个可以优化的地方——省掉它功能就坏了。

**`max_steps` 为什么不做成自适应的。**
想过，但没有数据支撑。现在这个 8 是拍的，等有真实的长任务样本再说。
