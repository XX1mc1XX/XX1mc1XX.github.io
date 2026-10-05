---
title: 六种参数压成一个外观类
description: 海康的曝光是个 MVCC_FLOATVALUE 结构体，别家可能是别的。界面凭什么用同一套代码显示和编辑它们？这一篇讲统一参数模型怎么把六种类型压进一个外观类、type 与值配对的那颗雷、以及权限三态为什么必须在模型层就拦下。
pubDate: 2026-10-04
tags: [C++, Qt, 架构设计, 设计模式, 工业软件]
---

上一篇讲多机寻址：一张「序列号 → 设备对象」的映射表怎么让界面在一堆相机里认出正在调的那台。门面把「是哪台设备」这件事收口了。

这一篇往下钻一层，问另一个问题：**认出了设备，参数面板上那一格格东西，界面凭什么画得出来？**

同一件事——比如「曝光时间」——在海康 MVS 里是 `MVCC_FLOATVALUE`，一个带 `fCurValue` / `fMin` / `fMax` 的结构体；换家品牌，可能是另一个结构体、另一套取值方式。如果界面为每家写一套参数处理，那前面几篇辛苦立起来的隔离就全废了——**又回到了「改遍上层」**。

所以契约层里有一个类专门吃这件事，`CameraParam`，它是整个参数体系的门面。这一篇讲它怎么把六种类型压成一个外观类。

## 一、现场问题：同一件事，六种长相

先把问题摆清楚。

![六种参数类型压进一个外观类](/images/zyclear/参数外观类.svg)

**参数这个词本身就含糊**——「曝光时间」是浮点数，「Width」是整数，「PixelFormat」是枚举，「ReverseX」是布尔，「DeviceUserID」是字符串，「AcquisitionStart」压根没有值、写下去就是个动作。这六类东西，在 SDK 里的类型、取值范围、取值方式全不一样。

看海康适配器里读一个浮点参数写了什么：

```cpp
MVCC_FLOATVALUE value {};
auto nRet = MV_CC_GetFloatValue(m_cameraHandle, name.toLocal8Bit().data(), &value);
if (nRet != MV_OK)
    return READ_PARAM_FAILED;
DoubleParam varParam = param.GetValue().value<DoubleParam>();
varParam.value = value.fCurValue;
varParam.min = value.fMin;
varParam.max = value.fMax;
```

**为什么这段是「现场」**：`MVCC_FLOATVALUE` 是海康私有的结构体，字段名 `fCurValue` / `fMin` / `fMax` 也只有海康认。如果界面直接面对它，那面板上每一处「显示曝光值」都得写 `value.fCurValue`，换品牌全部推倒。**统一模型要做的，就是把这一行右边的 SDK 类型，翻译成左边的通用结构，翻译点只准出现在适配器里。**

## 二、六种类型，去代码里数一遍

别信印象。打开 `ZCCameraParam.h` 第 12 行，`enum ZCParamType` 摊开是七个名字，但第一个不是类型：

```cpp
enum ZCParamType {
    UNKNOWN = 0,   // 占位，不是可用类型
    INT, DOUBLE, ENUM, BOOL, CMD, STRING
};
```

去掉 `UNKNOWN`，**可用类型正好六个**：`INT` / `DOUBLE` / `ENUM` / `BOOL` / `CMD` / `STRING`。CHANGELOG 里那句「六类参数（Int / Float / Enum / Bool / String / Command）」跟代码对得上，只是枚举名 `DOUBLE` 对应文档里的 Float。这六种类型每个配一个结构体：

```cpp
struct IntParam    : public ZCParam { int64_t value, min, max, increment; /* ... */ };
struct DoubleParam : public ZCParam { double  value, min, max; /* ... */ };
struct BoolParam   : public ZCParam { bool    value; /* ... */ };
struct StringParam : public ZCParam { QString value; unsigned int nMaxLength; /* ... */ };
struct EnumParam   : public ZCParam { QString value; QVector<QString> availableValue;
                                      int valueInt; QVector<int> availableInt; };
struct CmdParam    : public ZCParam { /* 无字段 */ };
```

**为什么每种类型一个结构体，而不是一个大结构塞所有字段**：注意 `IntParam` 有 `increment`（整数才有步长），`DoubleParam` 没有；`StringParam` 有 `nMaxLength`；`CmdParam` **一个字段都没有**。如果硬塞成一个 `struct Param { int a; double b; QString c; ... }`，那 `BoolParam` 里就会挂着一个永远没意义的 `min`，读代码的人得靠猜「这个字段对这种类型算不算数」。**每种类型各自 Data 自洽，字段即契约**——看到 `IntParam::increment` 就知道它是整数专有的。

顺带数一下 `EnumParam`，它是六个里字段最多的，四个：`value`（符号名）、`valueInt`（整数编码）、`availableValue`（候选符号名表）、`availableInt`（候选编码表）。为什么枚举要两套表示，上一篇契约篇讲过了——**SDK 只认整数、界面要显示文字，两套必须由同一次 `readParam` 一起填**。

## 三、外观类：`CameraParam` 到底藏了什么

六个结构体是「值」。但面板上显示一行参数，光有值不够——还要知道它叫什么、属于哪组、有什么提示、能不能写。这些是「元信息」，跟值分开：

```cpp
struct CameraParamMetaInfo {          // 静态描述，getParamList 给出后固定不变
    QString group;                    // 展示用的分组标题
    QString name;                     // 下发用的 GenICam 节点名
    ZCParamType type { UNKNOWN };     // 取值的解包开关
    QString relative_list;
    QString tips;                     // 纯文案
};
```

而 `CameraParam` 这个类，就是**把「元信息 + 值 + 权限」三样包在一起的外观类**：

```cpp
class CameraParam {
public:
    const QString& name() const;
    ZCParamType type() const;
    QVariant GetValue() const;        // 值本身，一个 QVariant
    QString displayText() const;      // 算出来的展示文本
    bool isValid() / isReadable() / isWriteable() const;   // 权限三态
private:
    CameraParamMetaInfo _meta;
    QVariant _value;                  // 存的是六个结构体之一的副本
    struct { bool valid:1, readable:1, writeable:1; } _accessMode {};
};
```

**为什么这是个「外观类」而不是简单的聚合**：看对外暴露的接口——`displayText()` 返回一个 `QString`，`isWriteable()` 返回一个 `bool`。**上层拿到的永远是标量，它从头到尾看不到 `IntParam`、`EnumParam` 这些具体类型的存在。** 这正是外观模式在这个位置解决的核心问题：

- 面板要显示一行，调 `displayText()`，不管是 int 还是 enum，统一给你一段文本。
- 面板要判断这行能不能编辑，调 `isWriteable()`，不用管底层是哪个结构体。
- 只有真正要下发 SDK 的适配器，才需要 `GetValue().value<T>()` 把包拆开。

**六种具体类型 + 一个外观 vs 面板直接面对六个类型，差的就是「上层改几处」**：前者的新增一种参数类型只影响「类型枚举 + 解析 + 控件分派」三处，后者则是面板每一个 switch 都得补一支。这一层抽象换来的东西，CHANGELOG 里那句话概括得最准——**「新增型号不编译、不发版，只改 JSON」**。

## 四、类型判定：`QVariant` 的 type 与值怎么配对

外观类里 `_value` 是个 `QVariant`，那解包时怎么知道该拆成哪个结构体？靠 `_meta.type`。看 `displayText()` 的实现就是这个套路：

```cpp
QString displayText() const {
    switch (type()) {
    case INT: {
        IntParam varParam = GetValue().value<IntParam>();
        return QString::number(varParam.value);
    }
    case DOUBLE: { /* 同理取 DoubleParam */ }
    case BOOL: {
        BoolParam varParam = GetValue().value<BoolParam>();
        return varParam.value ? "True" : "False";
    }
    // ...
    }
    return QString("unknow");
}
```

**为什么 `type()` 必须由外观类自己持有，而不能从 `_value` 推**：`QVariant` 确实记着自己装的是什么类型，理论上可以 `_value.type()` 反查。但那样做等于把「解包规则」交给 Qt 的元类型系统——而这里要解包的 `IntParam` 是我们自定义的结构体，`Q_DECLARE_METATYPE` 注册了它才能过编译，注册进来的 type id 是运行期分配的，跨 DLL 边界都不一定稳定。**把 `type` 当作元信息显式存着，是让解包规则跟着参数走，而不是跟着 Qt 的实现走。**

但这里埋了一颗雷，我在头文件第 10 行就把它写死了：

```cpp
// 一旦 type 与实际存入的结构体不符，value<T>() 会静默返回默认构造值，
// 既不抛错也不告警 —— 厂商实现里 type 与 SetValue 的配对必须严格一致
```

**为什么 `QVariant::value<T>()` 是这个脾气**：它**不做运行期类型校验**。你写 `GetValue().value<IntParam>()`，而 `_value` 里实际装的是 `DoubleParam`——它不会抛异常，不会返回空，而是**返回一个默认构造的 `IntParam`**，也就是 `value = 0, min = 0, max = 0`。上层拿到的就是「参数值丢了，但一切正常」——界面显示 0，写下去也是 0，没有任何一处报错。

**这是统一模型换来的便利里最贵的那张账单**：C++ 是静态类型，`QVariant` 是把类型擦除塞进一个容器，擦除之后类型正确性就只能靠「塞的人」和「取的人」自觉配对。而塞的人和取的人隔着一整层——塞在海康适配器的 `SetValue(QVariant::fromValue(varParam))`，取在 `displayText()`。中间没有编译器，没有运行期检查，只有一句注释和单元测试兜着。**便利和风险是同一个设计的两个面，这次风险大得必须写在契约文件里。**

## 五、权限三态：为什么在模型层拦，不在界面禁用

参数不光有值，还有「能不能读、能不能写」。GenICam 的访问模式有五种：`RO`（只读）、`RW`（读写）、`WO`（只写）、`NI`（未实现）、`NA`（不可用）。五种模式，我希望界面只认识三个语义——有效、可读、可写。看海康适配器怎么翻译：

```cpp
if (mode == AM_NI || mode == AM_NA || mode == AM_Undefined) {
    param.setValid(false);
    param.setReadable(false);
    param.setWriteable(false);
} else if (mode == AM_WO) {
    param.setValid(true);  param.setReadable(false);  param.setWriteable(true);
} else if (mode == AM_RO) {
    param.setValid(true);  param.setReadable(true);   param.setWriteable(false);
} else if (mode == AM_RW) {
    param.setValid(true);  param.setReadable(true);   param.setWriteable(true);
}
```

**为什么把五种压成三个 bool**：`NI` / `NA` / `Undefined` 三种对界面而言**没有区别**——都是「这个参数这台相机没有」，界面动作都是「别显示」。所以它们折叠成一个 `valid = false`。剩下 `RO` / `RW` / `WO` 三种则精确映射到 readable / writeable 两个位。三个 bool 能表达五种模式，是因为其中三种在界面上本就该被抹平。**这个折叠是业务语义的折叠，不是偷工减料。**

关键在于这三个标志**在哪一层生效**。看模型（`CameraParamModel::flags()`）第 81 行：

```cpp
// 只读权限在模型层就被掐掉，而不是留给委托去拒绝：视图看到不可编辑的 index
// 压根不会进入编辑态，连控件都不会造，比事后拦截少一轮创建/销毁。
if (cameraParam.isWriteable()) {
    return Qt::ItemIsEditable | QAbstractItemModel::flags(index);
} else {
    return Qt::ItemIsEnabled | QAbstractItemModel::flags(index);
}
```

**为什么在模型层拦比在界面上禁用控件更彻底**：

- **界面禁用是「看起来不能改」**，模型层撤回编辑标志是「**根本改不了**」。Qt 的 `flags()` 是整个视图编辑流程的入口——它看到 index 没有 `ItemIsEditable`，压根不会进入编辑态，连编辑器控件都不会创建。**拦截点越靠前，能走的弯路越少。**
- 更实在的一条：**如果只靠界面禁用，任何绕过界面的路径都拦不住。** 我后面还有 AI 助手（`CameraToolProvider`）会直接调参数、还有 JSON Schema 导入会批量下发。这些路径根本不经过控件。权限判断放在模型层，是所有出口共同的闸门。**「模型层拦下」的意思是：不管从哪个入口进来的写请求，都撞在同一个 `isWriteable()` 上。**
- 最后一个细节：分组节点的类型是 `UNKNOWN`、权限位全 0，所以自动落进 `else` 分支——**分组行天然不可编辑，不需要为它单独写一条判断**。这就是「权限位零初始化」的顺带收益，见下面踩坑节。

## 六、整包写回：为什么改一个值要还回一整包

权限三态和元信息从哪来、回哪去，这里有个设计选择值得单独说。一个 `CameraParam` 从设备读回、经模型、到委托控件，再到用户改值、沿原路写回，中间要过好几道手。**这中间传的到底是「一个值」还是「一整包」，决定了元信息会不会在半路丢掉。** 看委托（`CameraParamDelegate.h` 第 9 行）：

```cpp
// 委托只做两件事：按参数类型造出对应的编辑控件、在控件与模型之间搬运 CameraParam。
// 它自己不存任何参数状态，真值永远只有一份，留在模型的 ParamRole 里。
```

搬运时是**整包搬运**：

```cpp
// 整包写回 ParamRole，而不是按列写某个标量；控件改的只是包内 value 字段，
// 权限位、提示语等元信息随包一起回到模型
CameraParam cameraParam = pCustomEdit->getParam();
model->setData(index, QVariant::fromValue(cameraParam), CameraParamModel::ParamRole);
```

**为什么是整包而不是「只写那个改了的标量」**：因为一个 `CameraParam` 是**不可分割的语义单元**——值、权限、元信息必须同步。如果按列写值，控件只回传一个 `double`，那模型这边就得自己把新值塞进旧包里，还要小心不让权限位丢失。**整包写回把「同步」变成免费的**：控件改的只是包里 `value` 那一个结构体，其余字段（`_accessMode`、`_meta`）原样跟着回来，不会出现「值更新了但权限还是旧的」这种错位。

这里还连着一个上层容易忽略的行为——**界面是乐观更新的**。看 `CameraParamModel::setData()` 第 161 行：

```cpp
if (item->setData(value)) {
    // 先刷新视图再通知上层写设备：界面是乐观更新的，设备写失败
    // 不会回滚这里的值（回滚责任的缺失见 ParamWidget::writeCameraParam）
    emit dataChanged(index, index, { Qt::DisplayRole, Qt::EditRole });
    emit SigValueChanged(index);
}
```

**为什么先刷界面再写设备**：信号一发，界面立刻变了，用户感觉是「即时响应」；写设备在随后的槽里做。**代价是设备写失败时界面不会回滚**——值留在界面上，用户以为改成了，其实设备没收到。这个取舍我在 `ParamWidget::writeCameraParam` 的注释里点明了「要改成设备确认后才改界面，得让 setData 先写设备、成功再改模型」。**当前选的是「手感优先」，代价是一处语义不一致。** 这不是 bug，是一个我明确知道、明确记下的设计欠账。

## 七、值为什么用 `QVariant` 装，而不是 `void*` 或联合体

上面一路用 `QVariant` 当值的容器，这个选择值得单独交代一句，因为它直接决定了整条链路的形状。

**不用 `void*`**：`void*` 能做到类型擦除，但擦除得太彻底——拷贝时没人知道该 memcpy 多少字节、什么时候该 delete。`CameraParam` 在模型里存副本、在委托间搬来搬去、塞进 `QVariant`，每一处都在拷贝。`void*` 方案下，每次拷贝都要额外带一个「这个指针指向的结构体怎么深拷贝」的函数指针，等于自己重写一遍 `QVariant`。

**不用 union**：union 要求成员类型可平凡构造/析构，而 `StringParam`、`EnumParam` 里有 `QString` 和 `QVector`——非平凡类型放进 union，拷贝构造、析构全得手写。更要命的是 union 没有「当前激活的是哪个成员」的标记，得自己再配一个 `type` 字段，**而这正是 `CameraParam` 现在做的事，只不过换成了 `QVariant` 承担内部管理**。

**`QVariant` 给的正好是三样**：值语义（能拷贝）、类型标记（内部记着装的什么）、自定义类型支持（`Q_DECLARE_METATYPE` 注册即可）。代价就是前面那颗雷——它的类型检查是弱校验，`value<T>()` 对不上不报错。**我选 `QVariant`，是拿「类型安全」换「值语义 + 零所有权负担」，然后把这个交易的风险显式写进契约注释。**

## 八、一个手写拷贝构造，和它暴露的权限传播问题

`CameraParam` 里有个看起来多余的东西：一个手写的拷贝构造，注释写着「与编译器默认生成等价」。既然等价，为什么不删？

```cpp
// 手写拷贝构造（与编译器默认生成等价）：留意 _accessMode 随对象整体复制，
// 拷贝出的参数会带上源对象的读写权限标记
CameraParam(const CameraParam& param) {
    _meta = param._meta;
    _value = param._value;
    _accessMode = param._accessMode;
}
```

**为什么留一个等价的手写拷贝**：它是一个「刻意写出来给人看」的拷贝构造——功能上确实跟默认的一样，但它的存在本身是一份文档：**告诉每个读代码的人，拷贝一个 `CameraParam` 时，`_accessMode` 权限位是跟着走的。** 这件事不写出来就容易被忽略：有人可能以为拷贝出的新参数权限是干净的、要重新查一遍，结果它带着源对象的权限标签。

**为什么权限该跟着拷贝走**：`_accessMode` 描述的是「这台设备的这个参数节点的能力」，它是**参数身份的一部分**，不是某一次操作的临时状态。同一个参数从模型拷贝到委托再拷回来，权限当然应该一路保持——如果每次拷贝都清零，那控件拿到的参数就是「没查过权限」的，`flags()` 一判就不可写，界面全灰。**留这个手写拷贝，就是把这个不显然的语义钉在代码里。** 代价是维护时多一个要同步的地方——`CameraParam` 加字段时，默认拷贝会自动带上，这个手写的却要手动补。**用一个「等价但显式」的写法换一段能被读到的语义，值。**

## 九、为什么不做成六个类

这是本篇真正的分歧点。既然有六种类型，**为什么是「六个结构体 + 一个外观」，而不是「一个基类 `ZCParam` + 六个派生类 + 基类指针数组」？**

后者其实更「面向对象」：`CameraParam` 里存一个 `ZCParam*`，`displayText()` 变成虚函数，每种类型 override 自己的显示逻辑。多态一上来，`switch` 就没了。

我最后没这么选，三个理由：

**第一，值要能被拷贝、被放进 `QVariant`。** 参数在整条链路上是被当值用的——`CameraParam` 塞进 `QVariant`、模型里存副本、委托搬来搬去。如果内部是 `ZCParam*`，那 `CameraParam` 就要自己管所有权（拷贝构造深拷贝、析构 delete、移动语义），否则是个浅拷贝的野指针陷阱。**现在的 `QVariant::fromValue(IntParam{...})` 天然深拷贝，`CameraParam` 可以默认拷贝，整条链路不用想所有权。**

**第二，解包点必须显式，才能把风险摆在明面上。** 多态版的 `displayText()` 是虚函数——底层存了 `DoubleParam` 却派生成 `IntParam`，这是编译器的事（对象本身就是那个类型），不会错。但它也把「类型判定」藏进了对象头里的 vtable，**没有任何一处代码写着「这里的 type 必须跟值对上」**。而现状的 `switch (type())` 把这件事写在了脸上：`type` 和 `value<T>()` 的 T 必须一致，不一致就静默失败——正是那颗我在头文件里写死的雷。**我宁愿要一个「风险可见的 switch」，也不要一个「风险隐藏的虚函数」。**

**第三，六个类型没有共享实现，多态没东西可虚。** 看六个结构体，它们共有的只有 `clone()` 一个函数（还是给测试用的）。`displayText()` 里每种类型的逻辑完全不同、没有可复用性。**多态的价值在「共享接口 + 各自实现」，这里连接口都只有 `clone` 一个，与其说是在用多态，不如说是在为一个空壳基类买单。**

代价也真实：**每次新增一种类型，`displayText()` 那个 switch、`readParam`/`writeParam` 的两个 switch、委托的 `createWidget` switch，四处都要补一支，而且编译器不会提醒你漏了**（`default` 分支会静默吞掉）。这是「显式 switch」方案的账单——**你把风险从运行期藏起来，换成了编译期的四种重复。** 六种类型还扛得住，如果哪天参数类型涨到二十种，这个取舍我会重新算。

顺带说一句：基类 `ZCParam` 不是没用，它有个 `virtual ZCParam* clone()`，注释写着「当前主要由测试使用」。这是这套设计里唯一真正会用到多态的地方——测试要拿着基类指针操作一个脱离源的参数副本，才需要 `clone`。**多态留在了它唯一需要的地方，没有外溢到整条主链路。**

## 我踩过的坑

**坑一：`QVariant::value<T>()` 类型不匹配会静默返回默认值。**

这不是我踩出来才写的，是我在设计时就预判到、特意在头文件第 10 行写死警告的——但它值得排第一，因为它**没有编译器兜底**。厂商实现里只要有一处 `SetValue(QVariant::fromValue(doubleParam))`，而 `meta.type` 写的是 `INT`，读到上层就是 `IntParam{0,0,0}`：界面显示 0，不影响任何编译，不影响其他参数，只在「这个参数为什么一直是 0」的那一刻才暴露。

教训：**类型擦除（`QVariant`）和类型安全（解包）之间那道缝，只能靠「塞和取在同一处约定」来弥合。** 我把塞和取都压在「厂商实现必须先看 `type()` 再决定 T」这一条规矩上，然后用单元测试去卡。这规矩没法靠编译器执行——**有些契约的正确性，编译器管不了，只能靠契约把风险写在明面上 + 测试兜。**

**坑二：`_accessMode` 位域零初始化，不是可选的写法。**

看 `CameraParam` 里权限位那个成员：

```cpp
struct { bool valid:1, readable:1, writeable:1; } _accessMode {};
```

末尾那个 `{}` 是关键，注释写着「默认 valid/readable/writeable 全为 false，未经厂商 `getFeatureAccessMode` 填过的参数会被 read/write 当作不可访问而静默跳过」。**我一开始想过「不初始化，反正厂商读取前会先查 access mode 填一遍」。** 但 `getFeatureAccessMode` 是在 `readParam`/`writeParam` 的第一行调的，如果一个参数走了某条没填权限的路径，三个位就是随机值——`readable` 碰巧是真就往下读，碰巧是假就静默跳过。**零初始化把这个不确定性抹平**：没填过 = 不可访问 = 静默跳过，至少行为是可预期的。跟上一篇「结构体必须 `memset`」是同一类教训——**能被 SDK 或外部填写的字段，初始化与否决定的是「随机行为」还是「可预期行为」。**

**坑三：枚举写回用下标冒充编码，只在编码连续时才对。**

CHANGELOG 把它列在已完成修复里，我这次翻到 `EnumCustomWidget.cpp` 第 45 行，看它的注释原文：

```cpp
// valueInt 是相机侧的整型编码，不是下拉框下标 —— 两者只有在枚举编码
// 恰好是 0..N-1 连续时才碰巧相等。相机集成层走的是 availableInt 那条路，
// 界面这里必须与它同口径，否则在下拉里改一个枚举会往设备写进另一个值。
if (value >= 0 && value < varParam.availableInt.size()) {
    varParam.valueInt = varParam.availableInt.at(value);
}
```

**我最初的写法是拿下拉框下标当编码直接写**——`varParam.valueInt = value`。因为海康大多数枚举的编码恰好就是 `0..N-1` 连续的，**测试时我调的那几个参数全对**。直到碰到一个编码不连续的枚举，界面选「第一项」，写下去的却是一个别的编码，设备状态当场跑偏。

根源在于：**枚举有两套表示（符号名 + 整数编码），而界面控件的「第几项」是第三个数。** 三者里，下标和编码**只在编码恰好连续时相等**，这是个「碰巧对」，不是「正确」。修正是把 `valueInt` 从 `availableInt.at(value)` 取——**显式地拿下标去查编码表，而不是假设下标就是编码。** 跟第三篇那个 union 偏移「碰巧一致」是同一个坑：**不要依赖偶然成立的一致性。**

**坑四：`displayText()` 拼写沿袭成 `unknow`，改不动了。**

第 194 行那句注释：「拼写沿袭原文 unknow，别顺手改成 unknown」。这是个少了个 `n` 的拼写错误。为什么留？因为它是 `default` 分支（也就是 `UNKNOWN` 类型）的返回值，**每次写注释我都想顺手改掉它，每次又收手**——它虽然只在一个回退分支里出现，但已经有人（测试、日志）按这个字符串断言过了，改它意味着动那些地方。跟第二篇 `creatStream` 少个 `e` 一模一样：**契约定型后的任何改动都是全体补丁，哪怕是个拼写错误。** 教训不是「别改错字」，是**「写契约文件的时候就要逐字读两遍」**——定的时候不觉得，定完之后每个字符都贵。

**坑五：以为「界面禁用控件」就够了，忘了还有绕过界面的写入路径。**

权限三态第一版我是在委托里做的——不可写的参数，`createEditor` 就返回 `nullptr`，用户自然点不动。当时觉得挺干净。后来加 AI 助手（`CameraToolProvider` 直接调参数）和 Schema 批量导入时才反应过来：**这些路径根本不经过控件，委托那层拦不住它们。**

于是权限判断上移到模型层的 `flags()`——view 不给编辑标志，是**所有视图入口共同的一道闸**。但坦白说，`flags()` 也只管视图入口，AI 助手那条路径绕的是模型、走的是门面。**真正完整的做法是在门面/适配器的 `writeParam` 里再判一次 `isWriteable`**——海康适配器确实这么做了（`writeParam` 第一件事就是查 access mode，不可写直接返回成功）。所以现在其实是**两层**：模型层拦界面、适配器层拦一切。**「在模型层拦下」比「界面上禁用」彻底，但「模型层」也不是终点——每个能写设备的口子都得有自己的闸。**

## 结尾

参数模型这一篇讲到这：六种类型压进一个外观类，type 与值的配对着那颗静默失败的雷，权限五种模式折叠成界面三态、在最靠前的闸门拦下，整包写回让值与元信息同步。

但还有个问题没答：**这六种类型、这些 `group` / `name` / `tips`、这些候选值，是从哪来的？** 海康的 `getParamList` 里那份静态表是硬编码的——如果每换一个品牌都要重新手写一份这样的表，那「新增型号不编译、不发版」这句话就是空话。

下一篇讲**JSON Schema 驱动**：参数的静态描述怎么从代码里搬到 JSON，界面怎么在运行时按 Schema 装配，以及为什么我把参数表做成数据之后，新增一个相机型号变成了「改一个文件、不碰一行 C++」。

<!--
配图占位（本篇未配图，后续统一配）：
1. 六种类型结构体一览表 —— INT/DOUBLE/ENUM/BOOL/CMD/STRING 各自的字段，突出 CmdParam 无字段、EnumParam 四字段最多。
2. 外观类三层包裹图 —— CameraParam 外壳 { _meta（元信息） / _value（QVariant，内含六个结构体之一） / _accessMode（三位） }，对外只露出 displayText() 与三个 is*()。
3. 权限映射图 —— GenICam 五种模式（RO/RW/WO/NI/NA）→ 界面三个 bool（valid/readable/writeable），NI/NA/Undefined 折叠成一行。
-->
