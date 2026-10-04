---
title: 加型号不编译不发版：参数变成配置资产
description: 参数定义该是代码还是配置？这一篇讲 VirtualCameraParam.json 这棵参数树长什么样、ParseUiJson 怎么把它解析成元信息表、loadFromFile 失败时不清表这个坑怎么来的、界面又怎么在运行时按类型挂控件。
pubDate: 2026-10-03
tags: [C++, Qt, 架构设计, JSON, 工业软件]
---

上一篇讲统一参数模型：六种类型压进一个外观类，`type` 与值配对的那颗雷，权限三态在模型层拦下。那篇结尾留了个问题——**这六种类型、这些 `group` / `name` / `tips`、这些候选值，是从哪来的？**

如果这份静态描述是硬编码在 `HikCamera::getParamList` 里的，那「新增型号不编译、不发版」这句话就是空话：每接一个品牌，还是得打开 C++ 文件、照着结构体手写一张表、编译、测试、发版。

这一篇讲把这棵参数树从代码里搬出来的那一步：**参数定义变成一份 JSON 配置资产**，解析器读它，界面按它装配。

## 参数表为什么该是配置

先算一笔账。我在虚拟相机里试过两种写法。

第一种，硬编码：

```cpp
// 反面写法：新增一个型号 = 在这一行下面再抄一段，改字段名、改分组、改类型
CameraParamMetaInfo{ "DeviceControl", "DeviceVendorName", ZCParamType::STRING, "", "设备制造商名称" },
CameraParamMetaInfo{ "DeviceControl", "DeviceUserID",   ZCParamType::STRING, "", "设备名称" },
// ... 后面还有三十几行
```

第二种，读 JSON：`getParamList` 整个函数只有七行，不含任何参数名。

**这两种写法的差别不在打字量，在「改什么」**。硬编码版本里，加一个型号要动 `.cpp`、动构建产物、走一遍编译和回归测试；JSON 版本里，加型号是往 `src/Resource/` 扔一个新 JSON、在 `resource.qrc` 里登记一行——**代码零改动，产物零重建，配置文件的改动不需要任何人重编译**。

这正是 CHANGELOG 里那句「参数体系……由 JSON Schema 驱动，界面按类型运行时装配，新增型号不编译、不发版」的落点。它不是什么玄学，就是把一份**纯数据**从**可执行体**里拿出来。

**为什么参数描述是「纯数据」**：看 `CameraParamMetaInfo` 那五个字段——`group`（分组标题）、`name`（GenICam 节点名）、`type`（渲染成哪种控件）、`relative_list`、`tips`（说明文本）。五个字段里没有一个携带逻辑。它不是「怎么读写这个参数」，只是「这个参数叫什么、归哪组、长什么样」。**描述性数据没有理由编译进二进制。**

## 去数一遍：5 组、37 项

先把这份配置摊开。`VirtualCameraParam.json`，248 行，正则数出来的结构是这样：

| 分组 | 参数数 |
|---|---|
| `DeviceControl`（设备控制） | 3 |
| `ImageFormatControl`（图像格式） | 9 |
| `AcquisitionControl`（采集控制） | 10 |
| `AnalogControl`（模拟控制） | 11 |
| `UserSetControl`（用户参数组） | 4 |
| **合计** | **37** |

37 项按类型再数一遍：`INT` 8、`BOOL` 8、`ENUM` 8、`DOUBLE` 5、`CMD` 5、`STRING` 3。**六种类型一个不少，每种都在这份配置里真实出现了**——这不是巧合，是虚拟相机被设计成「要覆盖全部六条渲染分支」的测试替身，六条分支都得有活数据喂进去。

**为什么用 248 行 JSON 描述 37 项参数**：这不是啰嗦。一个 JSON 对象固定要 `name` / `type` / `relative_list` / `tips` 四个字段，加上引号、花括号、逗号，一项就花掉六七行。**行数换来的东西是「可读」**——你在编辑器里打开它，一行行扫下去，每个参数的用途一眼可见，不用去读结构体的构造调用。

## JSON 怎么描述一棵参数树

结构本身很简单，两层。顶层是**数组**，数组的每个元素是一个**分组对象**；分组对象里有 `group`（分组名）和 `params`（参数数组）；参数数组的每个元素是一个**参数对象**。节选前两组看得最清楚：

```json
[
  {
    "group": "DeviceControl",
    "params": [
      { "name": "DeviceVendorName",   "type": "STRING", "relative_list": "", "tips": "设备制造商名称" },
      { "name": "DeviceUserID",       "type": "STRING", "relative_list": "", "tips": "设备名称，默认为空，可自行设置" },
      { "name": "DeviceSerialNumber", "type": "STRING", "relative_list": "", "tips": "设备序列号" }
    ]
  },
  {
    "group": "ImageFormatControl",
    "params": [ /* Width/Height/OffsetX/... 共 9 项 */
      { "name": "PixelFormat", "type": "ENUM", "relative_list": "", "tips": "相机支持多种像素格式……" }
    ]
  }
]
```

**为什么顶层是数组而不是一个对象**：数组**自带顺序**。分组顺序直接等于界面上从上到下的排列顺序，不需要额外的 `order` 字段，也不需要解析后排序。这一条在解析器里被写死了——「顶层固定是分组数组，单个分组对象、单个参数对象都不接受」。**结构越死，解析越简单。**

参数对象四个字段的职责：

- `name` — **寻址键**。它同时是界面显示的名字和下发 SDK 的 GenICam 节点名，所以「必须与相机节点名逐字符一致」，大小写错一个字就是读不到。
- `type` — **渲染开关**。取值是六个大写字符串 `INT` / `DOUBLE` / `ENUM` / `BOOL` / `CMD` / `STRING`，跟 `ZCParamType` 枚举一一对应。
- `tips` — 纯文案，选中该行时显示在参数区下方那个说明框里。
- `relative_list` — 可选字段，下面单独一节讲。

**为什么 `type` 用字符串而不是数字**：字段名集中定义在实现文件顶部（`const QString kType = "type";` 这类），注释写着「它们是这份 JSON 的对外契约键，也是唯一允许改动 schema 的地方」。**写 JSON 的人是一份人读的配置的作者，不该被迫记住「3 代表 ENUM」这种编码。**

## 解析器：两个文件各干什么

`ParseUiJson` 拆成 `.h`（88 行，接口 + 契约注释）和 `.cpp`（293 行，实现）。职责切得很干净：

**`.h` 里是「谁能问它拿什么」**：单例入口 `instance()`、三个装载入口 `loadFromFile` / `loadFromString` / `loadFromByteArray`、三个查询 `getParamList` / `getParamListByGroup` / `getAllGroups`、状态查询 `isValid` / `getLastError`，加一个 `clear()`。**注意它的对外接口里没有任何一个方法暴露 `QJsonObject` 或原始行**——调用方拿到的是 `QList<CameraParamMetaInfo>`，解析细节全被关在 `.cpp` 里。

**`.cpp` 里是「怎么把 JSON 变元信息」**，主干是一条三层循环：遍历顶层数组（分组）→ 校验 `group` 字段 → 遍历 `params`（参数）→ 逐项 `validateParamObject` → 填一个 `CameraParamMetaInfo` → append。

**为什么做成单例**：头文件注释直接给了理由——「解析结果要跨相机实例复用：整张参数表只解析一次，谁问给谁，避免每 new 一台虚拟相机都重读一遍资源」。但单例是**全局共享**的，所以虚拟相机 `getParamList` 里每调一次都得重载一遍：

```cpp
// VirtualCamera::getParamList：单例是全局共享的，别的相机也可能往里塞过数据，
// 所以这里每调一次都重载一遍，保证本次结果正确
ParseUiJson* parser = ParseUiJson::instance();
parser->loadFromFile(":/VirtualCameraParam.json");
QList<CameraParamMetaInfo> paramMetaInfoList = parser->getParamList();
for (auto var : paramMetaInfoList) {
    paramList.push_back(CameraParam(var));
}
```

**为什么共享单例却每次重载**：单例省的是「解析成本」，不是「数据所有权」。第二个虚拟相机实例不该继承第一个塞进去的表，所以入口处强制重载。**共享的是解析器，不是解析结果**——这个区别不写清楚，就会有人以为拿到的是自己那份。

类型字符串到枚举的映射用一张**函数局部 static 表**：

```cpp
ZCParamType ParseUiJson::stringToParamType(const QString& typeStr) const
{
    static QMap<QString, ZCParamType> typeMap = {
        { kInt, INT }, { kDouble, DOUBLE }, { kEnum, ENUM },
        { kBool, BOOL }, { kCmd, CMD }, { kString, STRING }
    };
    return typeMap.value(typeStr, UNKNOWN);   // 不带默认值的 value，未知类型不插表
}
```

**为什么是 `value(str, UNKNOWN)` 而不是 `typeMap[str]`**：`operator[]` 在键不存在时会**插入一个默认项**——这个函数是 `const` 的，本来就不该改动任何状态，用 `operator[]` 等于偷偷改了一个静态表，而且以 `const` 之名干了非 const 的事。`value()` 只读，未知类型返回 `UNKNOWN`，干净。

## 一个真实的坑：失败路径不清表

这一篇最该讲透的坑，写在 `ParseUiJson.h` 第 28 到 32 行，代码作者（也就是我）自己把警告留在了契约文件里：

```cpp
// 关键坑：「返回 false」不等于「参数表是空的」。只有 loadFromByteArray
// 会先 clear()，而 loadFromFile 在文件不存在/打不开时是提前返回的，
// 上一轮成功解析出的 m_paramList 会原样留着。
// 所以调用方要么看返回值、要么看 isValid()，只调 getParamList()
// 会把上一次的旧数据当成这一轮的解析结果。
```

拆开看它怎么发生的。三个入口最终都汇聚到 `loadFromByteArray`，但**清理动作只在最里面那层**：

```cpp
bool ParseUiJson::loadFromByteArray(const QByteArray& jsonData)
{
    clear();                        // ← 唯一的清理点
    bool success = parseJson(jsonData);
    emit parseFinished(success, m_lastError);
    return success;
}

bool ParseUiJson::loadFromFile(const QString& filePath)
{
    QFile file(filePath);
    if (!file.exists()) {           // ← 早退，不碰 m_paramList
        m_lastError = QString("文件不存在: %1").arg(filePath);
        m_isValid = false;
        emit parseFinished(false, m_lastError);
        return false;
    }
    // ...
}
```

`loadFromFile` 有三条失败路径：**文件不存在、文件打不开、解析失败**。前两条在打开文件之前就 `return false` 了，压根到不了 `loadFromByteArray` 里的 `clear()`。于是状态变成：`isValid() == false`，但 `getParamList()` **返回上一轮那 37 项**。**两个 API 说的是两套话。**

**为什么这个坑这么典型**：它是「失败路径没处理干净」的教科书样子——成功路径和失败路径的**状态收尾不一致**。成功时表被换新，失败时表被原样留着，而且失败时连「我失败了」这件事都只通过返回值和 `isValid` 这两个旁路信号传出去，主数据通道（`getParamList`）是**沉默地撒谎**。

**我最后怎么定这个语义**：没有让 `loadFromFile` 也在失败时 `clear()`。理由是——那样会引入第三态：**「说不清是旧表还是新表」**。现方案把状态收敛成两个互斥的可能：**要么你拿到一份崭新的表，要么连旧表一起明确作废**（`loadFromByteArray` 的 `clear()` 保证了后半句）。头文件里那句「返回 false 不等于参数表是空的」就是这份语义的契约文字。**调用方要么看返回值、要么看 `isValid()`，绝不能只调 `getParamList()`。**

这个坑最贵的部分不是代码，是**它骗过了调用方**。虚拟相机 `getParamList` 现在的写法是「先 `loadFromFile`，再 `getParamList()`，不看返回值」——如果哪天资源路径配错、文件缺失，它不会失败，它会**沉默地把上一次别的相机塞进来的表当成自己的参数表**。这才是「返回 false 不等于表空」真正咬人的地方。修法很简单（判一下返回值），但**先得有人知道这个坑存在**——这就是为什么它必须写在契约头文件里，而不是留在 commit message 里。

## 视图运行时装配：空壳 + 现场挂载

参数表被解析出来之后，怎么变成界面上那一格格控件？

![JSON 描述一棵参数树，运行时渲染成另一棵控件树](/images/zyclear/Schema两棵树.svg)

先说界面容器这一层。`ParamWidget.h` 第 16 行的注释是整件事的总纲：

```cpp
// 参数区的容器：这里只搭空壳（两列表头 + 说明框 + 刷新按钮），真正的参数在收到
// 相机连接消息后由模型与委托运行时装配，所以本类里不会出现任何相机型号的参数名。
```

**「本类里不会出现任何相机型号的参数名」**——这句话可以当场验证：`ParamWidget.cpp` 里搜不到 `Gain`、`ExposureTime`、`PixelFormat` 任何一个名字。界面容器**完全不知道**自己要显示什么。它搭的是一个**空壳**：一个 `QTreeView`、一个说明框、一个刷新按钮，两列表头写死成 `Param` / `Value`。

参数什么时候进来？`CAMERA_CONNECT` 消息到达时：

```cpp
// ParamWidget::RespondMessage 收到连接消息后
QVector<CameraParam> paramList;
CameraContext::Instance()->getParamList(serial, paramList);   // 走门面拿 Schema 骨架
initParamWidget(paramList);                                    // 逐项 readParam 后进模型
```

`getParamList` 返回的是**没有值的 Schema 骨架**（`CameraParam` 只带了元信息，`_value` 是空的），`initParamWidget` 再逐项对设备 `readParam` 把值灌进去，然后 `addCameraParam` 挂进模型。**骨架来自配置，值来自设备，两条线在模型里汇合。**

控件层面的现场挂载在委托的 `createEditor` 里：

```cpp
// CameraParamDelegate::createEditor 内的 createWidget lambda
switch (cameraParam.type()) {
case STRING: return new StringCustomWidget(cameraParam, index, parent);
case CMD:    return new CmdCustomWidget(cameraParam, index, parent);
case INT:    return new IntCustomWidget(cameraParam, index, parent);
case DOUBLE: return new DoubleCustomWidget(cameraParam, index, parent);
case BOOL:   return new BoolCustomWidget(cameraParam, index, parent);
case ENUM:   return new EnumCustomWidget(cameraParam, index, parent);
default:     return nullptr;
}
```

**注意控件是按需造的，而且是在单元格被打开（进入编辑态）的那一刻才造**。行本身只是表格里的一行文字（委托的 `paint` 只画文本和网格线），直到用户点它才 `createEditor` 出一个真正带编辑元素的控件。**这就是「界面层对参数规模无感」的机制**：37 项参数意味着 37 行文字，不是 37 个控件实例。参数涨到 370 项，还是 370 行文字，**常驻的控件数始终是「正在编辑的那一个」**。

**为什么这个分派点是「新增型号不编译」的最后一块拼图**：`switch` 里**没有一处引用具体型号**——它只分派「类型」，不分派「参数」。新增型号往 JSON 里加 `"type": "ENUM"`，走的就是已有的 `ENUM` 分支，**这一行 switch 一个字都不用改**。只有当新增的是一种**新的参数类型**（比如 `RANGE`）时，才需要在这里补一支——那是改能力边界的活，本来就该编译发版。

分组节点也值得说一句。模型里的分组不是参数，是**懒建**的容器：

```cpp
// CameraParamModel::addCameraParam：头一次碰到某分组才补一个节点，之后命中缓存复用。
// 分组节点也往条目里塞一张 CameraParam：name 写成分组名、group 记 "root"，
// 类型给 UNKNOWN，顺带让它落进 flags() 的不可编辑分支
auto info = CameraParamMetaInfo { "root", strCurGroupName, UNKNOWN, "", "" };
newGroup->setData(QVariant::fromValue(CameraParam(info)));
```

**分组为什么复用 `CameraParam` 而不是另造一个节点类型**：因为它需要的东西跟参数一模一样——一个显示名（`name` 就是分组名）、一个能塞进 `QVariant` 的载荷、一套权限位。给它 `type = UNKNOWN`，`displayText()` 会回落到 `"unknow"`（也就是上一篇那个拼写），同时 `flags()` 因为 `isWriteable() == false` 自动判它不可编辑。**一个节点类，两种用途，靠类型字段分流。** 顺带说，模型 `data()` 里专为它写了一行：`if (m_groups.keys().contains(paramData.name())) return "";`——分组行的值列留空，不然就会把 `"unknow"` 显示出来。

## `relative_list`：一个还没被消费的字段

`relative_list` 出现在每个参数对象里，解析器也老老实实把它填进了 `CameraParamMetaInfo.relative_list`，`CameraParam` 还专门开了一个 `relativeList()` 访问器。**但这份 JSON 里 37 项的 `relative_list` 全是空串**。

那它解决什么问题？看测试里唯一给了非空值的例子：

```cpp
CameraParamMetaInfo meta { "AnalogControl", "Gain",
    DOUBLE, "ExposureTime", "增益设置" };
QCOMPARE(param.relativeList(), QStringLiteral("ExposureTime"));
```

`Gain`（增益）的 `relative_list` 指向 `ExposureTime`（曝光）。**这两个参数是一对联动项**——调曝光影响增益的可用范围，调增益也受曝光约束，界面上往往需要一起显示、一起校验、或者一个变化时联动刷新另一个。

**为什么用「名字字符串」而不是「索引」来建立关联**：名字是稳定键——参数在 JSON 里调个顺序、插一项，`relative_list: "ExposureTime"` 依然指得对；换成索引，任何一次插入都会让后面的引用全体指错。**跨项引用一律用稳定标识，不用位置。**

**为什么它现在全是空的**：这个字段是**为联动特性预留的**，而联动逻辑（比如「改了曝光，把 Gain 的 min/max 重新读一遍」）还没做到模型/委托里。它现在的状态是「契约先留了位，消费方还没接上」。这跟上一篇 `m_cameraParams` 那个死字段是同一种诚实——**一个字段要么被用、要么说清它为什么空着**。区别是 `relative_list` 至少有测试在用它，证明这条通路是活的：JSON 写进去、解析器读出来、访问器能取到。**消费侧没接，不等于这条线是断的。**

（第 5 篇讲过枚举的 `value` / `valueInt` 两套表示必须同步填。`relative_list` 跟那个不是一回事：枚举双表示是**单个参数内部**的两种形式，`relative_list` 是**两个参数之间**的关联。别混。）

## 配置化的代价：把编译期错误变成运行期错误

把参数表搬出代码，买到的是「改配置不编译」。代价必须说清楚，因为它不是小的。

**第一，格式错误只在运行期暴露。** 硬编码那张表写错一个字段名，编译器当场报错。JSON 写错，编译器一无所知——它只是一个字符串数组，对不对得等 `loadFromFile` 跑起来才知道。**编译期挪走了，就没有任何静态检查替你把关。**

**第二，错误路径必须自己兜，而且兜法有限。** 解析器的应对是 **fail-fast**：遇到第一个不合规的分组或参数就整体放弃。实现文件里给的理由是——「参数表缺项会让界面显示的控件与相机实际能力对不上，这种不同步比整表不加载更难排查，宁可明确失败」。**这是取舍，不是最优**：一个参数写错，整张表都不加载。另一条路是「跳过坏项继续」，但那样界面就会显示一张**残缺的表**，用户看到的是「有些参数没了」，而不知道是配置坏了还是相机不支持。**整表失败吵得响、残缺表藏得深。**

**第三，容错度要分层设计，不能一刀切。** 看解析器对两类错误的处理就不同：

- **结构错误**（缺 `group`、缺 `params`、`name` 不是字符串）→ **直接失败**，整表不加载。
- **未知 `type`**（不在六个白名单里）→ **静默落成 `UNKNOWN`**，不失败。

```cpp
// 类型不在白名单里不报错，静默落成 UNKNOWN —— 刻意的容错：
// schema 允许先于实现出现新类型，界面遇到 UNKNOWN 自行跳过渲染即可，
// 不该因为它整表加载失败。
paramInfo.type = stringToParamType(paramObj[kType].toString());
```

**为什么对 type 宽容**：schema 可以**先于实现出现**。产品还没实现 `RANGE` 类型的渲染，但配置里已经写了——这时候该做的是「这一项暂不渲染」，而不是整个型号的参数表全废。**结构错误是「这份配置本身是坏的」，未知类型是「这份配置比程序时机更超前」，两件事不该同样对待。** 这个分层容错是配置化方案里少有的、值得抄的技巧。

**第四，没有值的校验——因为值不在配置里。** JSON 只描述「参数长什么样」，不写值。值在 `readParam` 时从设备读回。所以配置化管不到「这个曝光值合不合法」，那是运行期设备的事。**参数树的形状来自配置，内容来自设备，两件事分得很清——这也正是这套设计能成立的前提。** 如果值也写进 JSON，它就要跟真机状态打架了。

## 我踩过的坑

**坑一：`loadFromFile` 失败时不清表，旧数据冒充新结果。**

本篇重点，见上面第五节。`loadFromFile` 的三条失败路径里有两条在读文件之前就 `return` 了，够不到 `loadFromByteArray` 里的 `clear()`。结果是 `isValid() == false` 和「表里还有上一轮的 37 项」**同时成立**。我最初以为「返回 false 就代表了参数表是空的」，把返回值当成了表状态的等价物。**实际上返回值和主数据通道各说各话。** 最阴的是调用方——虚拟相机现在就是「不看返回值、直接 `getParamList()`」，一旦资源路径配错，它不报错，它沉默地把别人的旧表当成自己的。

教训：**失败路径的状态收尾必须和成功路径一样干净。** 一个函数的返回值只能报告「这次成没成」，报告不了「我留下的状态是什么」——两者要分别约好、分别写进契约。我最后没让 `loadFromFile` 也 `clear()`，是因为要让状态只有两种可能（新表 / 明确作废），代价就是 `isValid()` 从此成了必须看的信号。

**坑二：`validateParamObject` 报错文案的下标是 1 基，`parseProgress` 是 0 基。**

看这两处的注释。`validateParamObject` 的 `index` 参数：「0 基下标，仅用于拼错误文案（文案里会 +1）」。而 `parseProgress` 发的：`emit parseProgress(i, totalGroups)`，注释写着「current 用的是 0 基下标……语义是『正在处理第几组』，因此它永远不会到达 total」。

**同一个遍历里，索引给用户看时要 +1，给进度条用时不 +1**——两个口径并存。我第一版把 `parseProgress` 也跟着 +1 了，进度条直接冲到 100% 然后停在那不动（因为最后一组的 current 等于 total，进度条以为结束了）。**凡是「下标」都要先问一句：这是给人看的第几个，还是给程序用的偏移量？** 两者错位一次，就是一个进度条永远卡在头或尾。

**坑三：字段名常量是非 static 全局变量，有重名符号风险。**

实现文件顶部那些 `kGroup` / `kParams` / `kName` / `kType` / `kRelativeList` / `kTips` 全是 `const QString`，注释自己招了：「注意这些是非 static 的全局常量（外部链接）。当前只有一个目标文件包含本实现，没问题；**若将来把这份 .cpp 编进多个静态库，会出现重名符号的链接错误**」。

我当时的想法是「集中定义字段名，改一处不散落」——这个目的达到了。但我用的是**外部链接**的全局常量，等于往全局符号表里塞了六个很常见的名字（`kName`、`kType`……）。现在只有一个 TU 包含它所以没事，一旦这份 `ParseUiJson.cpp` 被编进两个目标同时链接，就是链接期重名。**正确的写法是放进匿名命名空间，或者标 `static`**，把链接范围锁在本文件内。这个坑现在没爆，是因为使用场景恰好单一——**「还没出问题」和「没有问题」是两回事。**

**坑四：单例的双检锁在纯 C++ 语义下有竞争，我接受它是有前提的。**

`instance()` 的写法：

```cpp
if (!m_instance) {                       // ← 快路径无锁读
    QMutexLocker locker(&m_mutex);
    if (!m_instance) { m_instance = new ParseUiJson(); }
}
return m_instance;
```

头文件里我把这件事挑明了：`m_instance` 在快路径上是无锁读，「严格说与初始化写之间存在数据竞争；这里接受它是因为调用点全在启动阶段的单线程路径上」。**注意「接受」的前提被写下来了**——不是「双检锁是对的」，是「在当前调用时序下它不出错」。这跟坑三是同一类：**一个当前成立的假设，如果不写下来，下一个人换到多线程环境里就会踩。** 我把前提写进注释，就是为了让这件事从「隐藏假设」变成「已知条件」。

**坑五：`getParamList()` 按值返回，我一度不敢。**

`QList<CameraParamMetaInfo> getParamList() const` 返回的是**值**，不是 const 引用。第一反应是「37 项拷贝一份，浪费」。但注释点破了：`QList` 底层有隐式共享（copy-on-write），拷贝本身是 O(1)，只有调用方真的改写时才深拷贝。**所以这里不必返回引用，返回值的语义反而更安全**——调用方拿到的是一份可以随便改的独立列表，不会意外动到单例里的表。**「按值返回 = 浪费」是个需要看容器实现才能下结论的判断，不能凭直觉。** Qt 容器在这个点上恰好站在「值语义免费」这一侧。

## 结尾

参数定义从代码搬进 JSON，这件事的收益是**「新增型号不编译、不发版」**从一句口号变成了七行函数——`getParamList` 里没有一个参数名，改配置不动一行 C++。代价是把编译期的把关挪到了运行期，所以解析器要用 fail-fast 兜结构错、用 `UNKNOWN` 兜超前类型，并且把「失败时表不清空」这条反直觉的语义写进契约头文件。

下一篇讲**面板装配**：这份 Schema 解析出来的 37 项参数、5 个分组，怎么变成主窗口上那个参数面板的一部分——面板框架的注册表、`IPanel` 接口、以及参数面板为什么能和日志面板、图像面板在运行时被拆下来、装回去、甚至编成动态库放进 `extensions/` 被主程序装载。**参数是配置资产，面板也是。**
