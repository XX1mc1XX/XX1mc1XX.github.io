---
title: Agent 框架的骨架与错误码
description: "整套框架的零件图，以及为什么错误码值得单独设计一套——选错错误码，调用方就分不清该重试还是该修 bug。"
pubDate: 2026-10-01
tags: [C++, LLM, Agent, 架构设计]
---

这一篇讲两件事：先把这个框架整体长什么样讲清楚，再讲真正要动手写的第一段代码——怎么统一表达"出错了"。

顺序不能反过来。错误码这东西，单独看只是几个枚举值，没什么意思；只有先知道它会被放在链路的哪一环、会被谁接住，才知道它为什么必须长成那个样子。

## 这个框架解决什么问题

工业软件（相机控制、运动控制、视觉检测）里已经躺着大量稳定的 C++ 函数：

```cpp
camera.setExposure(8000);
camera.getStatus();
light.setBrightness(0.8);
stage.moveTo(x, y);
```

用户想用这些功能，现在的办法是翻菜单、点按钮、填参数表。

引入大模型之后，可以多一个入口——自然语言：

```text
用户："图像有点暗，帮我调一下。"
```

要让这句话最后真的变成 `camera.setExposure(8000)`，中间需要一条完整的链路。`agent4cpp` 就是把这条链路做成一个可复用的 C++ 库。

## 一次真实的运行

我在参考项目里跑了一遍 Mock 演示，输入 `image is dark`，日志原样是这样的：

```text
user input: image is dark
agent step 1 started
assistant requested tool name=get_camera_status arguments={}
tool result name=get_camera_status status=OK
     payload={"exposure_us":5000.0,"brightness":0.5,
              "brightness_target":1.0,
              "brightness_scale":"0.0=black, 1.0=correct exposure, >1.0=overexposed",
              "assessment":"underexposed"}
agent step 2 started
assistant requested tool name=set_exposure arguments={"exposure_us":8000}
tool result name=set_exposure status=OK payload={"exposure_us":8000.0}
agent step 3 started
assistant final answer: Done. Exposure is now adjusted for a brighter image.
```

拆开看，循环转了三圈：

| 圈 | 模型做了什么 | C++ 做了什么 |
|---|---|---|
| 第 1 圈 | 说"我要调 `get_camera_status`" | 真的执行了查状态函数，返回亮度 0.5 |
| 第 2 圈 | 看到亮度 0.5、目标是 1.0，说"我要调 `set_exposure`，参数 8000" | 真的把曝光改成了 8000 |
| 第 3 圈 | 说"调完了"（**没有再要工具**） | 循环结束，返回这句话 |

完整的链路是这样：

```text
用户自然语言
  -> Agent::Run
  -> ILLMClient::Chat  ────────────► 大模型
                                       │
       ┌───────────────────────────────┘
       │  模型返回 tool_calls: {"name":"set_exposure","arguments":"{\"exposure_us\":8000}"}
       ▼
  ToolRegistry::Call("set_exposure", ...)
       │
       ▼
  C++ 函数 / C++ 对象方法   ← 真正干活的是这里
       │
       ▼
  ToolResult（结果 JSON）
       │
       ▼
  追加成 tool 消息塞回上下文
       │
       ▼
  再请求一次模型 ... 直到模型不再要工具
       │
       ▼
  最终自然语言回复
```

把这张图记在心里。后面所有的模块，都是在某一环上替掉图中的一块。

## 链路上真正重要的三件事

在往下之前，有三条认知必须先立起来。它们不是细节，是整条链路的承重墙。

### 模型不执行代码

这是全项目最重要的一句。大模型**没有**执行你的 C++ 函数，它只是输出了一段结构化文本：

```json
{"name": "set_exposure", "arguments": "{\"exposure_us\":8000}"}
```

翻译成人话就是："我要调 `set_exposure`，参数是 `exposure_us=8000`。"

**真正执行 `camera.setExposure(8000)` 的，是你自己的 C++ 程序。** 模型只负责"决定调谁、传什么"。

记住这句话：大模型不碰你的设备，它只是提要求，执行权始终在 C++ 这边。对工业软件来说，这条就是安全边界——模型只能从你注册过的工具里挑，挑不出范围。

### 模型看到的不是你的 C++ 代码，是 JSON Schema

模型怎么知道有 `set_exposure` 这个函数、它要什么参数？靠程序提前把函数"描述"成一段 JSON 发给它：

```json
{
  "type": "function",
  "function": {
    "name": "set_exposure",
    "description": "设置相机曝光时间。",
    "parameters": {
      "type": "object",
      "properties": {
        "exposure_us": { "type": "number", "description": "曝光时间，单位微秒。" }
      },
      "required": ["exposure_us"]
    }
  }
}
```

这就是 **OpenAI Function Calling** 协议。整个项目的 `tool` 模块，核心工作就是：把你写的 C++ 函数，自动变成上面这段 JSON。**你没有手写这段 JSON，是宏和注册表生成的。**

### 循环的终点是"模型不再要工具"

```cpp
if (!llm_response.tool_call.has_value()) {
  return AgentResponse{Status::Ok(), llm_response.content, messages_};  // 结束
}
```

模型返回里**没有** `tool_call` 字段了，说明它认为可以给最终答案了，循环结束。

那模型一直要工具怎么办？靠 `max_steps` 兜底。这个是后面 Agent 循环那篇的重点，这里你先记住有这么个上限就行。

## 八个模块各管什么

参考项目的 `src/` 下有 8 个模块，每个模块在这条链路上负责一段：

| 模块 | 目录 | 干什么 |
|---|---|---|
| **Core** | `src/core/` | `Status` 统一错误码 + 内部 JSON 库 |
| **Tool** | `src/tool/` | 把 C++ 函数描述成 JSON Schema；注册、查找、校验、执行 |
| **Log** | `src/log/` | 基于 spdlog，记录对话全过程（就是刚才那份日志） |
| **LLM** | `src/llm/` | 模型客户端抽象 + Mock 假模型 + OpenAI 真实客户端 |
| **HTTP** | `src/http/` | 用 libcurl 发 HTTP POST，给 LLM 模块用 |
| **Agent** | `src/agent/` | **核心**：维护上下文、驱动多步工具调用循环 |
| **Knowledge** | `src/knowledge/` | 轻量 RAG：本地文档加载 + 关键词检索 |
| **CLI** | `src/cli/` | 黑色控制台交互界面（`agent4cpp >` 那个） |

还有一些外围目录：

| 目录 | 内容 | 说明 |
|---|---|---|
| `include/agent4cpp/` | 13 个公共头文件 | 要自己写 |
| `examples/` | 3 个示例程序 | 用来验证各模块 |
| `tests/` | 6 个单元测试 | 覆盖核心逻辑 |
| `dependence/` | spdlog + curl | 已经搭好 |
| `doc/` | 架构设计文档 | 参考读物 |

`Core` 排在第一个不是巧合——它是所有模块的共同语言。任何一个模块出错，都要往回传一个东西。传什么、怎么传，就是下面要解决的问题。

## 出错了，怎么告诉调用者

C++ 里让上层知道"这一步失败了"，就三个选择：

| 方案 | 写法 | 问题 |
|---|---|---|
| 返回错误码 | `int ret = setExposure(8000); if (ret != 0) ...` | 只给数字，不知道错在哪。参数缺失返回 -1、设备掉线也返回 -1，没法区分 |
| 抛异常 | `throw std::runtime_error("...")` | 调用栈一层层展开，路径不可预测；工业软件里往往停在某个回调里被吞掉 |
| **`Status`（本项目选这个）** | `Status s = ...; if (!s.ok()) return s;` | 兼顾：有错误码可区分、有文本可读、**传递路径完全可见** |

原项目 `status.h` 里有一行英文注释，道破了选它的理由：

> It intentionally avoids exceptions as a control-flow mechanism because industrial applications often need predictable failure paths and concise logs.
> （刻意不用异常做控制流，因为工业应用需要可预测的失败路径和简洁的日志。）

### 它长什么样

```cpp
Status s = SetExposure(8000);
if (!s.ok()) {
  logger.Error(s.ToString());   // "INVALID_ARGUMENT: 参数 exposure_us 缺少"
  return s;                      // 原样往上抛
}
```

**核心思想**：错误不是一个数字，是一个**带类型和说明的小对象**，可以直接 `return` 往回传。

这个"小对象"的形状，决定了后面每个模块的接口长什么样。所以在写它之前，有三个 C++ 知识点得先讲清楚。

## 写 Status 之前的三个 C++ 知识点

基础语法没问题的话，这三处是新的东西。第二个是重点，也是最容易懵的地方。

### 知识点 1：`enum class`（强类型枚举）

```cpp
enum class StatusCode {
  kOk = 0,
  kInvalidArgument,
  kNotFound,
  // ...
};
```

它和老的 `enum` 差在哪：

| | 老式 `enum` | `enum class` |
|---|---|---|
| 名字作用域 | 泄漏到外层，容易重名 | 锁在 `StatusCode::` 里面 |
| 能否隐式转 int | 能（容易出 bug） | **不能**，必须 `static_cast<int>(x)` |
| 本项目的用法 | —— | `StatusCode::kInvalidArgument` |

`kOk = 0` 后面没写值的自动递增：`kInvalidArgument = 1`、`kNotFound = 2`……

命名前缀 `k` 是 Google C++ 风格对常量的约定，照写即可。

### 知识点 2：`std::move`（移动语义）

这一段我讲得细一点，因为它是 C++11 里最容易"以为自己懂了、其实没懂"的地方。

#### 为什么需要它：拷贝太贵了

`std::string` 内部是一个指针 + 长度，指向堆上一块内存：

```text
std::string s = "一个很长的字符串...";
    s ┌──────────┐       堆内存
      │ ptr ─────┼────►  ┌──────────────────┐
      │ size=100 │       │ "一个很长的字符串..." │  100 字节
      └──────────┘       └──────────────────┘
```

要把它交给别人，有两种做法：

| | 拷贝（copy） | 移动（move） |
|---|---|---|
| 干什么 | 新开一块堆内存，逐字节抄过去 | 把指针直接递给对方 |
| 代价 | 100 字节的内存分配 + 复制 | 复制一个指针（8 字节） |
| 原对象 | 原封不动，两边各有一份 | **被搬空**，对方拿走 |
| 类比 | 复印一本书 | 把书直接搬走，你手上空了 |

#### 关键认知：`std::move` 本身什么都不搬

这是最容易误解的地方。`std::move(x)` **不移动任何东西**，它只做一件事：

> **把 `x` 这个"左值"，强制当成"右值"来看待。**

它是一次纯粹的类型转换（等同于 `static_cast<std::string&&>(x)`）。真正搬运的动作，发生在随后调用的**移动构造函数**里。

#### 左值 / 右值：编译器什么时候愿意"搬"而不是"抄"

| 术语 | 通俗说法 | 例子 |
|---|---|---|
| **左值** lvalue | 有名字的变量，你后面还可能用它 | `std::string a = "hi";` 里的 `a` |
| **右值** rvalue | 临时的、用完就扔 | `Status::InvalidArgument("缺参数")` 里那个临时 string |

编译器很保守：**有名字的东西它不敢动**（万一你后面还要用呢），所以对左值一律拷贝。只有对"马上要死的临时对象"，它才敢抢。这就是移动构造被触发的条件。

`std::move` 的用途，就是**当你确定"这个变量我用完了，可以随便搬"时，手动通知编译器**。

#### 项目里为什么这么写

```cpp
Status::Status(StatusCode code, std::string message)   // ← 参数按值收
    : code_(code), message_(std::move(message)) {}     // ← move 进成员
```

调用链是：

```cpp
Status::InvalidArgument("参数缺失")
  → 参数 message 从字符串字面量构造         （1 次构造）
  → std::move(message) 传给 Status 构造函数  （移动，0 拷贝）
  → message_(std::move(message)) 进成员      （移动，0 拷贝）
```

全程 **1 次构造、0 次拷贝**。如果把两处 `std::move` 去掉，就变成 1 次构造 + 2 次拷贝。

**为什么参数按值收（`std::string message`）而不是 `const std::string&`？**

| 调用方式 | `const std::string&` 写法 | 按值收 + move 写法 |
|---|---|---|
| 传临时对象 | 引用绑过去，但进成员时仍要拷贝 1 次 | 移动进去，0 拷贝 |
| 传左值 | 进成员时拷贝 1 次 | 拷贝进参数 + 移动进成员，实际还是 1 次拷贝 |

两边都不亏，而临时对象场景更赚。这是 C++11 之后的标准写法。

#### `&` 和 `std::move` 不是一回事

这两者**不在同一个层次上**，没法直接比：

| 层次 | 东西 | 作用 |
|---|---|---|
| **类型层** | `T&` / `const T&` / `T&&` | 声明"我用什么方式接收这个参数" |
| **转换层** | `std::move(x)` | 把一个**左值**转成 **`T&&` 类型**，好让移动构造被选中 |
| **动作层** | 拷贝构造 / 移动构造 | 真正执行"抄一份"还是"抢过来" |

`&` 是**类型**，`std::move` 是**转换工具**。一个函数参数写 `T&` 不代表会移动，写 `std::move` 也不代表参数类型变了。

**真正的区别在"原对象会怎样"**：

| 传参写法 | 拷贝吗 | 原对象结束后 |
|---|---|---|
| `void f(const T& x)` | 不拷贝 | 原封不动 |
| `void f(T& x)` | 不拷贝 | 原封不动（但函数内可以改它） |
| `void f(T x)` | 看实参：传左值→拷贝，传右值→移动 | 看实参 |
| `void f(T&& x)` | 不拷贝 | 通常会被搬空 |

**引用为什么"不拷贝也不搬走"**：引用只是**别名**。函数里操作的还是外面那个对象本身，等于给同一个对象贴了两个标签。既没复印，也没搬走。

**`std::move` 的意义不是"省一次拷贝"，而是"转移所有权"**——明确告诉编译器"这个东西我不要了，你可以抢"。

#### 移动构造的代码怎么写

```cpp
class Payload {
 public:
  // 移动构造函数：参数是右值引用 &&
  Payload(Payload&& other) noexcept
      : name_(std::move(other.name_)),      // 逐个成员从对方"抢"过来
        bytes_(std::move(other.bytes_)) {}
};
```

三个要点：

| 要点 | 说明 |
|---|---|
| 参数是 `Payload&&` | 右值引用。只有右值（临时对象、被 move 的东西）才能匹配它 |
| 成员用 `std::move` 搬 | `other` 是**右值引用类型的变量**，但它有名字，所以它本身是左值——**必须 move 才能触发成员的移动构造** |
| `noexcept` | 承诺不抛异常。**这条非常关键**：`std::vector` 扩容时，如果元素的移动构造没有 `noexcept`，为了异常安全它会**退化成拷贝**，白白浪费性能 |

#### 调用时怎么写

```cpp
Payload a("A");

Payload b(a);                  // ① a 是左值 → 拷贝构造
Payload c(std::move(a));       // ② 显式转成右值 → 移动构造，a 被搬空

f(a);                          // ③ 按值参数收到左值 → 拷贝
f(std::move(a));               // ④ 按值参数收到右值 → 移动
f(Payload("临时"));             // ⑤ 临时对象本来就是右值 → 自动移动（甚至直接省略）
```

#### 最反直觉的一条：右值引用变量本身是左值

```cpp
void f(Payload&& p) {          // p 的类型是 Payload&&
  Payload x = p;               // 拷贝！因为 p 有名字，有名字就是左值
  Payload y = std::move(p);    // 移动，必须再转一次
}
```

**正因为这一条**，项目里才必须这么写：

```cpp
Status::Status(StatusCode code, std::string message)   // message 有名字 → 是左值
    : code_(code), message_(std::move(message)) {}     // 不写 move 就是拷贝
```

`message` 的类型虽是 `std::string`，但它是个**有名字的变量**，所以它是左值。不写 `std::move`，成员初始化就是拷贝；写了才搬。

#### 那为什么不直接用指针？

因为**指针、引用、移动解决的是三个不同的问题**：

| 工具 | 解决的问题 | 能表示"没有"吗 | 所有权 |
|---|---|---|---|
| `const T&` | 我要读，但东西还是你的 | 不能 | 不拥有（借用） |
| `T*` | 可能没有，而且我不负责 | **能**（nullptr） | 不拥有 |
| `T`（按值） | 我要一份自己的副本 | 不能 | 拥有副本 |
| `std::move` | 这东西从此归我 | —— | **转移** |

**`Status` 为什么用值 + `std::move`，不用指针？**

假如真把 `message` 设计成持有指针：

```cpp
class Status {
  StatusCode code_;
  std::string* message_;   // 两个致命问题
};
```

| 问题 | 说明 |
|---|---|
| 拷贝不安全 | `Status b = a;` 之后两个对象指向**同一个**字符串。a 析构后 b 的指针悬空 |
| 所有权不明 | 谁负责 `delete message_`？没人说得清 |

而按值持有 + move：

| 好处 | 说明 |
|---|---|
| 值语义清晰 | 每个 Status 拥有自己的 message |
| 拷贝安全 | 深拷贝，互不影响 |
| 移动零成本 | 转移时只搬指针 |

**项目里确实用了指针，但都用在了正确的地方。** 比如 `AgentConfig`：

```cpp
struct AgentConfig {
  const IKnowledgeStore* knowledge_store;   // 不拥有 + 可以为空
};
```

这里指针是**故意的**，因为它要同时表达三件事，而引用一个都表达不了：

| 语义 | 引用能做到吗 |
|---|---|
| **不拥有**（Agent 不负责销毁知识库） | 勉强，但语义不明确 |
| **可空**（不配知识库就是 nullptr，Agent 跳过 RAG） | 不能，引用必须绑定真实对象 |
| **生命周期由外部管理** | 不能 |

### 知识点 3：`[[nodiscard]]`

```cpp
[[nodiscard]] bool ok() const;
```

意思是：**这个函数的返回值不许被无视**。如果你写了 `s.ok();`（不接收返回值），编译器会警告你"你干嘛呢"。

为什么加：`ok()` 是用来判断错误的，忘了判断就等于忘了处理错误。让编译器替你盯着。

## 四个文件

`Core` 模块落地下来是 4 个文件、166 行。这是整个项目里写的第一批代码。

### 文件 1：`include/agent4cpp/export.h`（18 行）

**它解决的问题**：本项目编译成 **DLL**（动态库）。DLL 有个规矩：

- DLL **内部**编译时，需要标注"这个类/函数要**导出**给外面用" → `__declspec(dllexport)`
- 外部程序 **使用**这个 DLL 时，需要标注"这个符号从**外面导进来**" → `__declspec(dllimport)`

**同一份头文件，两种场景要用两个不同的关键字。** 怎么让一份代码同时满足？

答案：用宏 + 编译期开关。CMake 在编译 DLL 自己时定义 `AGENT4CPP_BUILDING_LIBRARY`，外部使用者不会定义它。

原项目这一份是干净的，没有任何注释，照抄这个版本：

```cpp
#ifndef AGENT4CPP_EXPORT_H_
#define AGENT4CPP_EXPORT_H_

#if defined(AGENT4CPP_STATIC)
#define AGENT4CPP_API
#else
#if defined(_WIN32)
#if defined(AGENT4CPP_BUILDING_LIBRARY)
#define AGENT4CPP_API __declspec(dllexport)
#else
#define AGENT4CPP_API __declspec(dllimport)
#endif
#else
#define AGENT4CPP_API
#endif
#endif

#endif  // AGENT4CPP_EXPORT_H_
```

每一层的含义（理解就行，不要写进代码）：

| 层 | 条件 | 宏展开成 | 含义 |
|---|---|---|---|
| 1 | `AGENT4CPP_STATIC` 已定义 | 空 | 静态库模式，不需要导入导出标记 |
| 2 | `_WIN32` 已定义 | 继续往下 | Windows 平台才需要 dllexport/dllimport |
| 3 | `AGENT4CPP_BUILDING_LIBRARY` | `__declspec(dllexport)` | 正在编译 DLL 自己，要导出符号 |
| 4 | 否则 | `__declspec(dllimport)` | 外部程序在用这个 DLL，要导入符号 |

三层嵌套，从外到内读：静态库？→ 是则空宏。Windows？→ 否则空宏。正在编译库自己？→ 决定 export 还是 import。

`#ifndef` / `#define` / `#endif` 是头文件保护（include guard），防止同一头文件被重复 include。本项目用的是这种，不是 `#pragma once`。

用法就是把宏加在类名前面：

```cpp
class AGENT4CPP_API Status { ... };
```

### 文件 2：`include/agent4cpp/status.h`（50 行）

一个枚举 + 一个类。结构如下：

```cpp
#ifndef AGENT4CPP_STATUS_H_
#define AGENT4CPP_STATUS_H_

#include <string>

#include "agent4cpp/export.h"     // 用引号不是尖括号：这是本项目自己的头文件

namespace agent4cpp {

enum class StatusCode {
  kOk = 0,
  kInvalidArgument,
  kNotFound,
  kAlreadyExists,
  kFailedPrecondition,
  kInternal,
  kUnavailable,
  kUnimplemented,
};

// 这里放原项目那两行英文注释（讲为什么不用异常）

class AGENT4CPP_API Status {
 public:
  Status();
  Status(StatusCode code, std::string message);

  // 8 个静态工厂方法
  static Status Ok();
  static Status InvalidArgument(std::string message);
  static Status NotFound(std::string message);
  static Status AlreadyExists(std::string message);
  static Status Internal(std::string message);
  static Status Unimplemented(std::string message);
  static Status FailedPrecondition(std::string message);
  static Status Unavailable(std::string message);

  [[nodiscard]] bool ok() const;
  [[nodiscard]] StatusCode code() const;
  [[nodiscard]] const std::string& message() const;
  [[nodiscard]] std::string ToString() const;

 private:
  StatusCode code_;
  std::string message_;
};

}  // namespace agent4cpp

#endif  // AGENT4CPP_STATUS_H_
```

三个设计细节：

**① 为什么用静态工厂 `Status::NotFound("...")`，而不是直接 `Status(StatusCode::kNotFound, "...")`？**

- 短：`Status::NotFound("工具未注册")` 比 `Status(StatusCode::kNotFound, "工具未注册")` 好读
- 防错：不会把两个参数写反
- 构造函数仍然保留 public，因为有些场景需要传变动的 code（比如从字符串映射回来）

**② 成员变量的尾部下划线**：`code_`、`message_`。这是 Google 风格，一眼区分成员变量和局部变量。

**③ 只有 `message()` 返回 `const std::string&`**：因为 `message()` 是只读查询，没必要拷贝字符串；而 `ToString()` 要拼新字符串，返回 `std::string` 值。

### 文件 3：`src/core/status.cpp`（81 行）

结构如下：

```cpp
#include "agent4cpp/status.h"

#include <string>

namespace agent4cpp {

namespace {                                    // ← 匿名命名空间
std::string StatusCodeName(StatusCode code) {
  switch (code) {
    case StatusCode::kOk:                return "OK";
    case StatusCode::kInvalidArgument:   return "INVALID_ARGUMENT";
    case StatusCode::kNotFound:          return "NOT_FOUND";
    case StatusCode::kAlreadyExists:     return "ALREADY_EXISTS";
    case StatusCode::kFailedPrecondition:return "FAILED_PRECONDITION";
    case StatusCode::kInternal:          return "INTERNAL";
    case StatusCode::kUnavailable:       return "UNAVAILABLE";
    case StatusCode::kUnimplemented:     return "UNIMPLEMENTED";
  }
  return "UNKNOWN";
}
}  // namespace

// ... 各构造函数和静态工厂（都只是 return Status(...)）
// ... ok() / code() / message() 三个简单 getter

std::string Status::ToString() const {
  if (ok()) {
    return "OK";
  }
  return StatusCodeName(code_) + ": " + message_;
}

}  // namespace agent4cpp
```

三个设计细节：

**① 匿名命名空间 `namespace { ... }` 是什么？**

`StatusCodeName` 只是内部辅助函数，不希望被外部链接到。放进匿名命名空间 = **只在当前 .cpp 文件内可见**，相当于 C 语言的 `static` 函数。

如果写成 `static std::string StatusCodeName(...)` 效果一样，但匿名命名空间是 C++ 的推荐写法。好处是：不会和其他 .cpp 里同名的函数冲突，也不会污染库的符号表。

**② `switch` 没有 default，末尾却有一句 `return "UNKNOWN";`**

这是故意的：

- switch 里**穷举了全部**枚举值，编译器知道所有分支都有 return
- 但编译器仍会警告"函数可能没有返回值"（因为永远可以传进一个非法枚举值）
- 所以末尾补一句兜底

**这比写 `default:` 更好**——因为一旦以后往 `StatusCode` 里加了新枚举值，写 `default` 的版本会**静默**落到 default；而穷举版本会让编译器**警告"case 没覆盖全"**，逼你处理。这是个很实战的技巧。

**③ `ToString()` 的拼接**

```cpp
return StatusCodeName(code_) + ": " + message_;   // "NOT_FOUND: 工具未注册"
```

`"字符串字面量" + std::string` 是可以的（`std::string` 提供了 `operator+`）。但反过来 `"字面量" + "字面量"` 不行——那是两个指针相加，编译错误。这里 `StatusCodeName()` 返回的是 `std::string`，所以在最左边，安全。

### 文件 4：`include/agent4cpp/agent4cpp.h`（17 行）

**伞形头文件（umbrella header）**：把项目所有公共头文件 include 一遍。

```cpp
#ifndef AGENT4CPP_AGENT4CPP_H_
#define AGENT4CPP_AGENT4CPP_H_

#include "agent4cpp/agent.h"
#include "agent4cpp/export.h"
#include "agent4cpp/http_client.h"
#include "agent4cpp/interactive_cli.h"
#include "agent4cpp/knowledge_store.h"
#include "agent4cpp/llm_client.h"
#include "agent4cpp/log.h"
#include "agent4cpp/mock_llm_client.h"
#include "agent4cpp/openai_compatible_llm_client.h"
#include "agent4cpp/status.h"
#include "agent4cpp/tool.h"
#include "agent4cpp/tool_registry.h"

#endif  // AGENT4CPP_AGENT4CPP_H_
```

使用者只要 `#include "agent4cpp/agent4cpp.h"` 就能拿到全部 API。

**现在写它会飘红**（clangd 报找不到 `agent.h` 等文件）——因为那些头文件还没写。**不用管**，飘红不影响编译（只要没人 include 这个文件）。等所有头文件都写完，飘红会自动消失。

## 把它跑起来

验证脚手架已经放好了：`_lab/lab_status.cpp`。它不是复刻产物，只是个调用你 `Status` 的测试 main。

```powershell
clang++ -std=c++17 -DAGENT4CPP_STATIC -I include _lab/lab_status.cpp src/core/status.cpp -o _lab/lab_status.exe
```

**为什么必须加 `-DAGENT4CPP_STATIC`？** 第一次编译必踩这个，顺便复习 `export.h`。

我们这里是直接把 `.cpp` 编进 exe，既没有 DLL，也没定义 `AGENT4CPP_BUILDING_LIBRARY`。不加这个宏，`export.h` 会走到 `#else` 分支，把 `AGENT4CPP_API` 展开成 `__declspec(dllimport)`——等于告诉编译器"这些符号要从 DLL 里导进来"，可代码明明就在眼前，于是报：

```text
warning: 'agent4cpp::Status::Status' redeclared without 'dllimport' attribute:
         'dllexport' attribute added [-Winconsistent-dllimport]
```

加上 `-DAGENT4CPP_STATIC` 后 `AGENT4CPP_API` 展开成空宏，问题消失。**这就是 `export.h` 三层宏的意义**：同一份头文件，靠编译期宏切换身份。做 DLL 时 CMake 帮你定义 `AGENT4CPP_BUILDING_LIBRARY`，外部用它时什么都不定义，验证时你手动定义 `AGENT4CPP_STATIC`。

然后运行，逐行核对输出：

```powershell
.\_lab\lab_status.exe
```

```text
默认构造: ok()=1 code=0 ToString=OK
InvalidArgument: ok()=0 ToString=INVALID_ARGUMENT: 参数 exposure_us 缺失
NotFound: NOT_FOUND: 工具 set_exposure 未注册
FailedPrecondition: FAILED_PRECONDITION: 超过 max_steps 上限
Unavailable: UNAVAILABLE: LLM 服务不可用
kInternal: INTERNAL: 内部错误
message()=参数 exposure_us 缺失
ok 的 message 长度=0
```

编译报错如果出现，多半是三个原因：① 头文件路径写错 ② 少个分号 ③ `#include` 顺序导致找不到 `export.h`。

## 我踩过的坑

集中说一下。这些比代码本身更值得记。

**以为 `std::move` 会搬东西。** 我一开始觉得写了 `std::move` 就"搬完了"。实际它什么都不搬，只是把左值强制看成右值，真正的搬运发生在随后被选中的移动构造函数里。理解错这一层，后面所有"为什么这里要 move、那里不用"都会想不明白。

**右值引用变量本身是左值。** 这条最反直觉。构造函数参数写成 `Payload&& other` 之后，我在函数体里直接用 `other`，以为它会自动移动——不是，`other` 有名字，它就是左值，不写 `std::move` 照样拷贝。项目里 `message_(std::move(message))` 那个 move 就是因为这条才必须写的。

**只写析构函数，move 会静默失效。** C++ 有一条暗规则：**一旦你声明了析构函数，编译器就不再隐式生成移动构造函数。**

```cpp
class HalfMove {
 public:
  ~HalfMove() { /* 只写了析构 */ }
  // 没有移动构造！
};

HalfMove a("x");
HalfMove b(std::move(a));   // 不报错、不警告，但实际走的是拷贝构造
```

**不报错，只是悄悄变慢。** 这类静默性能退化在真实项目里最难发现。三种写法的区别：

| 风格 | 写什么 | 结果 |
|---|---|---|
| **零法则** | 什么都不写 | 编译器全生成，拷贝 / 移动都正常 |
| **五法则** | 析构 + 拷贝构造 + 拷贝赋值 + 移动构造 + 移动赋值 | 全部正常 |
| **半吊子** | 只写析构 | **移动静默失效，退化成拷贝** |

`Status` 属于零法则——它**没有手写析构函数**，所以编译器隐式生成了拷贝构造和移动构造，`std::move(message)` 正常生效。这个"声明析构会抑制隐式移动构造"的点很少人知道，但它是上面那条性能陷阱的根源。

**在 `return` 里写 `std::move`，画蛇添足。**

```cpp
Buffer MakeBuffer() {
  Buffer local("...");
  return std::move(local);   // 反而更慢
}
```

编译器本来有返回值优化（NRVO）——直接在调用方那块内存上构造，**一次拷贝/移动都不发生**。写 `std::move` 会把局部对象变成一个右值，**破坏 NRVO**，逼编译器真搬一次。费力不讨好。

**move 之后还去读原对象。**

```cpp
std::string a = "hello";
std::string b = std::move(a);
std::cout << a;            // a 现在是空串（或未指定状态），别依赖
```

move 之后原对象**不是销毁了**，而是变成"有效但未指定"状态（valid but unspecified）——标准库保证你还能安全地析构它、给它重新赋值，但**不要再去读它的值**。

**`Status` 差点用指针持有 message。** 我最早想过 `std::string* message_`，觉得"指针省事"。写了才发现两个致命问题：一是 `Status b = a;` 之后两个对象指向同一个字符串，a 析构后 b 悬空；二是谁负责 `delete`，说不清。值 + move 才是对的。

**编译时忘了 `-DAGENT4CPP_STATIC`。** 报一堆 `dllimport` 相关的警告，看着像环境坏了，其实就是宏没定义，`export.h` 走错了分支。

**写 `agent4cpp.h` 时一片飘红。** 一开始以为是自己写错了，其实是那些头文件还没写。飘红不影响编译，别管它。

## 几个我当时犹豫过的设计

**`Status` 为什么不用异常。** 异常的问题不是"不能用"，而是**失败路径不可预测**。工业软件里错误往往要跨进程、跨回调传递，异常在某一层被吞掉之后，你连错在哪都不知道。`Status` 牺牲了"忘记检查"这一点的强制性（靠 `[[nodiscard]]` 补），换来了完整的、可见的传递路径。

**`switch` 到底写不写 `default`。** 犹豫过。写 `default` 更"安全"（编译器不会警告缺 return），但代价是以后加枚举值时会静默漏掉。我最后选了穷举 + 末尾兜底，把"新增枚举没处理"变成一个编译期警告。这是我更想要的失败方式——**宁可编译时报警，也别运行时静默**。

**`export.h` 三层宏是不是过度设计。** 单看很啰嗦，但它解决的是一份头文件在"编译库""用库""静态编"三种身份下的切换问题。这是 DLL 的固有复杂度，不是可以省掉的。真觉得复杂，说明还没被 `dllimport` 坑过。

骨架到这里就立起来了，错误码也定好了。往下走，每个模块的返回值都会是 `Status`——你在这一篇里写下的那个小对象，接下来会出现在项目的每一个角落。
