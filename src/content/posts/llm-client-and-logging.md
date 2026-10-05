---
title: 接上模型，记下它干了什么
description: "一个插口两种助手：Mock 和真实模型走同一个接口。还有 libcurl 那七步，以及思考模型的推理内容为什么必须原样回传。"
pubDate: 2026-10-07
tags: [C++, LLM, libcurl, 可观测性]
---

这一篇讲两件配套的事：日志，和模型接入。

先讲日志，因为它是后面所有调试的眼睛——模型这玩意儿是个黑盒，你不记下来，出了问题只能干瞪眼。再讲模型接口：怎么把"问模型"抽象成一个可以换的插口，怎么用 libcurl 真把请求发出去，以及从假助手切到真模型时踩了什么。

## 一、为什么非得有日志

你雇了个新助手（大模型）帮你操作设备。它每次说了什么、你调了哪个工具、传了什么参数、结果是什么——这些都必须记下来。原因很实际：

- 大模型的决策是个黑盒，不记录的话根本没法复盘"它为什么决定调这个工具"。
- 工业软件现场出问题时，日志往往**是唯一的线索**——你不可能远程调试客户机器上的程序。
- 给别人演示的时候，"内部到底发生了什么"全在日志里。

一份典型的日志长这样：

```text
user input: image is dark
agent step 1 started
assistant requested tool name=get_camera_status arguments={}
tool result name=get_camera_status status=OK payload={...}
agent step 2 started
assistant requested tool name=set_exposure arguments={"exposure_us": 8000}
agent step 3 started
assistant final answer: Done. Exposure is now adjusted ...
```

每一行都是日志模块写进去的。

写日志听着简单，自己写就知道要处理的细节不少：多线程同时写会串行错乱、要按日期或大小切分文件、要按级别过滤、要格式化时间戳、要异步批量写。这些 spdlog 都做好了，所以直接用现成的。这个项目用的是它的"头文件模式"——整个库就是一堆 `.h`，拷进来就能用，不用单独编译、不用链接。代价是编译变慢、exe 变大（库放在 `dependence/spdlog-1.17.0/include`）。

## 二、把日志库藏起来

先说一个设计决定：**头文件里不能出现 spdlog**。使用者不该被第三方库的类型污染，哪天换成别的日志库，只要改 `log.cpp`，头文件和所有调用方一行都不用动。

所以 `log.h` 里只有自己的东西：

```cpp
enum class LogLevel { kTrace, kDebug, kInfo, kWarn, kError, kCritical, kOff, };

AGENT4CPP_API void SetLogLevel(LogLevel level);
AGENT4CPP_API void StartNewLogFile();
AGENT4CPP_API std::string GetLogDirectory();
AGENT4CPP_API std::string GetCurrentLogFilePath();
AGENT4CPP_API void LogMessage(LogLevel level, const char* file, int line,
                              const char* function, const std::string& message);
```

五个函数分工明确：`SetLogLevel` 设最低记录级别；`StartNewLogFile` 开一个新文件（一轮对话一个）；两个 `Get*` 查询路径；`LogMessage` 是底层真正写日志的地方，一般不直接调，用宏。`kOff` 可以完全关掉日志。

本项目和 spdlog 各自定义了一套级别枚举，中间得有个翻译，就像两个国家各有一套红绿灯标准：

```cpp
spdlog::level::level_enum ToSpdlogLevel(LogLevel level) {
  switch (level) {
    case LogLevel::kTrace:  return spdlog::level::trace;
    ...
  }
  return spdlog::level::info;
}
```

列举所有情况、不写 `default`、末尾兜底——漏了 case 编译器会警告。

### 1. 为什么用宏，不用普通函数

```cpp
#define AGENT4CPP_LOG_INFO(message)                                      \
  ::agent4cpp::LogMessage(::agent4cpp::LogLevel::kInfo, __FILE__,        \
                          __LINE__, __func__, (message))
```

六个宏结构完全一样，只有级别不同（TRACE / DEBUG / INFO / WARN / ERROR / CRITICAL）。

用宏的原因很直接：普通函数拿不到"是谁调用了我"这个信息。`__FILE__` / `__LINE__` / `__func__` 是编译器预定义的，宏在预处理阶段就把它们替换成字面量了。所以日志里能看到 `[agent.cpp:58] [Reset]`——一眼定位到源码哪一行。

宏里有三个细节要注意：`::agent4cpp::` 前面那个 `::` 是从全局命名空间开始找，因为宏展开在用户的代码里，用户可能身处任意命名空间；`(message)` 外面套括号是防御性写法，万一传进来带逗号的表达式，不加括号会被宏的参数拆分搞错；反斜杠是对齐的续行符，除最后一行外每行都要有，且后面不能有空格。

### 2. 全局状态：log.cpp 里那三个 g_

```cpp
std::mutex g_log_mutex;                        // 锁
std::shared_ptr<spdlog::logger> g_logger;      // 真正干活的
LogLevel g_level = LogLevel::kInfo;            // 当前级别
```

全局变量通常是坏味道，但日志、内存分配器这个级别的工具是例外——它们本来就是全程序共享的基础设施。你不可能给每个类都配一个日志器，那样写日志还得先找到"该用哪个"。

`g_logger` 用 `shared_ptr` 是因为它要能被替换：`StartNewLogFile()` 会丢掉旧的、建一个新的，`shared_ptr` 会自动管理旧对象的销毁。

加锁用最简单的 `std::lock_guard`：

```cpp
void SetLogLevel(LogLevel level) {
  std::lock_guard<std::mutex> lock(g_log_mutex);   // ← 构造 = 加锁
  g_level = level;
}                                                   // ← 析构 = 解锁
```

日志操作很短（写一行文件），不需要提前解锁，`lock_guard` 足够。如果需要在中间手动解锁，那就得换成 `unique_lock`。

### 3. 日志写在哪：模块目录，不是工作目录

这是个我踩过的坑，结论是：日志必须写在"本模块（exe 或 dll）所在目录"，而不是当前工作目录。

Windows 没有"给我当前 dll 路径"的直接接口，只能反查：

```cpp
HMODULE module = nullptr;
const auto flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                   GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
if (GetModuleHandleExA(flags, reinterpret_cast<LPCSTR>(&ModuleDirectory),
                       &module) != 0) {
  char path[MAX_PATH] = {};
  const DWORD length = GetModuleFileNameA(module, path, MAX_PATH);
  if (length > 0 && length < MAX_PATH) {
    return std::filesystem::path(path).parent_path();
  }
}
```

拆开看是五步：取当前函数自己的地址 → 告诉系统"我给的是地址不是名字" → 系统反查这个地址属于哪个模块 → 拿着句柄问系统这个模块的文件在哪 → 取父目录。

`reinterpret_cast<LPCSTR>(&ModuleDirectory)` 看着吓人，其实只是把一个函数指针当成字符串指针传——API 要求的参数类型是 `LPCSTR`，系统靠那个 FLAG 知道该怎么解释它。

为什么不能直接用工作目录，看这张表：

| 启动方式 | 当前工作目录 | 模块目录 |
|---|---|---|
| 双击 exe | exe 目录 | exe 目录（一样） |
| 快捷方式启动 | 可能是别的地方 | exe 目录 |
| 被别的程序调起 | 调用者的目录 | exe 目录 |
| 命令行在别处执行 | 你当时所在的目录 | exe 目录 |

工业软件可能从任意位置启动。日志跟模块走，才能保证它永远在程序旁边，用户找得到。

路径拼接用 `std::filesystem`：

```cpp
const std::filesystem::path log_dir = ModuleDirectory() / "agent4cpp_log";
std::filesystem::create_directories(log_dir);
g_current_log_file = MakeLogFilePath(log_dir);
```

`path / "子目录"` 这个 `/` 运算符会自动处理 Windows 的反斜杠还是 Linux 的斜杠，比字符串拼接可靠。`create_directories` 能多层一起建，`create_directory` 只能建一层。

时间戳这样拼：

```cpp
std::ostringstream output;
output << std::put_time(&local_time, "%Y%m%d_%H%M%S") << "_"
       << std::setw(3) << std::setfill('0') << millis.count();
return output.str();
```

拼出来是 `20260924_153042_007`。用 `ostringstream` 而不是 `+`，是因为要拼数字（毫秒），`+` 处理不了，流可以自动处理各种类型。`setw(3)` + `setfill('0')` 让毫秒固定占 3 位，文件名长度一致、排序整齐。

### 4. 落盘时机：每条立刻 flush

造 logger 的时候有三个设置：

```cpp
std::shared_ptr<spdlog::logger> CreateLogger(const std::filesystem::path& log_file) {
  auto logger = spdlog::basic_logger_mt("agent4cpp", log_file.string(), true);
  logger->set_level(ToSpdlogLevel(g_level));
  logger->flush_on(spdlog::level::trace);
  logger->set_pattern("[%Y-%m-%d %H:%M:%S.%e] [%l] [%s:%#] [%!] %v");
  return logger;
}
```

`set_level` 做级别过滤，低级别的直接丢弃不写盘。`set_pattern` 决定每行长什么样：

```text
[%Y-%m-%d %H:%M:%S.%e] [%l] [%s:%#] [%!] %v
        ↑              ↑     ↑      ↑    ↑
      时间(含毫秒)    级别  文件:行号 函数名 内容
```

最值得讲的是 `flush_on(spdlog::level::trace)`。库的默认行为是：日志先写进内存缓冲区，攒够一批再落盘——快，但丢数据风险大。

改成每条立刻落盘，是因为工业软件可能崩溃退出：设备异常、驱动崩了、用户强杀进程。缓冲区里没落盘的日志，丢了就永远没了，而崩溃现场的日志恰恰是最有价值的。

代价是频繁 IO，比攒批慢。但日志量不大（一轮对话几十条），可以接受。这是典型的"可靠性 vs 性能"取舍，而且这里的答案很明确：**日志的价值全在事后能查到，丢了就等于没写。**

### 5. 一个命名约定：Locked

```cpp
void EnsureLoggerLocked() {
  if (g_logger != nullptr) {
    return;                          // 已经建好了，什么也不做
  }
  const std::filesystem::path log_dir = ModuleDirectory() / "agent4cpp_log";
  std::filesystem::create_directories(log_dir);
  g_current_log_file = MakeLogFilePath(log_dir);
  g_logger = CreateLogger(g_current_log_file);
}
```

这个函数确保 logger 已经建好，没有就建一个——这叫懒加载，第一次真要用的时候才建，程序启动快一点。

函数名结尾的 `Locked` 不是"这个函数会加锁"，而是"**调用这个函数之前，你必须已经持有锁**"。

为什么这么设计：建 logger 是"检查 + 创建"两步，必须原子完成，否则两个线程可能同时检查到"还没建"，然后各自建一个互相覆盖。但如果函数内部自己加锁，而调用方已经持有锁，就会死锁（`std::mutex` 不可重入，同一个线程重复拿同一把锁也会死锁）。所以约定：锁由调用方持有，这个函数只负责干活。

```cpp
void LogMessage(LogLevel level, const char* file, int line,
                const char* function, const std::string& message) {
  std::lock_guard<std::mutex> lock(g_log_mutex);   // ← 先加锁
  EnsureLoggerLocked();                             // ← 再调用
  g_logger->log(spdlog::source_loc{file, line, function}, ToSpdlogLevel(level),
                "{}", message);
}
```

所有 `AGENT4CPP_LOG_*` 宏最终都走到这里。`file` / `line` / `function` 是宏自动填的，`level` 是宏里写死的，`message` 是调用方写的。

这是个很实用的经验：看到函数名带 `Locked`、`Unlocked`、`NoLock` 这类后缀，就要去查它的调用前提。很多 C++ 项目都这么约定。

注意最后是 `log(..., "{}", message)` 而不是直接 `info(message)`。后者会把 message 当成格式串解析——如果 message 里恰好有 `{}` 或 `%s`，会被当成占位符，导致输出错乱甚至崩溃。用 `"{}"` 等于告诉库："这个是数据，不是格式"。日志内容来自用户输入或模型输出时，这是个很实用的安全习惯。

`StartNewLogFile` 里有个必须先做的动作：

```cpp
void StartNewLogFile() {
  std::lock_guard<std::mutex> lock(g_log_mutex);
  ...
  if (g_logger != nullptr) {
    spdlog::drop(g_logger->name());   // 先注销旧的
  }
  g_logger = CreateLogger(g_current_log_file);
  g_logger->info("new agent conversation log started");
}
```

必须**先 `drop` 再建新的**——spdlog 里同一个名字的 logger 只能注册一个，不先注销，新建会失败（抛异常）。

每轮对话开始时调一次，这样一次对话一个文件，出问题时直接看那次的文件，不用在几万行日志里翻。最后那句 `info` 在文件开头留个标记，让你打开文件能确认它是个有效日志，而不是空文件。

## 三、模型接口：怎么抽象成可换的

### 1. 三种助手，一个插口

想象你要雇一个助手，市面上有好几种：真助手（DeepSeek / OpenAI）联网、要钱、聪明、每次回答不一样；假助手（Mock）不联网、免费、按剧本演、回答固定；以后可能还有本地助手（比如 Ollama），跑在你自己电脑上。

你的程序不该关心用的是哪一种，它只关心一件事：**我给它一段对话记录 + 工具清单，它回我一段回复。**

所以定义一个统一插口：

```cpp
ChatResponse Chat(const ChatRequest& request);
```

不管什么助手，都得能插进这个口。有了它，Agent 那边的代码只写一遍，换助手只换实现类。

![一个插口，两种助手](/images/agent4cpp/lesson07-统一插口.svg)

没有这层会怎样？Agent 里会变成这样：

```cpp
class Agent {
  MockLLMClient* mock_;              // 如果用的是假助手
  // 或者
  OpenAICompatibleLLMClient* real_;  // 如果用的是真助手
};
```

然后到处是 `if (用的是假助手) ... else ...`。想加个本地助手？改 Agent 的代码。想测试？也得改代码。

加一层插口之后：

```cpp
class Agent {
  ILLMClient* llm_;      // ← 只认"插口"，不认具体是谁
};

// 用假助手：
agent.SetLLM(std::make_unique<MockLLMClient>());

// 用真助手：
agent.SetLLM(std::make_unique<OpenAICompatibleLLMClient>(config));
```

大白话：插口是插座，实现类是各种电器。墙上那个插座不管你插的是台灯还是电风扇，它只提供电；至于插上去之后干什么，那是电器自己的事。同一行 `llm_->Chat(...)` 一个字没改，插进去谁就调谁，行为跟着实现类变——这叫多态。

### 2. 怎么写出这个插口

```cpp
class AGENT4CPP_API ILLMClient {
 public:
  virtual ~ILLMClient() = default;
  virtual ChatResponse Chat(const ChatRequest& request) = 0;
};
```

`virtual` 表示"这个函数可以被子类改写"，`= 0` 表示"我不实现它，子类必须自己实现"（纯虚函数），`= default` 表示"用编译器自动生成的那个版本就行"。

因为有 `= 0`，这个类不能创建对象：

```cpp
ILLMClient client;   // 编译错误：cannot instantiate abstract class
```

它本来就不是拿来用的，是拿来当类型用的：

```cpp
std::unique_ptr<ILLMClient> client = std::make_unique<MockLLMClient>();  // 可以
```

`I` 开头是命名习惯，一眼看出这是个抽象类。

虚析构那两个字必须加：

```cpp
virtual ~ILLMClient() = default;
```

看这个场景：`client` 的静态类型是 `ILLMClient*`，实际指向的是 `MockLLMClient` 对象。销毁时，如果析构函数不是虚的，只会调 `~ILLMClient()`，`~MockLLMClient()` 被跳过，它里面的资源全泄漏；是虚函数才会先调子类再调基类，正确。

规则很简单：**只要一个类会被当基类用（有虚函数），析构函数就必须是虚的。** 忘了写不会编译报错，只会在运行时悄悄泄漏。

### 3. 几个工具类型

`std::optional` 用来表达"可能有，也可能没有"。消息里的"工具调用"字段大多数是没有的，用空字符串表达不明确（万一真的是空串呢），用 bool 标记又要同步维护两个字段。`std::optional<ToolCall>` 从类型上就说清了这件事：

```cpp
if (message.tool_call.has_value()) {   // 有
  auto& call = *message.tool_call;
}
if (!response.tool_call) {             // 没有（可以直接当 bool 判断）
  // 助手说完了
}
```

假助手用 `std::queue` 存台词。助手是一问一答的，把台词按顺序排队，每问一次取走队首，顺序不会乱（先进先出）。对照一下，栈是后进先出，适合撤销操作。

`override` 是让编译器帮你检查的：

```cpp
ChatResponse Chat(const ChatRequest& request) override;
```

作用就是告诉编译器"我这是在实现基类的那个纯虚函数"。假设你写错了签名（少个 `&`），没有 `override` 时编译器以为你定义了个新函数，基类的 `Chat` 还是纯虚的，你那个类依然不能实例化——报错信息很难懂。有 `override` 就会直接说"Chat 没有覆盖任何基类函数"。凡是覆盖基类的虚函数，都写上 `override`。

### 4. 六个角色

`llm_client.h` 里有六个类型：`ChatRole`（一条消息是谁说的）、`ToolCall`（助手说"我要调谁、传什么"）、`ChatMessage`（一条消息）、`ChatRequest`（一次请求）、`ChatResponse`（一次回复）、`ILLMClient`（那个统一插口）。

```cpp
enum class ChatRole {
	kSystem,     // 系统提示词，设定模型行为
	kUser,       // 用户消息
	kAssistant,  // 模型回复
	kTool,       // 工具执行结果
};
```

发给模型的是一个对话记录，里面混杂着多种角色的消息，模型靠这个字段理解"这句是谁说的"。一个完整的多步对话记录长这样：

```text
[system]    你是一个工业相机助手。
[user]      图像有点暗
[assistant] 我要调 get_camera_status          ← 助手要工具
[tool]      brightness=0.5, target=1.0        ← 工具执行结果
[assistant] 亮度确实偏低，我要调 set_exposure   ← 助手再要工具
[tool]      曝光已更新
[assistant] 搞定了，我把曝光调到 8000           ← 助手最终答复
```

`ToolCall` 三个字段：

```cpp
struct AGENT4CPP_API ToolCall {
  std::string id;
  std::string name;
  std::string arguments_json;
};
```

模型返回的是 `{"id":"call_abc","name":"set_exposure","arguments":"{\"exposure_us\":8000}"}`。`id` 是这次调用的编号，工具执行完要带上它，模型才知道这是哪次调用的结果（一次可能要调好几个工具）。`name` 去登记处找工具。

`arguments_json` 有个反直觉的地方：**它是一串 JSON 文本，不是对象**。模型吐出来的参数永远是文本，外层带引号，你的程序要自己 parse 它。

`ChatMessage` 五个字段：

```cpp
struct AGENT4CPP_API ChatMessage {
  ChatRole role = ChatRole::kUser;
  std::string content;
  std::string tool_call_id;
  std::optional<ToolCall> tool_call;

  // 思考模式模型（DeepSeek 的 reasoning 变体等）会返回这段推理文本，并要求在
  // 后续请求里把 assistant 消息的 reasoning_content 原样回传，缺失时服务端会在
  // 长对话中拒绝请求。
  std::string reasoning_content;
};
```

`role` 永远有；`content` 在用户说话、助手答复、工具返回说明时有；`tool_call_id` 只有 `role = kTool` 的消息才有；`tool_call` 只有助手要调工具时才有；`reasoning_content` 只有思考模型才有。最后这个 `reasoning_content` 是个大坑，我单独放在后面讲。

同一个 `ChatMessage`，按角色要拼成完全不同的形状——这就是 `MessageToJson` 那个函数在干的事：

![同一条消息，按角色写成不同形状](/images/agent4cpp/lesson09-消息形状.svg)

`ChatRequest` 只有两样东西，而且每轮都全量发送：

```cpp
struct AGENT4CPP_API ChatRequest {
  std::vector<ChatMessage> messages;   // 到目前为止的完整对话记录
  std::vector<ToolDefinition> tools;   // 这次对话有哪些工具可用
};
```

因为模型本身不记事儿——你问"图像有点暗"，它只知道这一句，之前聊过什么一概不知。所以每轮都要把从头到现在的所有消息重新发一遍。代价是 token 消耗大，这是无状态 API 的必然代价。

`ChatResponse` 是整个 Agent 循环终止条件的藏身之处：

```cpp
struct AGENT4CPP_API ChatResponse {
  Status status;
  std::string content;
  std::optional<ToolCall> tool_call;
  std::string reasoning_content;
};
```

`tool_call` 有值 → 执行工具 → 把结果塞回对话记录 → 再问一遍；没有 → 助手认为说完了 → 循环结束。程序里没有一行代码判断"任务完成了没"，全靠这个字段。

`ILLMClient` 整个类只有两个成员，都跟实现无关：虚析构保证用基类指针删除对象时子类清理代码也会执行，`Chat` 规定"必须能收请求、返回回复"。接口里只有一个方法，够窄——窄的好处是实现它的门槛低，想接一个新的模型服务，只要实现一个 `Chat` 函数就行。

### 5. 假助手

```cpp
class AGENT4CPP_API MockLLMClient : public ILLMClient {
 public:
  void PushResponse(ChatResponse response);
  ChatResponse Chat(const ChatRequest& request) override;
  [[nodiscard]] const ChatRequest& last_request() const;

 private:
  std::queue<ChatResponse> responses_;
  ChatRequest last_request_;
};
```

`: public ILLMClient` 读作"MockLLMClient 是一种 ILLMClient"。`PushResponse` 往剧本里加一条台词，调用方先调它几次把台词排好队；`Chat` 问一次答一次，把队首取出来；`last_request` 把最后一次收到的请求交出去，给测试断言用（`[[nodiscard]]` 和前面一样，返回值是结果本身，不看等于白调）。

为什么需要这个假助手，三个实际理由：演示不翻车（现场网络出问题是常见的雷），测试能写断言（真模型每次回答不一样没法测），零门槛（不用 Key、不用花钱、不用装 Python）。它还顺带能检测循环次数——台词准备少了会明确报错。

```cpp
void MockLLMClient::PushResponse(ChatResponse response) {
  AGENT4CPP_LOG_DEBUG("mock llm response queued content=" + response.content);
  responses_.push(std::move(response));   // 按值收进来，用完就扔，直接搬进队列省一次拷贝
}

ChatResponse MockLLMClient::Chat(const ChatRequest& request) {
  last_request_ = request;     // ① 先把这次请求存下来，给测试用
  ...
  if (responses_.empty()) {    // ② 剧本空了
    AGENT4CPP_LOG_ERROR("mock llm response queue is empty");
    return ChatResponse{
        Status::FailedPrecondition("mock response queue is empty"), "", {}};
  }

  ChatResponse response = std::move(responses_.front());   // ③ 取队首
  responses_.pop();                                        // ④ 出队
  return response;
}

const ChatRequest& MockLLMClient::last_request() const { return last_request_; }
```

重点看 ②。剧本空了怎么办？返回一个空响应的话，Agent 会以为"助手说完了"，循环悄悄结束，**错误被掩盖**。抛异常这个项目又不用。正确的做法是返回一个明确的错误状态 `Status::FailedPrecondition`，调用方立刻知道台词准备得不够。

什么时候会碰到剧本空了：你只准备了 2 条台词，但循环转了 3 轮——说明你对这个任务的流程理解有误。所以这其实是假助手的一个检测功能，它帮你发现循环次数和预期不符。

`last_request()` 返回引用而不是拷贝，因为假助手只在单线程测试里用，不会有并发问题。测试里很常见：

```cpp
// 断言：Agent 第二轮发给模型的请求里应该有 3 条消息
EXPECT_EQ(mock.last_request().messages.size(), 3);
```

## 四、真把信寄出去：libcurl

### 1. 一封信要装什么

发 HTTP 请求听着玄乎，其实就是四样东西：

```cpp
struct HttpRequest {
  std::string url;                             // 寄到哪
  std::map<std::string, std::string> headers;  // 信头
  std::string body;                            // 信的内容
  int timeout_ms = 60000;                      // 等多久算超时
};
```

用真实的模型请求举例：`url` 是 `https://api.deepseek.com/v1/chat/completions`；`headers` 里 `Authorization: Bearer sk-xxxxx` 证明你是谁、`Content-Type: application/json` 说明内容是 JSON；`body` 是 `{"model":"deepseek-chat","messages":[...],"tools":[...]}`；超时 60 秒。

headers 用 `std::map` 存，因为头是"名字: 值"的键值对、可能有多个，方便按名字查和遍历。

### 2. 两个状态字段，最容易搞混

```cpp
struct HttpResponse {
  Status status;          // 这次"寄信"成功了吗
  long status_code = 0;   // HTTP 状态码
  std::string body;       // 回信内容
};
```

这两个是两件事：`status` 回答"信寄到了吗"（传输层），失败原因是网络断了、DNS 解析不了、证书不对、超时；`status_code` 回答"对方回话说成没成"（应用层），信寄到了但对方说 401（Key 不对）、429（太频繁）、500（它自己崩了）。

![两种失败的区别](/images/agent4cpp/lesson08-两种失败.svg)

实测两种情况：

```text
情况 A：域名不存在
  status      = UNAVAILABLE: Could not resolve hostname
  status_code = 0            ← 压根没拿到回信

情况 B：请求一个 404 路径
  status      = UNAVAILABLE: HTTP request failed
  status_code = 404          ← 回信拿到了，对方明确拒绝
```

排查时这么用：`status_code == 0` 说明问题在网络或证书，跟模型服务无关，该查 DNS、代理、防火墙、CA 证书；`status_code` 是 4xx/5xx 说明网络是通的，问题在请求本身或对方服务，去看 `body` 里的错误详情。搞混这两个，排查时就会找错方向——明明是自己 Key 写错了，却去查网络。

### 3. libcurl 的 API 为什么"原始"

libcurl 是个用 C 写的网络传输库，`curl` 命令行工具就是它。它的用法是 C 风格的：

```c
curl_global_init(...);          // 1. 全局初始化
CURL* h = curl_easy_init();     // 2. 创建一个句柄
curl_easy_setopt(h, 选项1, 值);  // 3. 往句柄上挂一堆设置
curl_easy_setopt(h, 选项2, 值);
curl_easy_perform(h);           // 4. 执行
curl_easy_cleanup(h);           // 5. 清理句柄
```

`CurlHttpClient` 这个类的作用，就是把上面那套 C 流程包起来，对外只暴露一个 C++ 方法：

```cpp
HttpResponse PostJson(const HttpRequest& request);
```

使用者完全不用知道底下是 libcurl，哪天换成 WinHTTP，只要改这个 .cpp。

### 4. 回调："边收边给你"

回信可能很大（模型返回的 JSON 有几 KB），libcurl 不是"收完了再给你"，而是"收到一块给你一块"：

```c
size_t WriteBodyCallback(char* ptr, size_t size, size_t nmemb, void* userdata) {
  auto* body = static_cast<std::string*>(userdata);   // 拿回你自己传进来的东西
  const size_t bytes = size * nmemb;
  body->append(ptr, bytes);     // 把这一块追加进去
  return bytes;                 // 告诉 libcurl："这些我都收下了"
}
```

三个要点：签名不能改，参数顺序和类型都是 libcurl 规定的；`userdata` 是你通过 `CURLOPT_WRITEDATA` 挂上去的，这里拿回来（本项目传的是要拼的字符串）；返回值必须是"处理了多少字节"，如果不等于 `bytes`，libcurl 认为你出错了会中止传输。

`size * nmemb` 这么理解：libcurl 说"我给你 nmemb 个元素，每个 size 字节"。实际上几乎所有情况下 `size` 都是 1，但**不能假设**，规规矩矩相乘。`static_cast<std::string*>(userdata)` 是因为 `userdata` 是 `void*`，必须转回真实类型才能用——因为我们自己传的时候传的就是 `std::string*`，所以转回来安全。

### 5. 全局初始化用 RAII 管

`curl_global_init()` 和 `curl_global_cleanup()` 是整个程序一次的操作，不是每个请求一次。用一个结构体包起来，构造时初始化、析构时清理，就不会忘：

```cpp
struct CurlApi {
  CurlApi() {                      // 构造时初始化
    const CURLcode init_status = curl_global_init(CURL_GLOBAL_DEFAULT);
    ...
  }
  ~CurlApi() {                     // 析构时清理
    if (initialized) {
      curl_global_cleanup();
    }
  }
};
```

`initialized` 这个标志的作用是：初始化失败时，析构里不能再调 cleanup，没初始化就清理是未定义行为。

谁来构造这个结构体？用函数内静态变量：

```cpp
CurlApi* GetCurlApi() {
  static CurlApi api;      // ← 函数内的 static 变量
  return &api;
}
```

这行 `static` 干了三件事：只构造一次（第一次调用时构造，之后返回同一个）；C++11 起线程安全（多个线程同时第一次调到这里也只会创建一个，其余的会等）；程序退出时自动析构（全局清理自动完成）。这叫 Meyers Singleton，是 C++ 里最推荐的单例写法。

对比常见的错误写法：全局静态变量 `static CurlApi g_api;` 的问题是跨编译单元的初始化顺序不保证。放进函数里，第一次调用时才构造，顺序完全可控。

### 6. 第三个插口

```cpp
class AGENT4CPP_API IHttpClient {
 public:
  virtual ~IHttpClient() = default;
  virtual HttpResponse PostJson(const HttpRequest& request) = 0;
};
```

和助手那层一模一样的套路：虚析构、纯虚函数、只有一个方法。为什么不直接用 `CurlHttpClient`——留换实现的空间，以后换 WinHTTP，或者写个假 HTTP 客户端做单元测试，只要实现这个接口。

```cpp
class AGENT4CPP_API CurlHttpClient : public IHttpClient {
 public:
  explicit CurlHttpClient(CurlHttpClientConfig config = {});
  ~CurlHttpClient() override;
  HttpResponse PostJson(const HttpRequest& request) override;
 private:
  CurlHttpClientConfig config_;
};
```

两个语法点：`explicit` 禁止隐式转换，`CurlHttpClient c = config;` 编译不过，必须写 `CurlHttpClient c(config);`；`config = {}` 让参数可以省略，`CurlHttpClient client;` 就是默认配置。

### 7. PostJson 主流程

![libcurl 的七步流程](/images/agent4cpp/lesson08-curl流程.svg)

第 0 步确保全局初始化好了，失败就直接返回。第 1 步创建句柄，返回 nullptr 就报错。第 2 步准备请求头：

```cpp
headers = api->SlistAppend(headers, "Content-Type: application/json");
for (const auto& [name, value] : request.headers) {
  headers = api->SlistAppend(headers, (name + ": " + value).c_str());
}
```

`curl_slist` 是 libcurl 存 HTTP 头的单向链表（C 库的常见风格，方便逐个追加）。`Content-Type: application/json` 必须加，告诉服务端"我发的是 JSON"，否则它可能不认。

第 3 步把设置挂到句柄上：

```cpp
api->EasySetOpt(curl, CURLOPT_URL, request.url.c_str());
api->EasySetOpt(curl, CURLOPT_HTTPHEADER, headers);
api->EasySetOpt(curl, CURLOPT_POST, 1L);
api->EasySetOpt(curl, CURLOPT_POSTFIELDS, request.body.c_str());
api->EasySetOpt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(request.body.size()));
api->EasySetOpt(curl, CURLOPT_WRITEFUNCTION, WriteBodyCallback);
api->EasySetOpt(curl, CURLOPT_WRITEDATA, &response_body);
api->EasySetOpt(curl, CURLOPT_TIMEOUT_MS, request.timeout_ms);
api->EasySetOpt(curl, CURLOPT_USERAGENT, "agent4cpp/0.1");
```

四个选项有讲究：`CURLOPT_POSTFIELDSIZE` 显式给长度，因为 body 是 JSON 文本理论上可能含 `\0`，靠 `strlen` 会截断；`CURLOPT_WRITEDATA` 把要写入的字符串的地址传给回调；`CURLOPT_TIMEOUT_MS` 让网络卡住时不至于永远等；`CURLOPT_USERAGENT` 自报家门，有些网关会检查 User-Agent，空的话可能被拒。

这里有个 C 接口的经典陷阱：`curl_easy_setopt` 传的是指针，libcurl 不会立刻拷贝内容，而是等 `curl_easy_perform` 执行时才读，所以被指向的字符串必须活到那时候。

```cpp
api->EasySetOpt(curl, CURLOPT_URL, request.url.c_str());
//                                  ↑ request 是调用方传进来的引用，
//                                    生命周期覆盖整个函数，安全

headers = api->SlistAppend(headers, (name + ": " + value).c_str());
//                                   ↑ 这是个临时字符串！函数结束就销毁
//                                     但 curl_slist_append 会立刻拷贝，所以没问题
```

这就是 C 风格 API 难用的地方：得时刻想清楚"这个指针指向的东西能活多久"。

`EasySetOpt` 用了个模板：

```cpp
template <typename T>
CURLcode EasySetOpt(CURL* curl, CURLoption option, T value) const {
  return curl_easy_setopt(curl, option, value);
}
```

因为 `curl_easy_setopt` 的第三个参数类型随选项变化——有的要 `long`，有的要 `const char*`，有的要函数指针。C 语言靠可变参数糊弄，C++ 里用模板就能统一转发。

那串 `EasyXxx` / `SlistXxx` 方法看着多余，它们只是转发。包一层是为了将来想在测试里替换掉 libcurl（打桩）时，只改这一个结构体就够了。

第 4~6 步执行、取状态码、清理：

```cpp
const CURLcode perform_status = api->EasyPerform(curl);   // 真正寄出去
long status_code = 0;
api->EasyGetInfo(curl, CURLINFO_RESPONSE_CODE, &status_code);
api->SlistFreeAll(headers);     // 先释放头链表
api->EasyCleanup(curl);         // 再销毁句柄
```

第 7 步判断结果，对应前面说的两个字段：

```cpp
if (perform_status != CURLE_OK) {
  // ① 连传输都没成功
  const char* message = api->EasyStrError(perform_status);
  return HttpResponse{Status::Unavailable(message), status_code, response_body};
}
if (status_code < 200 || status_code >= 300) {
  // ② 传输成功，但对方说不行。response_body 还是带回去，
  //    因为错误原因通常写在里面
  return HttpResponse{Status::Unavailable("HTTP request failed"), status_code, response_body};
}
// ③ 一切正常
return HttpResponse{Status::Ok(), status_code, response_body};
```

注意第 ② 种情况把 `response_body` 也带回去了：虽然失败了，但对方返回的错误 JSON 里通常写着具体原因（"Invalid API key"之类）。丢掉它，排查时就抓瞎。

## 五、从假助手切到真模型

### 1. 它是个翻译官

出去把 C++ 翻译成 JSON，回来把 JSON 翻译成 C++。具体说，出去是把"用户的话 + 工具清单"打包成助手能读的东西寄出去；回来是把助手的话翻译回你的程序，并回答一个问题——它是想调工具，还是说完了？

### 2. 出去：每轮发两样东西

```cpp
nlohmann::json body{
    {"model", config.model},
    {"messages", std::move(messages)},      // ← 对话记录
    {"temperature", config.temperature},
    {"max_tokens", config.max_tokens},
};
if (!tools.empty()) {
  body["tools"] = std::move(tools);         // ← 工具清单
  body["tool_choice"] = "auto";
}
```

对话记录要**逐条按身份拼 JSON**，这是出去这一半唯一的难点。协议要求不同身份用不同格式：

```text
用户说的话：   {"role":"user",  "content":"图像有点暗"}

工具的结果：   {"role":"tool",  "tool_call_id":"call_1", "content":"亮度 0.5"}

助手要调工具： {"role":"assistant", "tool_calls":[{"id":"call_1",
                              "function":{"name":"get_camera_status","arguments":"{}"}}]}
```

三处关键差别：工具结果要带 `tool_call_id`，模型一次可能要好几个结果，得知道这条对应哪次请求；助手要调工具时多一个 `tool_calls`，这是它下指令的方式；`arguments` 是字符串不是对象，参数内容是模型生成的文本，服务端不保证它是合法 JSON，原样传。

`MessageToJson()` 的读法是：从上往下，每遇到一个 `return` 就想"哪些情况在这里就结束了"。

```cpp
if (message.role == ChatRole::kTool) { ... return object; }   // ← tool 消息在这结束
if (message.role != ChatRole::kAssistant) { return object; }  // ← user/system 在这结束
if (!message.tool_call.has_value()) { return object; }        // ← 助手只说话，这结束
// 走到最后的，就是"助手要调工具"
```

工具清单直接复用前面工具那篇写好的 `BuildOpenAIToolSchema`，不用重新造。拼好之后交给 HTTP 层寄出去：

```cpp
http_request.url = TrimTrailingSlash(config_.base_url) + "/chat/completions";
http_request.body = BuildChatRequestBody(config_, request).dump();
http_request.headers["Authorization"] = "Bearer " + std::string(api_key);
http_request.headers["x-opencode-session"] = RoutingSessionId();
const HttpResponse http_response = http_client_->PostJson(http_request);
```

### 3. 回来：两种可能，都算成功

这是这一节最重要的一句话：

```text
可能一：助手想调工具  →  {"tool_calls":[...]}   ─► 循环继续
可能二：助手说完了    →  只有 {"content":"..."}  ─► 循环结束
```

程序怎么分辨——看回复里有没有 `tool_calls`。有，`tool_call` 字段就有值；没有，字段是空的。

**注意这两种情况状态都是"成功"**。"没要工具"不是错误、不是失败，它就是助手在说"我说完了"。程序里绝不能把它当成异常处理。

```cpp
const Status tool_status = ParseToolCall(message, &tool_call);
if (tool_status.ok()) {
  return ChatResponse{Status::Ok(), content, std::move(tool_call), reasoning};  // 有工具
}
// 没有工具调用不是错误 —— 助手说完了，循环该结束
return ChatResponse{Status::Ok(), content, std::nullopt, reasoning};            // 没工具
```

两行的 status 都是 `Status::Ok()`。回来的逻辑就这么点：

```text
模型返回一大坨 JSON
        │
        ├─ 能解析吗？──────── 不能 ─► 返回失败
        │
        ├─ 里面有没有 tool_calls？
        │       │
        │       ├─ 有 ─► 抠出来（调谁、传什么）─► 返回「要调工具」
        │       │
        │       └─ 没有 ─► 返回「说完了」，content 就是它的答复
        │
        └─ 顺手把推理内容也带上
```

`ParseToolCall()` 里有个值得知道的步骤：提前验证 `arguments` 是不是合法 JSON。模型偶尔会输出不合法的参数（截断的 JSON、或者直接给个数字），在源头验掉比执行时才炸好得多。验证失败也不抛出终止——返回错误状态，上层会回灌给模型让它自己改。

### 4. 实测

下面是 `lab_openai.exe` 打真实服务跑出来的完整往返——C++ 结构 → JSON → 网络 → JSON → C++ 结构：

![一次真实的往返（实测数据）](/images/agent4cpp/lesson09-真实往返.svg)

```text
发给模型：
  消息数 = 2（系统提示 + 用户说"the image looks a bit dark"）
  工具数 = 2（get_camera_status + set_exposure）

模型回复：
  content = I'll check the current camera status to see the exposure settings.
  reasoning_content = The user says the image looks a bit dark. I should check
                      the camera status first...（推理内容，要回传）
  要调工具！ name = get_camera_status   arguments = {}
```

这段输出证明整条链路通了：模型看懂了工具清单，才知道要调 `get_camera_status`（翻译对了）；用户的话和工具都送到了（打包对了）；`tool_call` 被准确抠出来了（拆包对了）；网关头有效，否则请求直接被拒；推理内容也确实拿到了。模型的行为完全符合预期：用户说"图像暗" → 模型想"我得先查一下相机状态" → 要调 `get_camera_status`。

关于"兼容"：DeepSeek、通义、本地 Ollama 都模仿了 OpenAI 的接口格式，所以同一份代码改两个字段就能换服务商。类名叫 `OpenAICompatible` 而不是 `OpenAI`，就是这个意思。API Key 从环境变量读，不落盘、不进仓库。`temperature` 设成 0.2，工业场景要决策稳定，不能忽左忽右。

## 六、我踩过的坑

这一节比上面的代码更值得看，都是我自己撞上去的。

**相对路径在桌面程序里是个陷阱。** CA 证书配置的是相对路径，默认相对当前工作目录解析。从 `bin` 目录双击运行没问题；但从仓库根执行 `bin\agent4cpp_openai_camera_cli.exe`，工作目录就变成仓库根了，找不到 `curl-ca-bundle.crt`，libcurl 报 `Problem with the SSL CA cert (path? access rights?)`。我改成强制相对模块所在目录解析，用 `GetModuleHandleExA` 反查模块路径——和日志文件是同一个套路。教训是：**工作目录不由你控制，用相对路径之前先问它相对谁。**

**日志写在当前工作目录，用户找不到。** 同一个道理。工业软件可能从任何位置启动——双击、快捷方式、被别的程序调起、命令行在别处执行。日志必须固定在程序旁边。

**`reasoning_content` 忘了回传。** 前三轮好好的，第四轮突然 400，查了半天才发现是这个。原因是思考模型返回的 `reasoning_content` 必须在后续请求里原样发回去，而服务端在短对话里不校验，所以漏传不会立刻暴露，对话一长每个请求都开始拒绝。教训：**接大模型不是调通一次就完事，有些约束只在长对话里才生效。**

**网关的路由标识头，文档里不写。** 我用的网关地址是 `https://opencode.ai/zen/go/v1`，这类网关要求每个请求带一个 `x-opencode-session` 的头，不带就报错，而这类要求通常只能靠抓包或者试出来。处理办法是无脑带上——对不认识这个头的服务（OpenAI 官方、DeepSeek 官方），HTTP 协议规定未知的头字段直接忽略，没有副作用。这和上面那条是同一类坑：**换个服务才暴露，短对话测不出来。**

**spdlog 同名 logger 不先 drop 会抛异常。** `StartNewLogFile` 里必须先 `spdlog::drop(g_logger->name())` 再建新的，因为同一个名字只能注册一个。

**日志内容直接 `info(message)` 会出事。** 那条路径把 message 当成格式串解析，内容里恰好有 `{}` 或 `%s` 就会被当占位符，输出错乱甚至崩溃。改用 `log(..., "{}", message)`，明确告诉库"这是数据"。日志内容来自用户输入或模型输出时尤其要注意。

**锁的命名约定看不懂会死锁。** `EnsureLoggerLocked` 名字里的 `Locked` 是"调用前你必须已持锁"，不是"这个函数会加锁"。建 logger 的"检查 + 创建"必须原子完成，但如果函数内部自己加锁而调用方已经持锁，`std::mutex` 不可重入就会死锁。所以约定锁由调用方持有。看到 `Locked` / `Unlocked` / `NoLock` 这类后缀，先去看它的调用前提。

**虚析构忘了写 `virtual`。** 不会编译报错，只在运行时悄悄泄漏子类的资源。只要一个类会被当基类用，析构函数就必须是虚的。

**剧本空了返回空响应，会把错误掩盖掉。** Agent 会以为"助手说完了"，循环悄悄结束。改成返回明确的 `Status::FailedPrecondition`，调用方立刻知道台词准备得不够——这反而让假助手变成一个检测工具。

**`-lcurl` 链接失败。** 报 `lld-link: error: could not open 'curl.lib'`。因为 clang 用的 MSVC 链接器按 Windows 惯例找 `curl.lib`，而我们的库是 MinGW 格式的 `libcurl.dll.a`。改成直接写库文件路径就行了。

**`curl_easy_setopt` 传的是指针，库不会立刻拷贝。** 得等 `curl_easy_perform` 执行时才读，所以被指向的字符串必须活到那时候。临时字符串 `(name + ": " + value).c_str()` 看着危险，但 `curl_slist_append` 会立刻拷贝，所以没事；`request.url.c_str()` 安全是因为 `request` 是引用，生命周期覆盖整个函数。这类地方得逐个想清楚。

**默认攒批落盘会在崩溃时丢日志。** 库默认先写内存缓冲区，攒够一批再落盘。工业软件可能被强杀，缓冲区里没落盘的日志就永远没了——而崩溃现场的日志恰恰最有价值。所以设成每条立刻 flush，用一点 IO 性能换可靠性。

这几条里，最像"只有真做过才会知道"的，是相对路径那条和 `reasoning_content` 那条。它们的共同点是：**在本机跑得好好的，换个启动方式或者对话变长，问题才冒出来。**

至于那三张对照表——日志接口为什么用宏、日志为什么跟模块目录走、为什么自己做一套级别翻译——前面正文里都讲过了，这里不再重复。
