---
title: 手写工具调用层
description: "模型能调用的工具是声明出来的，不是手写 JSON Schema 拼出来的。附工具登记处那把锁两次踩坑的记录。"
pubDate: 2026-10-08
tags: [C++, LLM, Agent, 并发]
---

上一篇讲 Agent 循环的时候，里面有这样一行：

```cpp
ToolResult tool_result = registry_->Call(tool_call.name, tool_call.arguments_json);
```

模型输出一段文字说"我要调 `set_exposure`，参数 10000"，是这一行把它变成一次真实的 C++ 函数调用。

这一篇就展开这一行。中间其实隔着五件事：

1. 用宏把一个 C++ 函数**声明**成模型看得懂的"工具"
2. 程序把这份声明**翻译**成 JSON Schema，随请求发给模型
3. 模型给的参数**过一道校验**
4. 工具**登记**进一个注册表
5. 运行时按名字**找到它、调用它**，把结果收拾干净

五个环节摊开是这样：

![Tool 模块里谁是谁](/images/agent4cpp/lesson04-角色关系.svg)

![一次工具调用的完整流程](/images/agent4cpp/lesson04-工具调用流程.svg)

下面按这个顺序走。

## 用宏描述一个工具

### 为什么不手写 JSON

模型要知道"有哪些函数能调、每个函数要什么参数"，靠程序提前把函数描述成一段 JSON：

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

这段 JSON 我一开始是打算手写的，写到第三个工具就放弃了。三个问题：

| 问题 | 后果 |
|---|---|
| 容易和 C++ 函数签名不一致 | 模型传了参数，C++ 那边没这个参数，运行时才炸 |
| 改了函数忘了改 JSON | 描述漂移，模型被误导 |
| 写起来啰嗦 | 每个工具几十行 JSON |

`tool.h` 要做的就是把这件事变成**用宏描述一次、编译期自动生成**：

```cpp
AGENT4CPP_TOOL(set_exposure, "设置相机曝光时间。") {
  // C++ 实现
}

AGENT4CPP_REGISTER_FUNCTION(registry, set_exposure, "设置相机曝光时间。",
                            AGENT4CPP_DOUBLE_ARG("exposure_us", "曝光时间，单位微秒。"));
```

上面这几行同时做完三件事：**定义函数 + 描述参数 + 注册进工具箱**。

### 四个核心类型

`tool.h` 的类型设计很简洁：四个 struct、一个 enum、一个类型别名。挑两个最关键的先说。

```cpp
struct AGENT4CPP_API ToolResult {
  Status status;              // 成功还是失败，失败时带原因
  std::string payload_json;   // 结构化数据（给模型做推理用）
  std::string content;        // 自然语言说明（给模型读）
};
```

结果为什么要分成两个字段？这是整个设计里我最想讲的一点。看一个真实的返回值：

```text
tool result name=get_camera_status status=OK
     content=Camera status returned.
     payload={"exposure_us":5000.0,"brightness":0.5,
              "brightness_target":1.0,
              "brightness_scale":"0.0=black, 1.0=correct exposure, >1.0=overexposed",
              "assessment":"underexposed"}
```

| 字段 | 给谁看 | 作用 |
|---|---|---|
| `content` | 模型（和日志） | 一句人话："相机状态已返回。" |
| `payload_json` | **模型推理** | 结构化数据。模型读 `brightness: 0.5` 和 `brightness_target: 1.0`，算出该把曝光调到 8000 |
| `status` | 程序 | 判断这次调用成没成 |

关键在于：`payload_json` 里不只给数字，还给了语义字段。`brightness_scale` 解释 0.5 是什么含义，`assessment` 直接给出结论。**光给一个裸数字 `0.5`，模型无从判断这是亮还是暗。** 我最初只想返回数据，后来发现数据不带语义，模型只能瞎猜。

```cpp
struct AGENT4CPP_API ToolDefinition {
  std::string name;                     // 工具名，模型靠它来调
  std::string description;              // 给模型看的说明：这工具干什么用
  std::vector<ToolParameter> parameters;// 参数列表
  ToolInvoker invoker;                  // 实际要执行的 C++ 函数
};
```

前三个字段是**给模型看的描述**，最后一个 `invoker` 是**真正干活的东西**。

```cpp
using ToolInvoker =
    std::function<ToolResult(const std::string& arguments_json)>;
```

这是整个工具层最要紧的一句：**所有工具统一成同一个签名**——收一个 JSON 字符串，吐一个 `ToolResult`。

为什么参数是 `std::string` 而不是结构体？因为参数来自模型的 JSON，**数量和类型都是运行期才知道的**。统一收一个 JSON 字符串，工具内部自己解析。这样就不用做 C++ 反射——C++ 根本没有反射，拿不到"函数有几个参数、什么类型"。

`std::function` 是个能装**任何可调用对象**的容器，只要签名匹配：

| 装什么 | 例子 |
|---|---|
| 普通函数 | `set_exposure`（宏生成的那个） |
| lambda | `[&](const std::string& s) { return camera.setExposure(s); }` |
| 函数对象（重载了 `operator()` 的类） | 少见但支持 |

后面能直接注册对象的方法，全靠这一点。

剩下两个类型顺手交代。参数类型是个枚举：

```cpp
enum class ToolParameterType {
  kBoolean,   // -> JSON Schema "boolean"
  kInteger,   // -> JSON Schema "integer"
  kNumber,    // -> JSON Schema "number"
  kString,    // -> JSON Schema "string"
  kEnum,      // -> JSON Schema "string" + enum 候选值数组
};
```

注意它**没有 `kOk = 0`**，全部自动递增——只有需要特殊数值时才写 `= 0`。每个参数的描述长这样：

```cpp
struct AGENT4CPP_API ToolParameter {
  std::string name;                                    // 参数名
  ToolParameterType type = ToolParameterType::kString; // 类型，默认 string
  std::string description;                             // 给模型看的说明
  bool required = true;                                // 是否必填
  std::vector<std::string> enum_values;                // 仅 kEnum 用
};
```

`type = kString` 和 `required = true` 这两处默认值不是装饰。C++11 之前，`ToolParameter p;` 里的 `name` 会是空串（`std::string` 自己会初始化），但 `required` 会是**内存里的随机垃圾值**。加了默认成员初始化才有保证。

### 五个宏

`tool.h` 有一半篇幅是宏。先看原项目那段英文注释，它是理解整套东西的钥匙：

> Macro helpers keep user code compact while still compiling to ordinary C++ functions. The generated function can be registered into any ToolRegistry, which avoids hidden global initialization order issues in Qt applications.
>
> （宏让用户代码简洁，但编译出来仍是**普通 C++ 函数**。生成的函数可以注册进任何 ToolRegistry，这就避免了 Qt 应用里隐藏的全局初始化顺序问题。）

就一句话概括：**宏不产生任何新能力，它只是让调用点变短。** 展开后全是普通 C++。

**`AGENT4CPP_TOOL` 定义函数：**

```cpp
#define AGENT4CPP_TOOL(tool_name, description) \
  static ::agent4cpp::ToolResult tool_name(    \
      const std::string& arguments_json)
```

用法和展开：

```cpp
AGENT4CPP_TOOL(set_exposure, "设置相机曝光时间。") {
  // ...
  return agent4cpp::OkToolResult("曝光已更新。", "{}");
}

// 展开后：
static ::agent4cpp::ToolResult set_exposure(const std::string& arguments_json) {
  // ...
  return agent4cpp::OkToolResult("曝光已更新。", "{}");
}
```

三个细节：宏定义**末尾没有分号**，所以使用时紧跟 `{ ... }`，拼起来正好是一个完整函数；`description` 参数在这里**用不上**，展开里看不到它（只在注册宏里用）；`static` 是内部链接，等价于匿名命名空间——这个函数只在本文件可见。

**`AGENT4CPP_XXX_ARG` 描述参数**，纯转发：

```cpp
#define AGENT4CPP_DOUBLE_ARG(name, description) \
  ::agent4cpp::DoubleParam((name), (description))
```

包一层宏只是为了让调用点短。`(name)` 外面加括号是防御性写法——万一传进来的实参是带逗号的表达式，不加括号会被宏的参数拆分逻辑拆错。其中枚举参数用了可变参数：

```cpp
#define AGENT4CPP_ENUM_ARG(name, description, ...) \
  ::agent4cpp::EnumParam((name), (description), {__VA_ARGS__})

// 候选值个数不定
AGENT4CPP_ENUM_ARG("trigger_mode", "触发模式", "software", "hardware")
// 展开：::agent4cpp::EnumParam("trigger_mode", "触发模式", {"software", "hardware"})
```

`{__VA_ARGS__}` 把展开后的多个值塞进一个初始化列表，正好对上 `std::vector<std::string>` 参数。

**`AGENT4CPP_REGISTER_FUNCTION` 注册普通函数：**

```cpp
#define AGENT4CPP_REGISTER_FUNCTION(registry, tool_name, description, ...) \
  (registry).Register(::agent4cpp::ToolDefinition{                         \
      #tool_name, (description), {__VA_ARGS__}, (tool_name)})
```

```cpp
// 展开后：
(registry).Register(::agent4cpp::ToolDefinition{
    "set_exposure",                                  // ← #tool_name 字符串化
    "设置相机曝光时间。",
    {::agent4cpp::DoubleParam("exposure_us", "曝光时间，单位微秒。")},
    (set_exposure)});                                // ← 函数名当函数指针传进去
```

这里的技巧是 `#tool_name`——`#x` 是**字符串化运算符**，把宏参数原样变成字符串字面量。所以**函数名和工具名自动一致**：你不可能写出函数叫 `set_exposure`、工具名却手滑打成 `"set_expsoure"`。这是宏相对手写的核心优势。四个位置正好对上 `ToolDefinition` 的四个成员：`name` / `description` / `parameters` / `invoker`。

**`AGENT4CPP_REGISTER_METHOD` 注册对象方法**，只有 `invoker` 那一格不同——换成 lambda：

```cpp
#define AGENT4CPP_REGISTER_METHOD(registry, object, method_name, description, \
                                  ...)                                       \
  (registry).Register(::agent4cpp::ToolDefinition{                           \
      #method_name, (description), {__VA_ARGS__},                            \
      [&](const std::string& arguments_json) -> ::agent4cpp::ToolResult {    \
        return (object).method_name(arguments_json);                         \
      }})
```

```cpp
CameraController camera;

AGENT4CPP_REGISTER_METHOD(registry, camera, setExposure, "设置相机曝光时间。",
                          AGENT4CPP_DOUBLE_ARG("exposure_us", "曝光时间，单位微秒。"));
```

**为什么必须绕一层 lambda**：`std::function` 装不了"对象 + 成员函数指针"这种组合，但可以装 lambda。于是用 lambda 把对象捕获进来，转发调用。拆开看：

| 语法 | 含义 |
|---|---|
| `[&]` | **按引用捕获**所有用到的外部变量（这里是 `camera`） |
| `(...)` | lambda 的参数列表，和普通函数一样 |
| `-> ::agent4cpp::ToolResult` | 显式写出返回类型（让 `std::function` 能推导） |
| `{ ... }` | 函数体 |

**这里有个真实的使用陷阱：`[&]` 按引用捕获了 `camera`。** 如果 `registry` 活得比 `camera` 久，调用时就悬空了。项目里假定两者生命周期一致（都是宿主程序的成员），所以没问题；但如果 `camera` 是个局部变量，注册完就析构，后面一调必崩。

9 个宏的完整中文注释对照版：

```cpp
// ---------------------------------------------------------------------------
// 下面 9 个宏的唯一目的：让调用点的代码变短。
// 它们不产生任何新能力，展开后全是普通 C++。
// ---------------------------------------------------------------------------

// ① 定义一个工具函数。
//    展开成：static ::agent4cpp::ToolResult 工具名(const std::string& arguments_json)
//    两个细节：
//      - 宏体末尾没有分号，用户使用时紧跟 { ... }，拼起来正好是完整函数定义
//      - 参数 description 在这里用不上，它只在下面的注册宏里用到
//      - ::agent4cpp 前面那个 :: 表示"从全局命名空间开始找"，
//        因为宏展开在用户的代码里，用户可能身处任意命名空间
#define AGENT4CPP_TOOL(tool_name, description) \
  static ::agent4cpp::ToolResult tool_name(    \
      const std::string& arguments_json)

// ② 声明一个 number 参数（旧的通用写法，等价于 double）。
//    展开成：::agent4cpp::NumberParam((name), (description))
//    参数外面套 ( ) 是防御性写法：万一用户传进来的是带逗号的表达式，
//    不加括号会被宏的参数拆分逻辑拆错。
#define AGENT4CPP_NUMBER_ARG(name, description) \
  ::agent4cpp::NumberParam((name), (description))

// ③ 声明一个 int 参数。结构和 ② 完全一样，只是换了工厂函数。
#define AGENT4CPP_INT_ARG(name, description) \
  ::agent4cpp::IntParam((name), (description))

// ④ 声明一个 double 参数。同上。
#define AGENT4CPP_DOUBLE_ARG(name, description) \
  ::agent4cpp::DoubleParam((name), (description))

// ⑤ 声明一个 string 参数。同上。
#define AGENT4CPP_STRING_ARG(name, description) \
  ::agent4cpp::StringParam((name), (description))

// ⑥ 声明一个枚举参数 —— 唯一需要可变参数的宏。
//    展开成：::agent4cpp::EnumParam((name), (description), {"software", "hardware"})
//    ... 和 __VA_ARGS__ 是 C++11 的可变参数宏：
//      用户传多少个候选值都行，全部塞进 { } 里，
//      正好对上 EnumParam 第三个参数 std::vector<std::string>
#define AGENT4CPP_ENUM_ARG(name, description, ...) \
  ::agent4cpp::EnumParam((name), (description), {__VA_ARGS__})

// ⑦ 声明一个 bool 参数。同上。
#define AGENT4CPP_BOOL_ARG(name, description) \
  ::agent4cpp::BooleanParam((name), (description))

// ⑧ 把一个普通函数注册进 registry。
//    展开成：
//      (registry).Register(::agent4cpp::ToolDefinition{
//          "set_exposure", (description), {参数们}, (set_exposure)});
//    四个位置正好对上 ToolDefinition 的四个成员：name / description / parameters / invoker
//    关键在 #tool_name —— 这是字符串化运算符，
//      把标识符 set_exposure 原样变成字符串 "set_exposure"
//      所以函数名和工具名自动保持一致，不可能拼错
//    最后一个 (tool_name) 是裸写函数名，它会自动退化成函数指针，存进 std::function
#define AGENT4CPP_REGISTER_FUNCTION(registry, tool_name, description, ...) \
  (registry).Register(::agent4cpp::ToolDefinition{                         \
      #tool_name, (description), {__VA_ARGS__}, (tool_name)})

// ⑨ 把一个对象的方法注册进 registry。
//    展开式和 ⑧ 一样，只有 invoker 那一格不同 —— 换成 lambda：
//      [&](const std::string& arguments_json) -> ::agent4cpp::ToolResult {
//        return (camera).setExposure(arguments_json);
//      }
//    为什么必须用 lambda？
//      std::function 装不了"对象 + 成员函数指针"这种组合，
//      但可以装 lambda。于是用 lambda 把对象捕获进来，转发调用。
//    语法拆解：
//      [&]                        按引用捕获外部变量（这里就是那个对象）
//      (const std::string& ...)   参数列表，和普通函数一样
//      -> ::agent4cpp::ToolResult 显式写返回类型，让 std::function 能推导
//      { return (object).方法(参数); }  函数体，转发调用
#define AGENT4CPP_REGISTER_METHOD(registry, object, method_name, description, \
                                  ...)                                       \
  (registry).Register(::agent4cpp::ToolDefinition{                           \
      #method_name, (description), {__VA_ARGS__},                            \
      [&](const std::string& arguments_json) -> ::agent4cpp::ToolResult {    \
        return (object).method_name(arguments_json);                         \
      }})
```

写这种多行宏有三条铁律：除最后一行外每行末尾都要有 `\`；`\` 后面**不能有空格**，否则续行失败、报一堆莫名其妙的错；`\` 尽量对齐在同一列。

### 为什么不用"全局自动注册"

很多框架会在启动时自动注册：定义一个全局对象，它的构造函数里往全局注册表塞。

```cpp
// 假想的"自动注册"写法
struct AutoRegister {
  AutoRegister() { GlobalRegistry().Register(...); }
};

static AutoRegister g_register_set_exposure;   // 全局对象，main 之前自动执行
```

看着更省事——连 `AGENT4CPP_REGISTER_FUNCTION` 都不用写。但我不这么干，原因是**静态初始化顺序**：`g_register_set_exposure` 和 `GlobalRegistry()` 内部那个全局注册表，谁先构造？C++ 标准**不保证跨编译单元的顺序**。如果注册对象先跑、注册表还没构造，程序直接崩。Qt 应用里全局单例更多，这个问题更难排查。此外全局状态还让测试互相污染，某些链接配置下没人引用的全局对象甚至会被优化掉。

宏生成的**只是一个普通函数**，什么时候注册由你决定：

```cpp
int main() {
  agent4cpp::ToolRegistry registry;      // 1. 先建注册表
  AGENT4CPP_REGISTER_FUNCTION(...);      // 2. 显式注册，时机你自己控制
  agent4cpp::Agent agent(...);           // 3. 再建 Agent
}
```

顺序完全可控，没有全局状态，每个测试自己建一个干净的 registry。代价就是每个工具多写一行注册调用。显式优于隐式。

## 参数 Schema 从哪来

`BuildOpenAIToolSchema` 就是那个翻译官：把 `ToolDefinition` 翻成 JSON。它的产物是模型唯一能看到的"工具清单"——这里少写一个字段，模型就永远发现不了那个工具。

翻译目标是 OpenAI 规定的格式，也是全世界 Agent 框架通用的格式：

```json
{
  "type": "function",
  "function": {
    "name": "set_exposure",
    "description": "设置相机曝光时间。",
    "parameters": {
      "type": "object",
      "properties": {
        "exposure_us": {
          "type": "number",
          "description": "曝光时间，单位微秒。"
        }
      },
      "required": ["exposure_us"]
    }
  }
}
```

逐层拆开：

| 层 | 内容 | 大白话 |
|---|---|---|
| 最外 | `"type": "function"` | "下面这个东西是个函数" |
| `function` | `name`、`description` | 工具叫什么、干什么用的 |
| `parameters` | `type: object` | "参数是一组键值对" |
| `properties` | 每个参数一项 | 每个参数叫什么、什么类型、干什么用 |
| `required` | 名字列表 | 哪几个参数是必须给的 |

实现不长：

```cpp
std::string BuildOpenAIToolSchema(const ToolDefinition& tool) {
  nlohmann::json properties = nlohmann::json::object();
  nlohmann::json required = nlohmann::json::array();

  for (const auto& parameter : tool.parameters) {
    nlohmann::json property = {
        {kJsonType, JsonTypeName(parameter.type)},
        {kJsonDescription, parameter.description},
    };
    if (parameter.type == ToolParameterType::kEnum) {
      property[kJsonEnum] = parameter.enum_values;
    }
    properties[parameter.name] = std::move(property);
    if (parameter.required) {
      required.push_back(parameter.name);
    }
  }

  nlohmann::json schema;
  schema[kJsonType] = kOpenAIToolTypeFunction;
  schema[kJsonFunction][kJsonName] = tool.name;
  schema[kJsonFunction][kJsonDescription] = tool.description;
  schema[kJsonFunction][kJsonParameters][kJsonType] = kJsonTypeObject;
  schema[kJsonFunction][kJsonParameters][kJsonProperties] =
      std::move(properties);
  schema[kJsonFunction][kJsonParameters][kJsonRequired] = std::move(required);
  return schema.dump();
}
```

第一段准备两个空容器：`properties` 装每个参数，`required` 装哪些参数必填。注意这里是显式写 `json::object()` / `json::array()`，不是直接 `{}`——要明确一个是盒子、一个是列表。

第二段遍历每个参数，造一个小盒子装两样：类型、说明。这里调用了内部函数 `JsonTypeName`，把 C++ 类型翻成 JSON 类型名：

| 手里的（C++） | 翻译成（JSON） |
|---|---|
| `kBoolean` | `"boolean"` |
| `kInteger` | `"integer"` |
| `kNumber` | `"number"` |
| `kString` | `"string"` |
| `kEnum` | **`"string"`** ← 注意 |

枚举翻译成 `"string"` 而不是 `"enum"`，因为 **JSON 里根本没有 `enum` 这个类型**。枚举的表达方式是"类型算文字，另外给一张可选值清单"：

```json
{
  "type": "string",
  "enum": ["software", "hardware"]
}
```

那张清单在循环里单独加：

```cpp
if (parameter.type == ToolParameterType::kEnum) {
  property[kJsonEnum] = parameter.enum_values;
}
```

`JsonTypeName` 的写法有个习惯：把 5 种情况**全部列出来**，最后兜底一句。**故意不写 `default`**——这样以后加了第 6 种类型，编译器会警告"这个情况没处理"。

第三段一层层往上拼：

```cpp
schema[kJsonFunction][kJsonName] = tool.name;
// 等价于 schema["function"]["name"] = tool.name
```

nlohmann/json 有个方便的特性：**中间层不存在会自动建出来**，所以不用先手动造 `schema["function"]`，直接往下写就行。拼完的层次是：

```text
schema
├── type = "function"
└── function
    ├── name          ← 资料卡的名字
    ├── description   ← 资料卡的说明
    └── parameters
        ├── type = "object"
        ├── properties = { ... }   ← 第二段造好的
        └── required = [ ... ]     ← 第二段造好的
```

最后 `schema.dump()` 压成一行文本发出去。真实输出是这样（没有换行和缩进，紧凑格式更省流量）：

```json
{"function":{"description":"设置相机曝光时间。","name":"set_exposure","parameters":{"properties":{"exposure_us":{"description":"曝光时间，单位微秒。","type":"number"}},"required":["exposure_us"],"type":"object"}},"type":"function"}
```

`properties` 和 `required` 拼进去时用了 `std::move`——这俩盒子造完就没用了，搬进去省一次深拷贝。参数多的时候拷贝不便宜。**用完就没用的临时东西就用 move 搬**，这是全项目反复出现的习惯。

## 参数进来先过一道安检

模型回了 `{"exposure_us": "八千"}`——类型错了。校验这一层就在这种时候起作用：**不是报错终止，而是退回给模型让它自己改。**

```text
模型说：我要调 set_exposure，参数 {"exposure_us": "八千"}    ← 类型错了
        ↓
[校验] 检查 → "参数类型不对"
        ↓
把这张错误条子交回给模型
        ↓
模型看到原因，自己改成 {"exposure_us": 8000} 重新说一遍
        ↓
这次通过了
```

这个"退回、让它自己改"的设计，是整个 Agent 系统能用的关键。如果直接报错终止对话，用户就得重新说一遍。

### 唯一的爆破点

`nlohmann::json::parse()` 遇到坏文本会**抛异常**——这是库的固有行为，改不了。项目其他地方刻意不用异常，但这里必须处理。做法是把它关进一个门口，就地接住、转成普通的错误对象：

```cpp
Status ParseArgumentsObject(const std::string& arguments_json,
                            nlohmann::json* arguments) {
  try {
    *arguments = nlohmann::json::parse(arguments_json);
  } catch (const nlohmann::json::exception& error) {
    return Status::InvalidArgument(std::string("invalid arguments JSON: ") +
                                   error.what());
  }
  if (!arguments->is_object()) {
    return Status::InvalidArgument("tool arguments must be a JSON object");
  }
  return Status::Ok();
}
```

它做两件事：把文本变成盒子（失败就接住爆炸，返回"文本格式错误"+ 库给的原因）；检查盒子是不是"对象"。第二步是必要的——JSON 顶层可以是对象 `{}`、列表 `[]`、单独一个值 `"abc"`，但工具参数**必须是个对象**，因为要按名字找参数。如果模型递来 `[1,2,3]`，后面"按名字找"就没意义了。全文件所有要读 JSON 的地方都走这一个门口，所以 `try/catch` 在整个项目里只出现这一次。

注意第二个参数是**指针**：函数的返回值被错误状态占用了，所以变出来的盒子只能通过这个参数送出去。

### ValidateArguments

```cpp
Status ValidateArguments(const ToolDefinition& tool,
                         const std::string& arguments_json) {
  nlohmann::json arguments;
  Status parse_status = ParseArgumentsObject(arguments_json, &arguments);
  if (!parse_status.ok()) {
    return parse_status;
  }

  for (const auto& parameter : tool.parameters) {
    const auto iter = arguments.find(parameter.name);
    if (iter == arguments.end()) {
      if (parameter.required) {
        return Status::InvalidArgument("missing required argument: " +
                                       parameter.name);
      }
      continue;
    }

    const nlohmann::json& value = *iter;
    const bool type_ok =
        (parameter.type == ToolParameterType::kBoolean && value.is_boolean()) ||
        (parameter.type == ToolParameterType::kInteger &&
         value.is_number_integer()) ||
        (parameter.type == ToolParameterType::kNumber && value.is_number()) ||
        (parameter.type == ToolParameterType::kString && value.is_string()) ||
        (parameter.type == ToolParameterType::kEnum && value.is_string());
    if (!type_ok) {
      return Status::InvalidArgument("argument has invalid type: " +
                                     parameter.name);
    }
    if (parameter.type == ToolParameterType::kEnum &&
        !ContainsEnumValue(parameter.enum_values, value.get<std::string>())) {
      return Status::InvalidArgument("argument has invalid enum value: " +
                                     parameter.name);
    }
  }
  return Status::Ok();
}
```

先交给门口接待员；文本本身就坏的话，后面检查都没意义。

然后遍历**资料卡上声明了哪些参数**——注意这个方向很重要。只有拿"应该有的清单"去核对，才能发现"少了什么"。反过来遍历模型实际传了哪些，那些该给没给的必填项压根不在列表里，永远查不出来。就像安检要拿装箱单核对箱子，才能发现少装了一件。

这个参数给了吗？分两种情况：必填没给，`return` 错误；可选没给，`continue` **跳过这个、继续查后面的**。这里容易写错——写成 `return Status::Ok()` 就提前结束了，后面那些参数根本没检查。

类型检查就是五组"或"，每组是两件事都要满足：「资料卡上写的类型 == 这一组的类型」**并且**「模型给的值确实是这种类型」。拿 `exposure_us` 走一遍（资料卡上写的是"小数"）：前两组不匹配，第三组命中——小数 == 小数，再确认值确实是数字，通过。

这里用到两个判断函数的差别：

| 函数 | `42` | `3.14` | 谁用 |
|---|---|---|---|
| `is_number_integer()` | 是 | **不是** | 整数参数（严格） |
| `is_number()` | 是 | 是 | 小数参数（宽松） |

枚举为什么也用 `is_string()`？因为枚举在 JSON 里就是**文字**（类型是 `"string"`），只是额外限制了取值范围——那个限制单独一步查：`ContainsEnumValue` 核对这个值在不在允许的名单里。例如 `trigger_mode` 允许 `software` / `hardware`，模型传了 `continuous`——它是文字（类型这步通过），但不在名单里（这步抓住）。

### 校验只管格式，不管业务

校验层检查的是**格式**：能不能读、有没有少、类型对不对、选项对不对。**它不检查值在业务上合不合理。**

曝光时间传了 `-1`：

| 层面 | 谁管 | 结果 |
|---|---|---|
| 格式 | 校验层 | `-1` 是数字，类型正确 → **放行** |
| 业务 | **工具函数自己** | 判断"曝光不能为负"并退回 |

所以真正干活的函数里要这么写：

```cpp
AGENT4CPP_TOOL(set_exposure, "设置相机曝光时间。") {
  double exposure_us = 0.0;
  const auto status = agent4cpp::GetRequiredDouble(arguments_json, "exposure_us", &exposure_us);
  if (!status.ok()) {
    return agent4cpp::ErrorToolResult(status);
  }
  // 业务检查：曝光不能为负，这是校验层管不着的地方
  if (exposure_us <= 0.0) {
    return agent4cpp::ErrorToolResult(
        agent4cpp::Status::InvalidArgument("曝光时间必须为正数。"));
  }
  camera->setExposure(exposure_us);
  return agent4cpp::OkToolResult("曝光已更新。", "{}");
}
```

这就是分层：通用设施管"格式对不对"，业务代码管"这件事合不合理"。很多项目把两层混着写，结果通用设施里塞满业务判断，换个项目就没法用了。

## 参数怎么抄进 C++ 变量

参数是一整块 JSON，用某个值时得把它抄进 C++ 变量。六个 `GetRequiredXxx` 干这个。标准用法：

```cpp
AGENT4CPP_TOOL(set_exposure, "设置相机曝光时间。") {
  double exposure_us = 0.0;                                      // ① 先准备一个变量
  const auto status = agent4cpp::GetRequiredDouble(              // ② 让取值函数去抄
      arguments_json, "exposure_us", &exposure_us);
  if (!status.ok()) {                                            // ③ 检查抄到没
    return agent4cpp::ErrorToolResult(status);
  }
  camera->setExposure(exposure_us);                              // ④ 用这个值干活
  return agent4cpp::OkToolResult("曝光已更新。", "{}");
}
```

最后那个 `&exposure_us` 的意思是"把抄到的值写进这个变量"。

```cpp
Status GetRequiredNumber(const std::string& arguments_json,
                         const std::string& name,
                         double* value) {
  nlohmann::json arguments;
  Status status = ParseArgumentsObject(arguments_json, &arguments);
  if (!status.ok()) {
    return status;
  }
  const auto iter = arguments.find(name);
  if (iter == arguments.end()) {
    return Status::InvalidArgument("missing required argument: " + name);
  }
  if (!iter->is_number()) {
    return Status::InvalidArgument("argument is not a number: " + name);
  }
  *value = iter->get<double>();
  return Status::Ok();
}

Status GetRequiredInt(const std::string& arguments_json,
                      const std::string& name,
                      int* value) {
  nlohmann::json arguments;
  Status status = ParseArgumentsObject(arguments_json, &arguments);
  if (!status.ok()) {
    return status;
  }
  const auto iter = arguments.find(name);
  if (iter == arguments.end()) {
    return Status::InvalidArgument("missing required argument: " + name);
  }
  if (!iter->is_number_integer()) {
    return Status::InvalidArgument("argument is not an integer: " + name);
  }
  *value = iter->get<int>();
  return Status::Ok();
}

Status GetRequiredDouble(const std::string& arguments_json,
                         const std::string& name,
                         double* value) {
  return GetRequiredNumber(arguments_json, name, value);
}

Status GetRequiredString(const std::string& arguments_json,
                         const std::string& name,
                         std::string* value) {
  nlohmann::json arguments;
  Status status = ParseArgumentsObject(arguments_json, &arguments);
  if (!status.ok()) {
    return status;
  }
  const auto iter = arguments.find(name);
  if (iter == arguments.end()) {
    return Status::InvalidArgument("missing required argument: " + name);
  }
  if (!iter->is_string()) {
    return Status::InvalidArgument("argument is not a string: " + name);
  }
  *value = iter->get<std::string>();
  return Status::Ok();
}

Status GetRequiredEnum(const std::string& arguments_json,
                       const std::string& name,
                       const std::vector<std::string>& values,
                       std::string* value) {
  Status status = GetRequiredString(arguments_json, name, value);
  if (!status.ok()) {
    return status;
  }
  if (!ContainsEnumValue(values, *value)) {
    return Status::InvalidArgument("argument has invalid enum value: " + name);
  }
  return Status::Ok();
}

Status GetRequiredBool(const std::string& arguments_json,
                       const std::string& name,
                       bool* value) {
  nlohmann::json arguments;
  Status status = ParseArgumentsObject(arguments_json, &arguments);
  if (!status.ok()) {
    return status;
  }
  const auto iter = arguments.find(name);
  if (iter == arguments.end()) {
    return Status::InvalidArgument("missing required argument: " + name);
  }
  if (!iter->is_boolean()) {
    return Status::InvalidArgument("argument is not a bool: " + name);
  }
  *value = iter->get<bool>();
  return Status::Ok();
}
```

六个函数活法完全一样，就四步：把文本变成盒子 → 按名字找，找不到退回 → 看是不是要的类型 → 抄进调用方给的变量。其中两个是"偷懒"的：`GetRequiredDouble` 直接转手给 `GetRequiredNumber`（要的东西完全一样），`GetRequiredEnum` 先转手给 `GetRequiredString`（枚举在 JSON 里就是文字，先按文字抄出来，再核对名单）。

为什么最后那个参数是指针？返回值被"成功/失败"占用了——抄不到的时候必须告诉调用方。用指针不用引用，是因为调用点写 `&exposure_us` **一眼能看出这个变量会被改**。

一段一张表收尾：

```cpp
// 假如工具有 3 个参数
double exposure_us = 0.0;
GetRequiredDouble(arguments_json, "exposure_us", &exposure_us);  // 解析第 1 遍
int frame_count = 0;
GetRequiredInt(arguments_json, "frame_count", &frame_count);     // 解析第 2 遍
std::string label;
GetRequiredString(arguments_json, "label", &label);              // 解析第 3 遍
```

同一块数据被拆了三遍。为什么还这么写？调用点最简洁——一行抄一个值，读起来最清楚；而拆包的开销相比后面跟模型通信的时间（几百毫秒起步）完全可以忽略。参数特别多的话，可以改成"拆一次包、让工具自己反复查"，那是个合理的优化方向。

## 登记：Register

`ToolRegistry` 是仓库管理员：工具得有地方存、能按名字查、能执行。对外就三件事——登记（`Register`）、查（`ListTools` / `Find` / 清单生成）、执行（`Call`）。一个程序可能有多个仓库：一个 Agent 会话一个，或者一个设备一个，权限和生命周期都明确。

```cpp
Status ToolRegistry::Register(ToolDefinition tool) {
  if (tool.name.empty()) {
    AGENT4CPP_LOG_ERROR("tool register failed: tool name is empty");
    return Status::InvalidArgument("tool name is empty");
  }
  if (!tool.invoker) {
    AGENT4CPP_LOG_ERROR("tool register failed: invoker is empty: " + tool.name);
    return Status::InvalidArgument("tool invoker is empty: " + tool.name);
  }
  const std::string tool_name = tool.name;
  std::unique_lock lock(mutex_);
  const auto [_, inserted] = tools_.emplace(tool.name, std::move(tool));
  if (!inserted) {
    AGENT4CPP_LOG_ERROR("tool register failed: already exists: " + tool_name);
    return Status::AlreadyExists("tool already exists");
  }
  AGENT4CPP_LOG_INFO("tool registered: " + tool_name);
  return Status::Ok();
}
```

**两个前置检查都放在锁外。** 它们只用到传进来的参数，不碰共享数据，不需要锁。能不加锁就不加锁——锁越少，并发性能越好，出问题的可能也越小。`if (!tool.invoker)` 读作"如果这个工具没有配执行函数"，因为 `std::function` 可以被当成布尔值用：里面装着东西就是 `true`，空的就 `false`。

**先存一份名字**，因为下一行 `std::move(tool)` 会把 `tool` 搬空，之后 `tool.name` 就是空的了，日志里还要用。`std::move` 之后原对象不能再用，这是个很容易踩的点。

**写操作加独占锁**，因为往柜子里插东西会改动内部结构，多线程同时插会直接把柜子搞坏。然后 `emplace` 就地构造，返回两个东西：迭代器（用 `_` 占位丢掉）和 `inserted` 布尔值（名字已存在就返回 `false`）。

为什么用 `emplace` 的返回值判断重复，而不是"先 find 再 insert"：

```cpp
// ❌ 有问题的写法
if (tools_.find(name) == tools_.end()) {   // 第 1 步：查，发现不存在
  tools_[name] = tool;                      // 第 2 步：插
}
```

两个线程可能同时执行到第 1 步，都发现"不存在"，然后**都去插**——结果要么覆盖、要么容器结构被搞坏。这叫竞态窗口。`emplace` 是**原子的**：系统保证只有一个线程能插入成功，另一个一定拿到 `inserted = false`。把"查"和"插"合成一步，消灭中间那个窗口。

查的部分有个值得说的取舍。`ListTools` 返回的是**拷贝**，不是 `tools_` 的引用：

```cpp
std::vector<ToolDefinition> ToolRegistry::ListTools() const {
  std::shared_lock lock(mutex_);        // 读操作用共享锁
  std::vector<ToolDefinition> tools;
  tools.reserve(tools_.size());         // 提前分配，避免边加边扩容
  for (const auto& [_, tool] : tools_) {
    tools.push_back(tool);              // 逐个拷贝出来
  }
  return tools;
}
```

如果返回引用，锁在函数返回时就释放了，调用方手上那份"引用"随时会被别的线程改——数据竞争。拷贝一份出来等于拿到一张自己的快照，锁释放后怎么用都安全。代价是一次拷贝，但工具数量通常就几个到几十个，可接受。

底层容器用的是 `std::map` 而不是 `unordered_map`，因为要按名字有序遍历——日志和调试时，"工具按名字排好序"比随机顺序好读得多。`Find` 返回 `std::optional`，因为"可能找到也可能找不到"这件事，类型本身就该说清楚：

```cpp
std::optional<ToolDefinition> ToolRegistry::Find(const std::string& name) const {
  std::shared_lock lock(mutex_);
  const auto iter = tools_.find(name);
  if (iter == tools_.end()) {
    return std::nullopt;      // 没找到
  }
  return iter->second;        // 找到，拷一份返回
}
```

清单生成就是把每个工具的 schema 拼成一个大数组，这个字符串就是每次请求时附在请求里的"工具清单"：

```cpp
std::string ToolRegistry::ListOpenAIToolSchemas() const {
  std::shared_lock lock(mutex_);

  nlohmann::json schemas = nlohmann::json::array();
  for (const auto& [_, tool] : tools_) {
    schemas.push_back(nlohmann::json::parse(BuildOpenAIToolSchema(tool)));
  }
  return schemas.dump();
}

std::string ToolRegistry::ListToolSchemas() const {
  return ListOpenAIToolSchemas();   // 别名
}
```

这里持锁执行了 `BuildOpenAIToolSchema`。判断标准不是"持锁时能不能执行代码"，而是"这段代码会不会慢、会不会回调"——它是本项目的纯计算函数，不回调 registry，微秒级，所以安全。不过这行有点绕：`BuildOpenAIToolSchema` 返回的是**字符串**，这里又 `parse` 回对象塞进数组，最后整体再 `dump` 一次——多了一次"字符串 → 对象"的无用转换。更好的设计是让它直接返回 json 对象，但它是对外 API，返回字符串对使用者更友好（不用暴露 nlohmann 类型），属于可接受的取舍。

## 调度：Call

模型说"我要调 set_exposure，参数 8000"，Agent 就调 `registry.Call(...)`。这个函数分三步。

```cpp
ToolResult ToolRegistry::Call(const std::string& name,
                              const std::string& arguments_json) const {
  AGENT4CPP_LOG_DEBUG("tool dispatch received name=" + name +
                      " arguments=" + arguments_json);

  ToolDefinition tool;
  {
    std::shared_lock lock(mutex_);          // 加锁
    const auto iter = tools_.find(name);
    if (iter == tools_.end()) {
      return ErrorToolResult(Status::NotFound("tool not found: " + name));
    }
    tool = iter->second;                     // 拷贝一份
  }                                          // 锁在这里释放

  Status status = ValidateArguments(tool, arguments_json);
  if (!status.ok()) {
    return ErrorToolResult(status);
  }

  try {
    ToolResult result = tool.invoker(arguments_json);
    return result;
  } catch (const std::exception& error) {
    return ErrorToolResult(
        Status::Internal("tool threw exception: " + std::string(error.what())));
  } catch (...) {
    return ErrorToolResult(Status::Internal("tool threw unknown exception"));
  }
}
```

三步里只有第一步持锁，而且极短：找到工具、拷贝一份出来，出了大括号锁就释放。参数校验和执行都在锁外。

第二步参数不合格时，不是报错终止，而是包成"失败回执"返回。上层 Agent 会把它塞回给模型，模型看到原因后自己改参数重试——这就是前面说的"让模型自我修正"。

第三步调用用户代码必须 `try/catch`。这里看着跟"项目刻意不用异常"矛盾，其实不矛盾，是那条原则的另一面：**库自己不用异常做控制流，但必须防着用户的代码抛异常。** 用户写的工具函数里可能 `new` 失败、`std::stoi` 遇到非法输入、调相机 SDK 抛异常……这些控制不了。不兜住的话，异常会一路穿过 `Call`、穿过 Agent 的循环，把整个程序掀掉。

| catch | 接住什么 |
|---|---|
| `catch (const std::exception& error)` | 标准异常，能用 `error.what()` 说出是什么错 |
| `catch (...)` | **任何东西**——包括不是 `std::exception` 子类的（比如有人 `throw` 一个整数）。少这一层，那些异常就漏出去了 |

### 为什么先拷贝、释放锁，再执行

![锁的边界](/images/agent4cpp/lesson05-锁的边界.svg)

因为 `tool.invoker` 是用户代码，我们完全控制不了它。

| # | 问题 | 具体后果 |
|---|---|---|
| ① | **它可能很慢** | 工具函数可能去调相机、发网络请求、等设备响应，耗时几百毫秒甚至几秒。持着锁执行，这段时间里**所有**其他线程的 `ListTools`、`Find`、甚至另一个 `Call` 全被堵死——整个 Agent 卡住 |
| ② | **它可能反过来再调 registry，这会死锁** | 用户完全可能这么写：`AGENT4CPP_TOOL(do_two_things, "...") { registry.Call("set_exposure", ...); }`。外层 `Call` 还持着锁，内层又要拿同一把锁——`shared_mutex` **不递归**（同一线程也不能重复拿），直接死锁 |
| ③ | **拷贝的代价很小** | `ToolDefinition` 里就是几个字符串 + 一个 `std::function`，拷贝一次微秒级。拿它换"不阻塞别人 + 不死锁"，太值了 |

### 为什么是 shared_mutex

![共享锁](/images/agent4cpp/lesson05-共享锁.svg)

看这个类的实际访问模式：写（`Register`）在启动时一次性做完，之后几乎不再写；读（`ListTools` / `Find` / `Call` 里的查找）每轮对话都要调，而且可能多个线程同时调。**读多写少**就是这个类的工作模式。

| | 普通 `mutex` | `shared_mutex` |
|---|---|---|
| 读 vs 读 | **互斥**（明明只是读，也得排队） | **可并发** |
| 读 vs 写 | 互斥 | 互斥 |
| 写 vs 写 | 互斥 | 互斥 |

用普通 `mutex` 的话，三个线程同时 `ListTools` 会被强行串成一条线，白白浪费并发能力。`shared_mutex` 给了两种卡：读者卡（`shared_lock`）多人可同时进，写者卡（`unique_lock`）一次只能进一个、且不许有读者在里面。代码里就是：

```cpp
std::unique_lock lock(mutex_);   // Register 里（写）—— 独占卡
std::shared_lock lock(mutex_);   // ListTools / Find / Call 里（读）—— 读者卡
```

别写反了。

### 贯穿整个类的几个细节

`std::shared_mutex` 那两种卡，用法上靠的是 RAII：

```cpp
{
  std::shared_lock lock(mutex_);    // ← 创建对象 = 加锁
  ...
}                                   // ← 对象销毁 = 自动解锁
```

全程没有一行 `unlock()`。锁的释放是自动的——`lock` 这个局部对象离开大括号时被销毁，它的析构函数负责解锁。手动加解锁一旦中间 `return` 或抛异常，就会跳过 `unlock` 直接死锁；RAII 不可能忘。`Call` 里那个包着查找的大括号不是随便加的，**它就是在划定锁的生命周期**。

`mutable` 是给编译器开的一个口子。`Call` 是 `const` 方法（确实不改仓库内容），但加锁这个动作本身会修改 mutex 的内部状态，编译器会拦住。所以：

```cpp
mutable std::shared_mutex mutex_;
//  ↑ "这个成员例外，在 const 方法里也允许改"
```

还有三个小语法。结构化绑定一次接住 `emplace` 返回的两个东西：

```cpp
const auto [_, inserted] = tools_.emplace(tool.name, std::move(tool));
//          ↑迭代器（占位）  ↑bool，是否插入成功
```

`[[nodiscard]]` 表示"返回值不许无视"——调用 `ListTools()` 却不用返回值，编译器会警告，因为这些方法的返回值就是结果本身。CTAD 是 C++17 起的模板参数自动推导，`std::shared_lock lock(mutex_);` 不用再写 `<std::shared_mutex>`。

头文件本身很简单，两个私有成员——仓库 + 门禁：

```cpp
#ifndef AGENT4CPP_TOOL_REGISTRY_H_
#define AGENT4CPP_TOOL_REGISTRY_H_

#include <map>            // std::map：抽屉柜
#include <shared_mutex>   // std::shared_mutex：两种卡的门禁
#include <optional>       // std::optional：可能没有的盒子
#include <string>
#include <vector>

#include "agent4cpp/export.h"   // AGENT4CPP_API
#include "agent4cpp/tool.h"     // ToolDefinition / ToolResult / Status

namespace agent4cpp {

class AGENT4CPP_API ToolRegistry {
 public:
  Status Register(ToolDefinition tool);

  [[nodiscard]] std::vector<ToolDefinition> ListTools() const;
  [[nodiscard]] std::optional<ToolDefinition> Find(const std::string& name) const;
  [[nodiscard]] std::string ListOpenAIToolSchemas() const;
  [[nodiscard]] std::string ListToolSchemas() const;

  ToolResult Call(const std::string& name, const std::string& arguments_json) const;

 private:
  std::map<std::string, ToolDefinition> tools_;   // 仓库
  mutable std::shared_mutex mutex_;               // 门禁
};

}  // namespace agent4cpp

#endif  // AGENT4CPP_TOOL_REGISTRY_H_
```

注意 `include` 的顺序：`<map> <shared_mutex> <optional> <string> <vector>` —— 这**不是**纯字母序（`shared_mutex` 跑到了 `optional` 前面）。原项目就是这么排的，照写。

## 我踩过的坑

集中说一下，这些比代码本身更值得记。

**以为 JSON 里有 `enum` 类型。** 我一开始把 `kEnum` 翻译成 `"enum"`，模型那边一直报参数类型不认识。JSON 里根本没有 `enum` 这个类型，枚举的表达方式是"类型算 `string`，另外给一张可选值清单"。这个点改过来之后，序列化那边一下通了。

**把 JSON 的字段名当普通字符串手写。** `schema["funcion"]["name"] = ...`（少打一个 `t`），编译器**不会报错**——对它来说那只是个普通字符串，它不知道应该是个固定字段名。结果模型收不到工具名，查了半天。后来把 `"type"`、`"function"`、`"name"` 全做成 `constexpr char` 常量，拼错当场被编译器抓住（未定义标识符）。

**`OkToolResult` 里填格子的顺序填反了。**

```cpp
ToolResult OkToolResult(std::string content, std::string payload_json) {
  //                                ↑ 收进来时：人话在前
  return ToolResult{Status::Ok(), std::move(payload_json), std::move(content)};
  //                              ↑ 装进回执时：数据在前
}
```

函数**收参数**的顺序是"人话、数据"，而 `ToolResult` **字段**的顺序（看 `tool.h`）是"状态、数据、人话"，两者是反的。写反了编译器**不会报错**——人话和数据都是 `std::string`，类型一样，它分辨不出来；但运行时两者内容会互换，模型收到一堆错乱数据。凡是"按顺序填格子"的写法都有这个陷阱，写的时候一定对照结构体字段顺序。

**校验时遍历方向搞反了。** 我最初遍历的是"模型实际传了哪些参数"，结果必填项漏传这种情况**永远查不出来**——它压根不在你遍历的列表里。必须拿"资料卡上声明了哪些参数"去核对模型传来的东西，才能发现"少了什么"。

**可选参数没给时写了 `return` 而不是 `continue`。** 写成 `return Status::Ok()` 就提前结束了，后面那些参数根本没检查。必填没给才 `return` 错误，可选没给要 `continue` 跳过、继续查后面的。

**用 `tools_[name]` 去查工具。** `operator[]` 在 key 不存在时会**静默插入一个默认构造的 `ToolDefinition`**——查一个不存在的工具，反而把仓库搞脏了，还返回一个空壳。查询一律用 `find`，找不到就返回 `nullopt` / 错误。

**持锁执行了用户代码。** 这是我一开始最自然的写法——找到了、顺手就调了。后果是工具函数一慢，整个 Agent 卡住；更糟的是，如果用户工具内部又调 registry，会直接死锁（`shared_mutex` 不递归）。改成"先拷贝、释放锁、锁外执行"才对。

**`std::move` 之后还去读 `tool.name`。** `Register` 里 `std::move(tool)` 把对象搬空之后，日志里再打印名字就是空串了。得提前存一份。

**`mutex_` 忘了标 `mutable`。** `Call` 是 `const` 方法，但里面要读锁，`const` 方法里改不了普通成员，编译不过。这个坑我在写工具注册表时踩过一次，写 Agent 循环时第二次遇到。

**`[&]` 捕获对象带来的悬空风险。** `AGENT4CPP_REGISTER_METHOD` 用 `[&]` 按引用捕获对象。项目里假定 registry 和对象生命周期一致，所以没事；但只要对象是局部的、注册完就析构，后面一调必崩。用这个宏时得清楚这个前提。

**每个 `GetRequiredXxx` 都重复解析整块 JSON。** 三个参数就拆三遍。我保留了它，因为调用点最简洁，而这点开销相比跟模型通信的时间可以忽略——但我知道这是个低效点，参数特别多时该优化。

**以为"不用异常"和"这里写 try/catch"矛盾。** 绕了一下才想明白：库自己不用异常做控制流，但必须防着用户代码抛异常，这是同一条原则的两面。所以 `ParseArgumentsObject` 接住 JSON 库的爆炸、`Call` 接住用户代码的爆炸，一个都不能少。

## 怎么确认它真的在工作

编译运行之后，下面这些输出是我实测的：

```text
### 1. 注册工具 ###
  注册 set_exposure -> OK
  再注册一次（应报已存在） -> ALREADY_EXISTS: tool already exists
  注册空名字（应报参数错误） -> INVALID_ARGUMENT: tool name is empty
  注册没有执行函数的（应报参数错误） -> INVALID_ARGUMENT: tool invoker is empty: empty

### 2. 查询 ###
  ListTools 数量 = 2（期望 2）
  找到 set_exposure: 是
  找到 not_exist:    否

### 3. 校验参数 ###
  正常参数     -> OK
  缺必填参数   -> INVALID_ARGUMENT: missing required argument: exposure_us
  类型错       -> INVALID_ARGUMENT: argument has invalid type: exposure_us
  JSON 语法错  -> INVALID_ARGUMENT: invalid arguments JSON: [json.exception.parse_error.101] ...
  不是对象     -> INVALID_ARGUMENT: tool arguments must be a JSON object

### 4. 执行工具 ###
  正常调用: status = OK, content = 曝光已更新。, payload = {"exposure_us":8000.000000}
  参数类型错: INVALID_ARGUMENT: argument has invalid type: exposure_us
  业务不合法（负数，格式检查放行、工具函数拦住）: INVALID_ARGUMENT: 曝光时间必须为正数。
  工具不存在: NOT_FOUND: tool not found: not_exist
  工具抛异常（被兜住，程序没崩）: INTERNAL: tool threw exception: 设备通信失败
```

最后两行值得盯着看。第一行演示了**分层**：`-1` 是数字，格式合法，校验层放行；"曝光不能为负"由工具函数自己拦住。第二行演示了**异常兜底**：工具函数抛了 `std::runtime_error`，被 `Call` 接住转成错误回执——**程序没崩**。

## 几个我当时犹豫过的设计

**工具返回值为什么要语义化。** 我最初只想返回数据。后来发现相机亮度返回 `0.5` 的同时，必须把目标值 `1.0` 和量纲说明 `0.0=black, 1.0=correct exposure` 一起给出去——模型读了才能算出该把曝光调到多少。只给 `0.5` 它只能瞎猜，可能越调越暗。这条代价是工具实现时要多写几行 payload 构造代码，我认为值。

**为什么不用 C++ 反射自动推导参数。** 项目定位是"轻量、可读、可迁移"，不是通用框架。统一收 JSON 字符串、内部自己解析，免去复杂反射，代码简单可读，新人能直接看懂。代价是每个工具要手写几行取值代码，这个边界我清楚。

**`ListOpenAIToolSchemas` 里那次多余的 `parse`。** 想过让 `BuildOpenAIToolSchema` 直接返回 json 对象，但它是对外 API，返回字符串对使用者更友好——不用把 nlohmann 类型暴露出去。属于可接受的取舍，我知道它多了一次转换。

**`Call` 里那个 `catch (...)`。** 一开始觉得多余（有 `catch (const std::exception&)` 不够吗），后来意识到用户可能 `throw` 一个非 `std::exception` 的东西（比如一个整数），少这一层就漏出去了。宁可多写一行。
