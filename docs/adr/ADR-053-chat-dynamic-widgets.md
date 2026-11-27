---
schemaVersion: archcontext.adr/v1
title: NSH 桌面对话的动态 widget：纯数据规格、Host 校验与解析、nsh/base/plot 渲染、k8.act 交互
status: proposed
decidedAt: 2026-11-27
appliesTo:
  - sdk-root
---

# ADR-053：对话动态 widget（Proposed）

> **来源与追踪**：总 issue [#2552](https://github.com/Ancienttwo/byok-sdk/issues/2552)，本 ADR 由调研子 issue [#2553](https://github.com/Ancienttwo/byok-sdk/issues/2553) 产出，约束后续子 issue [#2554](https://github.com/Ancienttwo/byok-sdk/issues/2554)（Host 工具、校验、解析、条目投影）、[#2555](https://github.com/Ancienttwo/byok-sdk/issues/2555)（base 目录渲染）、[#2556](https://github.com/Ancienttwo/byok-sdk/issues/2556)（finance 目录渲染）、[#2557](https://github.com/Ancienttwo/byok-sdk/issues/2557)（交互方法），以及 O1 裁定后拆出的 [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559)（`@byok-sdk/server` 的 task-context 声明与断言验证，阻塞 #2554）。承接 [ADR-052](./ADR-052-desktop-native-ui-nsh-mixed.md)（NSH Mixed、D2 能力集、D3 Host/UI 边界、D6 UI 层规范）。
> **依据文档**：[NSH 对话 widget 调研](../researches/2026-11-27-nsh-chat-widgets.md)（下称「调研」），基线 `main@18b963e8a`，NSH pin `2964346`。
> **状态说明**：`proposed`。Owner 已于 2026-11-27 裁定 §5 的 O1–O4（[决议记录](https://github.com/Ancienttwo/byok-sdk/issues/2553#issuecomment-7219557886)）。晋升 `accepted` 的前提：owner 的 artifact 导出落盘后，补齐 D7 的 spec v1 组件类型与开放问题裁定，并裁定 O5。
> **#2552 已定、本 ADR 不再讨论的事项**：widget 是纯数据，由 `nsh-app/src/ui` 的固定目录渲染，不新增 D2 能力；只有一个保留工具 `render_widget`；finance 数值走 snapshotRef，不由模型传数；Host 在所属边界校验一次，非法规格 fail closed；未知组件或版本渲染显式的不支持卡片；条目 kind 为 `widget`，key `w<id>`，带 `rev`；草稿按 widgetId 存在 store；一个交互方法推广 `k8.answer`，带幂等 actionKey；不允许掩码或秘密输入；链接只经 `links.ts`；规格与渲染器无关。

## 1. 背景

#2552 要在 NSH 桌面对话里渲染两套目录（base 11 个组件、finance 11 个组件）的动态 widget。约束已定，未定的是七件事：NSH 用什么原语画图、widget 怎样进入 `k8.view` 的 List、规格与校验器归哪个包、bridge 契约怎么改、Host 怎样给每个引擎声明工具并解析 snapshotRef、spec v1 的具体类型、规格的安全边界。另有一件排序问题：#2462 的 cutover 会删除 Electron 应用，widget 子 issue 与它的先后关系需要写定。

## 2. 决定

### D1. 图表原语：`nsh/base/plot` 为主，`Canvas` 补位，Data 表兜底

- 图表组件用 `nsh/base/plot`：`Plot` 加 `Line`、`Area`、`Bar`、`Rule`、`Grid`、`PlotAxis`、`PlotLabel`。这些 mark 画在 canvas 上（线、面、柱等 mark 是铺满 plot 的 canvas，Pie、Sankey、Treemap 则每个部分一块），行数据在 Rust 中缩放、绘制，不按点运行 JS（调研 §1，`nsh:crates/nsh-base/src/plot/mod.rs:5-13`）。虚线基准线用 `strokeDasharray`（`nsh:website/elements/plot.md:210-212`）。三端由各自 2D 引擎回放：macOS Core Graphics、Windows Direct2D、Linux Cairo，虚线与等宽数字在三端源码均有实现（调研 §1 表格）。绘制不需要任何 capability。
- `Plot` 不覆盖的小图（例如 `change_list` 每行的定尺寸 sparkline）用 `nsh` 的 `Canvas` `draw` 函数画，同样走三端原生回放。
- 每个 widget 的 Expand 面板都有 Data 标签页，是同一组数字的真表格；`failed` 状态在可行时退回该表格。数值不依赖 hover 或 tooltip。
- 否决方案：只用 View 盒子画柱、折线退回表格。NSH 已有原生向量层，这个降级没有必要。否决 `Image` 加 `data:image/svg+xml`：resvg 光栅化后放大会发虚，且会把模型可控的 SVG 解析带进持有 spawn 与 custody 权限的进程（见 D8）。
- 成本：nsh-app 目前不 import `nsh/base/plot`，`nsh package` 只在 bundle 引入时保留 `plot` runner feature（`nsh:crates/nsh-cli/src/native_features.rs:16-21`）。第一个图表组件会把该 feature 带进 release runner，#2555 须在 PR 中记录 release 包体积差。
- 涨跌色是 `nsh.json` `theme` 中的两个语义 token（`price-up`、`price-down`，light 与 dark 都给值），按 locale 选择方向（zh-CN 红涨，zh-HK 与 en 绿涨）并允许用户覆盖，映射写在 `nsh-app/src/ui`。规格只携带语义（正负、`variant`），不携带颜色。

### D2. 条目接入 transcript：`w<widgetId>` 加 Host 盖章的 `rev`，固定高度

- `ConversationItem` 联合（`src/host/conversation/view.ts:37-43`）新增 `kind: 'widget'`，key 为 `w<widgetId>`，与 `e`、`t`、`q` 前缀互不相交。`rev` 是 Host 盖章的整数，同一 widgetId 单调递增。新 rev 以新对象、同一 key 下发，List 原位替换；nsh-app 的 `Each` 按 `${key}:${kind}` 挂载（`nsh-app/src/features/conversation/Transcript.tsx:226`），rev 变化不换 key、不换 kind，行实例保留。
- 排序锚点为所属 Turn 的 input `seq + 0.625`。现有锚点：状态行（working 或 ended）在 `after(seq) = seq + 0.5`（`view.ts:117`、`:123`、`:128`），question 在 `after(seq) + 0.25` 即 `seq + 0.75`（`view.ts:134`），reply 是之后的整数 `seq`。widget 因此位于状态行之后、question 与 reply 之前：Turn 进行中依次为 input、working 行、widget；回复后依次为 input、widget、reply。同一 Turn 的多个 widget 按 widgetId 顺序排列。
- 没有 input 条目的 Turn 也要有稳定锚点：回答 question 后 K8 发起的 Turn（id 为 `hash(['answer', questionId])`，`packages/bot-collaboration/src/rules/commands.ts:309-311`）与委派 Turn 不经 `recordInput`，没有 input `seq`。working 行此时退到 `Number.MAX_SAFE_INTEGER`（`view.ts:128`）。widget 的锚点基数因此在第一个 rev 写入时确定并存进 widget 记录，之后不再重算：有 input 条目时取其 `seq`，没有时取当时该 Bot 最大的 entry `seq`。
- NSH List 只对完全位于视口上方的行补偿高度变化，视口内的行变高会推动其下内容（`nsh:crates/nsh-core/src/core/list.rs:1558-1581`，测试 `:2283-2292`）。每个组件在所有状态下总高度相同：提示行在每种状态都占位（`ready`、`loading` 等无提示时留同高空白），`loading` 与 `ready` 的主体等高。这样视口内的状态切换与 rev 替换不移动阅读位置。验收：在真 NSH List 中让视口内的卡片切换状态，卡片与下一行的 Y 坐标不变。
- `estimatedItemSize` 仍是整表一个值（NSH 没有逐项尺寸 prop，`nsh:crates/nsh-js/src/list.rs:721`），保持 64。估值偏差只影响测量前的滚动条与远距跳转。
- 草稿状态（表单值、选择、待确认的 actionKey）存于 `nsh-app/src/store.ts`，以 widgetId 为 key，Host 确认后清除，沿用 `pendingClears` 的做法（`store.ts:278-290`）。行内 signal 不保存草稿；现有 `QuestionRow` 的行内 signal（`Transcript.tsx:105-106`）在 #2557 迁到同一个 store 结构。
- Host 侧的 widget 记录是条目的唯一权威：Host store 中每个 widgetId 一行，保存当前 `rev`、锚点基数、组件、已校验的 props、解析后的 snapshot，以及每个 action 已接受的 actionKey（D4）。`k8.view` 从这里投影条目。

### D3. 规格归属：桌面应用 `examples/desktop-bot-app/src/widgets/`

- 规格类型、尺寸上限与校验器放在 `examples/desktop-bot-app/src/widgets/`，用 zod 编写。同一份 schema 产出 Host 校验器与工具对外公布的 JSON Schema（`z.toJSONSchema`）。桌面应用把 `zod` 列为直接依赖，版本跟随工作区现有的 `^4.6.6`（`packages/client/package.json:120`）。该依赖已经随 `@byok-sdk/client` 进入 Host bundle。
- 校验器只在 Host 运行。nsh-app 与 Electron renderer 只用 `import type` 引用类型，与 nsh-app 现在引用 Host 类型的方式一致（`nsh-app/src/store.ts:4-7`），QuickJS bundle 不含校验代码（ADR-052 D3）。
- 否决 `@byok-sdk/ui-runtime`：它是公开包，api-surface 预算是精确上限（`api-surface/entries.json:3011-3015`），每次规格变化都会成为 SDK 包的 semver 变化，而且 ADR-052 §4 把桌面 UI 材料留在 `packages/*` 之外。否决新建 `packages/widget-spec`：唯一的消费者是桌面应用。Electron renderer 在 #2462 cutover 时删除，gpui-kit renderer 只是 ADR-052 D1 的回退选项，达不到「第二个独立发布的消费者」这一建包条件。
- 规格不引用任何 NSH 类型、class 或 Plot prop，保证与渲染器无关。

### D4. Bridge 契约：`k8.act` 取代 `k8.answer`，`schemaVersion` 不变，`bridgeVersion` 升到 3

- `widget` 条目 kind 是 `view.ts` 的类型变化。`bridge-contract.json` 只列方法名，因此这一项没有 JSON diff（调研 §4）。
- 新增一个方法，同时删除 `k8.answer`，两者不并存：

  ```ts
  'k8.act': {
    params: { botId: string; itemKey: string; action: string; actionKey: string; values: Json };
    result: { turnId: string } | null;
  };
  ```

  - `itemKey` 为 `q<questionId>` 时，`action` 只能是 `answer`，`values` 为 `{ answer: string }`，Host 转给 K8 的 `bot.answer`（现路径 `src/host/conversation/service.ts:137-142`）。
  - `itemKey` 为 `w<widgetId>` 时，`action` 必须是该 widget 规格中声明的 actionId，`values` 由 Host 按该 widget 的规格校验一次，只能是规格中预设的选项值（D8）。通过后，Host 以 `actionKey` 作为 actionId 提交一次 K8 send，消息正文是该动作的确定性投影。返回 `{ turnId }`。
- actionKey 由 UI 生成，按 widgetId 存在 store，重试时复用，Host 确认后清除。去重沿用现有权威，不另建去重表：
  - question 由 K8 按 questionId 去重（`packages/bot-collaboration/src/rules/commands.ts:297-311`）；
  - widget 动作提交的 send 由 Host store 按 actionId 去重（`src/host/k8/conversation.ts:112-118`）；
  - 同一 `(widgetId, action)` 只接受一次。K8 按 actionId 与 botId 识别输入，管不到这一点，所以由 Host 执行：Host 在 `store.sqlite` 的同一个事务里写入 `(widgetId, action) → actionKey` 绑定（D2 的 widget 记录）与 input 条目，然后才调用 `bot.input`。同一 actionKey 重放得到相同结果；已有绑定而 actionKey 不同则拒绝（`method_failed`），与 question 的 `Answer identity conflict` 语义一致。UI 在 Host 确认后清掉 actionKey，再次提交会生成新 key，正好落到这条拒绝。
- Bot 的 Turn 仍在进行时，widget 动作不被拒绝，而是作为一条排队的输入：桌面 Host 构造 K8 时不传合并策略（`src/host/k8/conversation.ts:73-82`），没有策略时每条输入各自成为一个排队的 Turn（`packages/bot-collaboration/src/rules/coalesce.ts:131`）。按到达顺序合并多条输入是 K8 的可选策略，桌面 Host 目前未开启。控件在 Turn 进行中保持可用。
- 错误码沿用现有 `BridgeErrorCode`（`src/bridge/protocol.ts:168-169`）：形状、未知条目或非法 values 为 `invalid_params`，K8 拒绝（冲突、问题不存在）为 `method_failed`。不新增错误码。
- 不可逆动作（`confirm_action` 以及规格标为不可逆的动作）由 UI 先弹 `role=alertdialog` 确认，再调用 `k8.act`。审批继续走 `activity.approve` / `activity.reject`，不经 `k8.act`。
- JSON 变化：`rendererMethods` 与 `hostMethods` 各把 `k8.answer` 换成 `k8.act`。`schemaVersion` 保持 2：它标记文件结构，此前因新增 `shellToHostMethods` 键从 1 升到 2。`bridgeVersion` 从 2 升到 3：FORKING.md 规定改动 bridge 就提高 `BRIDGE_VERSION`，版本不同的 shell 与 Host 互相拒绝（`examples/desktop-bot-app/FORKING.md:67`）。删除 `k8.answer` 后，旧 Host 与新 shell 若版本相同，`hello` 会放行，直到第一次调用才失败；NSH 开发时也可能复用旧的 Host bundle。#2557 同步修改 `src/bridge/protocol.ts:22` 的 `BRIDGE_VERSION`、Rust 端的 `EXPECTED_BRIDGE_VERSION`（`native/byok-shell/src/contract.rs:15`）与版本相关 fixture。

### D5. Host 解析：一个 host toolset 覆盖所有引擎，snapshotRef 在同一 task 的活动尾部解析

- **声明**：`render_widget` 是桌面 Host 配置的一个 task-scoped host MCP toolset（`docs/spec.md:2715-2734`）。Host 在 `DaemonConfig.mcpToolsets` 中登记它，stdio server 是 Host 二进制的一个 argv 模式。K8 每个 Bot 的执行模板在 `requiredToolsets` 中带上它的 id，并经 `readOnlyToolsets` 声明为只读（`packages/bot-collaboration/src/host.ts:63-64`）：该工具只写 Host 自己的 transcript，不触达外部系统。
  - 现有全部 adapter 都声明 `mcpToolsets: true`（claude、codex、pi、antigravity、opencode、dsh、grok），所以不需要逐引擎代码。不支持 `mcpToolsets` 的引擎在准入时被拒，没有无工具的回退（`docs/spec.md:2733-2734`）。
- **把调用绑定到 task**：校验结果要同步返回模型，解析 snapshotRef 要知道调用属于哪个 task，两者都要求子进程证明自己的 task。SDK 为此提供 task-context 通道：daemon 追加 context file，子进程用 `requestTaskAssertion` 换取断言，Host 验证（`docs/spec.md:2575-2618`）。嵌入式 `@byok-sdk/server` 的能力声明从不包含 `host-mcp-task-context`（`packages/server/src/index.ts:455`，`packages/cloud/src/capabilities.ts:191-196`），所以当前桌面 Host 拿不到 nonce。
  - **路径 A（Owner 已选定，O1）**：`@byok-sdk/server` 增加显式开关，声明 `host-mcp-task-context` 并用 cloud 已有的组合验证断言（`packages/cloud/src/auth/device-assertion.ts:95`）。桌面 Host 的 toolset 子进程经 loopback 把参数与断言交给 Host，Host 校验、解析并作答。
  - *（未采用）路径 B*：在 `packages/client` 增加第五个 SDK 保留 helper，照 `submit_result` 的方式经 daemon control socket 转发（`packages/client/src/bin/agent-result-mcp-server.ts:39-67`）。它不需要该能力，但会把桌面产品工具放进 SDK 保留协议，并在已有的 host toolset 机制旁边形成第二种声明方式。
  - **audience**：断言签发默认关闭。桌面 daemon 配置没有 `deviceAssertion.audiences`（`src/host/compose.ts:147-163`），此时 task-context 能力不成立（`packages/client/src/daemon/create-daemon/presence.ts:32-36`），`task_assertion.issue` 以 `assertion_disabled` 拒绝（`create-daemon/control-methods.ts:565-570`），子进程拿到的 context file 不存在，`requestTaskAssertion` 返回 `context_token_invalid`（`packages/client/src/daemon/assertion-client.ts:199-203`）。因此三处使用同一个固定 audience 常量 `byok-desktop-widgets`：Host 的 `DaemonConfig.deviceAssertion.audiences` 只含这一项；toolset 子进程调用 `requestTaskAssertion` 时传入它；Host 验证时要求它。context 缺失时子进程照旧拒绝，以 JSON-RPC 错误返回，不发出未绑定的调用。
  - **每次调用的授权**：每次 `tools/call` 及其每次重试都换取新的断言（新 JTI，`docs/spec.md:2590-2595`）。Host 只调用 #2559 提供的单一验证入口，它同时证明两件事：断言真实且 JTI 只用一次（§8.2(2)）；断言中的 task、AgentRef 与 toolset 属于一个仍在执行的 Execution，且其冻结的 `requiredToolsets` 仍包含 widget toolset（§8.2(3)，`docs/spec.md:2597-2607`）。Host 的 cancel 或 End 提交之后，不再接纳新的调用，返回 `widget_task_inactive`。#2554 不直接调用底层验证器。
  - 路径 A 触及公开包中的断言验证这一认证路径。按 Owner 决议，`@byok-sdk/server` 的切片作为独立的 High 级子 issue [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559) 先行落地，并阻塞 #2554。audience 配置与验证入口都属于 [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559)。
- **snapshotRef 形状**：mock 的 `{ turnId, toolCallId }` 不可行。模型看不到 K8 turnId；`toolCallId` 在事件中是可选字段（`packages/protocol/src/agent-event.ts:86`、`:97`）；现有 adapter 都会设置它（claude、codex、pi、dsh、opencode 在各自的投影中设置，grok 与 antigravity 经共用的 `adapters/acp-turn-buffer.ts:45-56`），Host 可以据此配对 `tool_use` 与 `tool_result`，但它是运行时元数据，没有任何引擎承诺把它作为可复制的内容给模型。v1 采用模型能写出的内容（Owner 已确认，O2）：

  ```ts
  snapshotRef: { server: string; tool: string; input: Record<string, unknown>; pointer?: string }
  ```

- **解析器消费的规范观测**：解析器只读取一种规范形状的 MCP 工具观测，四项内容如下。
  1. **身份**：`tool_use` 与 `tool_result` 都带 `mcp: {server, tool}`，且 `server` 是该 task 冻结的 `requiredToolsets` 中某个 toolset 的 server。依据是 adapter 按自身配置投影的身份，不是模型看到的工具名。
  2. **参数**：`tool_use.input` 就是原始 MCP arguments 对象，不带外层包装。
  3. **成功**：`tool_result.isError !== true`，且协议层状态为成功。
  4. **载荷**：`tool_result.output` 是 MCP `CallToolResult`（`{ content, structuredContent? }`）。有 `structuredContent` 时取它；否则必须恰好有一个 `text` 内容项，其文本按 JSON 解析。都不满足时报 `snapshot_invalid`。
- **adapter 现状**：投影规则归 `packages/client` 的 adapter 所有，Host 不按 adapter 逐一解码，否则会形成第二个投影权威。现状如下：
  - claude 符合：身份、原始参数，`output` 为 `{ content }`（`adapters/claude/projection.ts:207-215`、`:294-302`）。
  - antigravity 带身份（`adapters/antigravity/projection.ts:58-59`），`output` 为 `{ content, exitCode? }`（`acp-turn-buffer.ts:63`），内容项形状待适配 issue 核对。
  - pi 带身份，但 `output` 包成 `{ result }`（`adapters/pi/events.ts:150-162`），且把 `structuredContent` 序列化成额外的 text 块（`adapters/pi/mcp-tools.ts:96-97`）。
  - codex 带身份，但参数嵌在 `input.arguments` 里，`output` 为 `{ result, error, status }`（`adapters/codex/projection.ts:271-297`）。
  - grok（`adapters/grok/projection.ts:78-80` 未传 `mcp`）、dsh（`adapters/dsh/projection.ts:92-110`）、opencode（`adapters/opencode/projection.ts:51-68`）不带 MCP 身份。
  - 让 pi、codex、grok、dsh、opencode 输出规范形状，并核对 antigravity，是一个新的 SDK adapter 子 issue（由 orchestrator 开立，不属于 #2554 或 #2559），它还须检查这些字段的其他使用者。在它落地之前，解析器只接受规范形状的事件，其余报 `snapshot_ref_unavailable`，相应引擎上的 finance widget fail closed；base widget 不用 snapshotRef，不受影响。
- **解析规则**（只在发起调用的同一 task 内）：
  1. 在该 task 的规范观测中找身份等于 `{server, tool}`、参数与 `input` 深相等的 `tool_use`。必须恰好一条：零条报 `snapshot_ref_unresolved`，多条报 `snapshot_ref_ambiguous`。同一 task 内用相同参数调用两次，按此规则一律报 `snapshot_ref_ambiguous`，#2554 为此加一个 golden fixture。
  2. 按 `toolCallId` 配对 `tool_result`。缺 id、失败或输出被 spill 成预览报 `snapshot_ref_unavailable`。inline 上限缺省 64 KiB（`packages/client/src/daemon/event-spill.ts:15`），受 server 活动预算限制（`task-runner.ts:663`），量的是序列化后的整个事件，含包装与元数据（`event-spill.ts:231-238`），所以数据工具可用的载荷略小于 64 KiB。
  3. 对规范载荷应用 `pointer`（RFC 6901，缺省为根），按组件的 snapshot schema 校验，失败报 `snapshot_invalid`。通过后 snapshot 字段原样复制，不做映射（O4：下游 finance 数据工具将改为返回 snapshot 形状的 JSON，整个事件小于 64 KiB）。
  - 只有 host toolset（MCP）结果可作来源，数值只来自 Host 声明的数据工具，不来自 shell 等原生工具。
  - **历史完整性**：活动尾部在 task 进行中也会按条数与字节上限清掉最旧的条目（`packages/server/src/stores/sqlite/activity.ts:204-212`）。两条相同调用中的一条被清掉后，另一条会看似唯一。因此只要该 task 的尾部发生过清除（`floor` 前移），解析器无法证明唯一性，一律报 `snapshot_ref_unavailable`；模型应在新的 task（下一个 Turn）中重新取数并渲染。
  - 后续可以考虑：做一个兼容性测试，让 Host 控制的数据工具在模型可见的结果正文中附带 Host 签发的 handle，验证各引擎能否保留它、用它选中同参数的第二个结果。这只是后续想法，不是 v1 的决定。
- **等待**：daemon 每 250 ms 批量上送进度（`packages/client/src/daemon/progress-batcher.ts:65`），`render_widget` 可能早于数据工具的 `tool_result` 到达 server。Host 在 `server.tasks.events(taskId)` 上等待匹配的那一对，最长 5 s，超时报 `snapshot_ref_unresolved`，不以第一次查不到为准；该 feed 由本实例的提交唤醒（`packages/server/src/index.ts:275-280`）。
- **记录位置**：工具结果的唯一来源是 SDK 已保存的 task 活动尾部 `server.tasks.activity(taskId)`（`packages/server/src/index.ts:263-269`），Host 的 activity 卡片已在读取它（`src/host/activity/domain.ts:64`）。上限为 1000 条、4 MiB，task 结束后保留 10 分钟（`packages/cloud/src/activity.ts:8-10`）。`render_widget` 与数据工具在同一 Turn 内调用，解析时结果通常仍在；被上限清除的情况按上面的「历史完整性」处理。Host 不新建工具结果表，只把校验后的 snapshot 复制进 D2 的 widget 记录：活动尾部会过期，widget 要比它活得久。跨 Turn 引用不在 v1（Owner 已确认，O3）。

### D6. 尺寸上限与错误码

上限集中定义在 `src/widgets/` 的一个模块里，初值如下。调整数值是该模块内的代码变更，附带 fixture 即可，不需要修订本 ADR；两个字节上限的调整除外。

| 项 | 上限 | 理由 |
|---|---|---|
| 模型参数（序列化 JSON） | 32 KiB | finance 不传数值，base 组件的文本与行数已另有上限 |
| 解析后的条目（含 snapshot） | 64 KiB | 与 `submit_result` outcome 上限一致（`docs/spec.md:4262`）；250 根 K 线加均线约 30 KB |
| 每个 Turn 的 widget 数 | 8 | `k8.view` 每次返回整份快照（`service.ts:61-90`），条目数直接决定刷新成本 |
| 每个 widget 的 rev | 100 | 防止模型循环刷新 |
| 块节点 / 嵌套 | 每个 widget 16 个块；`tabs` 只嵌一层，`tabs` 内不允许再有 `tabs`；JSON 深度 8 | 渲染树有界，高度可预知（D2） |
| 表格 | 50 行、8 列；超出时由模型给出总数 M，状态为 `partial` | 对应「showing N of M」，不翻页 |
| list / key_value / 选项 / 表单字段 / tabs | 50 / 30 / 12 / 12 / 6 | 固定高度可控 |
| 序列 | 每条 250 点（`price_chart` 上限），最多 5 条（`peer_comparison` 5 家公司） | 取自 `handoff.md` |
| 字符串 | 标题、标签 120 字符；单元格 200；`text` markdown 4000；动作标签 40 | 卡片排版有界 |

校验失败以工具结果返回，`isError: true`，正文沿用 `submit_result` 拒绝时的形状 `{ error, reason, issues, truncated }`（`packages/client/src/bin/agent-result-mcp-server.ts:60-66`）。`issues` 每项为 `{ pointer, keyword, message }`（`packages/client/src/daemon/control-protocol.ts:603-608`），`pointer` 是 JSON Pointer，最多 20 项，超出时 `truncated: true`。断言无效、传输故障是 JSON-RPC 错误，不是工具结果。

| `error` | 含义 |
|---|---|
| `widget_invalid` | 结构、类型、枚举或计数上限不符；snapshotRef 缺失（finance）或多余（base） |
| `widget_too_large` | 超出任一字节上限 |
| `widget_unknown_component` | 组件不在 Host 目录中 |
| `widget_turn_limit` | 本 Turn 已有 8 个 widget，或该 widget 已到 100 个 rev |
| `widget_not_found` | 仅在 D7 的 `replaces` 获确认后启用：指向不存在、属于其他 Bot 或已被折叠的 widget |
| `widget_task_inactive` | 断言有效，但 Host 已提交该 task 的 cancel 或 End，或其 Execution 不再允许该 toolset |
| `snapshot_ref_unresolved` / `snapshot_ref_ambiguous` / `snapshot_ref_unavailable` / `snapshot_invalid` | 见 D5 解析规则 |

模型传入的未知组件由 Host 拒绝并返回错误，模型可以改正。UI 侧的 `upgrade_required` 卡片处理另一种情况：Host 目录认识、当前渲染器还没实现的组件。按合并顺序，#2554 先让 Host 接受两套目录，#2555/#2556 之前 finance 组件就会以这张卡片显示。

### D7. Spec v1（待 artifact 导出）

- 已确定且只取 `handoff.md` 原文的部分：模型参数 `{ component, props, snapshotRef? }`（snapshotRef 形状按 D5 修改）；Host 条目 `{ kind: "widget", id: "w<id>", rev, component, props, snapshot, state, notice?, source?: { label, asOf } }`；状态 `loading | ready | partial | empty | unavailable | degraded | failed | upgrade_required`；规格带 `specVersion: 1`；两套目录的组件名见 #2552；共享卡片外壳（header、meta、body、notice、audit footer，以及 Chart/Data 标签页的 Expand 面板）。
- **待定（建议）**：原位更新的模型参数。`handoff.md` 只说 Host 盖章 `rev`，没有给出指向已有 widget 的参数。建议增加 `replaces: <widgetId>`：Host 校验该 widget 属于同一 Bot、未被 clear 折叠，然后写入新 rev（§5 O5）。
- **待定**：逐组件的 props/snapshot 类型、golden fixtures、mock 开放问题的逐条裁定（接受、修改或否决，各附理由）。三者以 `_ops/widget-mock/artifact/` 的导出为准，本 ADR 不猜测。导出落盘后在本节补齐，补齐前本 ADR 不晋升。

### D8. 安全边界

- **秘密输入（I1）**：字段类型枚举挡不住一个标签写着「API key」的普通文本框，用户输入后，值会经 D4 的 K8 send 送给 Bot（`src/host/k8/conversation.ts:112-118`）。因此模型定义的 `form` 只允许预设选项字段：`select` 与 `toggle`，提交值只能是规格中列出的选项。自由输入字段（`text`、`number`、`date`）及其标签只能来自 Host 拥有的、非秘密的表单定义，模型只能按 id 引用；v1 不定义任何这类表单。凭据只经 Keys 流程输入。base 目录中 `form` 的描述相应改为「只含预设选项字段」。`ui/Input` 的 `masked` 变体只在 keys 页面使用（ADR-052 D2 方案 A），widget 目录从不传入。
- **链接**：规格中的链接只以结构化的 `{ label, url }` 出现。渲染前先用 `links.ts` 的共享判定 `parseAllowedExternalUrl`（`nsh-app/src/links.ts:10-22`，`https:` 加 `brand.externalOrigins` 白名单）检查：通过才构造 `LinkText` 控件，点击进入 `openAllowedExternalUrl`（`links.ts:28-38`）；被拒的 URL 显示为纯文本，不产生可聚焦或可点击的控件。`text` 组件的 markdown 固定传 `links: false`（`nsh:website/elements/text-view.md:650`），链接显示为文字，不构造链接控件。能力层只放行 https `openUrl`（`nsh-app/nsh.json:9-11`）。
- **脚本**：规格没有表达式、模板或代码成员，目录是按 `component` 分派的固定代码。
- **标记与图片**：`TextView` 默认解析 raw HTML 与图片（`nsh:website/elements/text-view.md:648`、`:651`），`data:` URI 不受能力管控（`nsh:crates/nsh-core/src/access.rs:2233-2238`）。因此规格没有图片成员，目录的 `text` 渲染固定传 `options={{ html: false, images: false, links: false }}`：HTML 显示为文本，图片显示为 alt 文本，链接显示为文字。Host 不解析 markdown，避免出现第二个 markdown 解析器。
- **样式**：规格只携带 `variant`、`size` 与布局提示，颜色、字体、尺寸字面值被 schema 拒绝。

### D9. 与 #2462 Electron cutover 的顺序

- widget 子 issue 不等 cutover。cutover 受 #2458、#2461 S6、三端 Mixed release CI 与 #2479 四个条件约束，在此之前不产出桌面发布产物（#2462 正文「Cutover PR」）。CI 的桌面 job 只为本 runner 打包并做冒烟检查，不上传任何产物（`.github/workflows/ci.yml:2416-2420`；Windows 另用一次性证书签名，`:2456-2469`），Electron 上的临时显示不会到达用户。
- **#2554 要改 Electron 一处**：Electron `Row` 对 `item.kind` 的 switch 没有 default（`src/renderer/conversation/transcript.tsx:38-55`），直接引用 Host 联合类型（`:2`），根 tsconfig 为 `strict` 但没有 `noImplicitReturns`（`tsconfig.json:9`）。新增 `widget` kind 能编译通过，但会什么都不渲染，属于 #2552 禁止的静默丢弃。#2554 增加一个 `case 'widget'`，渲染显式的不支持文本（语义同 NSH 的 `upgrade_required` 卡片），cutover 时随 `src/renderer/**` 一起删除。
- **#2557 不需要 Electron stub**，但要迁移一处调用：删除 `k8.answer` 会使 Electron `QuestionCard`（`transcript.tsx:19`）失效，#2557 在同一 PR 内把它改为 `k8.act`。Electron 不显示 widget 控件，不会发出 widget 动作。
- 合并顺序为 2553、2559、2554、2557、2555、2556（#2559 由 O1 拆出，阻塞 #2554）。若 cutover 先落地，上述两处 Electron 改动随之取消。

## 3. 对下游的约束

| 约束 | 保护的不变量 | 下游怎么在约束内做同一件事 |
|---|---|---|
| 图表只用 `nsh/base/plot` 的 mark 或 `Canvas` 绘制；目录中不出现 `Image`、`data:` 或 SVG 来源；每个 widget 都有 Data 表 | 模型输出到不了 resvg 与 HTML 解析器；三端原生绘制且不新增能力；数值不依赖 hover | 线、面、柱、虚线、坐标轴与标注用 Plot 的 mark 与 `strokeDasharray`；Plot 不覆盖的小图用 `Canvas` `draw`；图标取 `ui/Icon` 的固定集合 |
| 规格类型与校验器只在 `examples/desktop-bot-app/src/widgets/`；TSX 只 `import type`；规格不进入 `packages/*` | Host 边界只校验一次；QuickJS bundle 保持轻量（ADR-052 D3）；公开包 API surface 与发布图不变（ADR-052 §4） | 渲染器按 `component` 分派，遇到未实现的组件或更高的 `specVersion` 显示 `upgrade_required` 卡片；出现第二个独立发布的消费者时，以新 ADR 迁移归属 |
| 规格只携带语义：`variant`、`size`、布局提示、`{label, url}` 链接；模型定义的 `form` 只含 `select`、`toggle` 这类预设选项字段；没有颜色、字体、样式、图片、HTML、表达式、自由输入、掩码或秘密字段 | I1：模型生成的 widget 收集不到凭据；外链只经 `links.ts`；外观由 `ui` 层 token 决定（ADR-052 D6） | 需要强调就用 `variant`；需要用户选择就给预设选项；确需自由输入时，由 Host 拥有的非秘密表单定义提供，模型按 id 引用；凭据只走 Keys 流程；需要链接就给 `{label, url}`，渲染前用 `parseAllowedExternalUrl` 判定，被拒的显示为纯文本；`text` 用 markdown 子集，渲染时 `html`、`images`、`links` 均为 `false` |
| finance 数值只来自同一 task 中 Host 声明的 MCP 数据工具结果，经 snapshotRef 在规范观测上精确匹配；模型参数中的 finance props 不含数值；Host 不按 adapter 解码事件；尾部发生过清除时拒绝 | 每个数字都能追溯到一次数据工具输出；投影规则只有 adapter 一个权威；匹配不到或无法证明唯一时 fail closed，不猜测 | 数据工具返回与组件 snapshot schema 一致的 JSON（可配 `pointer`），整个事件小于 64 KiB；模型在 `render_widget` 中用同样的 `{server, tool, input}` 引用它；引擎缺规范投影时由 adapter 子 issue 补齐 |
| widget 条目的唯一权威是 Host 的 widget 记录；工具结果不另存表；UI 草稿只在 `store.ts`，按 widgetId 存放 | 单一事实来源；List 回收单元格时草稿不丢失 | 需要旧 snapshot 时读 widget 记录；需要表单状态时读 store 中按 widgetId 存放的草稿 |
| 每个组件在所有状态下总高度相同：提示行在每种状态都占位，`loading` 与 `ready` 的主体等高；锚点基数在第一个 rev 写入时确定 | 视口内的状态切换与 rev 替换不移动阅读位置（NSH List 只补偿视口上方的行）；没有 input 条目的 Turn 也有稳定位置 | 状态差异放在固定高度的提示行与主体内部，不改变卡片高度；验收在真 NSH List 中比较切换前后卡片与下一行的 Y 坐标 |
| 交互只经 `k8.act`，带 UI 生成并复用的 actionKey；`k8.answer` 删除并把 `bridgeVersion` 升到 3；同一 `(widgetId, action)` 只接受一次，由 Host 在同一事务中绑定；不可逆动作先在 UI 确认；审批仍走 `activity.*` | 一条交互路径，重试幂等；新旧 shell 与 Host 互相拒绝；审批保留独立的安全路径 | 回答 question 用 `k8.act`（`itemKey: q<id>`、`action: 'answer'`）；widget 动作用 `k8.act`（`itemKey: w<id>`），不可逆的先弹 `alertdialog`；Turn 进行中提交的动作排队成为下一个 Turn |
| `render_widget` 只经 task-scoped host toolset 声明，不写逐 adapter 代码，不为不支持 `mcpToolsets` 的引擎回退；每次调用与重试都用新断言，经 #2559 的单一验证入口核对冻结的 offer | 一种工具声明机制；每次调用都绑定到仍被授权的 task；cancel 或 End 之后不再接纳调用 | 新引擎声明 `mcpToolsets` 即可获得该工具；audience 固定为 `byok-desktop-widgets`；task 绑定经 [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559) 的 `host-mcp-task-context` 通道落地 |

## 4. 不在本 ADR 内

- Sankey。NSH `2964346` 的 `nsh/base/plot` 已有 `Sankey` mark（`nsh:website/elements/plot.md:861-880`），可用向量原语画出，满足 #2552 设定的前提；但 base 与 finance 两套目录都没有用到它的组件，v1 不纳入。将来增加只需在目录中新增组件并扩展 schema，不涉及新能力。
- #2462 的打包与 Electron cutover 本身。
- 新增 D2 能力。
- 对话回复 `MarkdownView` 的默认 `html`、`images` 选项。它早于本 ADR 存在（`nsh-app/src/ui/MarkdownView.tsx:24-39`），回复中可以出现 `data:` 图片，ADR-052 D2 已承接该解析面。是否同样关闭，由 NSH UI 层另行决定（调研 §7）。

## 5. Owner 问题与裁定

O1–O4 已由 Owner 于 2026-11-27 裁定（[决议记录](https://github.com/Ancienttwo/byok-sdk/issues/2553#issuecomment-7219557886)）。

- **O1（认证路径，已裁定：路径 A）**：`@byok-sdk/server` 增加显式开关，声明 `host-mcp-task-context`，并用 cloud 现有的验证器验证 task 断言；widget toolset 子进程经 loopback 向 Host 证明自己的 task。该切片是独立的 High 级子 issue [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559)，阻塞 #2554。
- **O2（已裁定：接受）**：snapshotRef 为 `{ server, tool, input, pointer? }`，取代 mock 的 `{ turnId, toolCallId }`。
- **O3（已裁定：接受）**：v1 只在发起调用的 task 内解析 snapshotRef。
- **O4（已裁定）**：下游 finance 数据工具将改为返回 snapshot 形状的 JSON，单个结果小于 64 KiB inline 上限；Host 只复制、不映射字段。
- **O5（待定）**：原位更新是否采用 `replaces: <widgetId>`（D7），需与 artifact 导出核对。
- **D7（待定）**：spec v1 的组件类型与开放问题，等 artifact 导出。
