---
title: 外挂一个面板：插件契约与 ABI 的代价
description: 往程序目录里丢一个 DLL，主程序就多一个面板，而主程序一行代码都没改。这一篇讲 ZyClear 的面板插件系统——启动扫目录、QLibrary 装载、两个纯 C 导出函数撑起整条契约、注册表按 id 去重、QDockWidget 的停靠体系。以及这条契约的全部代价：同一套编译器、导出名改不动、析构必须虚。
pubDate: 2026-09-29
tags: [C++, Qt, 插件系统, ABI, 工业软件]
---

上一篇把面板之间的通信收成了一条事件总线：六个语义事件、按位掩码投递、进程内唯一的全局总线。但那篇结尾留了个尾巴——**到第九篇为止，所有面板都是编译进主程序的。** `ControlWidget`、`ParamWidget`、`ViewWidget` 各自实现 `Listener`、各自在构造时注册，它们是主程序的一部分，改一行就得重编整个工程、重新发版。

这一篇回答那个尾巴：**如果我想加第五个面板，而且要求不重新编译主程序呢？**

一句话先立住：**插件系统买到的是一样东西——新增面板不重编主程序；代价是那条契约一旦定了，就不能改。**

## 为什么面板值得做成插件

先说清楚这笔账划不划算。面板编译进主程序的写法，最直接，也最省事：

```cpp
// 编进主程序：加一个面板就在构造里 new 一个
m_pParamWidget = new ParamWidget(this);
m_pViewWidget  = new ViewWidget(this);
```

对一个「四个面板、稳定不怎么变」的程序，这样就够了，没必要上插件。**但智澈的面板是会长的**：这一版有控制栏、参数、预览、日志、AI 侧栏；下一版可能想加相机标定、加产线编排、加外部团队自研的专用面板。

**问题出在「加面板」这件事的成本随主程序膨胀。** 主程序越大，编译一次越慢；每加一个面板，都要重编整个工程、重跑一遍测试、重新发一个版本的安装包。而其中的改动可能只是「多了一个面板」，跟相机链路、参数体系、事件总线这些真正复杂的部分毫无关系。**为一个增量面板重编一整个桌面客户端，这个成本高得不成比例。**

更实际的场景是**外部协作**：标签面板如果是别的团队写的，或者某个现场用户自己攒的，你不可能让他们拿到整个主程序的源码去编译。他们只应该拿到一个头文件、一个接口约定，编出一个 DLL，丢进程序目录，重启就出现。

**所以插件的价值不是「架构更高级」，是「把加面板这件事从『重编发版』降级成『丢一个文件』」。** 我承认它带来了一整套成本——后面整篇都在讲这些成本——但对一个持续长出面板的客户端，这笔账是划算的。

## 装载：扫一个目录，认两个符号

![扫目录，认两个符号](/images/zyclear/插件装载.svg)

主程序装载插件的全部逻辑，在 `mainwindow.cpp` 里一个三十来行的匿名命名空间函数里：

```cpp
void LoadExternalExtensions(PanelRegistry* registry)
{
    const QDir pluginDir(QCoreApplication::applicationDirPath()
        + QStringLiteral("/extensions"));
    if (!pluginDir.exists()) {
        return;
    }
    const QFileInfoList plugins = pluginDir.entryInfoList(
        QStringList { QStringLiteral("*.dll") }, QDir::Files);
    for (const QFileInfo& plugin : plugins) {
        registry->LoadFromLibrary(plugin.absoluteFilePath());
    }
}
```

扫描路径是**可执行文件所在目录下的 `extensions/` 子目录**，只认 `.dll` 这一层（不递归）。用 `applicationDirPath()` 而不是当前工作目录，是因为工作目录会随启动方式变——从 IDE 启动、从资源管理器双击、从命令行带参数启动，工作目录各不相同，只有可执行文件自己的位置是稳定的。**插件目录是程序的一部分，就该跟着程序走。**

目录不存在直接返回，某个 DLL 不合规只记一条日志继续走。`LoadExternalExtensions` 上面的注释写得很直白：**「扩展永远不该让主程序起不来。」** 这是插件系统第一条、也是最重要的一条纪律——插件是可选增益，不是必需依赖，任何插件的问题都不能传染给宿主。

**「是不是合法插件」的判断标准只有一个：能不能 resolve 出约定的两个符号。** 不是看扩展名、不是看有没有某个标记文件、也不是看导出表里有没有别的东西。`PanelRegistry::LoadFromLibrary` 里干的就是这事：

```cpp
auto countFunction = reinterpret_cast<CountFunction>(
    library->resolve(ZYCLEAR_EXTENSION_COUNT_FN));
auto atFunction = reinterpret_cast<AtFunction>(
    library->resolve(ZYCLEAR_EXTENSION_AT_FN));

if (countFunction == nullptr || atFunction == nullptr) {
    qWarning() << "扩展库缺少约定的导出函数:" << libraryPath;
    delete library;
    return 0;
}
```

**resolve 不到这两个符号，这个 DLL 就不是插件**，删掉 `QLibrary` 对象、返回 0，当它没来过。**一个合法的插件，就是「这是一个能 load 的动态库」加「它导出了这两个名字」。** 没有任何别的元数据、没有清单文件、没有 `plugin.json`——契约小到这个程度，是刻意的。

## 纯 C 符号契约：两个函数，就是全部

契约本体在 `ExtensionInterface.h` 的四十几行里。它短到可以整段读，但它承载了宿主和插件之间**唯一**的约定。

导出的宏按平台分了两路：

```cpp
#if defined(_WIN32)
#define ZYCLEAR_EXTENSION_EXPORT extern "C" __declspec(dllexport)
#else
#define ZYCLEAR_EXTENSION_EXPORT extern "C" __attribute__((visibility("default")))
#endif

#define ZYCLEAR_EXTENSION_COUNT_FN "ZyClearExtensionCount"
#define ZYCLEAR_EXTENSION_AT_FN    "ZyClearExtensionAt"
```

**导出的函数就两个，名字和签名都是核实过的**——插件端 `plugin_entry.cpp` 的实现是这样的：

```cpp
extern "C" ZYCLEAR_EXTENSION_EXPORT int ZyClearExtensionCount()
{
    return 1;
}

extern "C" ZYCLEAR_EXTENSION_EXPORT IPanel* ZyClearExtensionAt(int index)
{
    if (index == 0) {
        return new DemoPanel();
    }
    return nullptr;
}
```

所以契约原文是：**`int ZyClearExtensionCount()`** 返回这个插件提供了几个面板；**`IPanel* ZyClearExtensionAt(int index)`** 按序号返回第 index 个面板对象，越界返回 `nullptr`。就这两个。宿主端解析出来的签名必须和它严格对上：

```cpp
using CountFunction = int (*)();
using AtFunction = IPanel* (*)(int);
```

`PanelRegistry.cpp` 里这句注释把风险挑明了：**「resolve 只认符号名、不认类型，返回的是裸地址，强转成函数指针的类型安全完全靠双方约定：导出端必须真的是这个签名。签名不符编译期查不出来，只会在真正调用时炸。」**

`QLibrary::resolve` 拿到的就是一个地址，宿主 `reinterpret_cast` 成函数指针。**编译器在这条线上什么也帮不了你**——它不知道那个地址背后是什么签名，只知道「用户说它是这个签名」。导出名对了、签名错了，程序照样能编译、能加载、能跑，直到那一次调用把参数栈错位、把返回值当错类型解读。

### 为什么必须 `extern "C"`

这是整篇最值得单独讲的一段。C++ 编译器会对函数名做**名字修饰**（name mangling）：把函数名和它的参数类型编码进最终符号名。`IPanel* ZyClearExtensionAt(int)` 在不同编译器、不同版本下会被修饰成**完全不同的长串**——MSVC 和 GCC 不一样，MSVC 的 2019 和 2022 之间也可能不一样，甚至同一个编译器的两次大版本升级都会改规则。

**如果按 C++ 链接，宿主会去 DLL 里找那个被修饰过的长名字**，而插件是用它自己的编译器版本修饰的——两边一对不上，宿主 `resolve` 直接失败，插件「消失」了，而 DLL 本身完好无损，只是名字对不上。

`extern "C"` 的作用就是**关掉名字修饰，让导出符号就是那个原名**。`ExtensionInterface.h` 里的注释原话是：**「`extern "C"` 还负责去掉 C++ 名字修饰：导出符号在 DLL 里就是 `ZyClearExtensionAt` 这个原名。若按 C++ 链接，名字会被编码成带参数类型的长串，插件换个编译器版本宿主就 resolve 不到。」**

**这就是「纯 C 符号」这条规矩的全部动机，不是洁癖，是让符号名在编译器版本之间保持稳定。**

### 硬契约：改名或改签名，不报错，静默错调

接着上面的注释写了第二句，我认为是**整个插件系统里最该裱起来的一句**：

```cpp
// 这两个导出名、以及 At 的「收 index 返回 IPanel*」签名，是宿主与插件之间唯一的硬契约。
// 改名或改签名不会在编译期报错，只会让老 DLL 在运行期静默错调，动之前先想兼容。
```

我把这句话拆开说，因为它反直觉：**「改名或改签名」为什么不会在编译期报错？**

因为宿主和插件是**分开编译**的，中间没有共享的编译期符号。宿主里的 `"ZyClearExtensionAt"` 是一个**字符串常量**，插件里真正的函数名是编译器生成的东西——两者之间唯一的绑定发生在**运行期的 `resolve`**。编译器看不到另一个翻译单元，甚至看不到另一个工程，它没有任何机会告诉你「这两边对不上」。

于是最阴的一类 bug 长这样：**插件 A 是新版，导出了 `ZyClearExtensionAt`（改了签名，比如加了参数）；宿主也升级了，按新签名去 resolve；但插件 B 是旧版，还是老签名。** 三边名字都能 resolve 成功，宿主照旧去调，参数栈错位——轻则读到垃圾数据、面板不显示，重则直接崩，而且崩在宿主里，堆栈里根本看不到插件 B 的身影。

**「唯一的硬契约」这个说法精确在这里：契约是唯一的，但它的两侧都不受编译期保护。** 这也是为什么我后来在改 `ExtensionInterface.h` 时格外小心——**这个文件是所有插件的编译期依赖，但它改动的影响不是「重编插件」那么简单，而是「没重编的老插件会在运行期变坏」。**

## `IPanel`：五个虚函数里藏着两条命门

面板接口 `IPanel` 一共五个虚函数，其中两个必须有实现、两个带默认实现、一个必须是虚析构：

```cpp
class IPanel {
public:
    virtual ~IPanel() { }                       // 命门之一
    virtual QString PanelId() const = 0;
    virtual QString PanelTitle() const = 0;
    virtual QWidget* CreateWidget(QWidget* parent) = 0;
    virtual Qt::DockWidgetArea DefaultArea() const;   // 默认右侧
    virtual bool VisibleByDefault() const;            // 默认 true
};
```

### 命门一：析构必须是虚的

`~IPanel` 是虚的，`ExtensionInterface.h` 里那一行注释解释了为什么它不能不是：

```cpp
// 主程序只经 IPanel* 持有面板，销毁时走这个虚入口；非虚会只跑基类析构，
// 插件在 CreateWidget 里自建、没交给 Qt 父子关系的资源会全漏。
```

**宿主从头到尾没见过具体的 `DemoPanel` 类型，它只持有一个 `IPanel*`。** 当宿主 `delete` 这个指针时，如果析构不是虚的，编译器只看静态类型 `IPanel*`，就只调用 `IPanel::~IPanel`——**插件那个派生类的析构函数根本不会执行。**

后果取决于插件里有没有「自建、且没交给 Qt 父子关系」的资源。**如果面板的所有成员都是 `QWidget` 且 parent 传得对，那 Qt 会兜底；但插件完全可能持有别的资源**——一个自己 `new` 的 buffer、一个从厂商 SDK 拿到的句柄、一个没设 parent 的辅助对象。这些东西的释放写在派生类析构里，**派生类析构不跑 = 全部泄漏，而且不报错、不崩溃，只是内存和句柄慢慢涨。**

这就是「插件与宿主之间，只要有一个裸指针跨过边界，析构虚不虚就从『细节』变成『命门』」。**`ExtensionHost::Attach` 里用的是 `std::unique_ptr<IPanel>` 接管 `registry->Create(id)` 的返回值**，靠的就是这个虚析构能正确释放派生类。

### 命门二：`CreateWidget(parent)` 的 parent 由宿主给

第二个虚函数是 `QWidget* CreateWidget(QWidget* parent)`。注意参数——**parent 不是插件自己造的，是宿主传进来交给插件的。** 注释写着「parent 由宿主传入，生命周期交给 Qt 的父子关系管理」。

宿主那侧的调用是这样的：

```cpp
std::unique_ptr<IPanel> panel(registry->Create(id));
QDockWidget* dock = new QDockWidget(panel->PanelTitle(), window);
QWidget* content = panel->CreateWidget(dock);   // dock 作 parent
if (content == nullptr) {
    delete dock;   // 造不出界面，手动回收
    continue;
}
dock->setWidget(content);
```

**宿主先把 `QDockWidget` 造好，再把 dock 当 parent 交给插件的 `CreateWidget`。** 这样插件里 `new QWidget(parent)` 造出来的界面就挂进了 Qt 的父子树，dock 一销毁、content 跟着销毁，**不需要宿主额外写一行 delete。** 这比「插件造 widget、宿主接管所有权」清爽得多——所有权边界就落在 parent 这个参数上，插件的职责被限定成「造出界面、挂到 parent 下」，宿主的职责是「管 dock 的生死」。

`CreateWidget` 返回 `nullptr` 表示这个面板造不出界面（比如它依赖的某个资源没就绪）。**宿主这时只跳过它一个面板，并且手动 `delete dock`**——注意附着的那句注释：「这时 dock 还没有父窗口接管，必须在这里手动 delete，否则每次挂载都漏一份。」这是典型的「异常路径也要配平所有权」：正常路径上 dock 归 `window` 管，异常路径上还没交接，宿主得自己收尾。

### 两个带默认实现的虚函数

```cpp
Qt::DockWidgetArea DefaultArea() const { return Qt::RightDockWidgetArea; }
bool VisibleByDefault() const { return true; }
```

它们**不是纯虚**，有默认实现：面板不覆写就默认停右侧、默认打开。注释各点了一条语义：`DefaultArea`「决定面板挂上去时停靠在哪一侧，用户之后拖到别处不受影响」；`VisibleByDefault`「挂载时的初始开合；用户关掉不写回配置，下次启动仍是这个初始值」。

**这两个默认值的存在本身是个接口设计取舍**：纯虚会逼每个插件都写全五个函数，哪怕它只想停右侧、只想默认打开；给默认实现后，一个最小可用的插件只需要实现三个纯虚（`PanelId`、`PanelTitle`、`CreateWidget`）就成立。**代价是「默认值可能不是插件作者想要的，但他忘了覆写，于是面板停在了意想不到的一侧」**——同样是编译期不报错的沉默错误。

## QDockWidget：停靠体系为什么值得用

面板为什么用 `QDockWidget` 而不是 `QSplitter`？`ExtensionHost.h` 的注释把理由写死了：

```cpp
// 用 QDockWidget 而不是 splitter：splitter 的每一栏都得一直占着宽度，
// 而 AI 助手和日志属于用时才打开的东西。QDockWidget 支持停靠到任意边、
// 浮动成独立窗口、右上角关闭、从菜单重新打开。
```

**关键区别是「可关闭 + 可恢复」。** splitter 的每一栏永久占位，关不掉；而日志面板、AI 侧栏是「用时才开」的，平时不该占着屏幕。`QDockWidget` 白送了四件套：

- **停靠任意边**：`dock->setFeatures(DockWidgetClosable | DockWidgetMovable | DockWidgetFloatable)` 一开，面板就能被拖到左/右/上/下任意边，或者拖出去变成独立浮动窗口。
- **关闭后从「视图」菜单恢复**：`ExtensionHost` 给每个面板建一条菜单项，用的是 `dock->toggleViewAction()`——**这是 QDockWidget 自带的动作，勾上/取消就等于显示/隐藏，勾选状态还会跟着面板状态自动变。** 宿主不需要自己维护「哪个面板开着」这份状态。
- **工具栏按钮随实际停靠位置重排**：面板被拖到别边后，工具栏上对应的按钮要跟着挪到对应的组里。这由一个小控制对象 `PanelBarController` 接 `QDockWidget::dockLocationChanged` 信号、重排工具栏动作来完成。

**重排里有一处我必须记下来的细节**——排序不能直接用 `Qt::DockWidgetArea` 的枚举值：

```cpp
// 不能直接拿 Qt::DockWidgetArea 的枚举值排序：那是 1/2/4/8 的位掩码，
// 排出来是 左、右、上、下，和屏幕上的空间顺序对不上。
int CurrentAreaOrder(QMainWindow* window, QDockWidget* dock)
{
    switch (window->dockWidgetArea(dock)) {
    case Qt::LeftDockWidgetArea:   return 0;
    case Qt::BottomDockWidgetArea: return 1;
    case Qt::RightDockWidgetArea:  return 2;
    // ... 上=3、浮动=4
    }
}
```

**`Qt::DockWidgetArea` 是位掩码**（`Left=1`、`Right=2`、`Top=4`、`Bottom=8`），按枚举值排序会得到「左上右下」这种和屏幕直觉无关的顺序——**又是位掩码当普通枚举用会咬人的那一类坑，跟上一篇事件总线里「组合值被当整键查」是同一个家族。** 所以我另写了一个显式的映射函数，把「空间顺序」这件事写成一张表，排在代码里，谁看都懂。

工具栏本身也有一处结构上的讲究：**「视图」入口和面板开关按钮分成两条工具栏。** 因为「视图」按钮要停在标题栏最左，而面板开关图标要停在右侧，同一条栏没法同时满足两边。这些按钮的图标是**现画的**（`MakePanelIcon`），不是资源里的 png：

```cpp
// 现画的侧边栏图标：一个矩形，里面一条线表示面板贴在哪一侧。
// 画出来而不往资源里塞 png，省得为各种分辨率各准备一套图。
const bool floating = (area == Qt::NoDockWidgetArea);   // 浮动用虚线区分
painter.setPen(QPen(QColor(210, 210, 210), 1.4,
    floating ? Qt::DashLine : Qt::SolidLine));
```

**图标随面板的实际停靠位置变化**——贴在左边就画左边的线、贴底就画横线、浮动就画虚线。这样工具栏上那排小图不只是「开关」，还是「这个面板现在在哪」的可视化读数。

## 注册表：按 id 去重，先来先占

面板的登记表是 `PanelRegistry`，一个进程内唯一的单例：

```cpp
PanelRegistry* PanelRegistry::Instance()
{
    // 函数内 static 的初始化由编译器加锁保证只跑一次；
    // 且首次真正用到登记表时才构造，避开跨编译单元的全局构造顺序问题。
    static PanelRegistry instance;
    return &instance;
}
```

**为什么必须全程序唯一**：主窗口、控制台模式、外部插件都往同一张表写，各自持一份副本就看不见彼此登记的面板了。这跟上一篇事件总线的单例是同一个理由。

登记的唯一约束是 **id 不能重复**：

```cpp
bool PanelRegistry::Register(const QString& id, PanelCreator creator)
{
    if (id.isEmpty() || !creator) {
        return false;
    }
    if (Contains(id)) {
        qWarning() << "面板 id 已存在，忽略重复登记:" << id;
        return false;
    }
    m_panels.append(Entry { id, std::move(creator) });
    return true;
}
```

**重复的 id 被拒掉，不是覆盖。** 这条规矩的功能在 `BuiltinPanels.cpp` 里用得极巧：**内置面板统一用 `extension.panel.` 前缀，在外部插件加载之前先登记**，注释写的是「靠『先登记』占位，保证 external DLL 顶不掉它们」。`mainwindow.cpp` 里的调用顺序正是这个意图：

```cpp
PanelRegistry* registry = PanelRegistry::Instance();
RegisterBuiltinPanels(registry, providers);   // 内置先占位
LoadExternalExtensions(registry);             // 外部插件后到
ExtensionHost::Attach(this, registry);        // 最后统一挂上
```

**顺序即策略**：内置面板先登记占住 id，一个恶意的（或者只是没注意命名的）外部 DLL 如果用了同一个 id，`Register` 会拒绝它，内置面板纹丝不动。**这比「后到的覆盖先到的」安全得多**——否则任何丢进 `extensions/` 的 DLL 都能顶掉宿主自带的面板，这是不能接受的信任模型。

**反过来，外部插件的 id 就该自觉带命名空间前缀。** 示例插件的 id 是 `demo.panel.hello`，注释明说「带命名空间前缀，避免和别的插件的 id 撞车」。**在这个系统里，id 就是面板的身份，冲突的处理方式是「拒绝后来者」而不是「合并」——所以起名的责任在插件作者身上。**

还有个实现细节值得记：登记表用 `QList` + 线性查找，而不是 `QMap`：

```cpp
// 用列表 + 线性查找而不是 QMap：面板只有个位数，图的是登记顺序稳定，
// 用 QMap 会按 id 字母序排，侧边栏顺序就不受控了。
```

**面板的排列顺序是有意义的 UI 信息**（谁在左、谁在先），用 `QMap` 会把顺序交给 id 的字母序，那是失控的。代价是查找 O(n)，但面板只有个位数，这点开销可以忽略。**「数据结构的选择服务于语义而非性能」——这里语义是「登记顺序必须稳定」，`QList` 是对的。**

最后一条，也是最重的一条：**注册表故意持有 `QLibrary` 不释放。**

```cpp
// 故意持有不释放：面板的虚函数表指向库里的代码，库一卸载调用就跳到野地址
QList<QLibrary*> m_libraries;
```

为什么不解载？因为在 `LoadFromLibrary` 里登记的不是「面板实例」，而是**一个转发到插件入口的闭包**：

```cpp
if (Register(id, [atFunction, index]() { return atFunction(index); })) {
    ++loaded;
}
```

**真正 `new` 面板被推迟到了以后任意一次 `Create`。** 也就是说，加载插件的那一刻并没有把面板全造出来，只是记住了「这个 id，将来要造的话，去调库里的 `atFunction`」。**那么库就必须活到进程结束**——如果解载了 QLibrary，`atFunction` 指向的代码段就没了，下次 `Create` 调用会跳到野地址直接崩。注释里那句「库必须活到进程结束、不解载」，就是这条链推出来的结论。

## 代价面：诚实的那一半

好处讲完了，代价必须一条条摆出来。这个系统的代价不是抽象的「复杂度」，是几条具体的、我每天都要面对的约束。

### 一、插件与主程序必须用同一套编译器与运行库

`ExtensionInterface.h` 里这句是硬约束：

```cpp
// 代价是插件与主程序必须用同一套编译器与运行库。
```

**为什么**：契约里跨边界传递的类型是 `QString`、`QWidget*`、`Qt::DockWidgetArea`——这些都是有内部布局的 C++ 类型。**`QString` 在宿主里是一个 object、在插件里是另一个 object，两者的内存布局必须逐字节一致**，否则宿主编出来的 `QString` 传进插件、插件按自己的理解去读，读到的就是垃圾。而 `QString` 的布局由 Qt 版本决定、`QWidget` 的 vtable 布局由编译器+Qt 一起决定。

`plugin_entry.cpp` 开头那句注释说得更直接：**「导出 C 函数而非类：C++ 类无稳定 ABI，换编译器或 STL 版本就对不上。插件与宿主必须同一套编译器和 Qt，否则传递 `QWidget*` 会出问题。」**

这正是「纯 C 符号」这条规矩的**另一半代价**：`extern "C"` 保住了**符号名**在不同编译器间的稳定，但**保不住类型的内存布局**。C 的 ABI 稳定，C++ 的 ABI 不稳定——所以契约用 C 符号传递，但传的内容还是 C++ 对象。**符号层面解耦了，类型层面没解耦。** 现实后果就是插件必须和宿主用同一个工具链（同为 MSVC），同一个 Qt 版本，同一位宽（x64）。

### 二、面板标题被三处共用，所以规定要写短

`PanelTitle()` 的返回值不只是 dock 的标题，它同时喂给了三个地方——`ExtensionInterface.h` 的注释点明了：

```cpp
// 同一个标题会被 dock 标题、视图菜单项、工具栏提示三处共用，写短一点，
// 别在这里塞说明性文字。
```

宿主侧的代码印证了这个「三处共用」：

```cpp
QDockWidget* dock = new QDockWidget(panel->PanelTitle(), window);  // ① dock 标题
QAction* toggle = dock->toggleViewAction();
toggle->setText(panel->PanelTitle());                              // ② 视图菜单项
toggle->setToolTip(QStringLiteral("显示/隐藏%1").arg(panel->PanelTitle())); // ③ 工具栏提示
```

**一个字符串填三个位置，意味着它的长度约束也是三个位置里最严的那个。** 视图菜单项在窄侧栏里，长标题会被截断；工具栏提示虽然能长，但和三处保持同一个词才不会让人困惑。**所以我把「写短一点」写进了接口注释——这是接口设计对插件作者的约束，不是编码风格偏好。** 示例插件给的标题「示例插件」、内置面板的「AI 助手」「日志」，都是两到四个字。

### 三、契约的稳定性债

这条最不显眼，但最重。`ExtensionInterface.h` 是**所有插件的编译期依赖**，但它和普通头文件有个本质区别：**改了它，不是「所有插件重编一下就好」，而是「已经发出去、装在用户机器上、没重编的老 DLL 会在运行期变坏」。**

考虑一个场景：我哪天觉得 `PanelId` 应该返回 `std::string`，或者 `CreateWidget` 应该多接一个参数。改了头文件、改了宿主、重编了主程序——**用户机器上那个旧版插件 DLL 没跟着重编**，它的符号名还在，宿主 resolve 得到，但签名对不上。**编译期零报错，运行期静默错调。**

**这就是「契约一旦定了就不能改」的真正含义。** 它不是「改起来麻烦」，是「改起来会静默地破坏已经存在的二进制」。要改就得做版本协商：多导一个 `ZyClearExtensionVersion` 函数、宿主检查版本号、不兼容就拒绝加载——那是下一阶段的工程量，我现在没做，但我清楚这个缺口在哪。

**所以我对 `ExtensionInterface.h` 的态度是：把它当成冻结的。** 加东西可以（新加一个带默认实现的虚函数，老插件不实现也能用），改现有的东西要极其谨慎。

## 我踩过的坑

**坑一：把「装载」和「造面板」当成了同一件事。**

我最早以为 `LoadFromLibrary` 会把插件里的面板全造出来挂上去。**读到 `Register(id, [atFunction, index]() { return atFunction(index); })` 才反应过来：装载阶段只是登记了一个闭包，真正的 `new` 推迟到 `Attach` 里每次 `Create` 的时候。**

**这个误解的后果是所有权理解全错。** 我以为「库加载 = 面板存在」，于是在脑子里把 `QLibrary` 的生命周期和面板绑在了一起；实际上登记的是「以后怎么造」，库必须活到**最后一次 `Create` 之后**，也就是进程结束。注释里那句「库必须活到进程结束、不解载」我一开始完全没读进去——因为我没有「登记的是闭包、不是实例」这个模型。**教训：看到 `std::function` 存进一个容器，先问一句「这里存的是值、还是以后怎么取值」，两者对生命周期的要求完全不同。**

**坑二：以为 id 冲突是「后者覆盖前者」。**

我去读注册表时，脑子里默认了配置系统常见的语义——同一个 key 再写一次就是覆盖。**结果 `Register` 是「已存在就拒绝、返回 false」**，而且 `BuiltinPanels` 恰恰是利用这一点，先登记内置面板来**占位防顶**。

**如果我当时按「覆盖」的心智模型去写一个外部插件，起了个和内置面板同名的 id，我不会收到任何明显的反馈**——`Register` 返回 `false`、`LoadFromLibrary` 少登记一个、日志里一行 `qWarning`，面板就是不出现。**又是一次「什么都没发生」**：面板没出现，日志里那行 warning 藏在启动信息里，很容易被当成噪音刷过去。现在我知道外部插件的 id 必须带命名空间前缀，示例插件那句注释「避免和别的插件的 id 撞车」就是为这个写的。

**坑三：差点按 `Qt::DockWidgetArea` 的枚举值给工具栏排序。**

写 `Rebuild` 的时候，最自然的写法是 `std::sort` 加一个比较 `dockWidgetArea()` 的 lambda。**幸好动笔前看了一眼枚举的定义——`Left=1, Right=2, Top=4, Bottom=8`，是个位掩码。** 按这个排序，得到的是「左、右、上、下」，和屏幕上的空间顺序（左、下、右、上）对不上，按钮会排成看着毫无道理的样子。

**这个坑和上一篇事件总线里「组合值被整键查表吞掉」是同一个根**：位掩码类型的值有「位」的语义，但一旦当成普通整数去排序、比较、查表，语义就丢了。**位掩码当普通枚举用的地方，永远要停下来问一句「我是不是在把一个掩码当序号用」。** 现在我给 `CurrentAreaOrder` 写了显式 switch，把空间顺序变成一张表——**这就是把「不能直接比」这件事变成代码里的一个显式决策。**

**坑四：以为 `~IPanel` 的 virtual 是「风格问题」。**

我最初扫 `ExtensionInterface.h` 时，`virtual ~IPanel() { }` 这一行看着就是个空析构，随手划过。**直到读注释里那句「非虚会只跑基类析构，插件……自建、没交给 Qt 父子关系的资源会全漏」，才意识到它是整个接口里最不能省的一个 `virtual`。**

**关键在于：宿主只经 `IPanel*` 持有面板，它连具体类型都不知道。** 非虚析构的话，`delete` 一个 `IPanel*` 只会跑 `IPanel::~IPanel`——这是编译器按静态类型决定的，它没有别的方式知道底下是个 `DemoPanel`。**我当时的错在于把「析构虚不虚」归类成了代码风格，实际上它决定了「派生类析构里的资源释放会不会发生」。** 教训：**只要有一个裸指针跨过模块边界，析构函数虚不虚就是接口契约的一部分，必须在接口的注释里写明。**

**坑五：以为「装了插件系统就一定解耦」。**

刚建成时我挺得意：宿主不认识任何具体面板，全走 `IPanel*` 和注册表。**但很快发现问题——`IPanel` 这个接口本身，就是一条不减的耦合。**

宿主不知道 `DemoPanel` 的存在是真的；但宿主和**每一个**插件都必须对 `IPanel` 有完全一致的理解：五个虚函数的顺序、`CreateWidget` 的 parent 语义、`DefaultArea` 的默认值、`VisibleByDefault` 的初始开合、析构必须是虚。**这些约定里没有一条有编译期保护，全靠两边读同一个头文件、读同一份注释。**

**插件降低的是「宿主对具体面板的编译期依赖」，代价是把耦合集中到了 `IPanel` 这一个接口上——它变成了一个所有插件都必须精确遵守、却又无法被编译器守护的契约。** 这跟上一篇的结论是一样的：**解耦不是消灭耦合，是把它从「分散在很多条直接引用里」凝聚成「一条显式的、写在头文件里的契约」。** 契约越集中越清晰，但也越不能改——这是同一件事的两面。

## 结尾

十篇到这里，全系列的技术篇收束了。回头看这十篇，其实一直在讲同一件事的不同侧面：

**先是边界。** 第 1 篇的六层架构定下了「硬件无关能力边界」——17 个纯虚方法，把「相机能做什么」和「某厂商怎么做」切开。第 2 篇到第 5 篇，是这条边界往下的四个纵深：厂商适配器怎么各自实现、门面怎么收口多机寻址、参数体系怎么用 JSON Schema 驱动到「新增型号不编译不发版」、图像链路怎么用四级异步隔离把 SDK 回调和 UI 渲染分开。**它们讲的是「边界画在哪，以及为了守住这条边界，底下要付出什么」。**

**然后是那几条边界之间的连线。** 第 9 篇的事件总线，把面板之间的 n² 条直接引用收成一条广播总线——六个语义事件、按位掩码投递。**它讲的是「边界之间的通信怎么不重新引入耦合」。**

**而这一篇，是边界里最有意思的一种：跨进程的文件边界。** 前面九篇的边界全在**编译期**——类之间、层之间、线程之间。插件的边界在**运行期**——宿主和插件是分开编译的两个二进制，它们之间没有共享的编译期符号，只有一个 DLL 文件和一个约定。**编译器在这条边界面前彻底失能**：导出名对不对、签名配不配、析构虚不虚、ABI 一不一致，没有一条能靠编译期检查发现，全靠运行期的 `resolve` 和人的约定。

**这也是为什么插件是我在整个项目里最小心的一块。** 它买到的东西很实在——新增面板不重编主程序，丢个 DLL 重启就出现；但代价也很实在——同一套编译器、契约冻结、改一个 `virtual` 关键字就可能让所有老插件静默变坏。**「契约一旦定了就不能改」不是一句耸人听闻的总结，是运行期边界的物理性质。**

下一篇是系列的最后一篇正式篇，讲**构建与测试**——四套 CMake 预设、可选的厂商 SDK、8 个测试目标 107 个用例，以及「整条链路在没接真相机的情况下怎么跑通」。**插件系统这一路讲下来，其实一直在暗示一件事：这个项目里所有「不需要真相机也能验证」的设计，最后都汇进了那套测试里。** 海康 SDK 缺失时的降级路径、虚拟相机、插件 DLL 的示例工程——它们不只是架构选择，也是测试能不能自动化运行的前提。下一篇收这一摊。
