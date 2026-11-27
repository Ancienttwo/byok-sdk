---
schemaVersion: archcontext.adr/v1
title: NSH 桌面对话的动态 widget：纯数据规格、Host 校验与解析、nsh/base/plot 渲染、k8.act 交互
status: proposed
decidedAt: 2026-11-27
appliesTo:
  - sdk-root
---

# ADR-053：对话动态 widget（Proposed）

> **来源与追踪**：总 issue [#2552](https://github.com/Ancienttwo/byok-sdk/issues/2552)，本 ADR 由调研子 issue [#2553](https://github.com/Ancienttwo/byok-sdk/issues/2553) 产出，约束后续子 issue [#2554](https://github.com/Ancienttwo/byok-sdk/issues/2554)（Host 工具、校验、解析、条目投影）、[#2555](https://github.com/Ancienttwo/byok-sdk/issues/2555)（base 目录渲染）、[#2556](https://github.com/Ancienttwo/byok-sdk/issues/2556)（finance 目录渲染）、[#2557](https://github.com/Ancienttwo/byok-sdk/issues/2557)（交互方法）。承接 [ADR-052](./ADR-052-desktop-native-ui-nsh-mixed.md)（NSH Mixed、D2 能力集、D3 Host/UI 边界、D6 UI 层规范）。
> **依据文档**：[NSH 对话 widget 调研](../researches/2026-11-27-nsh-chat-widgets.md)（下称「调研」），基线 `main@18b963e8a`，NSH pin `2964346`。
> **状态说明**：`proposed`。晋升 `accepted` 的前提：Owner 回答 §5 的 O1–O4，且 owner 的 artifact 导出落盘后补齐 D7 的 spec v1 组件类型与开放问题裁定。
> **#2552 已定、本 ADR 不再讨论的事项**：widget 是纯数据，由 `nsh-app/src/ui` 的固定目录渲染，不新增 D2 能力；只有一个保留工具 `render_widget`；finance 数值走 snapshotRef，不由模型传数；Host 在所属边界校验一次，非法规格 fail closed；未知组件或版本渲染显式的不支持卡片；条目 kind 为 `widget`，key `w<id>`，带 `rev`；草稿按 widgetId 存在 store；一个交互方法推广 `k8.answer`，带幂等 actionKey；不允许掩码或秘密输入；链接只经 `links.ts`；规格与渲染器无关。

## 1. 背景

#2552 要在 NSH 桌面对话里渲染两套目录（base 11 个组件、finance 11 个组件）的动态 widget。约束已定，未定的是七件事：NSH 用什么原语画图、widget 怎样进入 `k8.view` 的 List、规格与校验器归哪个包、bridge 契约怎么改、Host 怎样给每个引擎声明工具并解析 snapshotRef、spec v1 的具体类型、规格的安全边界。另有一件排序问题：#2462 的 cutover 会删除 Electron 应用，widget 子 issue 与它的先后关系需要写定。

## 2. 决定

### D1. 图表原语：`nsh/base/plot` 为主，`Canvas` 补位，Data 表兜底

- 图表组件用 `nsh/base/plot`：`Plot` 加 `Line`、`Area`、`Bar`、`Rule`、`Grid`、`PlotAxis`、`PlotLabel`。这些 mark 各是一块 canvas，行数据在 Rust 中缩放、绘制，不按点运行 JS（调研 §1，`nsh:crates/nsh-base/src/plot/mod.rs:1-27`）。虚线基准线用 `strokeDasharray`（`nsh:website/elements/plot.md:210-212`）。三端由各自 2D 引擎回放：macOS Core Graphics、Windows Direct2D、Linux Cairo，虚线与等宽数字在三端源码均有实现（调研 §1 表格）。绘制不需要任何 capability。
- `Plot` 不覆盖的小图（例如 `change_list` 每行的定尺寸 sparkline）用 `nsh` 的 `Canvas` `draw` 函数画，同样走三端原生回放。
- 每个 widget 的 Expand 面板都有 Data 标签页，是同一组数字的真表格；`failed` 状态在可行时退回该表格。数值不依赖 hover 或 tooltip。
- 否决方案：只用 View 盒子画柱、折线退回表格。NSH 已有原生向量层，这个降级没有必要。否决 `Image` 加 `data:image/svg+xml`：resvg 光栅化后放大会发虚，且会把模型可控的 SVG 解析带进持有 spawn 与 custody 权限的进程（见 D8）。
- 成本：nsh-app 目前不 import `nsh/base/plot`，`nsh package` 只在 bundle 引入时保留 `plot` runner feature（`nsh:crates/nsh-cli/src/native_features.rs:16-21`）。第一个图表组件会把该 feature 带进 release runner，#2555 须在 PR 中记录 release 包体积差。
- 涨跌色是 `nsh.json` `theme` 中的两个语义 token（`price-up`、`price-down`，light 与 dark 都给值），按 locale 选择方向（zh-CN 红涨，zh-HK 与 en 绿涨）并允许用户覆盖，映射写在 `nsh-app/src/ui`。规格只携带语义（正负、`variant`），不携带颜色。

### D2. 条目接入 transcript：`w<widgetId>` 加 Host 盖章的 `rev`，固定高度

- `ConversationItem` 联合（`src/host/conversation/view.ts:37-43`）新增 `kind: 'widget'`，key 为 `w<widgetId>`，与 `e`、`t`、`q` 前缀互不相交。`rev` 是 Host 盖章的整数，同一 widgetId 单调递增。新 rev 以新对象、同一 key 下发，List 原位替换；nsh-app 的 `Each` 按 `${key}:${kind}` 挂载（`nsh-app/src/features/conversation/Transcript.tsx:226`），rev 变化不换 key、不换 kind，行实例保留。
- 排序锚点为所属 Turn 的 input `seq + 0.375`：在该 Turn 的 question（`+0.25`）之后、状态行（`+0.5`）之前（`view.ts:117`、`:134`）。同一 Turn 的多个 widget 按 widgetId 顺序排列。
- NSH List 只对完全位于视口上方的行补偿高度变化，视口内的行变高会推动其下内容（`nsh:crates/nsh-core/src/core/list.rs:1558-1581`，测试 `:2283-2292`）。每个组件的每种状态使用固定的主体高度：`loading` 与 `ready` 等高，`partial`、`degraded`、`failed` 只多一行固定高度的提示。这样视口内的 rev 替换不移动阅读位置。
- `estimatedItemSize` 仍是整表一个值（NSH 没有逐项尺寸 prop，`nsh:crates/nsh-js/src/list.rs:721`），保持 64。估值偏差只影响测量前的滚动条与远距跳转。
- 草稿状态（表单值、选择、待确认的 actionKey）存于 `nsh-app/src/store.ts`，以 widgetId 为 key，Host 确认后清除，沿用 `pendingClears` 的做法（`store.ts:278-290`）。行内 signal 不保存草稿；现有 `QuestionRow` 的行内 signal（`Transcript.tsx:105-106`）在 #2557 迁到同一个 store 结构。
- Host 侧的 widget 记录是条目的唯一权威：Host store 中每个 widgetId 一行，保存当前 `rev`、组件、已校验的 props 与解析后的 snapshot。`k8.view` 从这里投影条目。

### D3. 规格归属：桌面应用 `examples/desktop-bot-app/src/widgets/`

- 规格类型、尺寸上限与校验器放在 `examples/desktop-bot-app/src/widgets/`，用 zod 编写。同一份 schema 产出 Host 校验器与工具对外公布的 JSON Schema（`z.toJSONSchema`）。桌面应用把 `zod` 列为直接依赖，版本跟随工作区现有的 `^4.6.6`（`packages/client/package.json:120`）。该依赖已经随 `@byok-sdk/client` 进入 Host bundle。
- 校验器只在 Host 运行。nsh-app 与 Electron renderer 只用 `import type` 引用类型，与 nsh-app 现在引用 Host 类型的方式一致（`nsh-app/src/store.ts:4-7`），QuickJS bundle 不含校验代码（ADR-052 D3）。
- 否决 `@byok-sdk/ui-runtime`：它是公开包，api-surface 预算是精确上限（`api-surface/entries.json:3011-3015`），每次规格变化都会成为 SDK 包的 semver 变化，而且 ADR-052 §4 把桌面 UI 材料留在 `packages/*` 之外。否决新建 `packages/widget-spec`：唯一的消费者是桌面应用。Electron renderer 在 #2462 cutover 时删除，gpui-kit renderer 只是 ADR-052 D1 的回退选项，达不到「第二个独立发布的消费者」这一建包条件。
- 规格不引用任何 NSH 类型、class 或 Plot prop，保证与渲染器无关。

### D4. Bridge 契约：`k8.act` 取代 `k8.answer`，两个版本号都不变

- `widget` 条目 kind 是 `view.ts` 的类型变化。`bridge-contract.json` 只列方法名，因此这一项没有 JSON diff（调研 §4）。
- 新增一个方法，同时删除 `k8.answer`，两者不并存：

  ```ts
  'k8.act': {
    params: { botId: string; itemKey: string; action: string; actionKey: string; values: Json };
    result: { turnId: string } | null;
  };
  ```

  - `itemKey` 为 `q<questionId>` 时，`action` 只能是 `answer`，`values` 为 `{ answer: string }`，Host 转给 K8 的 `bot.answer`（现路径 `src/host/conversation/service.ts:137-142`）。
  - `itemKey` 为 `w<widgetId>` 时，`action` 必须是该 widget 规格中声明的 actionId，`values` 由 Host 按该 widget 的规格校验一次（表单字段、选项）。通过后，Host 以 `actionKey` 作为 actionId 提交一次 K8 send，消息正文是该动作的确定性投影。返回 `{ turnId }`。
- actionKey 由 UI 生成，按 widgetId 存在 store，重试时复用，Host 确认后清除。去重沿用现有权威，Host 不另建去重表：
  - question 由 K8 按 questionId 去重（`packages/bot-collaboration/src/rules/commands.ts:297-311`）；
  - widget 动作由 K8 send 的 actionId 去重（`src/bridge/domains/k8.ts:16`）。
  - 同一 `(widgetId, action)` 只接受一次。同一 actionKey 重放得到相同结果；不同 actionKey 被拒，与 question 的 `Answer identity conflict` 语义一致。
- 错误码沿用现有 `BridgeErrorCode`（`src/bridge/protocol.ts:168-169`）：形状、未知条目或非法 values 为 `invalid_params`，K8 拒绝（冲突、问题不存在）为 `method_failed`。不新增错误码。
- 不可逆动作（`confirm_action` 以及规格标为不可逆的动作）由 UI 先弹 `role=alertdialog` 确认，再调用 `k8.act`。审批继续走 `activity.approve` / `activity.reject`，不经 `k8.act`。
- JSON 变化：`rendererMethods` 与 `hostMethods` 各把 `k8.answer` 换成 `k8.act`。`schemaVersion` 保持 2：它标记文件结构，此前因新增 `shellToHostMethods` 键从 1 升到 2，同一提交新增方法时未动 `bridgeVersion`（`git show a85fde7bc`）。`bridgeVersion`（`BRIDGE_VERSION = 2`，`src/bridge/protocol.ts:22`）也保持：契约在编译期嵌入 shell（`native/byok-shell/src/contract.rs:9`），Host 与 shell 同包发布，没有版本协商（ADR-052 S2）。

### D5. Host 解析：一个 host toolset 覆盖所有引擎，snapshotRef 在同一 task 的活动尾部解析

- **声明**：`render_widget` 是桌面 Host 配置的一个 task-scoped host MCP toolset（`docs/spec.md:2715-2734`）。Host 在 `DaemonConfig.mcpToolsets` 中登记它，stdio server 是 Host 二进制的一个 argv 模式。K8 每个 Bot 的执行模板在 `requiredToolsets` 中带上它的 id，并经 `readOnlyToolsets` 声明为只读（`packages/bot-collaboration/src/host.ts:63-64`）：该工具只写 Host 自己的 transcript，不触达外部系统。
  - 现有全部 adapter 都声明 `mcpToolsets: true`（claude、codex、pi、antigravity、opencode、dsh、grok），所以不需要逐引擎代码。不支持 `mcpToolsets` 的引擎在准入时被拒，没有无工具的回退（`docs/spec.md:2733-2734`）。
- **把调用绑定到 task**：校验结果要同步返回模型，解析 snapshotRef 要知道调用属于哪个 task，两者都要求子进程证明自己的 task。SDK 为此提供 task-context 通道：daemon 追加 context file，子进程用 `requestTaskAssertion` 换取断言，Host 验证（`docs/spec.md:2575-2618`）。嵌入式 `@byok-sdk/server` 的能力声明从不包含 `host-mcp-task-context`（`packages/server/src/index.ts:455`，`packages/cloud/src/capabilities.ts:191-196`），所以当前桌面 Host 拿不到 nonce。
  - 推荐**路径 A**：`@byok-sdk/server` 增加显式开关，声明 `host-mcp-task-context` 并用 cloud 已有的组合验证断言（`packages/cloud/src/auth/device-assertion.ts:95`）。桌面 Host 的 toolset 子进程经 loopback 把参数与断言交给 Host，Host 校验、解析并作答。
  - 备选**路径 B**：在 `packages/client` 增加第五个 SDK 保留 helper，照 `submit_result` 的方式经 daemon control socket 转发（`packages/client/src/bin/agent-result-mcp-server.ts:39-67`）。它不需要该能力，但会把桌面产品工具放进 SDK 保留协议，并在已有的 host toolset 机制旁边形成第二种声明方式。
  - 两条路径都动公开包。路径 A 触及断言验证这一认证路径，由 Owner 裁定（§5 O1），本 ADR 不代为决定。#2554 的范围须相应加入一个公开包切片，或拆出独立子 issue。
- **snapshotRef 形状**：mock 的 `{ turnId, toolCallId }` 不可行。模型看不到 K8 turnId；`toolCallId` 在事件中是可选字段（`packages/protocol/src/agent-event.ts:86`、`:97`），grok adapter 不设置它；也没有任何引擎承诺把调用 id 作为可复制的内容给模型。v1 采用模型能写出的内容（Owner 确认，§5 O2）：

  ```ts
  snapshotRef: { server: string; tool: string; input: Record<string, unknown>; pointer?: string }
  ```

- **解析规则**（只在发起调用的同一 task 内）：
  1. 在该 task 的 `tool_use` 事件中找 `mcp` 等于 `{server, tool}` 且 `input` 深相等的那一条。必须恰好一条：零条报 `snapshot_ref_unresolved`，多条报 `snapshot_ref_ambiguous`。
  2. 按 `toolCallId` 配对 `tool_result`。缺 id、`isError` 或输出被 spill 成预览（`packages/client/src/daemon/event-spill.ts:238`）报 `snapshot_ref_unavailable`。
  3. 输出解析为 JSON，取 `pointer`（RFC 6901，缺省为根）处的值，按组件的 snapshot schema 校验，失败报 `snapshot_invalid`。Host 只复制、不做字段映射（§5 O4）。
  - 只有 host toolset（MCP）结果可作来源，数值只来自 Host 声明的数据工具，不来自 shell 等原生工具。
- **记录位置**：工具结果的唯一来源是 SDK 已保存的 task 活动尾部 `server.tasks.activity(taskId)`（`packages/server/src/index.ts:263-269`），Host 的 activity 卡片已在读取它（`src/host/activity/domain.ts:64`）。上限为 1000 条、4 MiB，task 结束后保留 10 分钟（`packages/cloud/src/activity.ts:8-10`）。`render_widget` 与数据工具在同一 Turn 内调用，解析时结果仍在。Host 不新建工具结果表，只把校验后的 snapshot 复制进 D2 的 widget 记录：活动尾部会过期，widget 要比它活得久。跨 Turn 引用不在 v1（§5 O3）。
- **更新**：模型在参数中给出 `replaces: <widgetId>` 时，Host 校验该 widget 属于同一 Bot、未被 clear 折叠，然后写入新 rev。该字段待与 artifact 导出核对（D7）。

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

校验失败以工具结果返回，`isError: true`，正文为 `{ error, issues?, truncated? }`。`issues` 每项为 `{ path, message }`，`path` 是 JSON Pointer，最多 20 项，超出时 `truncated: true`。格式与 `submit_result` 一致（`agent-result-mcp-server.ts:60-66`）。断言无效、传输故障是 JSON-RPC 错误，不是工具结果。

| `error` | 含义 |
|---|---|
| `widget_invalid` | 结构、类型、枚举或计数上限不符；snapshotRef 缺失（finance）或多余（base） |
| `widget_too_large` | 超出任一字节上限 |
| `widget_unknown_component` | 组件不在 Host 目录中 |
| `widget_turn_limit` | 本 Turn 已有 8 个 widget，或该 widget 已到 100 个 rev |
| `widget_not_found` | `replaces` 指向不存在、属于其他 Bot 或已被折叠的 widget |
| `widget_task_inactive` | 断言有效，但该 task 的 Turn 已结束或已取消 |
| `snapshot_ref_unresolved` / `snapshot_ref_ambiguous` / `snapshot_ref_unavailable` / `snapshot_invalid` | 见 D5 解析规则 |

模型传入的未知组件由 Host 拒绝并返回错误，模型可以改正。UI 侧的 `upgrade_required` 卡片处理另一种情况：Host 目录认识、当前渲染器还没实现的组件。按合并顺序，#2554 先让 Host 接受两套目录，#2555/#2556 之前 finance 组件就会以这张卡片显示。

### D7. Spec v1（待 artifact 导出）

- 已确定且只取 `handoff.md` 原文的部分：模型参数 `{ component, props, snapshotRef? }`（snapshotRef 形状按 D5 修改）；Host 条目 `{ kind: "widget", id: "w<id>", rev, component, props, snapshot, state, notice?, source?: { label, asOf } }`；状态 `loading | ready | partial | empty | unavailable | degraded | failed | upgrade_required`；规格带 `specVersion: 1`；两套目录的组件名见 #2552；共享卡片外壳（header、meta、body、notice、audit footer，以及 Chart/Data 标签页的 Expand 面板）。
- **待定**：逐组件的 props/snapshot 类型、golden fixtures、mock 开放问题的逐条裁定（接受、修改或否决，各附理由）。三者以 `_ops/widget-mock/artifact/` 的导出为准，本 ADR 不猜测。导出落盘后在本节补齐，补齐前本 ADR 不晋升。

### D8. 安全边界

- **秘密输入**：表单字段类型枚举为 `text | number | select | toggle | date`，schema 没有 `masked`、`password`、`secret` 成员，校验器拒绝未知成员。`ui/Input` 的 `masked` 变体只在 keys 页面使用（ADR-052 D2 方案 A），widget 目录从不传入。
- **链接**：规格中的链接只以 `{ label, url }` 出现，由 `LinkText` 或 `links="report"` 的 `MarkdownView` 渲染，点击只进入 `openAllowedExternalUrl`（`nsh-app/src/links.ts:10-38`，`https:` 加 `brand.externalOrigins` 白名单），能力层只放行 https `openUrl`（`nsh-app/nsh.json:9-11`）。
- **脚本**：规格没有表达式、模板或代码成员，目录是按 `component` 分派的固定代码。
- **标记与图片**：`TextView` 默认解析 raw HTML 与图片（`nsh:website/elements/text-view.md:648`、`:651`），`data:` URI 不受能力管控（`nsh:crates/nsh-core/src/access.rs:2233-2238`）。因此规格没有图片成员，目录的 `text` 渲染固定传 `options={{ html: false, images: false }}`：HTML 显示为文本，图片显示为 alt 文本。Host 不解析 markdown，避免出现第二个 markdown 解析器。
- **样式**：规格只携带 `variant`、`size` 与布局提示，颜色、字体、尺寸字面值被 schema 拒绝。

### D9. 与 #2462 Electron cutover 的顺序

- widget 子 issue 不等 cutover。cutover 受 #2458、#2461 S6、三端 Mixed release CI 与 #2479 四个条件约束，在此之前不产出桌面发布产物（#2462 正文「Cutover PR」），Electron 上的临时显示不会到达用户。
- **#2554 要改 Electron 一处**：Electron `Row` 对 `item.kind` 的 switch 没有 default（`src/renderer/conversation/transcript.tsx:38-55`），直接引用 Host 联合类型（`:2`），根 tsconfig 为 `strict` 但没有 `noImplicitReturns`（`tsconfig.json:9`）。新增 `widget` kind 能编译通过，但会什么都不渲染，属于 #2552 禁止的静默丢弃。#2554 增加一个 `case 'widget'`，渲染显式的不支持文本（语义同 NSH 的 `upgrade_required` 卡片），cutover 时随 `src/renderer/**` 一起删除。
- **#2557 不需要 Electron stub**，但要迁移一处调用：删除 `k8.answer` 会使 Electron `QuestionCard`（`transcript.tsx:19`）失效，#2557 在同一 PR 内把它改为 `k8.act`。Electron 不显示 widget 控件，不会发出 widget 动作。
- 合并顺序维持 2553、2554、2557、2555、2556。若 cutover 先落地，上述两处 Electron 改动随之取消。

## 3. 对下游的约束

| 约束 | 保护的不变量 | 下游怎么在约束内做同一件事 |
|---|---|---|
| 图表只用 `nsh/base/plot` 的 mark 或 `Canvas` 绘制；目录中不出现 `Image`、`data:` 或 SVG 来源；每个 widget 都有 Data 表 | 模型输出到不了 resvg 与 HTML 解析器；三端原生绘制且不新增能力；数值不依赖 hover | 线、面、柱、虚线、坐标轴与标注用 Plot 的 mark 与 `strokeDasharray`；Plot 不覆盖的小图用 `Canvas` `draw`；图标取 `ui/Icon` 的固定集合 |
| 规格类型与校验器只在 `examples/desktop-bot-app/src/widgets/`；TSX 只 `import type`；规格不进入 `packages/*` | Host 边界只校验一次；QuickJS bundle 保持轻量（ADR-052 D3）；公开包 API surface 与发布图不变（ADR-052 §4） | 渲染器按 `component` 分派，遇到未实现的组件或更高的 `specVersion` 显示 `upgrade_required` 卡片；出现第二个独立发布的消费者时，以新 ADR 迁移归属 |
| 规格只携带语义：`variant`、`size`、布局提示、`{label, url}` 链接；没有颜色、字体、样式、图片、HTML、表达式、掩码或秘密字段 | I1 无秘密输入；外链只经 `links.ts`；外观由 `ui` 层 token 决定（ADR-052 D6） | 需要强调就用 `variant`；需要链接就给 `{label, url}`，由 `openAllowedExternalUrl` 放行；`text` 用 markdown 子集，渲染时 `html`、`images` 均为 `false` |
| finance 数值只来自同一 task 中 Host 声明的 MCP 数据工具结果，经 snapshotRef 精确匹配；模型参数中的 finance props 不含数值 | 每个数字都能追溯到一次数据工具输出；匹配不到时 fail closed，不猜测 | 数据工具返回与组件 snapshot schema 一致的 JSON（可配 `pointer`），模型在 `render_widget` 中用同样的 `{server, tool, input}` 引用它 |
| widget 条目的唯一权威是 Host 的 widget 记录；工具结果不另存表；UI 草稿只在 `store.ts`，按 widgetId 存放 | 单一事实来源；List 回收单元格时草稿不丢失 | 需要旧 snapshot 时读 widget 记录；需要表单状态时读 store 中按 widgetId 存放的草稿 |
| 每个组件每种状态的主体高度固定，`loading` 与 `ready` 等高 | 视口内的 rev 替换不移动阅读位置（NSH List 只补偿视口上方的行） | 状态差异放在固定高度的提示行与主体内部，不改变卡片高度 |
| 交互只经 `k8.act`，带 UI 生成并复用的 actionKey；`k8.answer` 删除；不可逆动作先在 UI 确认；审批仍走 `activity.*` | 一条交互路径，重试幂等；审批保留独立的安全路径 | 回答 question 用 `k8.act`（`itemKey: q<id>`、`action: 'answer'`）；widget 动作用 `k8.act`（`itemKey: w<id>`），不可逆的先弹 `alertdialog` |
| `render_widget` 只经 task-scoped host toolset 声明，不写逐 adapter 代码，不为不支持 `mcpToolsets` 的引擎回退 | 一种工具声明机制；每次调用都绑定到可验证的 task | 新引擎声明 `mcpToolsets` 即可获得该工具；task 绑定按 §5 O1 的 Owner 裁定落地 |

## 4. 不在本 ADR 内

- Sankey。NSH `2964346` 的 `nsh/base/plot` 已有 `Sankey` mark（`nsh:website/elements/plot.md:861-880`），可用向量原语画出，满足 #2552 设定的前提；但 base 与 finance 两套目录都没有用到它的组件，v1 不纳入。将来增加只需在目录中新增组件并扩展 schema，不涉及新能力。
- #2462 的打包与 Electron cutover 本身。
- 新增 D2 能力。
- 对话回复 `MarkdownView` 的默认 `html`、`images` 选项。它早于本 ADR 存在（`nsh-app/src/ui/MarkdownView.tsx:24-39`），回复中可以出现 `data:` 图片，ADR-052 D2 已承接该解析面。是否同样关闭，由 NSH UI 层另行决定（调研 §7）。

## 5. 待 Owner 决定的问题

- **O1（认证路径）**：嵌入式 `@byok-sdk/server` 是否增加 `host-mcp-task-context` 声明与 task 断言验证（路径 A，推荐），还是在 `packages/client` 新增 SDK 保留的 widget helper（路径 B）。裁定前，#2554 无法把解析错误同步返回模型。
- **O2**：用 `{ server, tool, input, pointer? }` 取代 mock 的 `{ turnId, toolCallId }`。
- **O3**：v1 只在发起调用的 task 内解析。跨 Turn 引用需要 Host 另存一份工具结果，会形成第二个记录。
- **O4**：数据工具的输出约定。Host 只复制、不映射字段，下游 finance 数据工具须返回 snapshot 形状的 JSON，需确认它们当前的输出。
- **D7**：spec v1 的组件类型与开放问题，等 artifact 导出。
