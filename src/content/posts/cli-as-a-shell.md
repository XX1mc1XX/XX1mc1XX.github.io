---
title: CLI 只是个壳
description: "终端界面只是个壳。看懂界面层与内核层那道边界，就知道换成 Qt 窗口要动哪三处、哪一行都不用动。"
pubDate: 2026-10-04
tags: [C++, CLI, Qt, 架构设计]
---

前面几篇讲的全是"内部"：工具怎么注册、模型怎么接、循环怎么转。但用户总得有个地方敲字。这一篇讲那个地方——`interactive_cli.cpp`。

回顾一下链路：用户说一句话，这句话先被送进 Agent 的循环，循环去问模型、执行工具、把结果塞回去，转几圈之后吐出一段答复。**但"这句话从哪来、答复往哪去"，循环本身是不管的。** 那个"哪来"和"哪去"，就是这一篇的主角。

我把这篇放在这个位置，是因为它有个特殊身份：它是整套框架里**唯一一个零依赖的界面实现**，一个终端版。它本身没什么技术含量，但它划出了一条线——**哪些代码属于"界面"（会随环境换掉），哪些属于"内核"（永远不动）**。这条线才是这一篇真正要讲的东西。

因为我们这个项目是做工业软件的（Qt、上位机），把这条线画清楚了，你就知道把终端换成 Qt 窗口时该动哪几处、不该动哪几处。我不想骗你，CLI 本身你不会用——但它是那本"参考实现"，是照着画 Qt 界面的底稿。

## 它做的事，朴素到三行

```text
打印欢迎语
while (true) {
    读一行用户输入
    是命令（help/clear/history/exit）→ 自己处理
    否则 → 丢给 Agent::Run，把回复打出来
}
```

就这么点。整个文件大部分是在填那些琐碎的边角——终端编码、颜色、命令词解析。真正属于"界面逻辑"的只有主循环那几十行。

## 最反直觉的一点：它不读 cin/cout

这一点跟我一开始的直觉是反的。

`Run` 的签名是：

```cpp
Status InteractiveCli::Run(std::istream& input, std::ostream& output);
```

**参数是流，不是标准输入输出本身。** 读的时候用传进来的 `input`，写的时候用传进来的 `output`，`std::cin` / `std::cout` 在实现里一次都没出现。

我最初写的时候是直接 `std::getline(std::cin, line)`、直接 `std::cout << ...`，看着天经地义——"这是命令行程序，不读标准输入读什么"。后来要写单元测试才发现问题：测试里没有人在键盘前敲字，`std::cin` 会一直等，整个测试挂死。

改成流参数之后，测试里传两个假的就行：

```cpp
std::istringstream fake_input("image is dark\nexit\n");   // 假输入：喂进去
std::ostringstream fake_output;                          // 假输出：抓出来
cli.Run(fake_input, fake_output);
EXPECT_NE(fake_output.str().find("assistant"), std::string::npos);
```

`istringstream` 把一串预先写好的文本当输入，`ostringstream` 把本该打屏的内容收进一个字符串。整条 CLI 逻辑——包括命令识别、编码处理——就都能在没人敲键盘的情况下跑完、还能断言。

这件事的意义超出"方便测试"。它说明**这个类的职责是"处理输入、产出输出"，不是"拥有终端"**。终端只负责给它喂和接。理解这一点，后面换成 Qt 就顺了：Qt 的输入框也是"喂进来"，信号槽也是"接出去"，换的只是那个喂和接的管道。

## 命令处理：/help 为什么不写死一张表

主循环里，非命令的输入才交给 Agent，命令走另一条路：

| 输入 | 干什么 |
|---|---|
| `help` / `/help` / `?` | 从登记处**现读**工具清单 + 命令表 |
| `clear` / `cls` / `reset` | `agent.Reset()` 清空对话记录 + 清屏 |
| `history` / `ctx` | 显示当前对话记录有几条 |
| `exit` / `quit` / `q` | 退出 |
| 其他 | 丢给 `Agent::Run` |

`/help` 那张表，我一开始的想法是"写死一个字符串数组，好维护"。后来发现这是个坑：写死的表和你实际注册的工具是**两份各自独立的数据**——你注册了个新工具，忘了改表，`/help` 就开始骗人，而且这种脱节能潜伏很久。

所以改成从 `ToolRegistry` 现读：

```cpp
const std::vector<ToolDefinition> tools = registry->ListTools();
for (const ToolDefinition& tool : tools) {
  output << "  " << Color(config, kGreen, tool.name) << "\n";
  output << "      " << Color(config, kDim, tool.description) << "\n";
  ...
}
```

**只有一份数据，就不会对不上。** `/help` 回答的是"这个 Agent 现在能干什么"，不是背一张开场就念过的键位表。

命令词的识别有个小工序叫 `NormalizeCommand`：把 `"  /Help "` 规整成 `"help"`——去两头空白、全转小写、去掉开头的 `/`。规整一次，后面所有 `if` 就都不用管大小写和斜杠了。

```cpp
std::string NormalizeCommand(std::string line) {
  line = ToLower(Trim(std::move(line)));
  if (!line.empty() && line.front() == '/') {
    line.erase(line.begin());
  }
  return line;
}
```

不这么写会怎样：每个 `if` 都得写成 `command == "help" || command == "/help" || command == "HELP" || command == "/HELP"`，组合爆炸。规整是"把一堆变体收敛成一个规范形"，这个套路哪儿都能用。

## 那些终端专有的琐碎

从"界面层"那个视角看，CLI 里有几段代码是**纯粹为终端环境服务**的，换成 Qt 之后一段都用不上。我把它们列出来，不是要你记住实现，而是要你认出"这一整类东西都属于壳，不属于内核"。

**编码转换。** Windows 中文控制台默认是 GBK（代码页 936），用户敲的中文到程序里是 GBK 字节，而模型只吃 UTF-8。所以进 Agent 之前得先统一：

```text
控制台编码字节 --MultiByteToWideChar--> 宽字符 --WideCharToMultiByte(CP_UTF8)--> UTF-8
```

两步转换中间绕一次宽字符，是因为 Windows 的编码 API 都以宽字符为中转。这里有个**必须先判断的地方**：

```cpp
std::string ConvertConsoleInputToUtf8(const std::string& line) {
  if (line.empty() || IsValidUtf8(line)) {
    return line;          // 已经是 UTF-8，原样返回，绝不二次转换
  }
  ...
}
```

`IsValidUtf8` 是手写的一段校验：首字节 `<= 0x7F` 是单字节、`110xxxxx` 是两字节、`1110xxxx` 是三字节（中文多半是这种）、`11110xxx` 是四字节（emoji），后续字节必须都是 `10xxxxxx`，任何一步不满足就不是合法 UTF-8。规则看着多，其实就是照 UTF-8 的编解码表抄了一遍。

**颜色。** 打印用的是 ANSI 转义序列，比如 `\033[36m` 是青色、`\033[0m` 是复位。终端认这些序列就变色，不认就打出一堆乱码字符。所以启动时得先开启虚拟终端处理：

```cpp
SetConsoleOutputCP(CP_UTF8);                    // 输出也走 UTF-8
mode |= ENABLE_VIRTUAL_TERMINAL_PROCESSING;     // 让上面的颜色码生效
SetConsoleMode(output, mode);
```

`Color()` 这个小函数负责把文字套上颜色码，`use_color` 关掉就直接返回原文——**颜色是个纯装饰，任何情况下都不该影响功能**。

**清屏。** `clear` 命令打印的是 `\033[2J\033[H`（清屏 + 光标回左上角），又是一个终端专有序列。

这三样，Qt 里一样都不需要：Qt 内部就是 UTF-16，不存在 GBK 转码；颜色用 QSS 样式表，不碰转义序列；清屏是清空某个 widget，不是往输出流里写字。**它们的存在恰好反证了那条边界**——凡是"为了让文字在某种特定终端里正常显示"的代码，都归界面层。

## 为什么这个壳值得单独写一篇

你可能会想：一个终端界面有什么好讲的，不就是个 `while(getline)` 吗。

我写这篇有两个理由。

一是**它是最小的完整参考实现**。要把内核接出去用，最少需要哪些东西？这个类回答了：取输入、判命令、调 Agent、显示结果。你照着它写 Qt 版本，把每一块替换成 Qt 的对应物，就是一个能用的界面——不需要重新想架构。

二是**它证明了边界是真实存在的，不是嘴上说说**。一套设计如果只写了一个界面，你没法知道哪些代码是"壳"；只有当你（或我）真的写了第二个完全不同的界面，才知道内核那部分到底有没有被界面污染。CLI 和 Qt 这两版放在一起看，右边那列一行没动——这就是分层的证据。

所以我一直把 CLI 定位成"底稿"，而不是"给用户用的东西"。它的价值不在运行，在**回答"换一个界面要动哪里"这个问题**。

## 界面层与内核层：那条线在哪

这是这一篇的核心。我把整个系统按"会不会随环境换掉"切成两半：

| | 属于界面（壳） | 属于内核 |
|---|---|---|
| 输入 | `std::getline` 读键盘、Qt 的 `QLineEdit` | `Agent::Run(text)` 收一个字符串 |
| 输出 | `std::cout`、`QTextEdit::append` | `AgentResponse.content` / `.status` |
| 编码 | 控制台 GBK → UTF-8、Qt 天然 UTF-16 | 只认 UTF-8 |
| 颜色/样式 | ANSI 转义码、QSS 样式表 | 完全不知道 |
| 命令词 | `help`/`clear`/`exit` | `Agent::Reset()` 这个动作 |
| 提示符 | `"agent4cpp > "` | 无关 |

![界面层与内核层的边界](/images/agent4cpp/lesson13-界面边界.svg)

左边这一列，**全都只服务于"怎么跟人交换文字"**，换成 Qt 就整列重写。右边这一列是纯逻辑，一行都不用动。

这条线是怎么做到的？关键就一个签名：

```cpp
AgentResponse Agent::Run(const std::string& user_input);
```

**输入是一个字符串，输出是一个结构体。** 没有 stream、没有窗口句柄、没有编码、没有颜色。内核同一个接口，谁都能接——这正是分层的好处。

## 换成 Qt 要动哪几处

现在说这篇文章你可能最想看的部分。把终端换成 Qt 窗口，要动的就三处，一处不多。

| # | 改哪儿 | CLI 里是什么 | Qt 里换成什么 |
|---|---|---|---|
| 1 | 取输入 | `std::getline(input, line)` | `QLineEdit::text()` / `QTextEdit::toPlainText()` |
| 2 | 跑 Agent | `agent_->Run(text)` | `agent_->RunAsync(text)`（**必须异步**） |
| 3 | 显示回复 | `output << response.content` | 结果好了往聊天面板里 append |

第 1 处和第 3 处是纯替换，没什么好说的。真正有讲究的是第 2 处，以及"异步结果怎么回到界面"这一段——因为 CLI 是同步阻塞的写法，直接搬到 Qt 会出事（见后文坑一）。

Qt 那边的骨架大概是这样：

```cpp
// 用户回车
const std::string text = ui->input->text().toStdString();
auto future = agent_->RunAsync(text);              // 立刻返回，界面不冻结

// 轮询等结果（也可以用 QFutureWatcher，避免定时器）
auto* timer = new QTimer(this);
connect(timer, &QTimer::timeout, this, [=]() mutable {
  if (future.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) {
    appendToChatPanel(QString::fromStdString(future.get().content));
    timer->stop();
  }
});
timer->start(100);
```

注意 `RunAsync` 的返回类型是 `std::future<AgentResponse>`，`wait_for(0ms)` 是"看一眼好了没，不阻塞"。定时器每 100ms 问一次，好了就把 `future.get()` 的内容贴进面板。这段代码里没有一行碰 CLI。

**为什么必须异步**——这是我在这篇里最想说清楚的一件事。CLI 里同步阻塞毫无问题：终端程序阻塞了，最坏结果就是"打完字之后十几秒才出下一行提示符"，用户知道它在转（我们还专门打了一行 `thinking...`）。但 Qt 完全是另一回事。

![同步 Run 冻住界面 vs 异步 RunAsync](/images/agent4cpp/lesson13-同步异步.svg)

同一段时间轴，两行的差别：

```text
同步 Run：
  0s    用户回车，主线程进 agent->Run()
  0s ────────────────────────────────────────► 16s  主线程一直卡在 Run 里
        这 16 秒里：窗口不重绘、按钮不响应、标题栏变灰"未响应"
  16s   终于返回，窗口一口气刷新

异步 RunAsync：
  0s    用户回车，RunAsync 立刻返回一个 future，主线程空出来
  0s    显示"思考中…"，主线程回到事件循环
  0s-16s 主线程每 100ms 被定时器叫一次："好了没？" → 没好，继续等
  16s   定时器发现 future ready → future.get() → 把回复贴进面板
```

关键差别不在"快慢"——两边总耗时一样。差别在**主线程有没有被占住**。Qt 把重绘、鼠标、键盘、定时器全部编在主线程的事件队列里；主线程一旦进 `Run` 不出来，这个队列就停止消费，界面表现为"死了"。所以这里不是"同步慢一点"，是**同步在 Qt 里根本就是错的**。

至于 `Agent` 内部怎么保证 `RunAsync` 和 `Run` 不打架（它俩会争同一份 `messages_`），那是另一篇的事——界面这一层只需要知道"用异步的就行"。

## CLI 自己怎么"借用" Agent

还有一处接口设计值得看，虽然跟 Qt 关系不大，但体现了同一种思路。

```cpp
class InteractiveCli {
 private:
  InteractiveCliConfig config_;
  Agent* agent_;        // 裸指针：不拥有 + 可空
};
```

构造函数把 Agent 存成一个**裸指针**。为什么不用 `unique_ptr`——因为 CLI **不拥有**这个 Agent，它只是"借来用"。按生命周期，宿主程序先建 Agent、再建 CLI，CLI 用完之前不能销毁 Agent：

```cpp
Agent agent(std::move(config), &registry);
InteractiveCli cli(cli_config, &agent);   // 只传地址，不转移所有权
cli.Run(std::cin, std::cout);             // 也可以传假流
```

这和前面 `Agent` 里 `registry_` 是裸指针是**同一个理由**：不拥有 + 可空，只有裸指针同时表达这两层语义。`unique_ptr` 会说"我负责销毁它"，那是假话；引用会说"它一定不为空"，但 CLI 允许没有 Agent（那样构造后 `Run` 直接返回 `InvalidArgument`）。

`Run` 一进来就先查这个指针：

```cpp
if (agent_ == nullptr) {
  return Status::InvalidArgument("agent is null");
}
```

早检查的好处，跟循环那篇说的一样：**出错现场留在调用方那一侧**，而不是等转到一半空指针崩在深处。

## 可测试性是设计出来的，不是补出来的

前面反复提"因为要能测"。把这件事收个尾，说清楚它到底买到了什么。

那个 `Run` 的流参数看起来只是换了个写法，实际它把 CLI 从"必须开一个真终端"变成了"一个纯函数式的处理过程"——给它两个流，它读、它写、它返回 `Status`，中间不碰任何全局状态（`std::cin` 就不是全局状态吗？是，所以能规避）。

于是这几类东西全都能测：

| 要测的边角 | 怎么喂进去 |
|---|---|
| 空行跳过 | 输入 `"\n\nhelp\n"`，断言不崩、命令照常识别 |
| 大小写/斜杠 | 输入 `"  /HELP "`，断言输出里有工具清单 |
| BOM 粘连 | 输入 `"\xEF\xBB\xBF/help\n"`，断言命令仍被识别 |
| 退出 | 输入 `"exit\n"`，断言 `Run` 返回 `Status::Ok()` |
| 输入流结束 | 输入流直接空，断言正常返回而不是错误 |

这五条里，**BOM 那条和"输入流结束"那条，人在终端里基本不可能手动复现**——BOM 是你用管道喂文件时才有的，"输入流结束"是你按 Ctrl+Z 才有的。它们就是靠这些测试兜住的。这也是为什么我把 `Run` 写成流参数：**不是为了好看的架构，是为了这些坑能被自动化测出来。**

## 我踩过的坑

**界面上用了同步 `Run`，窗口冻住。** 最早我写的 Qt 版本是 `auto r = agent->Run(text);`，模型一思考十几秒，这十几秒里窗口完全没反应，标题栏变灰、显示"未响应"。我一开始以为是 Qt 卡了，排查半天才发现是主线程被 `Run` 占着。**症状是"界面冻住"，原因是"阻塞调用跑在 UI 线程上"**——这类问题在终端里永远遇不到，因为终端程序阻塞了也只是不打印，不会"失去响应"。换成 `RunAsync` + 定时器轮询才好。

**管道输入开头的 BOM，把 `/help` 变成了乱码命令。** 用 `app < in.txt`、脚本或 CI 喂输入时，工具链可能在文件开头写三个看不见的字节 `EF BB BF`（UTF-8 BOM）。BOM 会粘在第一个词上，`"/help"` 实际变成 `"\xEF\xBB\xBF/help"`，命令匹配失败——**用户敲了没反应，而且肉眼看不出为什么**。更糟的是如果不剥掉，BOM 会当成正文发给模型。修法是进任何解析之前先剥：

```cpp
std::string StripUtf8Bom(std::string value) {
  constexpr char kUtf8Bom[] = "\xEF\xBB\xBF";
  if (value.size() >= 3 && value.compare(0, 3, kUtf8Bom) == 0) {
    value.erase(0, 3);
  }
  return value;
}
```

顺序不能反——BOM 在开头，不先剥掉，后面的 `Trim` 也不认识它。这个坑我在本机手动敲字时从没遇到过，只有用管道喂输入才冒出来。

**中文控制台输入乱码。** Windows 中文控制台默认是 GBK（代码页 936），用户敲的中文到程序里是 GBK 字节，而模型只吃 UTF-8。修法是判断"是不是已经是合法 UTF-8"，不是才按控制台代码页转。**关键是先判断再转**——我最早是无脑转，结果本来就是 UTF-8 的输入又被转了一次，变成更乱的码。

**ANSI 颜色码在某些终端里是乱码。** 我打的是 `\033[36m` 这种转义序列，终端得先开启"虚拟终端处理"才认识它。Windows 上不调 `SetConsoleMode(..., ENABLE_VIRTUAL_TERMINAL_PROCESSING)`，那些颜色码就会被原样打出来，屏幕上是一堆 `←[36m`。修法是在启动时打开这个模式——**而且这两步失败也不致命**，大不了没颜色，所以失败就静静返回，不中断程序。

**`/help` 写死工具表，和实际注册的对不上。** 前面说过了，这是"两份数据"的经典问题。改成从登记处现读之后，这个脱节就不可能发生了。

## 几个我当时犹豫过的设计

**要不要复用 CLI 到 Qt 里。** 犹豫过，最后答案是**不复用**。CLI 里所有东西——`istream`、ANSI 码、BOM 处理——都是"终端专用"的。Qt 不需要 `istream`（输入框直接给字符串），不需要 ANSI 码（用样式表），也不需要 BOM 处理（Qt 内部是 UTF-16，管道那套不适用）。硬要复用的结果是两边都别扭。**真正该复用的是接口，不是实现**：同一个 `Agent::Run` / `RunAsync`，两种壳各自调用。

**主循环写成 `while(true)`，退出靠 `return`。** 也可以用 `bool running = true; while (running)` 来控制。我选了 `while(true)` + 直接 `return Status::Ok()`，因为退出点有好几个（用户敲 exit、输入流结束），用 `return` 一眼能看出"到这里就出去了"，用标志位还得往下走完一圈才知道。代价是如果有清理代码，每个 `return` 前都得写一遍——不过这里没有清理代码，所以这个代价为零。

**输入流结束算不算异常。** `std::getline` 返回 `false` 表示输入流结束（Ctrl+Z、或者管道喂完了）。我一开始把它当错误处理，后来想通了：**这是正常的退出方式**，管道场景下它就是"我们说完了"，返回 `Status::Ok()` 才对。当成错误的话，所有用管道的地方都会收到一个假的失败。

## 停在哪

这个类就停在"壳"这个位置上。它不碰模型、不碰工具、不碰循环，只回答两个问题：**用户说了什么**、**Agent 说了什么**。

它的价值不在代码本身，在它示范的那条线——**内核收字符串、吐结构体，界面负责把字符串从某个地方拿来、把结果送到某个地方去**。想清楚了这条线，终端换成 Qt、换成 Web、换成任何东西，都是照葫芦画瓢。

下一篇全篇收口，讲测试怎么覆盖这些边角——尤其是刚才那些"人在键盘前永远不会遇到、只有喂输入才会遇到"的坑，就是靠测试兜住的。
