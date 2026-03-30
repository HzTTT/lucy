# Lucy iOS 聊天转录内核完全重构设计

**日期：** 2026-03-30

**目标**

彻底重构 `LucyIOSDemo` 当前聊天页的消息刷新、滚动、键盘联动与多媒体渲染内核，解决以下核心体验问题：

- 长会话和流式回复期间滚动明显卡顿
- 图片、音频、文档等多媒体消息进入列表后掉帧
- 键盘展开/收回时消息区跟随不自然，容易抖动或滞后
- 发送后无法稳定实现“用户消息顶到上方，agent 回复自然向下生长”的交互

本次设计以 `iOS 18+` 为目标平台，直接采用完全重构方案，不保留当前 `ScrollView` 聊天内核。

本次工作包含提升 `LucyIOSDemo` 聊天主路径的最低 iOS 版本要求到 `iOS 18.0`，并相应更新 Swift Package / App target 配置。`iOS 18.0` 作为本次对齐后的统一最低部署版本，后续实现计划不再要求新的聊天内核继续兼容 `iOS 16/17`。

本次工作也明确将 `LucyIOSDemoFeature` 收敛为 iOS-only package 实现；现有 package 层面的 `macOS(.v13)` 支持不再作为新聊天内核或其测试路径的兼容目标。实现计划应覆盖 `Package.swift` 与 Xcode / app target 两侧的部署目标和平台声明对齐，避免继续保留“package 仍宣称支持旧平台，但主聊天路径实际已依赖 iOS 18 UIKit 能力”的分裂状态。

现有本地聊天历史允许在这次重构中一次性清空；本次工作不要求为旧 `LucyConversationStore` 数据做向后迁移。新的本地历史存储格式可以按新 turn / transcript 模型重新设计，只需保证重构完成后的新格式稳定可恢复即可。

**用户已确认的关键交互**

- 目标平台：`iOS 18+`
- 目标交互：发送后，当前用户消息成为顶部锚点；agent 的 reasoning、tool、文本、多媒体输出在其下方自然向下展开
- 方向选择：直接完全重构，不做渐进式修补

## 当前状态分析

当前问题不是单点 bug，而是聊天页的几个高频系统耦合在一起：

1. `LucyAppModel` 同时管理会话列表、发送、流式更新、媒体下载、连接状态、配置状态，任一高频变化都可能扩大到整页刷新。
2. `LucyRedesignedRootScene.swift` 同时承担滚动、composer、消息行、媒体卡片、Markdown、缓存、picker，视图边界过于集中。
3. 当前滚动依赖 `ScrollViewReader + 多个 onChange + PreferenceKey` 手动触发 `scrollTo`，消息变化、焦点变化、sheet 收起、draft 长度变化都会争抢滚动控制权。
4. 键盘联动通过底部 overlay composer 与手工 inset 计算实现，导致 transcript 与 composer 不是同一个稳定布局系统。
5. 图片仍然使用同步解码路径，列表中混入大图后滚动成本过高。
6. Markdown、表格、Mermaid、SVG 与媒体渲染直接挂在消息行里，高频 token 更新时容易触发布局和渲染连锁放大。

对照 `outside/Open-Relay`，当前 Lucy 缺少两类关键设计：

- 将流式内容从主消息数组中隔离，避免所有消息随 token 一起重绘
- 使用现代滚动状态模型管理“自动跟随 / 用户手动浏览 / 滚动恢复”，而不是堆叠多个 `scrollTo`

## 设计原则

1. 高频状态与稳定状态分层。
2. 列表刷新粒度下降到 turn item，而不是整条 conversation。
3. 键盘、composer、transcript 使用同一套布局与状态机，不再互相覆盖。
4. Streaming 阶段优先保证流畅与稳定，最终完成后再补齐重渲染。
5. 多媒体、Markdown、播放器状态全部走独立 pipeline，不让 cell 在渲染现场承担重活。
6. 旧协议与业务语义保留，重构仅覆盖 iOS 聊天内核，不改 Lucy NATS 协议与插件侧传输行为。

## 目标架构

### 1. SwiftUI 外壳 + UIKit transcript 内核

- `LucyChatContainerView`
  - SwiftUI 外壳
  - 负责 header、settings、device 切换、sheet 路由、外层状态注入
- `LucyChatViewControllerRepresentable`
  - 把 UIKit transcript 容器嵌入 SwiftUI
- `LucyTranscriptViewController`
  - 使用 `UICollectionView + diffable data source`
  - 负责消息列表、局部刷新、顶部锚点、滚动状态机、键盘恢复
- `LucyComposerHostView`
  - 独立输入区容器
  - 与 transcript 共享布局体系，不再以 overlay 叠加在列表之上

### 2. 状态层

- `LucyChatSessionStore`
  - 持有稳定的 turn 列表
  - 负责发送、machine event 合并、完成态落盘、会话恢复
  - 使用新的本地持久化格式；不兼容旧 `LucyConversationStore` 序列化结构
- `LucyStreamingTurnStore`
  - 持有当前正在输出的临时 turn 状态
  - 包括 live text、reasoning、tool、approval、暂存 media
  - streaming 结束时一次性并入 `LucyChatSessionStore`
- `LucyTranscriptProjectionEngine`
  - 将领域状态投影为 transcript section/item
  - 产出专供 collection view 使用的稳定渲染模型
- `LucyTranscriptViewportController`
  - 管理顶部锚点、自动跟随、用户手动浏览与滚动恢复
- `LucyMediaPipeline`
  - 管理图片下采样、缩略图、音频播放模型、缓存与预加载

### 3. 保留不动的边界

- `Lucy` 插件侧 NATS / media / presence 协议
- `LucyMachineEvent` 语义
- 设备绑定、配置下发、settings、raw events、device setup 业务流程

## 核心交互设计

### 发送后的“顶部锚点工作区”

聊天不再定义为“永远贴底”的传统 transcript，而定义为“当前轮次工作区”：

1. 用户发送后创建一个新的 turn。
2. 当前 turn 的用户消息 cell 成为顶部锚点。
3. 列表自动将该消息滚动到距离顶部固定安全边距的位置。
4. assistant 的 reasoning、tool、text、image、audio、file 在其下方继续展开。
5. 这一轮结束前，不以底部为主锚点。

### 滚动状态机

统一为 4 个状态：

- `anchoredTurn`
  - 默认工作态
  - 当前轮次顶部固定
- `followingTail`
  - 用户主动回到当前轮次底部，希望继续跟随最新输出
- `manualBrowse`
  - 用户手动浏览历史，自动滚动全部暂停
- `restoringAnchor`
  - 键盘变化、媒体高度突变、旋转、动态字体变化后的短暂恢复态

状态机目标：

- 用户没打断时，持续保证当前轮次稳定可读
- 用户一旦手动浏览，系统不抢滚动控制权
- 键盘和媒体高度变化优先恢复当前 turn 的视觉位置，不做额外跳转

### 键盘与 composer 联动

键盘策略围绕顶部锚点而不是底部吸附设计：

- composer 改为 transcript 容器中的独立底部区域
- transcript 和 composer 使用同一布局系统跟随键盘
- 键盘弹出时优先保持当前轮次锚点稳定
- 键盘收起时恢复同一锚点，不做额外动画补偿
- 用户处于 `manualBrowse` 时，键盘仅调整 inset，不触发自动重定位

## 数据模型重构

### 领域模型

- `LucyTurn`
  - 一次用户输入及其对应 agent 输出
- `LucyTurnInput`
  - 用户文本、附件、发送状态
- `LucyTurnOutput`
  - 已完成输出的稳定快照
- `LucyStreamingTurnState`
  - 当前 streaming 临时状态

### 渲染模型

collection view 不直接渲染 `LucyConversation` 或 `LucyReplyState`，而是只消费下列投影模型：

- `TranscriptSection`
  - 一轮对话一个 section
- `TranscriptItem`
  - 一个可独立刷新的 item

建议的 item 类型：

- `userMessage`
- `reasoning`
- `toolGroup`
- `approvalCard`
- `assistantText`
- `imageGallery`
- `audioCard`
- `fileCard`
- `error`
- `turnFooter`

### 刷新规则

- token 增长：只刷新当前 turn 的 `assistantText`
- reasoning 变化：只刷新 `reasoning`
- tool 状态变化：只刷新 `toolGroup`
- approval 状态变化：只刷新对应 `approvalCard`
- 图片下载完成：只刷新受影响的 `imageGallery` 或 `fileCard`
- 音频播放进度：不回写 transcript 数据，由 cell 内局部控制器维护
- 新消息发送：新增一个 section，不重载旧 section

## Transcript Cell 设计

建议至少拆出以下 UIKit cell：

- `LucyUserMessageCell`
- `LucyReasoningCell`
- `LucyToolGroupCell`
- `LucyApprovalCell`
- `LucyAssistantMarkdownCell`
- `LucyImageGalleryCell`
- `LucyAudioCell`
- `LucyFileCell`
- `LucyTurnStatusCell`
- `LucyTurnFooterCell`

约束：

- cell 只消费已准备好的 view model，不做事件推导
- cell 不直接读取全局 store
- cell 内局部状态仅限展示行为，如展开、缩放、播放
- 高成本对象如播放器、缩略图控制器、排版缓存由独立 pipeline 持有

## 媒体与 Markdown 性能策略

### 图片

- 禁止列表中直接原图解码
- 统一做 downsample
- 图片分三级资源：
  - 列表缩略图
  - 预览大图
  - 全屏原图
- 列表 cell 仅消费缩略图

### 视频 / 文档

- 异步生成缩略图并持久缓存
- 列表先显示稳定 placeholder
- 缩略图完成后仅刷新对应 item

### 音频

- 列表中仅显示轻量播放卡片
- 不做运行时波形重计算
- 播放进度和暂停状态完全局部化，不回写 transcript

### Markdown

- Streaming 阶段不做完整富渲染
- Streaming 期间仅使用轻量文本渲染
- 最终完成后再进行 Markdown 富渲染
- Mermaid、SVG、表格仅在完成态渲染
- 解析结果和布局测量结果缓存

### 缓存策略

- 内存缓存
  - 当前会话可见区图片
  - 文档/视频缩略图
  - Markdown layout
- 磁盘缓存
  - 下载媒体
  - 文档/视频缩略图
  - 最终渲染 artifact

缓存 key 约定：

- media key: `deviceId + messageId + blockId + variant`
- markdown key: `messageId + blockId + contentHash + styleVersion`

## 清理与重构计划

这是一次明确的 cleanup / refactor / deslop 工作，按以下顺序推进：

1. 先建立新聊天内核，不直接在旧 `ScrollView` 页面上叠补丁。
2. 保留旧协议与业务流程，避免把 iOS 重构扩大成跨仓协议变更。
3. 将高频 streaming 状态从稳定会话模型中剥离。
4. 将 transcript 列表改造成 section/item 级局部刷新。
5. 再接入键盘、composer、媒体 pipeline。
6. 最后切流并删除旧聊天渲染逻辑。

遵循原则：

- 优先删除旧耦合路径，而不是给旧页面再加新抽象
- 优先复用现有协议与 store 能力
- 不在本次重构中新增依赖，除非 UIKit transcript 的实现被现有能力明确阻塞

## 迁移阶段

### 阶段 0：建立性能基线

记录并固化以下指标：

- 发送到首个 token 的耗时
- streaming 期间主线程卡顿
- 键盘展开/收起帧率
- 图片/音频/文档会话下滚动帧率

建议记录方式：

- Instruments Time Profiler / Hangs
- Core Animation FPS
- os signpost 或等价埋点记录发送、首 token、final 完成时间

### 阶段 1：引入新状态内核

新增：

- `LucyChatSessionStore`
- `LucyStreamingTurnStore`
- `LucyTranscriptProjectionEngine`

目标：

- 先让 machine event 合并逻辑从旧视图中迁出
- 先验证状态正确性，不替换主 UI

### 阶段 2：UIKit transcript 核心落地

新增：

- `LucyTranscriptViewController`
- diffable data source
- turn section / item identity
- 滚动状态机

目标：

- 验证顶部锚点与局部刷新模型成立

### 阶段 3：composer 与键盘联动重做

新增：

- `LucyComposerHostView`
- transcript / composer 共享布局体系
- 键盘恢复逻辑

目标：

- 先解决键盘自然度和 anchor 稳定性

### 阶段 4：接入真实 streaming 与媒体 pipeline

接入：

- 文本 streaming
- reasoning / tool / approval
- media 下载完成回填
- 图片下采样、文档/视频缩略图、音频播放

目标：

- 达到目标体验与目标性能

### 阶段 5：切流与删除旧路径

- 新旧聊天页并存一段时间
- 稳定后下线旧 `ScrollView` transcript
- 删除旧聊天渲染逻辑和重复缓存逻辑

这里的“并存”仅指实现阶段和同一开发分支中的临时共存，用于迁移与验证；不要求设计一个长期运行时 feature flag 供正式产品同时维护两套聊天主路径。

## 风险点

1. `TranscriptItem` identity 不稳定会导致 diffable 刷新抖动和滚动位置丢失。
2. `LucyStreamingTurnStore` 与完成态合并规则不清晰，会导致重复内容或错位。
3. 顶部锚点与键盘恢复逻辑处理不好，会把当前体验问题换一种形式保留下来。
4. 媒体完成回填如果刷新粒度过大，会重新退化成整页重算。
5. UIKit transcript 与 SwiftUI 外壳边界如果不清晰，会形成新一轮耦合。

## 非目标

- 不改 Lucy 插件侧协议
- 不改 `LucyMachineEvent` wire contract
- 不在本次重构中引入新的聊天产品能力
- 不同步重构 onboarding、settings、device setup
- 不为 `iOS 16/17` 兼容性保留旧滚动方案
- 不要求新聊天主路径继续维持 `LucyIOSDemoPackage` 当前 `.iOS(.v16)` 的最低部署目标
- 不要求 `LucyIOSDemoFeature` 继续维持当前 `macOS(.v13)` 的 package 平台声明、聊天主路径或测试可构建性

## 验证策略

### 单元测试

- `machine event -> turn state`
- `turn state -> transcript sections/items`
- streaming 完成合并
- reasoning / tool / approval / media 投影正确性

纯逻辑层应继续保持可在 iOS 目标下通过 SwiftPM 运行测试，包括状态合并、projection、identity 稳定性与本地持久化编解码；不再要求保留 macOS 可测试面。

### 集成测试

- 文本发送
- 图片发送
- 音频发送
- 文档发送
- assistant streaming
- media 下载完成后的局部刷新

UIKit transcript、键盘联动、滚动状态机与媒体交互以 iOS Simulator / Xcode 测试为主验证路径，不再要求这些 UI 路径继续在 SwiftPM 的 macOS 运行面上保持可测试。

### UI 测试

- 发送后用户消息进入顶部锚点
- 键盘展开/收起时锚点稳定
- 用户手动滚动后自动跟随暂停
- 回到当前轮次后恢复自动跟随

### 性能验证

- 长会话：200+ turns
- 混合媒体会话
- 连续 streaming
- 键盘开合与 streaming 并发

建议验收阈值：

- 文本会话中，发送后到首个 token 的 P95 不高于当前基线
- 纯文本 streaming 期间，主聊天视图滚动保持主观连续，无持续性明显掉帧
- 混合媒体会话中，连续滚动时不允许出现 1 秒级卡死或输入框明显失去跟手
- 键盘展开/收起期间，当前轮次锚点不得出现大幅跳变；可接受偏移应控制在一个气泡高度以内

## 最终交付标准

重构完成后，应满足以下标准：

1. 用户发送消息后，当前轮次稳定锚定在顶部工作区。
2. agent 的回复在其下方自然向下展开，无明显跳动。
3. 键盘展开/收起时 transcript 与 composer 联动自然，不出现明显滞后或反向抖动。
4. 大图、音频、文档混合会话中，滚动与输入仍保持可接受帧率。
5. Streaming 更新只影响当前 turn 的相关 item，不导致整页重绘。
6. 旧 `ScrollView` 聊天路径可被完全删除。
