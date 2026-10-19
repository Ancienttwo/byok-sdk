# PRD：SDK Bot 模式产品方案

> 版本：v2，2026-10-18。v1 同日。v2 并入 Aimpact 同日的决定（§12）和 review 清单 A1–A11、B1–B11。
> 状态：草案。只写文档，不授权实现、发布、issue 修改或下游迁移。
> 依据：byok-sdk `origin/main@becc9f57`（0.27.0，2026-10-18）。上游 OAR `c264f17`（0.67.0）。Aiphabee 基线沿用平台 PRD 的 `main@31b7280e`，M0 刷新。
> 权威关系：[docs/spec.md](../spec.md) 是产品权威。[ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md) D1 定义 Bot 模式的执行语义。[ADR-038](../architecture/adr-2026-10-13-bot-platform.md) 和 [Bot 平台 PRD](../researches/2026-10-13_bot-platform-prd.md)（下文称"平台 PRD"）定义 routine、Bot 协作和 K1–K9。本文不重写它们的契约，只引用，并在 §5.2 和 §5.5 记录对平台 PRD 的两处修订。记忆 apply 边的依据：[docs/protocol.md §2.4](../protocol.md#24-task-free-agent-memory-intent-notice)、spec「Durable Agent homes」倒数第二段、[v0.24.0 release notes](../releases/v0.24.0.md)、device memory CAS 契约（git 历史 `e46df7630^` 下的 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md`，#390 后不再跟踪）。
> 背景事实：仓库里没有 Muse 的任何引用。OAR 在 SDK 里只是 Codex 的私有 fork（55 个源文件，`packages/client/vendor/oar/c264f17/PROVENANCE.md`），不是通用 harness 层。Claude 和 Pi adapter 是 SDK 自己写的。

## 0. 结论

Bot 模式是一种执行方式，不是一种 runtime。一个 Bot 是一个持久的 Agent：`AgentRef` 加它的 home。每次唤醒都是一次新的 fresh 执行（ADR-036 D1）。它说的话走 `messageEgress`，它要 Host 做的事走 `submit_result`。Bot 之间的协作由 Host 编排多次 fresh 执行（ADR-038 决策 8）。

SDK 侧的执行原语和记忆原语都已落地。K2 wake 队列、K5 `executions.submit`、K6 typed busy code、K7 `submit_result`、#500 回复草稿、`memory_recall`/`memory_save`、`agent.memory.projection`、`agent.memory.intent` 都在 0.27.0 里。没有落地的是四块：K4 Host 执行核心参考实现、K8 Bot 协作参考实现（含一个小的 SDK 片段切片）、记忆页的 Host 半、以及记忆写入和 intent 在 macOS 和 Windows 上的平台证明。前两块主要是 `examples/` 里的 copy-and-own 代码。后两块里，平台证明是 SDK 切片，记忆页是 Host 参考实现。

| 判断 | 状态 |
|---|---|
| 方向成立 | 是。符合 ADR-036 D1、D3 和 ADR-038 决策 7–13。 |
| 可以开始实现 | M0 之后 K4 可以。它依赖的 K2、K5、K6、K7 都已合并。平台证明切片可以和 K4 并行。K8 在 K4 之后。 |
| 可以上线 | 否。平台证明没做，Bot 协作没有参考实现，`submit_result` 的成功率没按 runtime 测量，Aiphabee 的 A1–A4 没有接入。 |

## 1. 背景与问题

Aimpact 问：SDK 除了接 agent 模式的 harness，是否支持 Bot 模式接入，例如 Grok Bot、Muse 和 Hermes。这个问题有两种读法：

1. 把 Grok、Hermes 当 runtime，由 SDK 驱动它们。SDK 不支持。adapter 只有 `PiAdapter`、`ClaudeAdapter`、`CodexAdapter`（`packages/client/src/adapters/index.ts`）。上游 OAR 有 `grok` runtime，SDK 没有带进来，也决定不带（§7）。
2. 在 SDK 上做 Grok Bot、Hermes 那种 Bot 产品。SDK 支持大部分。这是本文的范围。

仓库里这三个名字的含义：

| 名字 | 在仓库里的含义 | 依据 |
|---|---|---|
| Grok Bot | 持续多 Agent 对话的目标体验参考。只描述体验，第三方的存储、生命周期和 exactly-once 行为没有验证过。 | [README「Conversation-turn mode」](../../README.md#conversation-turn-mode-current-status-and-authoritative-path) |
| Hermes | "Hermes Bot Mode"：记忆、身份和工具边界这条线的设计参考。WP1-I（prepared 记忆模式）在 0.23.0 落地（#236）。WP2-I 的 SDK 半（设备 CAS intent）在 0.24.0 落地（#240、#241）。 | `docs/releases/v0.23.0.md`、`docs/releases/v0.24.0.md`；git 历史 `32d1a43fc` 下的 `docs/researches/2026-09-28-hermes-host-lifecycle-design.md` |
| Muse | 无引用。 | 全仓库搜索 |

已落地与未落地：

| 能力 | 状态 | 依据 |
|---|---|---|
| Agent home、`MEMORY.md`/`notes/`、单 writer、memory reader | 已落地 | spec「Durable Agent homes」；#317 |
| `memory_recall`/`memory_save`，sha256 CAS，prepared lane 的 `agentMemory: none/read/read-write`（v8） | 已落地 | #236；`docs/researches/2026-09-28-prepared-agent-memory-contract.md` |
| hosted 脱敏记忆快照 `agent.memory.projection` | 已落地，只读，不是 authoring 路径 | `packages/protocol/src/agent-memory-projection.ts` |
| Host 审批的记忆 intent `agent.memory.intent.available`：设备 CAS `replace`/`delete`，at-most-once ledger，completion/readback | 已落地（SDK 半） | #240、#241；`docs/protocol.md` §2.4 |
| 记忆写入权威的平台门：Linux 原生；macOS 需要外部 helper；Windows 不可用 | 限制 | `packages/client/src/daemon/agent-memory.ts` `isAgentMemorySecureFilesystemAvailable`；`agent-memory-fs-helper.ts` `helperPlatformSupported` |
| `agent-memory-intent.v1` 能力只在 native Linux 广播；macOS helper 和 Windows 不广播 | 限制 | spec「Durable Agent homes」；`agent-memory-intent.ts` `helperAgentMemoryIntentBackend` |
| 设备端 wake 队列（K2） | 已落地 | #452 |
| `MailboxWake` 取代 250 ms 轮询 | 已落地 | #455 |
| `executions.submit`（K5） | 已落地 | #474 |
| home busy 的 typed `code`（K6） | 已落地 | #473、#498 |
| `submit_result` 结构化 outcome，wire v3（K7） | 已落地 | #488 |
| 回复草稿流式显示 `tasks.messageDraft` | 已落地 | #505、#506 |
| K4 Host 执行核心参考实现 | 未做 | `examples/` 下没有 |
| K8 Bot 协作参考实现和 outcome 动作片段 | 未做 | 同上 |
| 记忆页的 Host 半：transport、落账、baseRevision 获取 | 未做 | CAS 契约 P1 表「memory proposal / approval：不存在」 |
| Host ContextPack → Summary → fresh 回复的集成验收（Salesko） | SDK 侧已齐，Host 侧未做，Salesko 暂不做 | [#195] 2026-10-17 评论 |

## 2. 目标用户与场景

### 2.1 用户

- 最终用户：在聊天界面里和几个有名字、有人格、有记忆的 Bot 交流。Bot 记得用户说过的事。用户能看到并修改 Bot 的记忆。Bot 会主动按计划汇报，也能自己定计划。Bot 之间能分工。有后果的动作先起草，用户确认后才执行。用户能看到每一步的结果，也能看到失败和不确定。大部分用户用 Windows。
- Host 开发者：Aiphabee 是首个下游（§12 Q1）。它已经是 Topology L：`apps/local-agent/src/research-pass-host.ts` 在同一个进程里跑 embedded server（SQLite）和 daemon，bot 聊天跑在 Pi BYOK 上（平台 PRD §6；#512）。Salesko 暂不做。
- 平台运营者：成本只随存储增长。不计量执行（ADR-038 决策 1、2）。

### 2.2 场景

| # | 场景 | 用到的 SDK 原语 | 现状 |
|---|---|---|---|
| S1 | 用户和一个 Bot 连续对话，回复边写边显示 | fresh 执行、`messageEgress`、`tasks.messageDraft`、ContextPack | SDK 齐；Host 执行核心未做（K4） |
| S2 | Bot 记住用户的事：常驻档案每次都在，详细笔记按需读 | `memory_save`、`memory_recall`、`agent.memory.projection` 进 ContextPack | SDK 齐；两层组合未做；macOS/Windows 受平台门限制 |
| S3 | 用户在记忆页看、改、删、forget Bot 的记忆 | `agent.memory.projection`、`agent.memory.intent` | SDK 半齐；Host 半未做；只在 Linux 广播 |
| S4 | Bot 每个交易日 09:00 主动汇报；routine 可以由 Host 定义，也可以由 Bot 自己建 | K2 wake 队列、`executions.submit`、outcome 的 routine 动作 | SDK 时钟齐；routine 动作片段和 Host 执行核心未做 |
| S5 | Bot A 把任务委派给 Bot B，B 的结论回到 A 的对话 | `submit_result`（`delegate`）、K4 队列 | K8 未做 |
| S6 | 群里多个 Bot 按点名发言，未被点名不发言 | `submit_result`（`post`/`pass`/`room_call`） | K8 未做 |
| S7 | Main Bot 按一句话建 Bot、建群、写团队笔记 | `submit_result`（`create_bot` 等）、`enqueueAgentHomeProjection` | K8 未做 |
| S8 | Bot 起草一封邮件；用户确认后 Host 发出；结果回到对话 | `submit_result`（`confirmable_action`）、Host 连接器 | K8 未做 |
| S9 | 长任务：Bot 先回一句"收到，正在做"，之后再给最终结果；中间进度看得到但不是消息 | `messageEgress`、`delegate` 给自己、draft lane、typed activity | K8 未做 |
| S10 | 外部事件唤醒 Bot：邮件、Slack、webhook | Host 执行核心的第四种触发来源 | v1 非目标 |

### 2.3 成功标准

产品层：

1. S1–S9 在 Aiphabee 固定 revision 上用真实 Pi 跑通一次，macOS 和 Windows 各一台设备。
2. S4–S8 在 SDK 仓库的合成端到端（§5.8）里跑通，不依赖任何下游。
3. 用户 key 不离开设备。hosted API 不接受用户模型凭据（ADR-036 D3）。
4. 每个 Bot 执行的回复和动作都能回溯到一个 `taskId`。不从模型正文推导语义。
5. 记忆只有一个写入者：设备上的 Agent home。Bot 的 `memory_save` 和用户在记忆页的改动都经过设备 CAS。
6. 有后果的动作没有一次是 Bot 直接执行的。

工程层沿用平台 PRD §3 的 1–12 条。

## 3. Bot 语义

本节引用已定的决策，并补 v2 新增的规则。

- **身份**：一个 Bot 是一个 `AgentRef { agentId, profileRevision }` 加 `<hostStorageRoot>/agents/<agentId>` 下的 home。persona 文件由 Host 经 `enqueueAgentHomeProjection` 落到设备。改资料推进 `profileRevision`，已提交的执行用旧的，下一次用新的（平台 PRD §9.1）。
- **执行**：每次唤醒都是一次新的 fresh 执行，从 home 和 ContextPack 重建 context，不复用 session（ADR-036 D1）。一个 home 同时只有一个 writer。第二个 writer 收到带 `code` 的 decline（K6）。
- **触发来源**：用户输入、routine、其他 Bot。三者进同一个 Host 执行核心，每个 Agent 一个 FIFO（ADR-038 决策 7）。第四种来源是外部事件（邮件、Slack、webhook）。它在 v1 是非目标，将来也进同一个执行核心，作为一个 intent 排队。
- **两条出口**：`messageEgress` 是 Bot 说的话。`submit_result` 是 Bot 要 Host 做的事，按 offer 里冻结的 JSON Schema 校验（K7）。缺 outcome 的成功执行以不可重试的失败结束。
- **一条入口**：Bot 要读的内容由 Host 放进 ContextPack：常驻档案、花名册、群记录、可用模型、团队笔记。Bot 不读其他 Agent 的记忆（ADR-038 决策 9）。
- **两层记忆**：常驻档案是 `MEMORY.md`，上限 8 KiB（§12 Q10），它的 hosted 投影每次执行都进 ContextPack。详细记忆是 `notes/**`，Bot 按需 `memory_recall`。Bot 用 `memory_save` 直接写两层，没有审批门（§12 Q2）。设备上的文件是真相，投影是脱敏的 latest-value；Bot 要精确内容就 recall。prepared Pi 收不到 cwd 文件，所以常驻层只能从 ContextPack 进（spec「Official Pi migration security and installation contract」）。
- **记忆页**：用户在 Host 的记忆页看投影，改、删、forget 走 `agent.memory.intent`。Host 是唯一 approval authority，这里的 approval 就是用户在记忆页上的操作。
- **待确认动作**：发邮件、发消息、删除、付款这类有后果的动作，Bot 只能在 outcome 里起草 `confirmable_action`。用户确认后 Host 用自己的连接器执行。执行结果作为新 Turn 回到 Bot 的对话。
- **Bot 自管 routine**：Bot 在 outcome 里 `create_routine`/`update_routine`/`cancel_routine`。Host 落账、算时点、调 `wakes.schedule`。设备上没有任何调度工具。
- **长任务**：一个 task 只有一份不可变正文。长任务的第一次执行只回一句 ack，并在 outcome 里 `delegate` 给自己。续作执行的回复才是最终结果。进度只走 draft lane 和 typed activity，不是消息。
- **群聊**：未被点名不发言。席位只来自 UI 的 mention 或 outcome 的 `room_call`。

Bot 模式的不变量在平台 PRD §5 的 I1–I12。本文补七条：

- M1：Agent working memory 只有一个写入者，就是设备上的 canonical home。Bot 的 `memory_save` 和用户的记忆页改动都经过设备 CAS。Host 不持有第二份可写副本。
- M2：记忆页的改动只改 Host 账本，直到设备 CAS apply。intent 的 completion 是唯一的 apply 证据。
- M3：apply 绑定精确的 AgentRef、`profileRevision` 和 `baseRevision`。revision 不符就是 `conflict`，不合并，不 last-write-wins。
- A1：Bot 执行拿不到任何有外部副作用的工具。给 Bot 执行的 Host toolset 只读或只起草。有后果的动作只经 `confirmable_action` 和用户确认后的 Host 执行。
- R1：Bot 没有调度工具。`wakes.*` 是服务端 API，设备上没有它的工具面。周期规则只在 Host，SDK 只收时间点（平台 PRD I2）。
- L1：一个 task 最多一份接受的消息。进度不是消息。
- G1：群聊席位只来自结构化 mention 或 `room_call`。未被点名的成员不执行。

## 4. 权责

| 对象 | 权威 | 说明 |
|---|---|---|
| Bot 档案、花名册、Main Bot 标记、persona 文本 | Host 服务端 | 每个 Bot 对应一个 AgentRef |
| Conversation、Turn、输入来源、群、委派账本、待确认动作账本、routine 账本 | Host | 平台 PRD §9.1 加 v2 新增 |
| Host 执行核心：per-Agent FIFO、`taskId` 代际 | Host（K4 参考实现） | 不进 SDK API |
| Execution、offer、terminal、outcome 格式校验 | SDK | `executions.submit`、`tasks.deviceTerminal`、K7 |
| `bot-turn-outcome.v1` 的动作片段、routine 时点纯函数 | SDK（`@byok-sdk/protocol`、`@byok-sdk/core`） | §5.2 K8-S；Host 填 enum 并冻结最终 schema |
| 设备端时钟 | SDK `server.wakes`（Topology L） | Aiphabee 是 L。周期规则在 Host |
| Agent home、记忆内容、CAS、intent 的 at-most-once apply | SDK daemon（设备本地） | 单 writer |
| 记忆写入权威和 intent 屏障在三端的证明 | SDK | §5.3.3 |
| 记忆页的看/改/删/forget 语义、transport、落账 | Host | §5.3.2 |
| 待确认动作的确认 UI 和执行 | Host 连接器 | SDK 不执行 |
| 回复草稿 | SDK 显示通道 | 接受的消息才是产品真相 |
| 模型凭据 | 设备上的 keys launcher | 不进云端 |
| 外部事件的接收和去重 | Host（将来） | v1 非目标 |

## 5. 功能块

### 5.1 K4：Host 执行核心参考实现

范围按平台 PRD §9.2 的 9 条。交付物：

- `examples/host-execution-core`（§12 Q5），TypeScript，copy-and-own。
- 它只调用公开 API：`executions.submit`、`tasks.offer`、`tasks.deviceTerminal`、`tasks.cancel`、`wakes.schedule`/`cancel`/`pending`。
- 一个 routine 和一个 Bot 触发共用同一个 per-Agent FIFO。
- `taskId = H(intentKey, generation)`。提交前持久化完整输入。换代只在读到设备 terminal 后，并且 decline `code` 是 `agent_home_writer_busy`/`agent_home_reader_busy`，或失败且重试策略允许。
- 每个 intent 有等待上限，超过后取消未认领的 offer，结论 `expired`。
- 读到成功 terminal 后，在一个事务里按 `taskId` 应用 outcome，只应用一次。
- 恢复靠持久 outbox 扫描。
- 平台 PRD §12 的 Host 指南独立成英文文档，README 链接它。

验收：平台 PRD §13.1 K4 行。

### 5.2 K8：Bot 协作参考实现和 outcome 动作片段

范围按平台 PRD §9.3–§9.6，加 v2 新增的三类动作和一条默认规则。

**对平台 PRD 的修订一（K8-S，Aimpact 已接受）。** 平台 PRD §9.3 写"schema 由 Host 在提交时生成"，§13.1 写"K8 只改 `examples/` 和文档"。v2 改为：`@byok-sdk/protocol` 发布 `bot-turn-outcome.v1` 的动作片段（K7 受限 JSON Schema 子集，含 cron/tz 的 pattern）和 TS 类型；`@byok-sdk/core` 发布纯函数 `nextRoutineOccurrence(schedule, now)`，设备和服务端共用（平台 PRD §12.4 第 6 条已要求同一个纯函数）。Host 仍然组合最终 schema：按角色和执行类型选片段，填花名册、群、模型、routine id 的 `enum`，冻结进 offer。daemon 仍只按冻结 schema 校验格式（K7 不变）。K8-S 是一个小的 SDK 切片，改 protocol、core、spec 和 api-surface。

**outcome 契约 `bot-turn-outcome.v1`。** 总上限是 `RESULT_OUTCOME_MAX_BYTES = 65 536` 字节（`packages/protocol/src/result-schema.ts`）。每个动作的上限之和要留在这个数以内。

| 动作 | 字段 | 谁能用 | Host 的处理 |
|---|---|---|---|
| `delegate` | `to`（enum，含自己）、`request` ≤ 8 KiB | 所有 Bot | 新建委派，key `H(A.taskId, 动作序号)`。`to` 是自己时是续作（§5.6），用续作预算 |
| `ask_user` | `question`、`answerKind`、`options` | 所有 Bot | 建问题卡片。回答作为新一轮 `user` 输入 |
| `confirmable_action` | `action`（Host enum）、`summary` ≤ 300 字、`draft` ≤ 16 KiB | 所有 Bot | 建确认卡（§5.4） |
| `create_routine` | `localId`、`schedule { cron, tz }`、`prompt` ≤ 4 KiB、`target`（默认自己） | 所有 Bot；`target` 指向别人只有 Main Bot | 落 routine 账本，算下一个时点，`wakes.schedule`（§5.5） |
| `update_routine` | `routineId`（enum）、要改的字段 | routine 的 owner 或 Main Bot | 推进定义版本，当前 occurrence 完成后切换 |
| `cancel_routine` | `routineId` | 同上 | lifecycle 改 `completed`，`wakes.cancel` |
| `post` / `pass` / `room_call` | `text` ≤ 16 KiB / 无 / `members` | 群发言执行 | 写入群对话 / 本席位不发言 / 在预算内追加席位 |
| `create_bot` / `update_bot` / `delete_bot` | 见平台 PRD §9.3 | Main Bot | 建档案和 AgentRef，persona 落设备并确认后才派发 / 推进 `profileRevision` / 归档 |
| `create_room` / `update_room` | 名称、成员、admin、模式、公告 | Main Bot | 写群账本 |
| `team_note` | `text` ≤ 300 字 | Main Bot | 追加团队笔记 |

只有 Main Bot 的 schema 含管理类动作。只有群发言执行的 schema 含 `post`、`pass`、`room_call`。`actions` 可以为空。没交 outcome 的成功执行是 `task.fail`（K7）。

**Turn 来源**加一种：`action_result`，承载待确认动作的执行结果（§5.4）。原有五种是 `user`、`routine`、`bot_request`、`bot_reply`、`room_slot`。

**委派**：异步。A 交出委派后执行就结束。每个委派只有一个结论：`answered`、`failed`、`cancelled`、`refused`、`expired`、`abandoned`。不确定时不自动重派，用户可以关闭。回传 Turn 的 key 是 `H(delegationId)`。

**群聊（修订二，Aimpact 已定）**：默认模式是"未被点名不发言"。席位只来自 UI 的结构化 mention 或 outcome 的 `room_call`。平台 PRD §9.5 的 `admin` 模式降为可选。预算默认值不变。成员失败或没交 outcome 显示为失败，不算 PASS。

**Main Bot**：可以有多个。首次建团队时建一个默认 Main Bot。`delete_bot` 归档档案，SDK 不删 home。

交付物：`examples/bot-collaboration`（§12 Q5），建在 K4 之上。按 §12 Q6 拆两步：K8a 是委派、`ask_user`、`confirmable_action`、routine 三动作和长任务规则；K8b 是群聊和 Main Bot。K8-S 在 K8a 里。参考实现暴露的其他 SDK 缺口另开 issue。

验收：平台 PRD §14.2 全表（群聊行按 mention-only 默认改写），加 §9 的新行。

### 5.3 记忆

#### 5.3.1 两层记忆

| 层 | 文件 | 进入模型的方式 | 写入方式 |
|---|---|---|---|
| 常驻档案 | `MEMORY.md`，≤ 8 KiB | Host 把 `agent.memory.projection` 里的脱敏投影放进每次执行的 ContextPack | Bot `memory_save`；用户记忆页 `replace` |
| 详细记忆 | `notes/**` | Bot 按需 `memory_recall` | Bot `memory_save`；用户记忆页 `replace`/`delete` |

- Bot 执行在 prepared lane 上用 `agentMemory: read-write`。Aiphabee 用的是哪条 Pi lane 由 M0 查清；ordinary lane 上记忆工具走 live reserved helper `byokagentmemory`。
- `MEMORY.md` 超过 8 KiB 时，Host 不放进 ContextPack，而是显式阻塞并提示用户整理。不静默截断。
- 投影可能落后于设备。Bot 需要精确内容时 recall `MEMORY.md`。

#### 5.3.2 记忆页

看：`agent.memory.projection` 的脱敏快照。它不是 authoring 路径。

改、删、forget：Host 铸 `intentId`，释放 `agent.memory.intent`（`replace` 带全文和 `targetRevision`，`delete` 不带内容），设备在 task-free home lease 下做一次 CAS，回 `applied | conflict | rejected | uncertain`。规则：

- `MEMORY.md` 不可删（设备报 `memory_md_not_deletable`）。forget 对 `MEMORY.md` 是 `replace` 成编辑后的全文。
- forget 不删对话历史、Summary、审计和 Host 侧元数据（CAS 契约 §F）。
- `conflict` 带 `observed` revision。纠正是新的 intent，不自动 rebase。
- `uncertain` 是 terminal non-success。UI 只能说"目标内容当前存在/不存在（revision …）"。
- `baseRevision` 的获取是 M0 的核验项（§10 M0.2）：投影只带 `redactedHash`，明文 sha256 不过线；CAS 契约 §B 的做法是先用 `sha256("")` 探一次，拿 `conflict{observed}` 里的当前 revision 再提交。

Host 半的交付物放在 `examples/host-execution-core`：`DaemonConfig.agentMemoryIntents` 的 `fetch`/`complete` transport、intent 账本、baseRevision 探测、投影进 ContextPack。

#### 5.3.3 三端差距与证明切片

记忆写入权威有一个平台门（`agent-memory.ts` `isAgentMemorySecureFilesystemAvailable`）。intent 能力的广播另有两项证明（`agent-memory-intent.ts`：`conflictProvesNoRename`、`strictLedgerBarrier`）。现状：

| 端 | `memory_recall`/`memory_save` | `agent-memory-intent.v1` 广播 | 差距 |
|---|---|---|---|
| Linux | 可用。原生 `/proc/self/fd` 描述符后端。 | 广播。native backend 两项证明都为 true。 | 无 |
| macOS | 需要产品部署 Go helper（`packages/client/native/agent-memory-fs`），并配置 `agentMemoryFilesystem`。helper 的 race proof 已过。 | 不广播。helper backend 两项证明都声明 false：SDK 在仓库内和运行时都证明不了配置的二进制"先比对 revision 再 rename"和"replace 含严格目录 fsync"。conflict 会报 `uncertain`。 | 证明两项；定义 APFS 上"严格目录 fsync"的实现（`F_FULLFSYNC`） |
| Windows | 不可用。`helperPlatformSupported()` 只认 darwin，注释写"reparse/junction 矩阵还没在真 Windows 主机上跑"。Go 源码已有 `identity_windows.go` 和 `main_windows_test.go`。 | 不广播。 | 在真 Windows 主机跑 reparse/junction 矩阵；开放 win32 helper；定义 NTFS 上的屏障语义（spec：Windows 只能 flush 文件句柄，Node 没有目录 flush）；再做两项证明 |

Aimpact 已定：不接受 Linux-only。v1 把 macOS 和 Windows 的证明都列入分期（§10 P2）。CI 已有 `macos-latest` 和 `windows-latest` runner，证明矩阵可以在 CI 跑。

#### 5.3.4 不采用

- 记忆审批门。v1 不做（Q2）。Host 将来要加审批，走同一条 intent 路径，不需要新 wire。
- Host 持有第二份可写记忆。违反 M1。
- 用 Summary 代替记忆，或把 forget 说成删 Summary。
- 扩展 `agent.home.projection` 来写记忆文件。它是 ≤ 64 KiB 的不透明 JSON，交给 Host 的 consumer hook，不是按路径写文件的通道。

### 5.4 待确认动作

- Bot 在 outcome 里交 `confirmable_action { action, summary, draft }`。`action` 是 Host 定义的 enum，例如 `send_email`、`send_message`、`delete_record`、`pay`。`draft` 是该 action 的不透明草稿，≤ 16 KiB。
- Host 应用 outcome 时建确认卡，key `H(taskId, 动作序号)`。卡片有 `pending`、`confirmed`、`rejected`、`expired` 四态。
- 用户确认后 Host 用自己的连接器执行。SDK 不执行，也不知道 action 的语义。
- 执行结果（成功、失败、外部 id）作为新 Turn 回到 Bot 的对话，来源 `action_result`。Bot 的下一次执行能看到它。
- 不变量 A1：Bot 执行拿不到任何有外部副作用的工具。`examples/salesko-connector-broker` 那种执行型连接器不进 Bot 执行的 toolset。
- `ask_user` 保留，用于只要答案的场景。

### 5.5 Bot 自管 routine

- Bot 在 outcome 里 `create_routine { localId, schedule: { cron, tz }, prompt, target }`。`target` 默认是自己；Main Bot 可以指向团队 Bot（§12 Q12）。
- Host 应用时：落 routine 账本（定义版本 1，owner 是发起的 Bot），用 `nextRoutineOccurrence` 算下一个时点，`wakes.schedule({ dedupKey: "<routineId>:<version>:<t>", availableAt: t })`。之后按平台 PRD §6 Topology L 和 §12 跑。
- routine 执行的输入是 `prompt` 加 Host 的 ContextPack。结果回 owner 的对话，来源 `routine`。
- `update_routine` 推进定义版本，当前 occurrence 完成后切换（平台 PRD §12.3 第 6 条）。`cancel_routine` 把 lifecycle 改为 `completed` 并 `wakes.cancel`。
- 用户在 UI 看得到 Bot 建的 routine，可以暂停、改、删。
- 不变量 R1：设备上没有调度工具。cron 的解析和时点计算只在 Host，用 SDK 的纯函数。SDK 的 wake 队列只收时间点。
- 每个 Bot 的 routine 数量有上限（暂定 8），超过时 Host 拒绝并写进下一次的 ContextPack。

### 5.6 长任务规则

- Host 的 system prompt 写明：任务会超过一轮能完成的量时，先回一句 ack，并 `delegate` 给自己，`request` 写清要做什么。
- Host 把 `to` = 自己的委派标为续作，显示"正在处理"。续作有单独的预算：每条用户输入最多 4 次（§12 Q11），不占委派预算，hop 不增加。
- 续作执行的 `messageEgress` 是最终结果。中间进度只走 `tasks.messageDraft` 和 typed activity，不进对话。
- 续作失败、取消或没交 outcome 时，用户看到的是失败，不是沉默。

### 5.7 外部事件（v1 非目标）

邮件、Slack、webhook 唤醒 Bot。将来的形状：Host 接收并去重事件，作为一个 intent 排进目标 Bot 的 FIFO，输入来源加 `external_event`，内容进 ContextPack。SDK 不接收外部事件。本节只占位，v1 不做。

### 5.8 CI 级合成端到端

平台 PRD K4 已含"routine 冒烟测试"。v2 把它扩成一个不依赖任何下游的合成端到端（§12 Q13）：

- 一个进程里跑 embedded server（SQLite）、daemon 和 fake runtime。
- 覆盖：一轮聊天（`executions.submit` → `messageEgress` 接受）；一个 routine（`wakes.schedule` → 到期 → 执行 → 结果）；一次委派；一次 `confirmable_action` 确认；一次记忆页 `replace` 和 `delete`（Linux runner 上）；崩溃后重启不产生第二个执行。
- fake runtime 调用 `byokagentresult` 的 `submit_result` 交固定 outcome。真实 Pi 的 `memory_save` 和模型行为在 P6 用 Aiphabee 手动跑。
- 不单独建演示 Host 目录。

### 5.9 回复显示

S1 的"边写边显示"用 #500 的 draft lane。草稿只用于显示。接受的消息是唯一产品真相。群发言不用 `messageEgress`，所以群里的 Bot 发言没有草稿。这是 v1 接受的限制。

## 6. 与 #195 的关系

[#195] 是 Salesko 的 Host ContextPack → 同 home Summary → fresh 回复集成验收。它的 SDK 侧前提已齐（2026-10-17 评论）。Salesko 暂不做，所以 #195 不再是 Bot 模式的上线门槛，保持开放，作为 Salesko 自己的验收。

Bot 模式复用它定下的模式：ContextPack 在派发时冻结、同 home 的 strict fresh Summary 走 result-document 且无 `messageEgress`、消息处置和设备 terminal 分轴。Aiphabee 需要自己的等价链路，列在 §10 P6。群聊的共享对话也需要 ContextPack；v1 不为群对话做 Summary，群记录按条数和字节截断进 ContextPack，超出时显式阻塞。

## 7. OAR grok ACP：改判为做，Grok Bot 优先（2026-10-19）

Aimpact 于 2026-10-19 约 13:45 HKT 改判（§12 Q4）：「可以顺手接入 grok cli，但 grok bot 才是重点」。它推翻 2026-10-18 的「不做 grok ACP adapter」。

- 做 `GrokAdapter`（#514）。方案见 [#514 plan](2026-10-19-514-grok-adapter-plan.md)（PR #536）。
- 重点是 Grok Bot：Bot 模式里用 Grok 跑 Bot。Grok Build CLI 的适配是顺手，只作底层 runtime。能力矩阵、切片顺序和验收都以 Bot 场景优先。
- Pi + `xai` profile 保留给「只当模型」的用法。它不能代替 Bot 优先的 adapter 工作。
- 本裁定不批准 Hermes（#519），也不为其他 runtime 整体改写 Q8。

事实留档：

- 上游 OAR `c264f17` 的 `packages/oar/src/runtimes/grok/` 有 11 个文件，经 `shared/acp/`（19 个文件）驱动 Grok CLI。SDK 现在的 vendor 选择只有 Codex（PROVENANCE.md）。#514 plan 在同一个 fork、同一个 pin 上加 Grok 选择。
- Grok CLI 由 xAI 脚本安装，认证是 CLI 自己的（OAR 优先 `cached_token`），不走 keys launcher。
- Grok 作为模型的路：Pi 加 `xai` profile。两个阻塞 issue 开着：#512（Pi 投影只会发 `openai-completions`，xAI 已把它标为 legacy）、#513（`PiModelConfigSchema.compat` 表达不了 pi-ai 1.2.0 的字段）。
- Grok Bot 不依赖 Grok 读 Agent home 里的指令文件。persona 和常驻记忆由 Host 放进 ContextPack，和 prepared Pi 一样。
- Grok 默认带 shell、改文件和联网工具，还会读用户自己的规则、MCP 配置和原生记忆。Bot 执行要守 A1 和 M1，就要先证明能按 session 关掉这些（#514 plan §7.4，切片 S0）。证明不了，Grok Bot 不上线。

## 8. 非目标

- SDK 里的 Conversation、Room、委派、待确认动作或 routine 账本（ADR-038 决策 8）。
- SDK 里的 per-Agent 队列（平台 PRD §9.7）。
- 运行中往返 Host 的动作通道（K9，推迟）。
- 记忆审批门（Q2）。
- 外部事件唤醒（§5.7）。
- 把 Bot 搬到另一台设备。跨 Agent 读记忆。
- 群对话的 Summary。向量检索、后台总结器、通用 Host 记忆服务。
- SDK 执行有后果的动作。SDK 解析 cron。
- Claude、Codex 作为 Bot 执行的 runtime（Q8）。grok ACP adapter 已不是非目标（Q4，2026-10-19 改判，见 §7）。
- 单独的演示 Host 目录（Q13）。把 K4、K8 提升为包（两个下游采用后再评估）。
- Salesko 接入。执行计量和价格。
- 复制 DeepSeek Bot、DS Bot App、Grok Bot 或 Hermes 的代码。
- 云端 `cloud-do` 跑 BYOK Bot（ADR-038 决策 4）。移动端传输、配对和推送。

## 9. 验收标准

| 块 | 验收 | 证据级别 |
|---|---|---|
| M0 | 每个核验项有命令输出或源码引用；每个 falsifier 落到"可表达"或"修订稿" | 文档 |
| K4 | 平台 PRD §13.1 K4 行；§14.1 routine 矩阵在 Topology L 跑通 | SDK 仓库合成 Host |
| 合成端到端 | §5.8 的七项在 Linux CI 跑通 | fake runtime |
| K8-S | api-surface 新增片段和纯函数；片段通过 K7 受限子集校验；`nextRoutineOccurrence` 对 DST 跨越、月末、闰年有定向测试 | SDK 单测 |
| K8a | 平台 PRD §14.2 委派行；新增：`to` = 自己走续作预算、`confirmable_action` 四态、`create_routine` → wake → 执行 → 结果回 owner、`cancel_routine` 后无新 occurrence、普通 Bot 的 schema 不含 `target` 指向别人 | SDK 仓库合成 Host |
| K8a | `submit_result` 成功率在 Pi 上测量并记录 | 真实 runtime，付费调用另行授权 |
| K8b | 平台 PRD §14.2 群聊行，按 mention-only 默认改写；未被点名的成员没有执行 | SDK 仓库合成 Host |
| 平台证明 macOS | 配置 helper 后 `agent-memory-intent.v1` 广播；两项证明的定向测试在 `macos-latest` 通过；spec 的平台句子更新 | SDK 单测 + CI |
| 平台证明 Windows | reparse/junction 矩阵在 `windows-latest` 通过；`memory_recall`/`memory_save` 在 Windows 可用；intent 两项证明通过并广播；NTFS 屏障语义写进 spec | SDK 单测 + CI |
| 记忆页 | 改 → `applied` → 下一次执行 recall 到新内容；`conflict` 不合并；forget 不删对话和 Summary；`MEMORY.md` 删除被拒；8 KiB 上限阻塞 | SDK 集成测试，三端各跑 |
| Aiphabee | S1–S9 在固定 revision 上用真实 Pi 跑通，macOS 和 Windows 各一台；§14.1 routine 矩阵；空闲设备每 60 秒最多一次轻量调用 | native |
| 安全 | hosted 存储和请求日志里没有用户模型 key；Bot 执行的 toolset 里没有执行型连接器 | 平台 PRD §14.1 安全行 + A1 检查 |

## 10. 分期

依赖图：M0 → P1 ∥ P2 → P3 → P4；P5 在 M0 和 P2 之后；P6 在 P1、P3、P4、P5 之后；P7 最后。

### M0 契约核验切片

- 目标：在写任何产品代码前，把 v2 新增内容里"没有证据"的点全部落到证据或修订稿。
- 范围：
  - M0.1 记忆页 apply 边：在 Linux 容器里用现 main 跑通 `replace MEMORY.md`、`delete notes/x.md`、`MEMORY.md` 删除被拒、`conflict{observed}`、`uncertain` 路径。
  - M0.2 `baseRevision` 获取：验证 CAS 契约 §B 的 `sha256("")` 探测路径；裁定是否需要一个 Host 可见的明文 revision 字段。需要的话出 protocol/spec 修订稿，不实现。
  - M0.3 三端差距清单：macOS helper 两项证明各缺什么，`F_FULLFSYNC` 的位置；Windows 的 reparse/junction 矩阵内容、NTFS 屏障语义的定义、`identity_windows.go` 的现状。产出 P2 的切片边界。
  - M0.4 outcome 表达能力：K7 受限 JSON Schema 子集能否表达 `confirmable_action`、routine 三动作和 `to` 含自己；每个动作的上限之和 ≤ 65 536。
  - M0.5 routine 片段对齐：cron/tz 词汇、`nextRoutineOccurrence` 签名、`dedupKey` 派生、和 `wakes.schedule` 的字段对应；确认 I2 不破。
  - M0.6 Aiphabee 前置清点：bot 聊天用的 Pi lane（ordinary 还是 prepared）及其记忆工具和 `submit_result` 的接法；A1–A4 进度；credits 执行计费（和 ADR-038 决策 1 冲突）；#512、#513；用户设备的 OS 分布；刷新基线。
  - M0.7（可选）Grok CLI 是否读指令文件。
- 依赖：无。
- 验收：一份核验记录（`docs/researches/`），每项有命令输出或 `file:line`；falsifier 成立的项有修订稿草案。
- 风险：M0.2 可能需要新字段，会拖 P5；M0.3 可能发现 Windows 需要的不只是 helper 开放，而是新的后端设计。

### P1 K4 Host 执行核心 + 合成端到端

- 目标：Host 执行核心可以 copy-and-own；SDK 仓库里有不依赖下游的端到端。
- 范围：§5.1 全部；§5.8 的合成端到端；Host 指南英文成文并从 README 链接。
- 依赖：M0.4、M0.5（合成端到端里的 outcome 形状）。K2、K5、K6、K7 已合并。
- 验收：§9 的 K4 行和合成端到端行。
- 风险：fake runtime 和真实 Pi 的行为差异；合成端到端的记忆页部分只在 Linux runner 跑，macOS 和 Windows 要等 P2。

### P2 跨平台记忆写入与 intent 屏障证明（SDK 切片）

- 目标：`memory_recall`/`memory_save` 和 `agent-memory-intent.v1` 在 Linux、macOS、Windows 三端都可用并广播。
- 范围：
  - macOS：证明 helper 的 conflict-before-rename 和 replace 的严格目录 fsync（APFS `F_FULLFSYNC`）；证明机制由 M0.3 定（SDK 自建 helper 并钉 digest，或运行时自证）；`helperAgentMemoryIntentBackend` 两项改 true；capability 广播。
  - Windows：在 `windows-latest` 跑 reparse/junction 矩阵；`helperPlatformSupported()` 和 `isAgentMemorySecureFilesystemAvailable` 开放 win32 加 helper；定义 NTFS 屏障语义并写进 spec（文件句柄 `FlushFileBuffers`，无目录 flush 的替代证明）；intent 两项证明；capability 广播。
  - spec「Durable Agent homes」的平台句子和 v0.24.0 升级表的对应行更新。
- 依赖：M0.3。
- 验收：§9 的两行平台证明。
- 风险：NTFS 没有目录 fsync，"严格屏障"可能只能证明到文件级，需要 Aimpact 接受这个定义；helper 是产品部署的二进制，运行时自证不成立时要改成 SDK 自建；Windows 真机矩阵可能暴露 junction 以外的问题（short name、大小写、DACL）。

### P3 K8a：委派、待确认动作、routine 动作、长任务规则

- 目标：单 Bot 的全部动作在参考实现里跑通；outcome 片段进 SDK。
- 范围：K8-S（`@byok-sdk/protocol` 片段 + `@byok-sdk/core` 纯函数 + spec + api-surface）；`examples/bot-collaboration` 的委派（含自委派）、`ask_user`、`confirmable_action`、routine 三动作；长任务规则进示例 system prompt；`submit_result` 成功率在 Pi 上测量。
- 依赖：P1；M0.4、M0.5。
- 验收：§9 的 K8-S 行和两条 K8a 行。
- 风险：模型不调用 `submit_result` 会让执行 fail closed，比例现在没有数据；K8-S 改 api-surface，要走 `check:api-surface`；续作预算 4 次对多步任务可能不够，先按默认值测。

### P4 K8b：群聊、Main Bot

- 目标：群聊和团队管理在参考实现里跑通。
- 范围：mention-only 群聊、席位预算、晚到发言、Main Bot 的 `create_bot`/`update_bot`/`delete_bot`/`create_room`/`update_room`/`team_note`。
- 依赖：P3。
- 验收：§9 的 K8b 行。
- 风险：群记录不做 Summary，长群撞 ContextPack 预算，v1 显式阻塞；`create_bot` 后 persona 落设备要等 `readAgentHomeProjection` 确认，被常驻 reader 拖慢。

### P5 记忆页 Host 半参考实现 + 两层 ContextPack

- 目标：用户能看、改、删、forget Bot 的记忆；常驻档案每次进 ContextPack。
- 范围：`examples/host-execution-core` 里的 `agentMemoryIntents` transport、intent 账本、baseRevision 探测、投影进 ContextPack、8 KiB 上限阻塞；合成端到端的记忆页部分扩到三端。
- 依赖：M0.1、M0.2；P2。
- 验收：§9 的记忆页行，三端各跑。
- 风险：M0.2 若裁定要新字段，P5 要等那个切片；投影是 latest-value，用户看到的可能落后于设备，UI 要显示投影时间。

### P6 Aiphabee 接入（外部仓库）

- 目标：Aiphabee 用真实 Pi 跑通 S1–S9。
- 范围：平台 PRD §13.2 的 A1–A4；删除 credits 执行计费；采用 K4、K8 参考实现；记忆页 UI；部署 macOS 和 Windows helper 并配置 `agentMemoryFilesystem`；执行改用 `agentMemory: read-write`（或 ordinary lane 的 reserved helper，按 M0.6）；关 #512、#513 让 `xai` profile 可用；Bot 执行的 toolset 按 A1 清理。
- 依赖：P1、P3、P4、P5；M0.6。
- 验收：§9 的 Aiphabee 行和安全行。
- 风险：Aiphabee 是 Workers 部署，空闲成本和 R3 的每 60 秒一次调用要先量；用户设备上 helper 的分发和升级是新运维面；credits 删除改收入模型，要产品确认。

### P7 上线门槛

- 目标：Bot 模式对 Aiphabee 用户可用。
- 范围：无新代码。关闭记录。
- 依赖：全部。
- 验收：§9 全表通过；关闭记录注明精确 SDK 版本、Aiphabee revision、source/packed/native 证据级别、未覆盖项。
- 风险：Windows 证明晚于其他阶段时，上线会被它卡住；按 Aimpact 决定不接受 Linux-only。

每个阶段运行根 `CLAUDE.md` 的必检：`bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`。P2 和 P3 改 protocol 或 spec 时另加 `bun run check:release-pack`。

spec 修改：P1 加 README 链接；P2 改平台句子；P3 加 `bot-turn-outcome.v1` 片段一节并修订平台 PRD §9.3、§13.1；P4、P5 只改 `examples/` 和文档。

回滚：P1、P4、P5 只有参考实现、文档和测试，直接回退。P2、P3 发布前 revert；发布后没有兼容层（ADR-038 O10），按 release notes 处理。

## 11. 风险

- **Windows 是大部分用户的设备，而记忆读写在 Windows 现在完全不可用。** 不只是 intent 不广播：`helperPlatformSupported()` 只认 darwin，Bot 的 `memory_save`/`memory_recall` 在 Windows 也不可用。P2 是上线的硬前置。
- macOS 的 helper 是产品部署的二进制。SDK 现在证明不了它的两项屏障。运行时自证做不到时，要改成 SDK 自建并钉 digest，多一条发布链。
- NTFS 没有目录 fsync。"严格 ledger 屏障"在 Windows 可能只能证明到文件级。这个定义要 Aimpact 接受。
- 模型不调用 `submit_result` 的比例没有测量数据。不调用会让执行 fail closed。P3 测量。
- `baseRevision` 的获取可能需要新字段（M0.2）。
- outcome 总上限 64 KiB。`confirmable_action.draft`、routine `prompt` 和 `post` 加起来要留在里面；M0.4 定每项上限。
- Aiphabee 的 bot 聊天如果在 ordinary lane，记忆工具是 live reserved helper，没有 prepared 的显式模式；M0.6 查清后再定接法。
- Aiphabee 对设备端执行收 credits，和 ADR-038 决策 1 冲突（平台 PRD §10.3）。
- #512、#513 挡着 `xai` profile。Grok 回复要等它们。
- 群聊不做 Summary，长群会撞 ContextPack 预算。v1 显式阻塞，不静默截断。
- 热门 Bot 反复被 busy 拒绝，每次消耗一个 `taskId` 代际和一行 mailbox。Host 保持每个 Agent 只有一个 writer 在途。
- 两个 Bot 写同一个共享仓库没有保护（ADR-031 的 WorkspaceRef 未实现）。
- Salesko 暂不做。它的 #195 链路留着，不影响 Aiphabee。

## 12. 决策表

| # | 问题 | 决定 | 状态 | 理由 |
|---|---|---|---|---|
| Q1 | Bot 模式的首个下游 | Aiphabee | 已定（Aimpact，2026-10-18） | 它已是 Topology L，bot 聊天跑在 Pi BYOK 上，routine 的 A1–A4 接入计划已有；Salesko 暂不做 |
| Q2 | v1 记忆是否要审批门 | 不要。Bot 直接 `memory_save`；用户有记忆页看/改/删/forget | 已定（Aimpact，2026-10-18） | 三个 SDK 原语已落地；审批将来走同一条 intent 路径 |
| Q3 | 记忆页改/删的 apply 边 | 用已落地的 `agent.memory.intent`，不加新消息 | 暂定默认，待 Aimpact 确认 | 0.24.0 已发布，带 at-most-once ledger 和 CAS 契约 |
| Q4 | OAR grok ACP adapter | 做 `GrokAdapter`（#514、PR #536）。Grok Bot 是重点，Grok Build CLI 只作底层 runtime。Pi + xAI 保留给只当模型的用法 | 已定（Aimpact，2026-10-19 约 13:45 HKT 改判，推翻 2026-10-18 的「不做」） | 原话「可以顺手接入 grok cli，但 grok bot 才是重点」。不批准 Hermes #519；不为其他 runtime 整体改写 Q8 |
| Q5 | K4、K8 的目录名 | `examples/host-execution-core`、`examples/bot-collaboration` | 暂定默认，待 Aimpact 确认 | 和平台 PRD 的 K4/K8 一一对应；不提升为包 |
| Q6 | K8 是否拆两步 | 拆：K8a 单 Bot 动作，K8b 群聊和 Main Bot | 暂定默认，待 Aimpact 确认 | 委派先把 outcome → apply → 再排队的整条路跑通；群聊的席位和晚到发言更复杂 |
| Q7 | Salesko 的拓扑 | 删除 | — | Aiphabee 是 Topology L（平台 PRD §6） |
| Q8 | v1 Bot 执行的 runtime | 只 Pi | 已定（Aimpact，2026-10-18） | `agentMemory` 模式在 prepared Pi 上；`submit_result` 只在 Pi 上量过 |
| Q9 | outcome 动作片段和 routine 纯函数放哪 | `@byok-sdk/protocol` 片段 + `@byok-sdk/core` 纯函数；Host 填 enum 并冻结 | 已定（Aimpact，2026-10-18） | 协议层在 SDK，周期规则仍在 Host |
| Q10 | `MEMORY.md` 常驻层上限 | 8 KiB，超出显式阻塞 | 已定（Aimpact，2026-10-18） | 每次执行都进 ContextPack，要留预算给对话 |
| Q11 | 续作预算 | 每条用户输入最多 4 次，不占委派预算 | 已定（Aimpact，2026-10-18） | 长任务要几次续作；和委派分开算才不互相挤 |
| Q12 | routine 的 `target` | 默认自己；Main Bot 可指向团队 Bot | 已定（Aimpact，2026-10-18） | 普通 Bot 替别人定计划是越权 |
| Q13 | 演示 Host | 不单独建目录；把 K4 的冒烟测试扩成合成端到端 | 已定（Aimpact，2026-10-18） | 少一个要维护的目录；端到端在 Aiphabee 做 |
| Q14 | 三端支持 | 不接受 Linux-only；macOS 和 Windows 的证明都进 v1 | 已定（Aimpact，2026-10-18） | 大部分用户是 Windows |

[#195]: https://github.com/Ancienttwo/byok-sdk/issues/195
