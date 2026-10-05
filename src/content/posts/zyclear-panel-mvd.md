---
title: 面板怎么长出控件：Model-View-Delegate 与六类编辑控件
description: 参数树是数据，界面要把它渲染成可编辑的控件树。这一篇讲为什么用 MVD 而不是手工搭控件、六种参数类型怎么在运行时挂上对应的编辑控件、委托为什么不把逻辑塞进 widget，以及 enum 写回下标冒充编码、索引越界、构造期调虚函数、setParam 死循环这四个真实的坑。
pubDate: 2026-10-02
tags: [C++, Qt, 架构设计, 设计模式, 工业软件]
---

上一篇把参数表从代码搬进了 JSON：37 项参数、5 个分组，解析器读它、界面按它装配，「新增型号不编译、不发版」从口号变成了七行函数。

那篇结尾我留下一个问题——**这份 Schema 解析出来的 37 项参数，怎么变成主窗口上那个参数面板的一部分？** 更具体一点：参数树在模型里是一堆数据，可面板上要显示的是能点的树、每行右边要有一个能改的控件（数字是SpinBox、枚举是下拉框、命令是按钮）。**这中间隔着「数据 → 控件」这一步，谁来干、怎么干。**

这一篇就写这一步。主角是 `src/ParamWidget/` 这个目录——它 22 个文件（顶层 10 个 `.h`/`.cpp` 加 `CustomWidget/` 下 12 个），把上个系列的成果接了起来：左边吃模型层的参数树，右边吐出可编辑控件。

## 为什么不是手工搭控件

先算一笔账，跟上一篇同一种算法。

参数有多少种，就有多少种面板。为保证「新增型号不编译」，参数集合是数据、是从 JSON 来的——海康一台相机的 `AnalogControl` 就有 11 项，加上其它四组共 37 项。**如果界面是手工搭的，那每接一个型号就要照着它的参数表，在某个 `setupUi()` 里手写 37 个 `new QSpinBox`、`new QComboBox`、`connect`……** 这还不算分组标题、布局、说明框。

更要命的是**手工搭出来的控件跟参数树是两份东西**。参数值来自设备、会变；参数分组来自配置、会调。手搭的界面得自己维护「第几个控件对应哪个参数」，一旦配置里插一项、调个顺序，这份对应关系就错位。**手工搭控件，等于把「参数变了界面也得变」这件事，重新变回「改代码」。**

所以界面这一层不能知道任何具体参数。`ParamWidget.h` 第 16 行的注释就是这件事的总纲：

```cpp
// 参数区的容器：这里只搭空壳（两列表头 + 说明框 + 刷新按钮），真正的参数在收到
// 相机连接消息后由模型与委托运行时装配，所以本类里不会出现任何相机型号的参数名。
```

**「本类里不会出现任何相机型号的参数名」**——这句可以当场验证：`ParamWidget.cpp` 搜不到 `Gain`、`ExposureTime`、`PixelFormat` 任何一个名字。它搭的是一个空壳：`QTreeView` + `QTextBrowser`（说明框）+ 刷新按钮 + 两列表头写死 `Param` / `Value`。**界面容器完全不知道自己将来要显示什么。**

## 三者分工：模型存数据、视图显示、委托造控件

Qt 的 Model-View-Delegate 正好卡在这个需求上。它不是「MVC 换个名字」，是把一件事切成三份：

| 角色 | 类 | 负责 |
|---|---|---|
| 模型 | `CameraParamModel` | 持有参数树（`CameraParamItem` 组成），回答「这行显示什么」「这行能不能改」 |
| 视图 | `QTreeView` | 显示、展开、选择；它自己不知道单元格里该画数字还是下拉框 |
| 委托 | `CameraParamDelegate` | 只干两件事：按参数类型造控件、在控件与模型之间搬运数据 |

`CameraParamDelegate.h` 第 9 行把委托的边界钉死了：

```cpp
// 委托只做两件事：按参数类型造出对应的编辑控件、在控件与模型之间搬运 CameraParam。
// 它自己不存任何参数状态，真值永远只有一份，留在模型的 ParamRole 里。
```

**「它自己不存任何参数状态」**是这三者分工里最值钱的一句。委托是个无状态的分派器——参数值永远只有一份，在模型的 `ParamRole` 里。委托被视图反复调用来画格子、造控件、搬值，但它手里不留任何一份数据副本，所以**永远不会出现「委托里的值和模型里的值不一致」这种状态错位**。数据只有一份，就没有同步问题。

**为什么不是自定义一个 `QWidget` 把整棵树包起来**：那是「手工搭控件」的高级版本——只不过把 37 个控件的管理逻辑收进一个类里，本质上还是要自己实现「哪行是哪项、值变了怎么回写、权限怎么判断」。MVD 把这三件事分别交给了 Qt 已经实现好的三块：模型的 `data()`/`flags()`/`setData()`、视图的展开与选择、委托的 `createEditor`/`setEditorData`/`setModelData`。**我写的是「填空」，不是「从零造」。**

## 六类控件怎么挂上去

参数树的每一项，模型里存的是一个 `CameraParam`（上一篇讲的外观类，带 `type()`）。`type()` 取值 `INT` / `DOUBLE` / `ENUM` / `BOOL` / `CMD` / `STRING` 六种。这六种在负责造控件的地方被摊成一个 `switch`——`CameraParamDelegate::createEditor` 里的 `createWidget` lambda：

```cpp
auto createWidget = [](CameraParam& cameraParam, const QModelIndex& index, QWidget* parent) -> OneCustomWidget* {
    switch (cameraParam.type()) {
    case STRING: return new StringCustomWidget(cameraParam, index, parent);
    case CMD:    return new CmdCustomWidget(cameraParam, index, parent);
    case INT:    return new IntCustomWidget(cameraParam, index, parent);
    case DOUBLE: return new DoubleCustomWidget(cameraParam, index, parent);
    case BOOL:   return new BoolCustomWidget(cameraParam, index, parent);
    case ENUM:   return new EnumCustomWidget(cameraParam, index, parent);
    default:     return nullptr;
    }
};
```

去数一遍 `CustomWidget/` 目录，正好 6 个控件、每个一对 `.h`/`.cpp`：

| 参数类型 | 控件类 | 内部编辑元素 | 出处 |
|---|---|---|---|
| `INT` | `IntCustomWidget` | `QSpinBox` | `IntCustomWidget.h:23` |
| `DOUBLE` | `DoubleCustomWidget` | `QDoubleSpinBox` | `DoubleCustomWidget.h:23` |
| `ENUM` | `EnumCustomWidget` | `QComboBox` | `EnumCustomWidget.h:23` |
| `BOOL` | `BoolCustomWidget` | `QCheckBox`（两态，不 tristate） | `BoolCustomWidget.h:23` |
| `STRING` | `StringCustomWidget` | `QLineEdit` | `StringCustomWidget.h:22` |
| `CMD` | `CmdCustomWidget` | `QPushButton` | `CmdCustomWidget.h:23` |

六种类型、六个控件、六种编辑元素，一一对应。**注意这里是从 `type()` 分派的，不是从参数名分派的**——`switch` 里没有一处提到 `Gain` 或 `ExposureTime`。这跟上一篇的观点是同一件事：**分派「类型」而不是「参数」，才能让新增型号只是往 JSON 里加一项。** 新增型号的 `PixelFormat`（`ENUM` 类型）走的就是已有的 `ENUM` 分支，这里一个字都不用改。**只有新增一种参数类型（比如 `RANGE`）才需要补一支——那是改能力边界，本来就该编译发版。**

一个细节：**控件是按需造的，而且是单元格被打开（进入编辑态）的那一刻才造**。行本身在委托的 `paint()` 里只是两行文字加网格线，不是控件。37 项参数意味着 37 行文字，不是 37 个控件实例；参数涨到 370 项，还是 370 行文字。**常驻的控件数始终是「正在编辑的那一个」——这就是「界面层对参数规模无感」的机制。**

## 六个控件长在同一个基类上

六个控件不是各写各的，它们都继承 `OneCustomWidget`。基类干了两件事：持有 `m_param`（那份参数外观对象）和 `m_index`（单元格位置），并提供一套统一的存取接口：

```cpp
// OneCustomWidget.h：按类型运行时挂载，视图与模型始终只认基类指针
explicit OneCustomWidget(CameraParam param, const QModelIndex& index, QWidget* parent = nullptr);
void InitWidget();
virtual void setParam(CameraParam& param);   // 模型 → 控件（推值）
virtual CameraParam getParam();              // 控件 → 模型（取值）
signals:
    void sigValueChanged(const CameraParam& param, const QModelIndex& index);
```

**委托和视图从头到尾只认 `OneCustomWidget*` 这一个基类指针，从不 `qobject_cast` 到具体子类**——`createWidget` 的返回类型写的就是 `OneCustomWidget*`。这跟上一篇「六种类型压进一个外观类」是同一个手法的第二次出现：外层面对一个基类，具体类型被关在分派点后面。区别是上次的「分派点」是 `displayText()` 里的 `switch (type())`，这次是 `createEditor` 里的 `switch (type())`。

一个真正的 C++ 陷阱藏在这里，我把警告写进了基类的注释里：

```cpp
// 构造完还得由外部再调一次 InitWidget()：它要派发虚函数 addEditLayout()，而构造期
// 调用只会落到基类的空实现，子类那个编辑控件就挂不进布局。
```

拆开看：基类是这么搭布局的——`InitWidget()` 里造一个 `QHBoxLayout`，然后调 `addEditLayout(layout)`，由**子类** override 往布局里塞自己那个 `QSpinBox` / `QComboBox`：

```cpp
void OneCustomWidget::InitWidget()
{
    QHBoxLayout* pLayout = new QHBoxLayout();
    pLayout->setContentsMargins(0, 0, 0, 0);
    addEditLayout(pLayout);      // 虚函数，子类版本才加控件
    this->setLayout(pLayout);
}
```

**为什么不能在基类构造函数里调 `addEditLayout()`**：构造函数执行时派生类还没构造完——派生类的成员（`m_SpinBox`）此刻还是未初始化的，vtable 指针指向的还是基类的 vtable，所以虚函数派发会落到**基类的空实现**上。我的基类 `addEditLayout` 是这么写的：

```cpp
void OneCustomWidget::addEditLayout(QHBoxLayout* layout)
{
    // 有意留空而非纯虚：漏重写的子类会静默得到空单元格，而不是编译期报错
}
```

**它是「空实现」而不是「纯虚函数」，这个选择值得说清楚**：如果设成 `= 0`，那所有子类必须重写，但**「构造期调虚函数」这个坑就不会被编译器抓住**——因为编译能过，只是运行期派发到基类版本。空实现方案下，漏重写的子类会得到一个**空单元格**（界面上什么都不显示，一眼看得出来），而不是编译报错。**这个取舍是刻意的：我宁愿要一个「看得见的运行期错误」，也不要一个「编译期通过、运行期悄悄用错版本」的陷阱。** 而 `InitWidget()` 必须在**外部、构造完成之后**才调——委托的 `createEditor` 里就是这个顺序：

```cpp
auto* oneCustomWidget = createWidget(cameraParam, index, parent);
if (oneCustomWidget) {
    // InitWidget 要在接管信号之前调：控件得先把自己内部的输入元素建好，
    // 否则随后 setEditorData 推值时会写进一个还没成形的控件
    oneCustomWidget->InitWidget();
    connect(oneCustomWidget, &OneCustomWidget::sigValueChanged, this,
        &CameraParamDelegate::onValueChanged, Qt::UniqueConnection);
}
```

**顺序也是契约**：先 `InitWidget()` 把控件建好，再接管信号，最后才是 `setEditorData` 推值。反了就是往一个还没成形的控件里 `setText`。

## 委托的交接班：三步

![模型存、视图画、委托造控件 —— 三步交接](/images/zyclear/委托三步.svg)

MVD 的编辑流程是三个约定俗成的时机，委托在这三个点上跟控件交接：

- **`createEditor`**：造控件（上面那段）。只在单元格进入编辑态时调一次。
- **`setEditorData`**：把模型当前值推进控件。**每次进入编辑态都重新推一次**，注释写着「保证控件看到的是模型此刻的快照，而不是造控件时那一份可能已经过期的拷贝」。
- **`setModelData`**：控件编辑结束、把值写回模型。

但这里有个反常规的地方：**`setModelData` 其实几乎用不上**。因为控件值一变就立刻上报了，不等编辑事务结束——`CameraParamDelegate.h` 第 34 行：

```cpp
// 控件的值一变就走这里直写模型，不等编辑事务结束——本表没有"确认/取消"语义
void onValueChanged(const CameraParam& param, const QModelIndex& index);
```

**为什么不要「确认/取消」**：参数面板改一个值，就是要立刻下发给相机（自动曝光、增益这些实时参数，谁也不想改完还得按个确定）。所以控件的信号直接连到委托的 `onValueChanged`，一改就 `setData` 写模型；模型的 `dataChanged` 刷新视图、`SigValueChanged` 触发 `ParamWidget::writeCameraParam` 下发设备。**「编辑事务」这个 MVD 本来要维护的概念，在这个场景里被砍掉了。**

`onValueChanged` 里有个值得看的防御：

```cpp
OneCustomWidget* pCustomEdit = qobject_cast<OneCustomWidget*>(sender());
if (pCustomEdit) {
    // 控件会一直攥着这个 QModelIndex 直到编辑结束，期间若模型 clear()/reset() 过，
    // 它指向的节点已被删，所以先判 isValid 再写
    if (index.isValid()) {
        QAbstractItemModel* model = const_cast<QAbstractItemModel*>(index.model());
        if (model) {
            model->setData(index, QVariant::fromValue(param), CameraParamModel::ParamRole);
        }
    }
}
```

这里有两个「历史生还者」标志：`sender()` 可能不是 `OneCustomWidget`（判空）、`index` 可能已经失效（判 `isValid`）、`index.model()` 可能为空（判 `model`）。**这三个判断，每一个都对应一条真实的失效路径**——尤其是 `index.isValid()`，直接连着下面那个坑。

顺带说 `const_cast`：`index.model()` 只给 `const` 指针，而写模型必然要改它。这是 Qt 这套接口的固有尴尬，注释里我明确交代了为什么能这么做（模型对象本身不是 const 的，只是索引把指针降级了）。

## 坑一：枚举写回的是下标，不是编码

CHANGELOG 第 26 到 27 行记了这条：

> **枚举控件写回错误的编码**：写入的整数取自下拉框下标而非相机侧的编码表，两者只在编码恰好连续时相等；同时候选项在重填前没有清空，会叠加出重名条目。

**症状**：在参数面板里改一个枚举参数，选了下拉框的第一项，界面上显示新值了，但**往设备写进去的是另一个编码**，相机状态当场跑偏。而且不是所有枚举都跑偏——大多数时候是好的。

**为什么难发现**：根源是枚举有**三套表示**，它们的数值**只在特殊情况下相等**：

1. 下拉框的**下标**——第几项，`0..N-1`，是界面概念。
2. 枚举的**符号名**——`availableValue`，给界面显示的字符串。
3. 相机侧的**整数编码**——`availableInt`，SDK 只认这个，是设备概念。

我最初的写法是拿下拉框下标当编码直接写：`varParam.valueInt = value`。**海康大多数枚举的编码恰好就是 `0..N-1` 连续的，所以测试时我调的那几个参数全对。** 这是个「碰巧对」，不是「正确」——直到碰到一个编码不连续（比如 `{1, 2, 4, 8}`）的枚举，下标 `0` 和编码 `1` 对不上，界面选第一项，写下去的是别的编码。

去读代码确认相机侧走的是哪条路，`HikCamera.cpp` 第 547 到 563 行：

```cpp
for (unsigned int i = 0; i < value.nSupportedNum; i++) {
    int curInt = value.nSupportValue[i];      // 相机上报的编码，可能不连续
    intlist.push_back(curInt);
    // ... 用 nValue = curInt 去查符号名，填进 strlist
}
varParam.valueInt      = value.nCurValue;     // 当前编码
varParam.availableInt  = intlist;             // 候选编码表
varParam.availableValue= strlist;             // 候选符号名表
```

**相机集成层是显式查 `availableInt` 表的，界面这里必须跟它同口径。** 所以修正就是「拿下标去查编码表」，而不是假设下标等于编码。`EnumCustomWidget.cpp` 第 45 行是修正后的样子：

```cpp
// valueInt 是相机侧的整型编码，不是下拉框下标 —— 两者只有在枚举编码
// 恰好是 0..N-1 连续时才碰巧相等。
if (value >= 0 && value < varParam.availableInt.size()) {
    varParam.valueInt = varParam.availableInt.at(value);
}
```

**注意那个范围判断也是修正的一部分**：越界时**保留原值、不写**，而不是把越界下标当编码发出去。跟第三篇那个「union 偏移碰巧一致」是同一个教训——**不要依赖偶然成立的一致性，显式查表比自己算术。**

这条 CHANGELOG 还带了第二半：**候选项在重填前没有清空，会叠加出重名条目。** 因为编辑器在存活期间 `setEditorData` 可能被再次调用，第二次 `addItems` 不清空就等于往旧列表后面追加，下拉框里出现重复项。修正后 `EnumCustomWidget::setParam` 是先 `clear()` 再 `addItems()`：

```cpp
// 先清空再填：编辑器存活期间 setEditorData 可能被再次调用，
// 不清就会把候选项叠加进去，下拉里出现重名条目
QStringList valueList(varParam.availableValue.begin(), varParam.availableValue.end());
m_pCombox->clear();
m_pCombox->addItems(valueList);
```

**这两半（编码、清空）是同一类错误的两面：都源于「控件状态是会累积的」，而我一开始把它当成了「每次都是全新的」。** 控件不是每次重建的——它是个有生命周期的对象，方法会被重复调用，所以任何「往控件里加东西」的操作前面都得先想清楚要不要清。

## 坑二：模型与面板缺索引防护

CHANGELOG 第 28 到 29 行的另一条：

> **模型与面板缺少索引防护**：无效索引会经 `getItem()` 回落到根节点而被写坏，空选择会走到 `QList::first()` 越界。

这其实是**两个独立的越界点**，被同一句「缺索引防护」概括了。

**第一个在模型层**，`CameraParamModel::getItem()` 第 91 到 99 行。它长这样——一个看起来人畜无害的「拿条目」函数，携带了一颗雷：

```cpp
CameraParamItem* CameraParamModel::getItem(const QModelIndex& index) const
{
    if (index.isValid()) {
        CameraParamItem* item = static_cast<CameraParamItem*>(index.internalPointer());
        if (item)
            return item;
    }
    return m_pRootItem;      // ← 无效索引静默回落到根节点
}
```

**这个「回落到根节点」是个便利，也是个陷阱**：它让 `rowCount(QModelIndex())` 这类「问根有几个孩子」的正常调用不至于崩。但它同时意味着——**谁拿着一个失效的 `QModelIndex` 去 `setData`，值就会被写到根节点上**（根节点不对应任何参数，写进去等于数据凭空消失），而且还会发出一个指向无效索引的 `dataChanged`，视图那边随即错乱。

修法是在 `setData` 入口拦一道，`CameraParamModel.cpp` 第 151 到 154 行：

```cpp
// 索引必须先判有效：getItem() 对无效索引会回落到根节点，不拦就会把值写到根上，
// 还会发出一个指向无效索引的 dataChanged，视图那边随即错乱
if (!index.isValid())
    return false;
```

**为什么必须在 `setData` 里拦，而不是把 `getItem()` 改成「无效就返回 nullptr」**：改了 `getItem` 会破坏 `rowCount(QModelIndex())` 这些**需要根节点**的正常调用。**同一个 `getItem`，从「读」的角度看，回落是对的；从「写」的角度看，回落是灾难。** 所以防护要加在**写的那一侧**（`setData` 判 `isValid`），而不是改 `getItem` 的读语义——**写操作对无效输入必须更严格，这个不对称是刻意的。**

**第二个在面板层**，`ParamWidget::OnUpdataSelection` 第 190 到 194 行。选择变化时取第一个索引去查说明文本：

```cpp
// 只取第一个索引去查说明：tips 挂在条目上，同一条目两列取到的内容相同。
// 但模型清空 / reset 会带着空选择走到这里，.first() 就成了越界访问，
// 所以先判空——"选择变化至少带一个索引"这条视图行为不能当契约使
const QModelIndexList selectedIndexes = selected.indexes();
if (selectedIndexes.isEmpty()) {
    return;
}
```

`QModelIndexList` 底层是 `QList`，`.first()` 对空列表是**未定义行为**（在有些 Qt 版本上是越界读）。**我一开始的前提是「选择变化回调至少带一个索引」**——这个前提在用户手动点选时几乎总成立，但**模型 `clear()`/`reset()` 会带着一个空的 `selected` 走到这里**。这不是「用户点了空的地方」，是「模型自己把选择清空了」。

**为什么视图回调不能当契约使**：回调的参数是**视图当前状态的快照**，而视图状态可能被模型的任何一次 `reset()`/`clear()` 改动。**「这个回调至少带一个参数」是我从「用户操作」推断出来的行为，不是视图保证的语义。** 把它当契约写进代码，就等于依赖一个没写在文档里的假设。教训跟上一篇「返回 false 不等于表空」是同一类：**接口的旁路信号（回调、返回值）不能等价于主数据状态的保证，两者要分别约定。** 修法很简单（判空），但**先得承认那个前提根本不成立**。

## 坑三：`setParam` 的信号回环

第三个坑不在 CHANGELOG 里，是因为它没爆成 bug——但它的危险不亚于前两个，而且每个控件的 `setParam` 里都有同一段防御代码。

问题的形状是这样的：`setParam()` 负责把模型的值推进控件（`m_SpinBox->setValue(...)`、`m_pLineEdit->setText(...)`）。**但 Qt 的控件有个脾气——编程式设值也会发信号。** `QSpinBox::setValue(5)` 会发 `valueChanged`，`QLineEdit::setText(...)` 会发 `textChanged`。而控件的这些信号连着的正是 `onValueChanged`，`onValueChanged` 又改 `m_param`……

于是形成一条闭环：**`setParam` → 控件设值 → 控件发信号 → `onValueChanged` → 改参数；更糟的是若 `onValueChanged` 又反过来触发一次 `setParam`，就是死循环。** 界面在推值的时候被自己推出来的信号反咬一口。

断开的方式是**在编程式设值前后关掉信号**，看 `IntCustomWidget::setParam`：

```cpp
void IntCustomWidget::setParam(CameraParam& param)
{
    disconnect(m_SpinBox, QOverload<int>::of(&QSpinBox::valueChanged),
        this, &IntCustomWidget::onValueChanged);

    OneCustomWidget::setParam(param);
    IntParam varParam = m_param.GetValue().value<IntParam>();
    m_SpinBox->setMinimum(varParam.min);
    m_SpinBox->setMaximum(varParam.max);
    m_SpinBox->setValue(varParam.value);      // ← 这个设值不会再回发信号
    // ...

    connect(m_SpinBox, QOverload<int>::of(&QSpinBox::valueChanged),
        this, &IntCustomWidget::onValueChanged);
}
```

基类的注释把这条规矩钉死了：**「灌值前必须断开控件的值变更信号，因为 setText/setValue 这类编程式设值同样会发信号，不断开就会经 onValueChanged 回程再走一次 setParam，读写互为因果成死循环。」**

**这里的取舍是「手动关信号」而不是更优雅的东西**。更干净的做法是 `QSignalBlocker`（RAII，作用域结束自动恢复）或 `blockSignals(true/false)`。我选了 `disconnect`/`connect` 手动配对，是因为它**显式得近乎啰嗦**——每个 `setParam` 里那对 disconnect/connect 就是一段可以被读到的契约：这段时间内控件不能发信号。代价是**一旦中途有 `return` 提前退出，`connect` 就漏了**，控件从此静默。可现在这几个 `setParam` 都是直线代码没有提前 return，这个风险暂时为零——**又是一个「当前成立但没写下来就会被下个人破坏」的假设。**

一个有意思的对照：`BoolCustomWidget` 和 `CmdCustomWidget` 用的是 `clicked` 信号，而 `clicked` **只在用户交互时发出，编程式 `setChecked`/`setText` 不会回发**——它们本来不需要断开。但这两个控件的 `setParam` 里**照样写了那对 disconnect/connect**，注释写明了原因：

```cpp
// clicked 只在用户交互时发出，编程式 setChecked 不会回发信号，这里本可不断开；
// 保持与其它控件同一对 disconnect/connect 包围，免得日后换信号或加控件时漏掉
```

**这个「多余」是刻意的**：六个控件的 `setParam` 长得一样，读代码的人不用逐个判断「这个控件的信号会不会回发」。**统一写法的价值不在于当前正确，在于它消除了一个「每读一处都要重新推理」的认知负担。** 跟上一篇那个手写拷贝构造是同一个思路——用一个看起来冗余的写法，承载一段能被读到的语义。

## 模型这一层顺带的两件事

**第一，分组节点是懒建的**。模型里的分组不是参数，是「头一次碰到某个分组名才补一个节点，之后命中缓存复用」的容器。`addCameraParam` 里：

```cpp
// 分组节点也往条目里塞一张 CameraParam：name 写成分组名、group 记 "root"，
// 类型给 UNKNOWN，顺带让它落进 flags() 的不可编辑分支
auto info = CameraParamMetaInfo { "root", strCurGroupName, UNKNOWN, "", "" };
newGroup->setData(QVariant::fromValue(CameraParam(info)));
```

**分组为什么复用 `CameraParam` 而不是另造一个节点类型**：它需要的东西跟参数一模一样——一个显示名（分组名就是它的 `name`）、一个能塞进 `QVariant` 的载荷、一套权限位。给它 `type = UNKNOWN`，`flags()` 里因为 `isWriteable() == false` 自动判它不可编辑。**一个节点类，两种用途，靠类型字段分流。** 这就是上一篇「权限位零初始化」的顺带收益——分组行天然不可编辑，不需要为它单独写一条判断。

**第二，`addCameraParam` 全程没有 `beginInsertRows`/`endInsertRows`**。这意味着视图收不到行数变化通知。现在能工作，是因为装载完之后 `ParamWidget` 会整树 `reset()` + `expandAll()` 兜底——`clearParamWidget()` 里那句注释写着「reset() 不是多余的：模型加/删行都没发 begin/end 通知，只有整树重挂才能让视图丢掉旧行」。**这是个明确的欠账**：模型绕过了 Qt 的行通知协议，靠一个外部调用者的 `reset()` 补上。换个不信 `reset` 的调用方，这棵树就不刷了。注释里写清了「换到别处复用必须自己补模型通知」。

## 我踩过的坑

**坑一：枚举写回用下标冒充编码，只在编码连续时才对。**

本篇重点，见上面第五节。三套表示（下拉下标、符号名、相机编码）只在编码恰好连续时前两者与后者相等。海康大多数枚举碰巧连续，所以测试全过；碰到不连续的枚举，界面选第一项、设备收到另一个编码。修正是显式查 `availableInt.at(value)` 并判越界。这条 CHANGELOG 里还带着姊妹坑——候选项重填前没清空，下拉里叠出重名条目。**两个都是「把有状态的控件当成每次全新的」**。教训：控件的方法会被重复调用，任何「往控件里加」的操作前面先问要不要清。

**坑二：无效索引经 `getItem()` 回落到根节点，把值写坏。**

`getItem()` 对无效索引返回 `m_pRootItem`——这个便利让「问根有几个孩子」这类读操作正常，但也让「拿着失效索引发写」变成「静静写到根节点上」。修法是在 `setData` 入口判 `isValid`，而不是改 `getItem` 的读语义。**读可以宽容，写必须严格**——这个不对称是因为同一个回落，用在读上是兜底、用在写上是灾难。根因是 `QModelIndex` 会在模型 `reset`/`clear` 后失效，而控件会一直攥着一个旧索引直到编辑结束。**持有索引就等于持有「它会失效」这个义务。**

**坑三：空选择走到 `QList::first()` 越界。**

`OnUpdataSelection` 里取 `selected.indexes().first()` 查说明。我原来的假设是「选择变化回调至少带一个索引」——用户手动点选时确实成立。但模型 `clear()`/`reset()` 会带着一个空的 `selected` 走到这里，`.first()` 就是未定义行为。**「视图回调至少带一个参数」是我从「用户操作」推断的行为，不是视图保证的语义。** 跟上一篇「返回 false 不等于表空」同一类：**回调参数是旁路信号，不能等价于主数据通道的保证。** 修法判空，但先得承认前提根本不成立。

**坑四：构造期调虚函数，`addEditLayout` 会落到基类空实现。**

基类 `InitWidget()` 要调虚函数 `addEditLayout()` 让子类加控件。**如果在构造函数里调它，派生类还没构造完，vtable 指向基类，虚函数派发落到基类的空实现**——子类的 `QSpinBox` 永远挂不进布局。修法是把 `InitWidget()` 拆出来，**由委托在控件构造完成后显式调一次**。基类的 `addEditLayout` 还刻意写成空实现而非纯虚：纯虚能拦住「忘了重写」，但拦不住「构造期调虚函数」这个坑（编译能过，运行期派发到基类）；空实现方案下，漏重写或时序错了会得到一个**空单元格**，一眼看得见。**我宁愿要「看得见的运行期错误」，不要「编译通过、运行期悄悄用错版本」。** 这也是为什么 `createEditor` 里 `InitWidget()` 必须排在 `connect` 和 `setEditorData` 之前——顺序本身就是契约。

**坑五：`setParam` 的信号回环，靠手动 disconnect/connect 断开。**

编程式 `setValue`/`setText` 照样发信号，值一变就回程走 `onValueChanged`，读写互为因果。断开方式是在推值前后手动 `disconnect`/`connect`。我选了显式配对而不是 `QSignalBlocker`，因为前者意味着「这段时间控件不能发信号」被写在了脸上。代价是提前 `return` 会漏掉 `connect`。更值得记的是 `BoolCustomWidget`/`CmdCustomWidget`——它们的 `clicked` 信号本来就不回发，但**照样写了这对 disconnect/connect**，为的是六个控件的 `setParam` 长一样、读的人不用逐个推理。**统一写法的价值在消除「每读一处都要重新判断」的认知负担。**

**坑六（半个）：`addCameraParam` 不发行通知，靠 `reset()` 兜底。**

模型加行没走 `beginInsertRows`/`endInsertRows`，视图收不到行数变化。现在靠 `ParamWidget` 装载完之后的整树 `reset()` 兜住。它能工作，但**这是模型绕过 Qt 协议的欠账**，换个不信 `reset` 的调用方就失效。写清在注释里了，但它现在仍是「靠调用方默契成立」，不是「模型自己负责」。

## 结尾

参数树是数据，界面把它渲染成控件树，靠的是 MVD 的三方分工：模型持数据与权限、视图管显示与选择、委托只做「按类型造控件」和「搬运」两件事。六种参数类型在这里分派出六个控件，分派的是**类型**不是**参数**——所以新增型号不用改这一行 `switch`。委托里的 `switch` 是整个参数体系「界面层对参数规模无感」的落点：37 项参数是 37 行文字，常驻控件数始终是「正在编辑的那一个」。

四个坑里有三个是同一类：**把有状态、会失效的东西当成了无状态、永久的**——控件会被重复调用（所以要清空、要断信号）、`QModelIndex` 会失效（所以写前判 `isValid`）、视图回调不保证非空（所以判空）。第四个是纯 C++ 的构造期虚函数陷阱。它们的修法都很短，贵的从来不是修法，是**先得知道这些坑存在**。

参数面板到此能读能写能下发。但它只解决了一半问题——**值改完下发到相机，相机那边到底有没有真接受，界面现在是乐观更新的（写失败不回滚）。** 而比这更重的另一半是：参数只是配置，相机还有一条**每秒几十帧的图像链路**——采集线程、双队列缓冲、满队列保新弃旧、四级异步隔离。

下一篇讲**图像链路**：一帧数据从相机回调出发，穿过采集线程和缓冲队列，最后落到界面那块显示控件上，中间每一级为什么要异步、队列满了丢哪一帧、以及为什么图像显示要做像素级取色而不是简单贴图。
