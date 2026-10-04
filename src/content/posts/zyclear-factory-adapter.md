---
title: 工厂与适配器：换品牌为什么只改一处
description: "契约签完，得有人履约。这一篇讲工厂那张「创建器 + 枚举器」配对的注册表、品牌名匹配为什么脆弱、适配器要把 692 行 SDK 代码吃掉什么，以及三个不会让编译器吭声的真实缺陷。"
pubDate: 2026-10-06
tags: [C++, Qt, 架构设计, 设计模式, 工业软件]
---

上一篇把契约定完了：17 个纯虚方法划出能力边界，统一参数模型和统一错误码跟着一起定。那张合同谁都得签。

但合同是口，是纸上的东西。**签完得有人履约：谁来造一台真的海康相机？谁来造一台不用真机的虚拟相机？新增一个品牌到底要改几处？** 这一篇讲的就是履约的这一层——工厂和适配器。

一句话先立住：**整个项目里，只有这一层认识具体品牌。往上走，品牌这两个字会被抽象吸收干净。** 所以所谓"换品牌只改一处"，改的就是这里。

## 工厂干的事，只是把名字翻译成类型

工厂很小。头文件去掉注释不到 50 行，实现文件 71 行。但它要回答两个问题，而且必须由同一处回答：

- **这台相机是谁？** 名字（厂商串）→ 一个能 `new` 出来的具体类型。
- **这台相机在哪？** 让各品牌去枚举设备，凑出一张设备清单。

`CameraFactory` 是一个**进程级单例**。头文件里把理由写死了：

```cpp
// 进程级单例：注册表在首次 instance() 时一次性装配，之后只读访问。
// 故意不留释放路径——静态析构顺序不可控，交给进程退出回收更安全。
static CameraFactory* instance();
```

**为什么这么写**：注册表就两张 `QMap`，内容全进程一致，天然该是一份。不给释放路径不是偷懒——如果留一个 `Release()` 让人在某个时机调，就变成了"谁负责在什么时候销毁"的问题，而单例的销毁时机恰恰是最难定的：析构函数里可能会调到别的单例，而静态析构顺序在 C++ 里本来就不可控。索性不回收，进程退出时操作系统一并收走。

### 注册表：一个模板方法，两张表

这是本篇第一个值得讲的点。登记一个品牌，只调一次模板方法：

```cpp
template <typename T>
void registerVendor(const QString& venderName)
{
    m_creatorMap[venderName] = [](const CameraMetaInfo& info) -> CameraInterface* {
        return new T(info);
    };
    m_enumeratorMap[venderName] = [](QVector<CameraMetaInfo>& cameraInfos) -> uint32_t {
        return T::EnumCamera(cameraInfos);
    };
}
```

**为什么这么写**：注意它一次写了两张表——`m_creatorMap` 存的是"给我一份设备信息，我造一台相机出来"，`m_enumeratorMap` 存的是"去把这个品牌的所有设备找出来"。两张表用**同一个 key**（厂商名）索引。

为什么非要绑成一个方法，不能开两个接口？头文件里那句注释是核心：

```cpp
// 接新品牌只动这一处：按同一个 T 同时登记创建器与枚举器，缺一即半残——
// 只登记创建器则枚举不出设备，只登记枚举器则创建必然失败。
```

**"缺一即半残"是字面意思，不是修辞。**

- 只登记**创建器**：注册表里有这个品牌，上层拿名字能造出相机，但这台相机的名字永远**不会出现在设备列表里**——因为没人去枚举它。用户界面上根本看不到这台设备，创建器永远没人拿得到入参去调。
- 只登记**枚举器**：设备能被列出来了，列表里看得见，但用户点"连接"的时候，工厂拿设备自报的厂商串去查创建器，查不到，回 `nullptr`。**枚举得出来，创建不出来**——列表上挂着这台设备，就是连不上。

两半各自"卡在中间"，症状还完全不同：一个看不见设备，一个看得见连不上。所以我把它压成一个方法，让"必须成对"这件事由**接口形状**来保证，而不是写在文档里指望人记得。

### T 的两个硬约束

模板参数 `T` 不是随便什么类型都能塞进去。注释里写明了两个：

```cpp
// 代价是 T 需满足两个硬约束：能从 CameraMetaInfo 构造、有 static EnumCamera(QVector<CameraMetaInfo>&)。
```

这两个约束不是我自己发明的规矩，是上面那两行 lambda **逼出来的**：

| 约束 | 谁要求的 | 不满足会怎样 |
|---|---|---|
| `T` 能从 `CameraMetaInfo` 构造 | 创建器 lambda 里那句 `new T(info)` | 编译不过（这是好事，见下） |
| `T` 有 `static EnumCamera(QVector<CameraMetaInfo>&)` | 枚举器 lambda 里那句 `T::EnumCamera(...)` | 编译不过 |

关键在于：**这两个约束都在编译期检查，而且检查的很及时。** 你新写一个适配器类型去 `registerVendor<新类型>()`，如果忘了写静态枚举器，失败发生在**调用点**——也就是你刚写的那一行，而不是等到运行时某个设备连不上才暴露。

反过来，如果你只给工厂传一个 `T` 的类型名、不在模板里实例化这两个 lambda，编译器就不会替你去查这两个约束——你得等到运行时才发现 `EnumCamera` 没实现。**把约束写进模板体的做法，等于让编译器替工厂值守门禁。**

这也是我把 `registerVendor` 做成模板而不是做成"传两个 `std::function`"的原因。传两个函数对象更灵活，但也就丢掉了这层编译期保障。**灵活性在这里是负资产。**

### 注册全发生在实例化那一刻

单例初始化里有一个细节，注释把它当成 bug 来说：

```cpp
// 先把两张注册表填满，最后一步才发布指针：指针一旦可见，其余线程
// 就会不加锁地查这两张表，此时它们必须已经完整。先前先赋值再登记，
// 存在「看到非空指针却拿到一张还没填完的表」的窗口。
auto* factory = new CameraFactory();
factory->registerVendor<VirtualCamera>(VirtualCamera::VIRTUAL_CAMERA_VENDER);
#ifdef ZYCLEAR_HAS_HIK_SDK
factory->registerVendor<HikCamera>(HikCamera::HIK_CAMERA_VENDER);
#endif
m_instance = factory;
```

**为什么这么写**：看最后一行——`m_instance = factory` 是**最后**一步。这是经典的双重检查锁（DCLP）变体，关键是**先构造完全、再发布**。如果反过来先 `m_instance = new CameraFactory()` 再往上填表，另一个线程可能在这两句之间进来，看到 `m_instance` 非空，直接跳过锁去查表，查到的是**一张填了一半的表**——查创建器就是"这个品牌不存在"。

而且注意配套的设计：`m_mutex` **只守护首次构造，不守护之后对两张表的读**：

```cpp
// 只守护首次构造，不保护两张表的读写：注册全发生在实例化那一刻，
// 此后它们视为只读，createCamera 才敢不加锁直接查。
```

**为什么敢不加锁**：因为注册这个动作**有且只有一次**，就在 `instance()` 里。只要保证"表填完才发布指针"，那么任何**能看到 `m_instance` 的线程**，看到的必然是一张完整的、此后不再变的表。一个只读的 `QMap`，多线程并发查是安全的。于是 `createCamera` 省掉了每次查表的加锁开销。

这两句注释其实是一件事的两面：**"注册只发生一次"是前提，"先填表后发布指针"是对这个前提的实现保障。** 少了后一句，前提就不成立。

### 枚举顺序为什么是稳定的

`enumCameras` 遍历枚举器表，把结果追加进传入的 vector：

```cpp
uint32_t CameraFactory::enumCameras(QVector<CameraMetaInfo>& cameraInfos) const
{
    for (auto it = m_enumeratorMap.begin(); it != m_enumeratorMap.end(); ++it) {
        it.value()(cameraInfos);
    }
    return ZYCLEAR_OK;
}
```

**为什么用 `QMap` 而不是 `QHash`**：注释里点破了——`QMap` 按 key 字典序遍历，**顺序是稳定的、与注册先后无关**。这意味着"同一台机器、同一批设备，两次枚举出来的列表顺序一致"。看起来是小事，但设备列表顺序漂移会让用户困惑（"我上次选的就是第一台，怎么又变了"），也会让人眼比对日志变麻烦。`QHash` 会快一点，但顺序不确定，我选 `QMap`。

还有两处口径，注释都写明了，值得单独记：

```cpp
// 各枚举器的返回值被丢弃，本函数永远报成功，“没找到相机”与“枚举失败”在此无法区分。
// 不做跨品牌去重，同机被两品牌枚举出由调用方过滤。
```

**为什么这么定**：`enumCameras` 恒返回 `ZYCLEAR_OK`。**"没枚举到相机"和"枚举本身失败了"在这里被折叠成同一种结果。** 这是有意的取舍——对上层来说，这两件事的应对动作都是"再等等/换个操作"，弹一个错误码反而制造了假的选择。代价是排障时看不到"枚举失败"这个信号，只能翻各适配器自己的日志。跨品牌去重同理：这个函数只负责"汇总"，不负责"裁定"，去重策略（按序列号?按传输层优先级?）是上层的事，工厂不该替它决定。

## 品牌名匹配为什么脆弱

这一节是本篇我想讲透的一节，因为它是"看起来最无害、实际最要命"的一处。

工厂查表的 key，是 `CameraMetaInfo.VenderName`。这个值是从哪来的？**不是本地常量，是设备自报的厂商字段。** 头文件里写得很直白：

```cpp
// 品牌名必须与 EnumCamera 写进 CameraMetaInfo.VenderName 的串逐字一致；
// 海康链路里该值取自设备的厂商字段而非本地常量，匹配格外脆弱。
bool isVenderSupported(const QString& venderName) const;
```

配套的实现里也有一句，说明为什么查不到要告警而不是静默吞掉：

```cpp
// 品牌名来自设备枚举结果，必须与注册键逐字一致；查不到只告警并回 nullptr，
// 不吞成“没相机”，是为了能把“设备自报的厂商串对不上”这种情况暴露出来。
```

**为什么脆弱，得从两条链路分别看。**

第一条是**虚拟相机**（本地常量，不脆）。`VirtualCamera.cpp` 第 11 行定义 `VIRTUAL_CAMERA_VENDER = "Virtual"`，枚举时第 29 行把这个常量写进 `CameraMetaInfo`，工厂注册时也传同一个常量。**同一个字符串常量，来源一致，永远不会错。** 这是安全的写法。

第二条是**海康真机**（设备自报，脆）。看 `HikCamera.cpp` 里枚举的时候是怎么填这个字段的：

```cpp
info.VenderName = (char*)cameraInfo->SpecialInfo.stGigEInfo.chManufacturerName;
```

**注意右边**：它是从 SDK 返回的设备信息里，读**设备自己报告**的 `chManufacturerName`。而左边，工厂注册时用的 key 是什么？

```cpp
const QString HikCamera::HIK_CAMERA_VENDER = "Hikrobot";
```

HikCamera.cpp 第 7 行，一个**本地字面量**。

**于是脆弱的根源就在这里**：注册 key 是本地写的 `"Hikrobot"`，而查表用的 key 是设备固件里报出来的字符串。这两个值**必须逐字相等**，但它们**分属两个世界**——一个是你源代码里的常量，一个是别人的设备固件里的一个字段。中间没有任何编译期检查，没有任何运行时校验告诉你不匹配（只有一个 `qWarning`，还没有错误码）。

想一想它可能怎么不匹配，就知道为什么我说"格外脆弱"：

- 固件报告的厂商名可能是 `"HIKROBOT"`（全大写）或 `"Hikvision"`——**大小写和拼写都不由我控制**。
- 不同 SDK 版本、不同型号的相机，这个字段的值可能不同。
- 万一某版固件里这个字段是空的，或者带了个尾随空格。

**任何一处不一致，结果都是：设备枚举得出来、列表里看得见、但点连接时工厂查不到 key，回 `nullptr`。** 而 `createCamera` 此时只打一行 `qWarning`，上层如果不判空就直接用了。这个失败模式非常隐蔽——设备明明在列表里。

所以为什么我说"换品牌只改一处"，但这里又强调脆弱？**因为它确实只改一处，但那一处必须改得逐字正确。** 便利和风险是同一个设计的两个面。我在 `CameraFactory.h` 和 `HikCamera.cpp`、`enumCameras` 三处都留了注释，就是为了让后来人改这一处时知道：**你改的不是一个字符串，是一个跨进程、跨厂商、跨固件的契约。**

顺带说一个我核实过的细节：`isVenderSupported` 和 `createCamera` 的实现**查的都是 `m_creatorMap`**（前者 `contains`，后者 `contains` 再取用）。也就是说，**"支持这个品牌"的判定只看创建器表**。如果哪天有人只登记了枚举器，这个方法会告诉上层"不支持"，但设备其实枚举得出来——这就是上面"半残"的另一种表现，只是在 API 层看起来正常。

## 工厂不用异常：nullptr 是一条必须走的路

接着上面说。未注册品牌怎么办？工厂的选择是**回 `nullptr`，不抛异常**：

```cpp
// 未注册品牌回 nullptr 而非抛异常，调用方必须判空；返回实例所有权归调用方，由它 delete。
CameraInterface* createCamera(const CameraMetaInfo& info);
```

**为什么不用异常**：跟上一篇契约层错误码是同一个理由——**工业软件的失败路径要可见、要能跨线程传**。这条调用链可能从 UI 线程发起，也可能从 SDK 回调线程发起；异常跨线程传播是个雷（Qt 的信号槽、`std::thread` 都不会替你接住异常），而且异常让"可能失败"这件事从函数签名上消失了——调用方看到返回类型是 `CameraInterface*`，如果不看注释，根本不会想到要先判空。

**用返回 `nullptr` 的代价是**：判空的责任转移给了调用方。这也是注释里必须把"调用方必须判空"写出来的原因——它不是一个实现细节，是**接口契约的一部分**。返回值 `nullptr` 的含义不是"出错了"，而是"这个厂商没被注册，我不认识它"，两者不能混。

这里还说清了**所有权**：返回的实例由调用方 delete。工厂只负责造，不负责养。**工业代码里"谁拥有这个对象"比"这个对象怎么造"更容易出岔子**，所以这两句话我写在了一行注释里。

## 适配器要吃掉什么

讲完工厂，进适配器。工厂把名字翻译成类型，那这个类型本身呢？HikCamera 有 692 行，它要把几百个 MVS SDK 接口压进契约的 17 个方法里。挑四处最典型的讲。

### 一、结构体清零：不是洁癖，是各版本 SDK 的容错不一样

```cpp
MV_CC_DEVICE_INFO_LIST stDeviceList;
memset(&stDeviceList, 0, sizeof(MV_CC_DEVICE_INFO_LIST));
auto nRet = MV_CC_EnumDevices(MV_GIGE_DEVICE | MV_USB_DEVICE, &stDeviceList);
```

**为什么必须 `memset`**：注释写的是"否则各 SDK 版本对未初始化计数字段的容错不同"。拆开讲：`MV_CC_DEVICE_INFO_LIST` 里有个 `nDeviceNum` 计数字段，SDK 枚举时会往里填。但**有些 SDK 版本是"追加"语义而非"覆写"语义**——它读你传进来的 `nDeviceNum` 当作已有个数，在它后面继续追加。这时候如果栈上的结构体没清零，`nDeviceNum` 是个随机值，SDK 可能就往那个随机偏移写，或者认定你已经枚举了一大堆。**清零是把这个字段的不确定性抹平。**

同一条链路上还有一个 union 的坑：

```cpp
// 两种传输层的设备信息共用一个 union 的不同分支，必须按 nTLayerType 各取其分支。
for (unsigned int i = 0; i < stDeviceList.nDeviceNum; i++) {
    MV_CC_DEVICE_INFO* cameraInfo = stDeviceList.pDeviceInfo[i];
    if (cameraInfo->nTLayerType == MV_GIGE_DEVICE) {
        info.Serial = (char*)cameraInfo->SpecialInfo.stGigEInfo.chSerialNumber;
    } else if (cameraInfo->nTLayerType == MV_USB_DEVICE) {
        info.Serial = (char*)cameraInfo->SpecialInfo.stUsb3VInfo.chSerialNumber;
    }
}
```

**为什么必须判 `nTLayerType`**：`SpecialInfo` 是个 union，GigE 设备的信息和 USB3 设备的信息**共用了同一块内存**，只是字段名和布局不同。你**必须**先看 `nTLayerType` 知道这是哪种设备，再去取对应的分支。

这里有个更阴的点：`chSerialNumber` 这两个分支的**偏移恰好一致**。也就是说，如果你偷懒不判 `nTLayerType`，直接读 `stGigEInfo.chSerialNumber` 去取 USB 设备的序列号，**在大多数情况下居然能读对**。但这是"碰巧对"，不是"正确"。一旦某个 SDK 版本改了布局，或者你取的是偏移不同的字段（比如厂商名），它就悄悄读错。所以注释里说"依赖它是自找麻烦"——**不要依赖偶然成立的偏移一致性。**

### 二、厂商名逐字匹配：脆弱点藏在适配器里

这一处就是上面第三节讲的那个脆弱点的**源头**。适配器在枚举时把设备自报的 `chManufacturerName` 塞进 `CameraMetaInfo.VenderName`，工厂再拿它去查表。**适配器负责"产生这个名字"，工厂负责"消费这个名字"，两边一旦对不上，失败在工厂侧暴露，根因在适配器侧。** 我为什么把这条注释在 HikCamera 的枚举循环里也写一遍？因为排查这类问题时，**看到告警的地方（工厂）和执行出错的地方（适配器枚举）不是同一个地方**，注释得写在两边，才能让人顺着找过去。

### 三、进程级日志打点：static 只做一次

```cpp
static bool logPathSet = false;
if (!logPathSet) {
    const QString logDir = QCoreApplication::applicationDirPath() + QStringLiteral("/MvSDKLog");
    QDir().mkpath(logDir);
    QByteArray logPath = logDir.toLocal8Bit();
    MV_CC_SetSDKLogPath(logPath.constData());
    logPathSet = true;
}
```

**为什么用 `static`**：`MV_CC_SetSDKLogPath` 是 **SDK 的进程级全局设置**，不是每台相机一个。所以它在整个进程里只需要设一次。用函数内 `static bool` 打点，第一次调用时设好，之后所有枚举都跳过。**既保证设了，又避免每次枚举都跑一遍 `mkpath`（一次磁盘操作）。**

注释里还留了一句提醒：重复设置会被 SDK 忽略。这句话是给"我能不能不用 static，每次都设一遍"这个念头准备的答案——会白跑 `mkpath`，且没有任何收益。

### 四、`CameraHandle()` 这个后门

适配器里有个方法，注释写得很警惕：

```cpp
// 裸句柄出口，只给 SDK 回调这类必须回传句柄的内部路径用，
// 业务层不要拿它绕过本类封装直接下发 SDK 调用。
void* CameraHandle() { return m_cameraHandle; }
```

**为什么要有它**：因为 SDK 的回调函数（`ImageCallBack`）是个**自由函数**，不是类成员。SDK 调用它的时候，只会给你 `pData`（图像数据）、`pFrameInfo`（帧信息），还有一个你自己注册时透传的 `pUser` 指针。回调里要调 `MV_CC_ConvertPixelType`，**需要相机句柄**，而句柄是 `HikCamera` 的私有成员。于是回调先 `static_cast<HikCamera*>(pUser)` 还原出对象，再调 `CameraHandle()` 拿句柄。

**为什么注释要警告业务层别用**：这个出口一旦被业务层拿去"绕过封装直接下发 SDK 调用"，等于把 SDK 的类型和调用方式泄漏到了适配器外面——**契约层的隔离就白做了**。它是给回调用的逃生舱，不是常规出入口。

## 虚拟相机：为什么它必须有

如果只有海康一个适配器，我就不需要 `VirtualCamera` 了吗？恰恰相反，**虚拟相机是这个架构能不能跑起来的前提。**

`VirtualCamera.h` 里三行注释把它的价值说尽了：

```cpp
// 与真机共用同一套相机契约的仿真实现：枚举恒返回一台虚拟设备，
// 采集由本地线程造图，用于无硬件时跑通“枚举—连接—采集—取帧”全链路。
static const QString VIRTUAL_CAMERA_NAME;
static const QString VIRTUAL_CAMERA_SERIAL;
static const QString VIRTUAL_CAMERA_VENDER;
```

**它跟真机共用同一套契约**——这是最关键的一句。它实现的也是那 17 个纯虚方法，走的是同一个工厂注册流程，进的是同一个图像队列。区别只在数据来源：

```cpp
// 起采即拉起一条 detach 的造帧线程，线程以 isGrabbing() 为唯一退出条件
auto CreateImage = [this]() -> void {
    while (this->isGrabbing()) {
        cv::Mat canvas = cv::Mat::zeros(cv::Size(512, 512), CV_8UC3);
        ...
        this->getImageQueue().Put(canvas);
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
    }
};
```

**为什么这么设计是对的**：真机是 SDK 回调线程 `Put`，虚拟相机是自建的造帧线程 `Put`，**两种来源投进的是同一份 `m_imageQueue`**（基类内置的那个）。所以取帧侧（`getImageLast`、`Take`）**完全不需要区分**底下是真机还是仿真。这意味着：

- **开发时不需要真机**——界面布局、参数面板、图像显示全都能在没有相机的情况下调完。
- **测试不需要真机**——CHANGELOG 里写得很清楚，测试目标里不注册厂商适配器，整条链路走的都是虚拟相机。
- **CI 不需要真机，也不需要 SDK**——配合上一篇讲的 `#ifdef` 降级，一台没装 MVS 的机器能跑完整个构建 + 单测。

**所以"虚拟相机"不是"测试用的小玩具"，它是这个架构的第二根承重柱。** 它证明了一件事：契约是完备的——**17 个方法真的足够描述一台相机**，因为一个完全不碰硬件的实现，只靠这 17 个方法就撑起了全链路。

## 三个不会让编译器吭声的缺陷

这一节是本篇最值钱的部分。三个缺陷都在 CHANGELOG 的"未发布 / 修复"里，都是**逐文件写注释时暴露出来的**。我这次翻源码逐个核实了行号和成因。它们的共同点很扎心：

**编译过、测试过、界面正常——因为都不影响功能自洽，只影响语义正确性。**

### 缺陷一：`RGB8_Packed` 漏认，帧被静默丢弃

**位置**：`src/CameraFactory/HikCamera.cpp`，`IsColor` 函数，第 14–50 行。

**核实结果**：现在第 18 行是 `case PixelType_Gvsp_RGB8_Packed:`。看 `git show 68a1452` 的 diff——**这一行是那次修正新加的**，修正前 `IsColor` 里只有 `BGR8_Packed`，没有 `RGB8_Packed`。

**为什么是致命的**：这一层的职责是把千奇百怪的采集格式归一成两种。看 `HikConvert2Mat` 的分支：`IsMono` 命中就走 `Mono8`，`IsColor` 命中就走 `RGB8_Packed`。**`RGB8_Packed` 恰恰是本层的转换目标格式之一。**

于是矛盾出现了：**如果相机自己把 `OutputFormat` 就设成了 `RGB8_Packed`（这完全合法，相机原生支持），那么**：

1. `IsMono(RGB8_Packed)` → false（它不是单色）
2. `IsColor(RGB8_Packed)` → false（当时的判定表里没收录它）
3. 两个判定同时落空 → `enDstPixelType` 保持 `PixelType_Gvsp_Undefined`
4. 命中 `if (enDstPixelType == PixelType_Gvsp_Undefined)` → `return false`

回到调用它的 `ImageCallBack`：

```cpp
cv::Mat cvImage;
if (!HikConvert2Mat(pCamera->CameraHandle(), pFrameInfo, pData, cvImage))
    return;   // ← 直接 return，什么也不做
pCamera->ImageQueue().Put(cvImage);
```

**`return` 掉了，没有任何 `Put`。** 上层 `Take` 拿不到帧，只会收到 `GETIAMGE_TIMEOUT`（超时）。**界面上就是黑屏/不出图，日志里只有一行 `Unsupported pixel format` 的 `qWarning`——上面一层完全不知道发生了什么。**

**为什么注释里写"必须互补"**：现在 `IsMono` 上面那句注释是：

```cpp
// 与 IsColor 必须互补且不留缝：漏掉任何一种在用格式，整条链路就会丢帧。
```

这不是修辞，是对这个 bug 的描述。这两个函数构成一个**覆盖判定**——它们的并集必须覆盖所有"可能出现在相机 OutputFormat 里的格式"。漏掉一个，就是漏掉一整类设备的出图能力。而 `RGB8_Packed` 漏得特别讽刺：**它正是我们自己要转成的目标格式**，我们却认不出"已经是它"的输入。

### 缺陷二：序列号与显示名互换

**位置**：`src/CameraFactory/VirtualCamera.cpp`，`EnumCamera`，第 24–31 行。

**核实结果**：看 `git show 68a1452` 的 diff，修正前的代码是：

```cpp
cameraInfos.push_back(CameraMetaInfo { VIRTUAL_CAMERA_NAME, VIRTUAL_CAMERA_SERIAL, VIRTUAL_CAMERA_VENDER });
```

注意参数顺序：**`{ 名称, 序列号, 厂商 }`**。而 `CameraMetaInfo` 在 `ZCCameraMetaInfo.h` 第 7–10 行，声明顺序是：

```cpp
struct CameraMetaInfo {
    QString Serial {};
    QString UserDefineID {};   // ← 对应显示名
    QString VenderName {};
};
```

**`{ Serial, UserDefineID, VenderName }`**——也就是 `{ 序列号, 显示名, 厂商 }`。

**聚合初始化是按位置对齐的。** 于是 `VIRTUAL_CAMERA_NAME = "VirtualCamera"`（第 9 行）被填进了 `Serial` 字段，`VIRTUAL_CAMERA_SERIAL = "Vir123456"`（第 10 行）被填进了 `UserDefineID` 字段。**序列号和显示名，逐字互换。**

**为什么测试发现不了**：因为**功能上仍然自洽**。上层一律按 `info.Serial` 寻址——它拿到的是 `"VirtualCamera"`，但**同一次枚举每次都返回同一个值**，所以"按序列号稳定索引同一台虚拟相机"这件事依然成立。功能正常，只是**对外语义错了**：用户看到的"序列号"其实是名字，看到的"名字"其实是序列号。

而且注意：**`{ 名称, 序列号, 厂商 }` 和 `{ 序列号, 显示名, 厂商 }` 的字段类型全都是 `QString`。** 三个连续同类型字段，聚合初始化按位置对齐，编译器**一声不吭**。这正是 CHANGELOG 里说的"不易从代码本身读出"。

现在修正后的代码第 27–29 行，加了一行注释把顺序钉死：

```cpp
// 字段顺序必须对齐 CameraMetaInfo 的声明 { Serial, UserDefineID, VenderName }：
// 两个常量名字相近，顺序写反了照样编译通过，序列号与显示名却就此互换
cameraInfos.push_back(CameraMetaInfo { VIRTUAL_CAMERA_SERIAL, VIRTUAL_CAMERA_NAME, VIRTUAL_CAMERA_VENDER });
```

### 缺陷三：门面丢弃关键返回值（跨层耦合的代价）

**位置**：不在本篇的两个适配器里，在 `src/CameraInterface/CameraContext.cpp`。

**核实结果**：`git show 68a1452` 的提交信息写明——`startGrabbing` 与 `destroyStream` 的返回值未被接收，紧随其后的判断检的是**上一次调用**的结果。也就是说，如果 `startGrabbing` 失败了，但上一次某个调用成功了，第二个判断就会把这个"陈旧的成功"当成"启动成功"。

**为什么放在这一节讲**：因为它跟适配器直接相关。`HikCamera::startGrabbing` 里有个本地状态镜像：

```cpp
// isStartGrabbing 是本地状态镜像，只为 isGrabbing() 省一次 SDK 往返；
// 它仅在起采成功后置位，失败必须保持 false，否则上层会误以为已在采集。
```

适配器这侧的行为是**对的**——它老老实实返回错误码、老老实实不置位。**问题出在它的返回值没被人看。** 这是"契约层错误码体系"落地时最容易漏的一环：契约规定了每个方法返回 `uint32_t`，但如果某一层调用时忘了接，契约的强制性就断在那一行。**编译器管不了"你调了但没看返回值"**（`[[nodiscard]]` 是后来的事了，当时没上）。

### 三个缺陷的共同教训

把三个缺陷放一起看，会发现它们指向同一件事：

| 缺陷 | 谁本来能拦住它 | 为什么没拦住 |
|---|---|---|
| `RGB8_Packed` 漏认 | 测试 | 测试用的是虚拟相机，不走海康的像素格式判定 |
| 序列号/显示名互换 | 测试 | 功能自洽（按 Serial 寻址仍稳定），测试断言的是行为不是语义 |
| 门面丢返回值 | 编译器 | 调用返回值不接，编译器默认不报错 |

**三个缺陷没有一个能让编译器失败，也没有一个能被现有测试抓住。** 它们是被"逐文件写注释"这个动作逼出来的——因为你写注释时必须逐行问自己"这一行为什么这么写"，而**"这一行为什么这么写"问到最后，就变成了"这一行凭什么是对的"**。

我现在回头看，**注释不只是文档，它是一个强制你复核每一行的机制。** CHANGELOG 里那句话我很有共鸣：

> 它们都不会导致编译失败，也都不易从代码本身读出。

**这就是静态检查和单元测试的盲区：语义错误。** 你没法测出"这个字段语义反了"，因为程序跑起来是对的。

## 设备独占检测：连接前先问一句"你能独占吗"

这一节原本可以独立成篇，但素材不厚，并进来讲。

工业产线上，一台相机常常不只被一个进程用——可能另一个调试工具也开着，可能上一次的程序没退干净。**如果两个进程同时独占一台相机，后打开的那个失败，而且失败得很晚（打开到一半才报错）。**

`HikCamera::connect` 的第一件事就是先把这种冲突问出来：

```cpp
// 先判独占再打开：IsDeviceAccessible(MV_ACCESS_Exclusive) 反映“此刻能否被独占访问”，
// 别的进程占着设备时这里就失败，把冲突提前到打开之前暴露。
if (MV_CC_IsDeviceAccessible(m_pDeviceInfo, MV_ACCESS_Exclusive) == false) {
    return DEVICE_NOT_ACCESSIBLE;
}
auto nRet = MV_CC_OpenDevice(m_cameraHandle);
```

**为什么是"降级为可读错误"而不是异常**：看 `DEVICE_NOT_ACCESSIBLE` 这个错误码——它不是一个笼统的"连接失败"，它**明确告诉上层"设备被别的进程占着了"**。上层拿到这个码，可以弹出"设备正在被其他程序使用"这种可操作的提示，而不是"连接失败"这种让用户瞎猜的提示。

**都有哪些环节会卡住**——注释把它的局限也写清楚了：

```cpp
// 该判断依据枚举时缓存的访问模式，GigE 下可能滞后，真正权威的仍是 OpenDevice
// 的返回值，所以两步都要查，少一步都可能在多进程抢机时误判。
```

**为什么要查两步**：`IsDeviceAccessible` 用的是**枚举那一刻缓存的访问模式**。在 GigE 网络下，从你枚举到你要连接，中间可能过了几百毫秒，这期间设备可能被别人抢走了——**缓存的信息可能已经过期**。所以权威判定必须是 `OpenDevice` 的返回值。但你又不能只靠 `OpenDevice`：那样失败太晚，而且分不清"被占用"和"设备坏了"。**两步都查：先查缓存拿到一个清晰的错误码，再让 OpenDevice 做权威裁决。**

顺带一个和上上节呼应的点：`MV_CC_IsDeviceAccessible` 的第一个参数是 `m_pDeviceInfo`。而这个指针指向的**必须是一份自有副本**，不能是 SDK 枚举列表里的裸指针。看 `HikCamera.h` 第 69–73 行的注释：

```cpp
// 设备信息的自有副本。acquire() 从 SDK 的枚举列表里值拷贝进来，m_pDeviceInfo
// 指向它 —— 枚举列表的内存归 SDK 管且会被下一次枚举覆写，直接引用原节点，
// 多机依次连接时早先那台的指针就会悬垂，而 connect() 还要拿它判独占。
```

**为什么必须值拷贝**：多机依次连接时，你连接第二台会触发一次新的枚举，SDK 会覆写枚举列表的内存。如果第一台还指着那个列表节点，它的 `m_pDeviceInfo` 就**悬垂**了——而 `connect()` 判独占时还要拿它。所以 `acquire()` 里那句 `m_deviceInfo = *cameraInfo;` 是必须的，**它把设备信息从"借来的"变成"自己的"**。

## 我踩过的坑

**坑一：以为注册表"登记创建器"就够了。**

最早我把创建器和枚举器想成两件独立的事，觉得"注册一个品牌"主要是告诉工厂怎么造它，枚举是另一码事。结果设备列表里空荡荡——**枚举器没登记，没人去枚举**。反过来的情况更隐蔽：只登记枚举器时设备列得出来，点连接回 `nullptr`，我当时还以为是设备权限问题，排查了半天。

教训：**这类"两半必须配对"的设计，不能让使用方靠记忆去配。** 我把 `registerVendor` 做成一个模板方法、一次登记两张表，就是逼着它成对。**能用接口形状保证的事，不要用文档保证。**

**坑二：`ChatGPT` 式的"这三处字符串肯定一致"——品牌名匹配。**

我在写海康适配器时，注册 key 写的是 `"Hikrobot"`。写下这个字面量的时候，我心里想的是"海康嘛，肯定是这个"。**但我从来没去核实过设备固件里 `chManufacturerName` 报出来的是什么。** 我是后来写注释、翻到 `info.VenderName = ...chManufacturerName` 这一行，才意识到两边是两个来源。

现在这一段有 5 G 的 SDK 和一堆设备型号，我没办法在每台机器上都验证固件字段。**我能做的是把这个风险写在三个地方**：工厂头文件（注册键必须逐字一致）、工厂 `createCamera`（查不到要告警不要吞）、适配器枚举循环（VenderName 取自设备自报）。**一个跨系统的隐式契约，就得在它跨越的每一个边界上都留标记。**

**坑三：`RGB8_Packed` 漏认——"互补判定"漏一个就是丢一类帧。**

这个坑的症状最气人：**界面黑屏，日志里就那么一行 `Unsupported pixel format`。** 我第一次遇到时以为是相机没出图、查了半天曝光和触发模式。后来才明白，帧**出图了、到回调了、转换失败了、被静默 return 掉了**。

最讽刺的是漏的那个格式**恰是我们自己的转换目标**：`HikConvert2Mat` 想把彩色都转成 `RGB8_Packed`，结果相机原生就用 `RGB8_Packed` 时，我们反而不认识它。**"我能把它转成 X"和"它本来就是 X"是两条独立的代码路径，都得覆盖。** 现在 `IsMono` 上那句"必须互补且不留缝"，是我用这个 bug 换来的。

**坑四：聚合初始化把序列号和显示名写反了，测试一声不吭。**

`CameraMetaInfo { VIRTUAL_CAMERA_SERIAL, VIRTUAL_CAMERA_NAME, ... }`——修正前是反的。**三个连续的同类型 `QString` 字段，按位置对齐，写反了编译器完全不管。** 而它**功能上居然是对的**，因为上层只按 `Serial` 寻址，同一个值每次枚举都稳定。测试断言"能按序列号索引到这台相机"——**这个断言在字段反过来时也成立**。

教训有两层。第一层是**聚合初始化的位置对齐太脆弱**，尤其当字段名相近（`NAME` 和 `SERIAL` 就差一个词）、类型又全一样时。第二层更狠：**测试只能验证"行为自洽"，验证不了"语义对齐"。** 一个字段装错了内容但系统内部自洽，测试是绿的，界面上你看不出来，只有人逐字读代码才会发现。**后来我给这类构造都加了注释把声明顺序钉死在旁边。**

**坑五：门面丢返回值——契约立得住，接的人不接也白搭。**

`startGrabbing` 和 `destroyStream` 的返回值没被接住，判断检的是上一次调用的结果。**这是契约落地时最容易漏的一环：契约规定了所有方法返回 `uint32_t`，但契约管不了"你调了必须看返回值"。** 适配器老老实实返回错误码、老老实实不置位（`HikCamera::startGrabbing` 里失败时 `isStartGrabbing` 保持 false，这是对的），结果上一层不看——**适配器的诚实全白费。**

教训：**契约的强制性，一半在定义（纯虚方法逼你实现），一半在使用（逼你看返回值）。** 前一半编译器帮你守，后一半当时没有任何机制守。现在我会对这类"返回值必须处理"的方法考虑 `[[nodiscard]]`。

**坑六：`m_pDeviceInfo` 一开始指向 SDK 的枚举列表，是个悬垂指针。**

看 `HikCamera.h` 注释里那句：

```cpp
// 它曾被写成指向 SDK 枚举列表的裸指针，那句被注释掉的 delete 就是当年
// 误删 SDK 内存留下的；注意 m_deviceInfo 是成员，不能 delete。
```

**当年我写过 `delete m_pDeviceInfo`。** 因为按常识"我 new 的东西我 delete"，但这个指针根本不归我——它指向 SDK 管理的枚举列表内部的内存。**我去 delete 别人的内存，这是双重错误**：第一，它不是我的；第二，多机依次连接时它早就悬垂了。现在改成"`acquire` 值拷贝进自有成员 `m_deviceInfo`，`m_pDeviceInfo` 指向它"。**所有权这个东西，不看注释真会错。**

**坑七：回调里 `static_cast` 还原对象，前提是反注册必须先于析构。**

`ImageCallBack` 里那句 `HikCamera* pCamera = static_cast<HikCamera*>(pUser);`——`pUser` 是 `connect()` 时透传的 `this`。这个模式能成立的前提是：**对象活的时间必须长于回调被注册的时间，也就是 `disconnect()`（反注册）必须先于对象析构。** 我一开始的驱动顺序是反的——先析构对象再断连，等于回调还可能拿着一个已经被析构的 `this` 去访问。注释里现在写死了这个前提。**凡是把 `this` 交给别人的地方，都得想清楚它还回来的时候你还在不在。**

## 结尾：工厂是唯一的翻译点

回到开头那句话。工厂和适配器这一层，是整个项目里**唯一认识具体品牌的地方**。往上走：

- 契约层不认识海康，它只有 17 个纯虚方法。
- 门面层不认识海康，它持有的永远是 `CameraInterface*` 基类指针。
- 界面更不认识海康，它看到的是 `CameraMetaInfo` 那三个字段。

**"Hikrobot" 这个字符串，从适配器往上走，走到契约层就被抽象吸收掉了。** 所以"换品牌只改一处"是真的——你只改工厂里的注册 + 新写一个适配器。**剩下的所有上层，一个字不动。** 代价是这一处必须改对：厂商名要逐字对上设备自报的串，`RegisterVendor<T>` 的 T 要满足两个编译期约束，返回值要接、要判空。

到这里，单台相机的完整生命周期就闭环了：契约定义能力 → 工厂按名字造出实现 → 适配器把 SDK 差异吃掉 → 虚拟相机让这一切不需要真机。

但故事还没完。上面讲的都是**一台**相机——一次枚举、一个设备对象、一条图像队列。产线上是**多台**同时挂着，而且是几千帧/秒的高频场景。**谁记住"序列号 12345 对应哪个对象"？谁来托管这么多相机的连接、断连、重启？谁来保证高频取值不串帧？**

下一篇讲**门面层的多机寻址与门面**：序列号到设备对象的那张映射表、多机的生命周期托管，以及图像链路怎么做到不丢帧也不串帧。

<!--
配图占位（本篇未配图，后续统一配）：
1. 注册表双 Map 图 —— 一个 key（厂商名）下挂两条 lambda：创建器与枚举器，突出"缺一即半残"。
2. 品牌名两条来源链路图 —— 左：虚拟相机走本地常量（安全）；右：海康走设备自报 chManufacturerName（脆弱），两线在 m_creatorMap 汇合，标出"必须逐字一致"。
3. 三个缺陷标注图 —— RGB8_Packed 判定落空路径、{名称,序列号} ↔ {Serial,UserDefineID} 的位置互换箭头、门面丢返回值那一行。
-->
