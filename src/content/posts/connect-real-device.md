---
title: 怎么把一个真实设备接进这套框架
description: "把设备接进来，难的不是包一层，而是给设备函数补上说明、边界、回执和语义化观测值这四样它原来没有的东西。"
pubDate: 2026-10-05
tags: [C++, 工业相机, LLM, Agent]
---

这一篇讲的是整条链路的最后一公里：**把你手里那台真实设备接进来。**

前面几篇讲的都是框架内的事——循环怎么转、工具怎么定义、参数怎么校验。但这一切最后要落到一件具体的事上：你那台工业相机、那台运动平台、那个光源控制器，怎么变成模型能调的工具？

这篇不打算逐行讲 `examples/camera_mock/main.cpp` 那个示例。它是个道具——用一个假相机演完整闭环的小程序。我想讲的是：**你拿到自己的设备代码，照着什么路子接。**

## 一、先看清要跨的那道墙

这块墙是我做这事之前没想清楚的。

我的相机代码是现成的——枚举设备、开流、设曝光、软触发抓图，这些海康 MVS 的调用我写了不止一遍。我最初以为"接进 Agent"就是把这些函数再包一层。

后来想明白了，不是"再包一层"那么简单。两边对世界的假设根本不一样：

| 你在做的事 | 你那台真设备 | 模型那边 |
|---|---|---|
| 谁在调 | 你写死的调用顺序 | 模型自己决定下一步 |
| 参数从哪来 | 界面上的输入框 | 一段自然语言推理出来的 JSON |
| 会不会失败 | 偶尔，你会 try/catch | 每步都可能失败，模型得知道原因 |
| 返回值给谁 | UI 显示给人看 | 给模型做下一步推理用 |
| 快不快 | 你没在意过 | 一次几百毫秒到几秒，模型可能随时叫你 |

所以接设备这件事，本质上不是"把函数注册一下"，而是**给你的设备函数补上这四样它原来没有的东西**：

1. 一个**说明**——告诉模型这个功能是干嘛的、参数什么含义
2. 一个**边界**——防住模型乱传参数
3. 一个**人话版的回执**——失败时告诉它为什么失败
4. 一个**语义化的观测值**——让模型看得懂设备返回的数字是什么意思

最后那条是这篇最值钱的东西，我单独放一节讲。

## 二、示例程序演的是什么

先把示例的位置交代清楚。`camera_mock` 就三块：

```text
① MockCamera           假相机：只有一个曝光值，亮度 = 曝光 / 10000
② 两个 C++ 工具
     get_camera_status 查状态 —— 返回语义化观测值 
     set_exposure      改曝光 —— 带范围校验
③ CameraDemoLLMClient  假模型：一摞写好的台词，演三步闭环
   main()               组装：注册工具 → 选模型 → 建 Agent + CLI → 跑
```

它跑起来是这样：

```text
agent4cpp > image is dark
thinking...
assistant | Done. Exposure is now adjusted for a brighter image.
```

用户一句话，Agent 自己查状态、自己判断偏暗、自己调曝光、自己收尾。**这个过程是真设备接进来之后想要的效果。**

**关键：你替换的只有 `MockCamera` 那一层。** 两个工具函数、Agent 循环、假模型，一行都不用动。这就是这套架构解耦得好的地方——设备是个可替换的零件，不是嵌在流程里的钉子。

![设备函数怎么变成模型能调的工具](/images/agent4cpp/lesson12-封装路径.svg)

这张图是这篇的主线：左边是你的设备函数（原来只有 C++ 签名），右边是模型能看能调的东西（说明 + Schema + 工具），中间这条路径就是这篇文章要讲的全部动作。

## 三、那个假相机，和真设备的差距

先看假相机长什么样：

```cpp
class MockCamera {
 public:
  double exposure_us() const { return exposure_us_; }
  void set_exposure_us(double exposure_us) { exposure_us_ = exposure_us; }

  double Brightness() const {
    return exposure_us_ / 10000.0;   // 亮度 = 曝光 / 10000
  }

 private:
  double exposure_us_ = 5000.0;      // 初始 5000 → 亮度 0.5，偏暗
};
```

一个值、一个除法、零失败可能。这就是它和真设备的差距：

| | MockCamera | 真实相机 |
|---|---|---|
| 初始化 | 构造即可用 | 枚举设备 → 打开句柄 → 开流，任一步都可能失败 |
| 状态 | 一个 double | 需要先连上才能查 |
| 失败 | 不存在 | 断连、超时、句柄失效、设备被别的进程占用 |
| 资源 | 没有 | 句柄要管，用完必须释放 |
| 耗时 | 微秒 | 几十到几百毫秒，抓图更慢 |

**但这个差距不改工具接口。** 工具对外还是那两句话：`get_camera_status` 无参数、`set_exposure` 收一个 `exposure_us`。真设备带来的那些麻烦——重连、超时、句柄——**全部封在工具函数内部**，用 `Status` 返回出来。模型那边看到的只是"这次调用失败，原因是设备断连"，它自己会决定要不要重试。

这就是接设备的核心动作：**把设备的复杂度挡在工具函数里面，外面只留一个干净的接口。**

## 四、动作一：给设备函数补一段"使用说明书"

最容易被低估的一步。

工具注册的时候要填一段 `description`。我一开始是照抄 C++ 注释的——写了个 "Get current mock camera exposure and brightness." 就完事了。

后来发现不行。这段话**是发给模型的**，模型全靠它决定什么时候调这个工具、参数该填多少。它不是注释，是接口文档，而且是写给一个没看过你代码、只知道自然语言的外行看的。

对比一下那个示例里两处的差别：

```cpp
// 工具函数头上那行（作者自己看）：
AGENT4CPP_TOOL(get_camera_status,
               "Get current mock camera exposure and brightness.")

// 注册时那行（发给模型看的）：
AGENT4CPP_REGISTER_FUNCTION(
    registry, set_exposure,
    "Set mock camera exposure time in microseconds. Brightness equals "
    "exposure_us / 10000, so 10000 us is correct exposure; use a smaller "
    "value to darken the image and a larger value to brighten it. "
    "Valid range is 100 to 100000.",
    AGENT4CPP_NUMBER_ARG(
        "exposure_us",
        "Exposure time in microseconds, 100 to 100000. "
        "10000 us gives brightness 1.0 (correct exposure)."))
```

差别巨大。注册那句里多出来的全是**模型做决定需要的东西**：

| 写进去的 | 模型拿它做什么 |
|---|---|
| 亮度 = 曝光 / 10000 | 知道参数的量纲，不是瞎猜 |
| 10000 是正确曝光 | 知道目标值，能算出该调多少 |
| 调小变暗、调大变量 | 知道方向，不会越调越暗 |
| 范围 100 到 100000 | 减少传越界值的概率 |

**我踩过的坑就在这里**：我第一版注册时用的就是 "Set exposure time." 这种话。模型完全不理解参数是什么意思，用户说"太亮了"，它反手把曝光调更大。不是模型笨，是我没告诉它哪个方向是亮。

**把 description 当使用说明书写，不是当注释写。** 你用设备时心里知道的那些默认知识——量纲、方向、合理范围——都得写进去。这些"常识"对模型全是空白。

## 五、动作二：语义化观测值——这一步我做对了

这是我整个项目里最想说的一点，也是这篇的重点。

先看问题。如果 `get_camera_status` 只返回一个裸数字：

```json
{"brightness": 0.5}
```

模型拿到 0.5 会怎么想？**它不知道 0.5 是高还是低。**

它没有你的"亮度刻度"这个概念。0.5 在有些系统里算正常，在另一些系统里算严重欠曝。模型没有任何参照，只能瞎猜——而瞎猜的代价是它可能把曝光往反方向调。

正确的做法是：**把语义一起给它。**

```cpp
AGENT4CPP_TOOL(get_camera_status,
               "Get current mock camera exposure and brightness.") {
  const double brightness = g_camera->Brightness();
  const char* assessment = brightness < 0.9   ? "underexposed"
                           : brightness > 1.1 ? "overexposed"
                                              : "normal";
  return agent4cpp::OkToolResult(
      "Camera status returned.",
      "{\"exposure_us\":" + std::to_string(g_camera->exposure_us()) +
          ",\"brightness\":" + std::to_string(brightness) +
          ",\"brightness_target\":1.0"                                              // ← 目标值
          ",\"brightness_scale\":\"0.0=black, 1.0=correct exposure, >1.0=overexposed\""  // ← 量纲
          ",\"assessment\":\"" + assessment + "\"}");                               // ← 结论
}
```

只比"裸数字版"多三样东西：

| 加的字段 | 值 | 作用 |
|---|---|---|
| `brightness_target` | `1.0` | 告诉模型"多亮算对" |
| `brightness_scale` | `"0.0=black, 1.0=correct..."` | 量纲说明，模型一读就懂刻度 |
| `assessment` | `"underexposed"` | 直接给结论，省得模型自己算 |

加完这三样，模型就能自己推理了：

```text
brightness 0.5 < brightness_target 1.0
  → assessment 说 underexposed
  → 该把曝光调大
  → 目标 10000 us（description 里写了）
```

**这一条不只适用于相机，是所有设备工具的通用规律。** 温度控制器返回 `{"temp": 45}`——45 度高不高？压力传感器返回 `{"pressure": 2.3}`——2.3 是什么单位、正常吗？编码器返回 `{"position": 12000}`——离目标多远？

模型不知道你的物理世界的刻度。**你要在工具返回的时候，一次性把"人来解读数据"这件事说清楚**，而不是丢个数字让模型猜。

我后来把所有设备工具的返回值都改成了这个套路：数字 + 单位/量纲 + 目标或正常范围 + 直接结论。多写几行 payload 构造代码，换来模型能自己判断——值。

## 六、动作三：工具是最后一道防线

模型可能传越界值。示例里的 `set_exposure` 做了一次范围校验：

```cpp
AGENT4CPP_TOOL(set_exposure,
               "Set mock camera exposure time in microseconds.") {
  double exposure_us = 0.0;
  const auto status =
      agent4cpp::GetRequiredNumber(arguments_json, "exposure_us", &exposure_us);
  if (!status.ok()) {
    return agent4cpp::ErrorToolResult(status);
  }
  if (exposure_us < 100.0 || exposure_us > 100000.0) {     // ← 范围校验
    return agent4cpp::ErrorToolResult(agent4cpp::Status::InvalidArgument(
        "exposure_us must be in range [100, 100000]"));
  }
  g_camera->set_exposure_us(exposure_us);
  return agent4cpp::OkToolResult("Exposure updated.",
                                 "{\"exposure_us\":" + std::to_string(exposure_us) + "}");
}
```

框架的校验层只管**格式**——是不是数字、有没有少参数。它管不着"曝光时间 999999 是不是离谱"，因为那是业务知识。**业务校验必须写在工具函数里。**

这里有个真设备上特别重要的细节：**失败要返回 `Status`，不要抛异常。**

```cpp
// 对的写法：
return agent4cpp::ErrorToolResult(agent4cpp::Status::InvalidArgument(
    "exposure_us must be in range [100, 100000]"));

// 真设备上更常见的：
return agent4cpp::ErrorToolResult(
    agent4cpp::Status::Unavailable("camera disconnected, last handle invalid"));
```

为什么？因为返回失败状态，这个原因会被塞回给模型，模型看到下一轮就自己改了——参数越界它就调小，设备断连它就知道要重连。**你抛异常的话，上层虽然兜得住（框架 `Call` 里有 try/catch），但模型拿到的信息是"内部错误"，它就不知道怎么自救了。**

真设备接进来之后，工具里要主动检查的失败至少这几类：

| 失败 | 返回什么 | 模型能做什么 |
|---|---|---|
| 句柄为空 / 没连接 | `Unavailable("camera not connected")` | 先调连接工具 |
| 连接超时 | `Unavailable("connect timeout")` | 重试或换设备 |
| 参数越界 | `InvalidArgument("... range ...")` | 改参数重试 |
| 抓图失败 | `Internal` 或 `Unavailable` | 重试或报告 |
| 设备被占用 | `Unavailable("device busy")` | 稍后再试 |

关键是**每类的 message 要写具体的**，模型全看这段文字做判断。写 `Unavailable("error")` 等于没写。

![真设备和 mock 的区别，全在工具函数里面](/images/agent4cpp/lesson12-工具内部分层.svg)

这张图画的是"外壳不变、内里换芯"：工具对外的名字、参数、返回结构完全一样，但函数体里面从"一个 double 赋值"变成了一整套设备操作 + 错误处理。

## 七、动作四：把设备类包进工具，用宏还是用手写

你说接真实设备，工具函数里肯定要调你那个设备对象的方法。示例里用的是普通函数 + 全局指针：

```cpp
MockCamera* g_camera = nullptr;   // 工具函数是 static 的，访问不到 main 里的局部变量

AGENT4CPP_TOOL(get_camera_status, "...") {
  const double brightness = g_camera->Brightness();   // 靠全局指针去够
  ...
}
```

这个写法在示例里能用，因为相机是 `main` 里的局部对象，工具函数够不着它，只能拿个全局指针指过去。

**接真实设备时不建议照抄这个"全局指针"的写法。** 你有两种更干净的选择：

```cpp
// 写法 A：注册普通函数，函数内部通过参数/单例拿设备
// 适合设备本来就是单例的场景（一台机器接一台相机）

// 写法 B：注册对象方法，直接把设备对象的方法挂上去
CameraController camera;
AGENT4CPP_REGISTER_METHOD(registry, camera, setExposure,
                          "Set camera exposure time in microseconds.",
                          AGENT4CPP_DOUBLE_ARG("exposure_us", "Exposure time in microseconds, 100 to 100000."));
```

写法 B 的展开就是一层 lambda 转发：

```cpp
[&](const std::string& arguments_json) -> agent4cpp::ToolResult {
  return (camera).setExposure(arguments_json);
}
```

**但这里有个坑得知道**：`[&]` 是按引用捕获 `camera` 的。如果 `camera` 是个局部变量、注册完就析构了，后面一调必崩。用写法 B 的前提是——**`camera` 的生命周期必须活过 `registry` 和 Agent**。真实项目里通常把设备对象放成宿主程序的成员，和 registry 同生共死，就没问题。

我的经验是：**设备对象是单例（一台机器一台设备）就用写法 A，设备对象需要多实例（多个相机通道）就用写法 B。** 别用全局裸指针硬够——那是示例为了短才那么写的，生产代码里全局可变状态是灾难。

## 八、换模型那一行不用动

示例里有一段很值得看的代码——它证明整个链路对设备是真正解耦的：

```cpp
std::shared_ptr<agent4cpp::ILLMClient> llm;
const std::string base_url = ReadArg(argc, argv, "--base-url", "");
if (base_url.empty()) {
  llm = std::make_shared<CameraDemoLLMClient>();          // 假模型
} else {
  agent4cpp::OpenAICompatibleLLMConfig llm_config;
  llm_config.base_url = base_url;
  llm_config.model = ReadArg(argc, argv, "--model", "gpt-4.1-mini");
  llm = std::make_shared<agent4cpp::OpenAICompatibleLLMClient>(llm_config);  // 真模型
}
```

**换个助手，工具注册和 Agent 循环一行不用改。** 因为假模型和真模型都实现同一个 `ILLMClient` 接口。

这件事对设备接入的意义是：你可以**先用假模型把设备工具调到痛快**（不联网、不花钱、结果可复现），确认工具本身没问题了，再加 `--base-url` 切真模型。调试设备工具和调试模型行为这两件事完全可以分开做。

**我就是这么干的**——真实相机接进来的时候，先用写死的假模型验收"枚举设备 → 设曝光 → 抓图"这条链路通不通，通了之后才接真模型测自然语言驱动。

## 我踩过的坑

集中说一下，接设备这块的坑比框架内部更隐蔽。

**工具返回值只给裸数字。** 我最早 `get_camera_status` 就返回 `{"brightness": 0.5}`。模型看到 0.5 完全没概念，用户说"太亮了"，它反手把曝光调更大——因为它不知道 0.5 是低还是高。加上 `brightness_target` / `brightness_scale` / `assessment` 三样之后，它才开始稳定地往正确方向调。**这是这篇最值得记的一条：设备返回的每个数字，都得附上它能被解读的上下文。**

**description 照抄了 C++ 注释。** "Set exposure time." 这种话对模型等于没说。它不知道单位、不知道方向、不知道范围，调参全靠乱猜。注册用的 description 是**给模型的说明书**，量纲、方向、目标值、合法范围都得写进去。

**设备失败时抛异常，而不是返回 Status。** 框架兜得住异常，程序不崩，但模型收到的是笼统的"内部错误"，它不知道是断连了还是参数错了，下一轮还是瞎调。改成返回 `Unavailable("camera disconnected")` 这种具体状态之后，模型看到就会先去重连。

**用全局裸指针去够设备对象。** 示例里 `g_camera` 那个写法是为了短，生产代码里全局可变状态会带来初始化顺序、多实例、生命周期一堆问题。**这个坑是我照抄示例时踩的**——单相机没事，一上双相机就全乱套。

**设备对象的生命周期没管住。** 用 `AGENT4CPP_REGISTER_METHOD` 时，`[&]` 按引用捕获设备对象。设备对象若是局部的，注册完就析构，之后一调必崩。项目里必须保证设备对象活得比 registry 和 Agent 都久。

**以为"接设备"就是把 SDK 调用包一层。** 实际要补的是四样东西：说明、边界、人话回执、语义化观测值。少写哪样，模型就多一分瞎调的可能。

## 九、怎么确认接对了

接真设备的验收，我建议分两步走，别一步到位。

**第一步：假模型验收链路。** 先把设备操作全部注册成工具，用一个写死台词、且台词里**故意带越界参数和断连场景**的假模型跑一遍。确认工具能正确返回失败状态、模型能"看到"原因。这一步不联网，可复现。

**第二步：真模型验收自然语言。** 加 `--base-url` 切真模型，用自然语言驱动，把 `transcript` 打出来看。

一份接对了的日志大概长这样：

```text
user input: 图像太暗了
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
assistant final answer: 我把曝光调到了 8000 us，图像应该会亮一些。
```

盯三个地方：模型的第二步决定**是不是朝对的方向调**（语义化观测值有没有起作用）；`set_exposure` 的 payload 里**参数有没有被工具拦住**；以及断连场景下模型**是不是先去重连了**。

如果模型调参方向老是反的，八成是观测值不够语义化——回去补 `brightness_target` 和 `assessment`。

## 十、几个我当时犹豫过的设计

**语义字段到底该给几样。** 一开始只加了 `assessment`（结论），够模型用一阵。后来发现设备一多，不同的量纲让它频繁误判，才把 `brightness_target` 和 `brightness_scale` 都补上。结论是：**目标值和量纲是底线，结论能加就加。** 结论省模型的推理步骤，量纲让它不容易在陌生设备上翻车。

**设备失败到底是重试还是上报。** 我犹豫过要不要在工具里自动重连三次。最后没做——**把重连也做成一个独立工具**，让模型决定。原因很简单：自动重连会掩盖设备问题的真实频率，而且重试策略该不该执行，跟当前任务上下文有关（用户可能就想知道设备到底怎么了）。让模型看见失败、自己决定，比工具里偷偷重试更透明。代价是模型偶尔会忘了重连，但至少日志里看得到。

**工具颗粒度：一个粗工具还是几个细工具。** 比如"抓一张图"到底是 `capture()` 一个工具，还是 `open_stream` / `software_trigger` / `grab_frame` 三个工具分开？我选了**细一点的拆法**。因为模型的能力恰恰在于"看情况组合"——它能在抓图失败时只重试 `grab_frame`，而不用把整个流重启一遍。粗工具省注册代码，但把决策权从模型手里收走了。这条我还在观察，任务简单时粗工具确实更省 token。

设备接进来，整条链路才算真正落地。这一篇之后，`agent4cpp` 从"一个能跑的框架"变成"一个能驱动你那台真设备的东西"——差别不在框架里，就在你那几个工具函数里补的那四样东西。
