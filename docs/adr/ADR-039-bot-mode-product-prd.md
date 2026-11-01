# ADR-039：SDK Bot 模式产品方案（PRD）

> **来源**：PR [#523](https://github.com/Ancienttwo/byok-sdk/pull/523) 加入本文，PR [#524](https://github.com/Ancienttwo/byok-sdk/pull/524) 写入 v3 裁定，PR [#579](https://github.com/Ancienttwo/byok-sdk/pull/579) 补 K8b 对齐。决定在 §3（M1–M3、A1、R1、L1、G1）、§12 决策表和「PRODUCT RULINGS 2026-10-19」。其余各节是这些决定的背景。
> **移入**：#1291 把本文从已退役的 plans 目录（`2026-10-18-bot-mode-product-prd.md`）移到这里。正文未改；只把指向已移走或已删除文件的链接改为新位置或合入它的 PR。

> 版本：v3，2026-10-19。v1、v2 为 2026-10-18。v3 写入第一批 WO-01..05 的事实修正和 Aimpact 裁定。修订依据见 §13。上限表仍是 v1 提议值。
> 状态：草案。只写文档，不授权实现、发布、issue 修改或下游迁移。
> 依据：byok-sdk `origin/main@becc9f57`（0.27.0，2026-10-18）。上游 OAR `c264f17`（0.67.0）。Aiphabee 核验基线为 `main@2eae75c7`（2026-10-18；WO-04）。本文记录该快照，不声称它是当前部署状态。
> 权威关系：[docs/spec.md](../spec.md) 是产品权威。[ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md) D1 定义 Bot 模式的执行语义。[ADR-038](../architecture/adr-2026-10-13-bot-platform.md) 和 [Bot 平台 PRD](../researches/2026-10-13_bot-platform-prd.md)（下文称"平台 PRD"）定义 routine、Bot 协作和 K1–K9。本文不重写它们的契约，只引用，并在 §5.2 和 §5.5 记录对平台 PRD 的两处修订。记忆 apply 边的依据：[docs/protocol.md §2.4](../protocol.md#24-task-free-agent-memory-intent-notice)、spec「Durable Agent homes」倒数第二段、[v0.24.0 release notes](../releases/v0.24.0.md)、device memory CAS 契约（git 历史 `e46df7630^` 下的 `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md`，#390 后不再跟踪）。
> 背景事实：仓库里没有 Muse 的任何引用。OAR 在 SDK 里只是 Codex 的私有 fork（55 个源文件，`packages/client/vendor/oar/c264f17/PROVENANCE.md`），不是通用 harness 层。Claude 和 Pi adapter 是 SDK 自己写的。

## 0. 结论

Bot 模式是一种执行方式，不是一种 runtime。一个 Bot 是一个持久的 Agent：`AgentRef` 加它的 home。每次唤醒都是一次新的 fresh 执行（ADR-036 D1）。它说的话走 `messageEgress`，它要 Host 做的事走 `submit_result`。Bot 之间的协作由 Host 编排多次 fresh 执行（ADR-038 决策 8）。

SDK 侧的执行原语和记忆原语都已落地。K2 wake 队列、K5 `executions.submit`、K6 typed busy code、K7 `submit_result`、#500 回复草稿、`memory_recall`/`memory_save`、`agent.memory.projection`、`agent.memory.intent` 都在 0.27.0 里。没有落地的是四块：K4 Host 执行核心参考实现、K8 Bot 协作参考实现（含一个小的 SDK 片段切片）、记忆页的 Host 半、以及记忆写入和 intent 在 macOS 和 Windows 上的平台证明。前两块主要是 `examples/` 里的 copy-and-own 代码。后两块里，平台证明是 SDK 切片，记忆页是 Host 参考实现。

| 判断 | 状态 |
|---|---|
| 方向成立 | 是。符合 ADR-036 D1、D3 和 ADR-038 决策 7–13。 |
| 可以开始实现 | M0 之后 K4 可以。它依赖的 K2、K5、K6、K7 都已合并。平台证明切片和 K8-S 可以与 K4 并行。K8 的 Host 协作参考实现依赖 K4 和 K8-S（§5.2）。 |
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
- Host 开发者：Aiphabee 是首个下游（§12 Q1）。它已经是 Topology L：`apps/local-agent/src/research-pass-host.ts` 在同一个进程里跑 embedded server（SQLite）和 daemon。bot 聊天走 ordinary fresh lane，没选 runtime 时用 Pi BYOK。设备现在也可以选 Claude 或 Codex；v1 目标仍只 Pi（Q8）。Salesko 暂不做。（依据 R4）
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
- 它只调用公开 API：`executions.submit`、`tasks.offer`、`tasks.attempt`、`tasks.get`、`tasks.deviceTerminal`、`tasks.cancel`、`wakes.schedule`/`cancel`/`pending`。
- 一个 routine 和一个 Bot 触发共用同一个 per-Agent FIFO。
- `taskId = H(intentKey, generation)`。提交前持久化完整输入。换代只在读到设备 terminal 后，并且 decline `code` 是 `agent_home_writer_busy`/`agent_home_reader_busy`，或失败且重试策略允许。
- 每个 intent 有等待上限。到期先 `tasks.cancel`，再用 `tasks.attempt` 读回。状态是 `cancelled` 且没有 claimed runtime 或 owner 时，结论为 `expired`。已有 claim 或状态是 `cancel_requested` 时，保持 FIFO 占用，等设备 terminal 后结为 `cancelled`。接受到期与 claim 的竞态。`tasks.get` 是产品快照，不能代替 attempt 读回。不修改 `tasks.cancel` 的返回值。
- 读到成功 terminal 后，在一个事务里按 `taskId` 应用 outcome，只应用一次。
- 恢复靠持久 outbox 扫描。
- 平台 PRD §12 的 Host 指南独立成英文文档，README 链接它。

K4 保持每个 routine id 的定义不可变。改定义换新 id。同 id 的版本管理归 K8a（§5.5）。本参考实现覆盖 §5.8 的聊天、routine 和崩溃恢复。平台 PRD §14.1 的服务端各行在 K2、A2 之后由下游 Host 服务实现。（依据 R5、R6）

验收：平台 PRD §13.1 K4 行；§14.1 Topology L 执行各行在 SDK 仓库合成 Host 跑通。浏览器关闭时的同步、`sync_failed`、409、`device_offline`、`missed`、安全和成本归下游。

### 5.2 K8：Bot 协作参考实现和 outcome 动作片段

范围按平台 PRD §9.3–§9.6，加 v2 新增的三类动作和一条默认规则。

**K8-S（Aimpact 已接受）。** `@byok-sdk/protocol` 发布 `bot-turn-outcome.v1` 的动作片段、组合函数和 TS 类型。Host 按角色和执行类型选片段，填花名册、群、模型、routine id 的 `enum`，调用 `composeBotTurnOutcomeSchema`，冻结进 offer。daemon 仍只按冻结 schema 校验格式，K7 不变。`@byok-sdk/core` 发布 Host 调用的纯函数 `nextRoutineOccurrence(schedule, now)` 和 `checkRoutineSchedule`。K8-S 改 protocol、core、server 的 wake 上限、spec 和 api-surface。（依据 R3）

K7 子集没有 `pattern`、`format`、`uniqueItems`、`$ref`。schedule 用结构化字段（§5.5）。类型、范围和 enum 放在外层 `properties`，三种封闭形状用只列属性名的 `oneOf` 区分。Host 应用时调用 `checkRoutineSchedule`，处理 schema 看不到的日期组合。`maxLength` 数码点。canonical JSON 中每码点按最多 6 字节计；`number`、`integer` 的保守上界分别为 25、24 字节。只有整数范围的两端绝对值都小于 1e21 时，才按端点十进制长度收紧。

组合函数分别报告 `not-subset`、`schema-over-budget`、`over-budget`。只有 schema 超过 16 KiB 才可把 routine 片段改为 `flat` 后重新组合。必须在冻结 offer 前完成。仍超限时显式阻塞，或走 Host 已定义的分批选择流程。不静默截断授权对象的 enum。`flat` 的字段组合仍由 Host 应用时校验。（依据 WO-03 v4 §2.6；R3）

**outcome 契约 `bot-turn-outcome.v1`。** 总上限是 `RESULT_OUTCOME_MAX_BYTES = 65 536` 字节（`packages/protocol/src/result-schema.ts`）。根是封闭对象，每种动作一个可选字段。数组动作各有 `maxItems`。下表的码点和个数上限是 WO-03 v4 §2.5 的 **v1 提议值**，不标已定。Host 填 enum 后，组合函数重新检查总上界。

| 动作 | 字段 | 谁能用 | Host 的处理 |
|---|---|---|---|
| `delegate`（最多 2） | `to`（enum，含自己）、`request` ≤ 1 000 码点 | 所有 Bot | 新建委派，key `H(A.taskId, 'delegate', 下标)`。`to` 是自己时是续作（§5.6），用续作预算 |
| `cancel_delegation`（最多 2，K8b Q12 已定） | `delegationId`（Host 开放委派 enum） | Main Bot，且 Turn 的 `authority = owner`，不在群席位 | 管理动作后运行统一取消仲裁；最新 24 个目标，ContextPack 显示未列出数。已结算则 `already_resolved` |
| `ask_user`（最多 1） | `question` ≤ 400 码点、`answerKind`；单选 `options` 2–6 项，id ≤ 24、label ≤ 80 码点 | 所有 Bot | 建问题卡片。回答作为新一轮 `user` 输入 |
| `confirmable_action`（最多 1） | `action`（Host enum）、`summary` ≤ 300 码点、`draft`（Host 草稿 schema，有有限上界，最坏 ≤ 16 KiB） | 所有 Bot | 建确认卡（§5.4） |
| `create_routine`（最多 1） | `localId`（Host 槽位）、`schedule { minute, hour, daysOfWeek? 或 dayOfMonth? 加 month?, tz }`（§5.5）、`prompt` ≤ 500 码点、`target`（默认自己） | 所有 Bot；`target` 指向别人只有 Main Bot | 校验 schedule，落 routine 账本，算下一个时点，`wakes.schedule`（§5.5） |
| `update_routine` | `routineId`（enum）、要改的字段 | routine 的 owner 或 Main Bot | 推进定义版本，当前 occurrence 完成后切换 |
| `cancel_routine` | `routineId` | 同上 | lifecycle 改 `completed`，`wakes.cancel` |
| `speech` / `room_call` | 必填 `speech`：`{ kind: 'post', text ≤ 2 730 码点 }` 或 `{ kind: 'pass' }`；可选 `room_call.members` ≤ 4 项 | 群发言执行 | 写入群对话 / 本席位不发言 / 在预算内追加席位 |
| `create_bot` / `update_bot` / `delete_bot` | 见平台 PRD §9.3 | Main Bot | 建档案和 AgentRef，persona 落设备并确认后才派发 / 推进 `profileRevision` / 归档 |
| `create_room` / `update_room` | 名称、成员、admin、模式、公告 | Main Bot | 写群账本 |
| `team_note`（最多 1） | `text` ≤ 300 码点 | Main Bot | 追加团队笔记 |

其余个数提议值：`update_routine` 1、`cancel_routine` 2、`create_bot` 3、`update_bot` 1、`delete_bot` 1、`create_room` 1、`update_room` 1。`update_routine.prompt` ≤ 500 码点。Bot 的 name/role/persona 分别 ≤ 40/80/300 码点。群的 name/announcement 分别 ≤ 40/300 码点。

只有 Main Bot 的 schema 含管理类动作。只有群发言执行的 schema 含必填的 `speech`（`post` 或 `pass`）和可选的 `room_call`。对话变体的 `{}` 表示没有动作。没交 outcome 的成功执行是 `task.fail`（K7）。Host 预发 localId 槽位，并在同一 outcome 的引用中使用这些槽位。

动作 key 是 `H(taskId, kind, 数组下标)`。Host 在同一个事务里按固定顺序应用：`create_bot` → `update_bot` → `delete_bot` → `create_room` → `update_room` → `team_note` → `cancel_delegation` → routine 三动作 → `confirmable_action` → `ask_user` → `delegate`。（依据 R3）

**Turn 来源**加一种：`action_result`，承载待确认动作的执行结果（§5.4）。原有五种是 `user`、`routine`、`bot_request`、`bot_reply`、`room_slot`。

**委派**：异步。A 交出委派后执行就结束。每个委派只有一个结论：`answered`、`failed`、`cancelled`、`refused`、`expired`、`abandoned`。不确定时不自动重派，用户可以关闭。

K8b Q2 的回报规则：一个接受目标用 `H('bot_reply', delegationId)`；两个接受目标用 `H('bot_reply', A.taskId)`。每个目标都有结论或 uncertain，且至少一个有结论时，放行一次批次回报。全部 uncertain 时不建空回报。后来取得的结论单独回报。`replyTurnId` 使每个委派最多属于一个回报。没有接受项时，一个 outcome 的全部拒绝共用一次回报。没有空闲预算时只交付记录，不启动模型。拒绝回报没有 `delegate`。

K8b Q10 的 root 准入：n 个接受目标预留 `n + max(n, 1)` 单位，同时计入其他开放预留。`spent + reserved <= 12`。续作独立上限为 4。Bot 来源 Turn 及其续作、回报不会因 Main Bot 角色取得 owner authority。Main Bot 的 `cancel_delegation` 使用和用户相同的取消仲裁，记录 `main_bot_cancelled`。取消先提交时拒绝首次回复；接受先提交时保留 partial 回复。

**群聊（修订二，Aimpact 已定）**：默认模式是"未被点名不发言"。席位只来自 UI 的结构化 mention 或 outcome 的 `room_call`。平台 PRD §9.5 的 `admin` 模式降为可选。预算默认值不变。成员失败或没交 outcome 显示为失败，不算 PASS。

**Main Bot**：可以有多个。首次建团队时建一个默认 Main Bot。`delete_bot` 归档档案，SDK 不删 home。

交付物：`examples/bot-collaboration`（§12 Q5），建在 K4 之上。按 §12 Q6 拆两步：K8a 是自委派续作、`ask_user`、`confirmable_action`、routine 三动作和长任务规则；`update_routine` 含同 id 的版本管理。K4 保持定义不可变。K8b 是群聊、Main Bot 和跨 Bot 委派。跨 Bot 委派等 #530、#531 合并后实施，按已批准的 K8b X1–X6、X2M 和独立 XS 切片交付。K8-S 可先于 K8a 独立交付，不依赖 K4。参考实现暴露的其他 SDK 缺口另开 issue。（依据 R3、R6）

验收：平台 PRD §14.2 已定行，加 §9 的新行。群聊行已按 mention-only 默认写明。标为「待 Aimpact 裁定」的行不能记为已通过。

### 5.3 记忆

#### 5.3.1 两层记忆

| 层 | 文件 | 进入模型的方式 | 写入方式 |
|---|---|---|---|
| 常驻档案 | `MEMORY.md`，≤ 8 KiB | Host 把 `agent.memory.projection` 里的脱敏投影放进每次执行的 ContextPack | Bot `memory_save`；用户记忆页 `replace` |
| 详细记忆 | `notes/**` | Bot 按需 `memory_recall` | Bot `memory_save`；用户记忆页 `replace`/`delete` |

- Bot 执行在 prepared lane 上用 `agentMemory: read-write`。ordinary lane 上记忆工具走 live reserved helper `byokagentmemory`。WO-04 核验的 Aiphabee 是 ordinary lane，未配置 filesystem helper 和 intent transport。用户设备上的 SDK 记忆工具尚未注入；现有 consolidation 和 D15 恢复路径仍需按 Q2、M1–M3 迁移。P6 完成接入后才符合本节目标。（依据 R4）
- `MEMORY.md` 超过 8 KiB 时，Host 不放进 ContextPack，而是显式阻塞并提示用户整理。不静默截断。
- 投影可能落后于设备。Bot 需要精确内容时 recall `MEMORY.md`。

#### 5.3.2 记忆页

看：`agent.memory.projection` 的脱敏快照。它不是 authoring 路径。

改、删、forget：Host 铸 `intentId`，释放 `agent.memory.intent`（`replace` 带全文和 `targetRevision`，`delete` 不带内容），设备在 task-free home lease 下做一次 CAS，回 `applied | conflict | rejected | uncertain`。规则：

- `MEMORY.md` 不可删（设备报 `memory_md_not_deletable`）。forget 对 `MEMORY.md` 是 `replace` 成编辑后的全文。
- forget 不删对话历史、Summary、审计和 Host 侧元数据（CAS 契约 §F）。
- `conflict` 带 `observed` revision。纠正是新的 intent，不自动 rebase。
- `uncertain` 是 terminal non-success。UI 只能说"目标内容当前存在/不存在（revision …）"。
- P5a 提供显式整文件替换和删除笔记。`sha256("")` 是 absent-or-empty 的写条件，不是只读探测。只有用户已授权可能发生的写入时，才可按 CAS 契约 §B 发 intent。`conflict{observed}` 不可自动套到旧草稿；重新提交需要新的用户决定和 intent。
- P5b 提供 edit-view 投影。沿用 `agent.memory.intent`，不加 wire `sourceRevision`。设备把 path、展示正文和 `contentComplete` 绑定到同一次 snapshot。完整文件的编辑基线为 `sha256(utf8(展示正文))`。incomplete 文件只读，不导出原文 hash。普通全文编辑要等 P5b 契约落地。（依据 R1）

Host 半的交付物放在 `examples/host-execution-core`。P5a 交付 `DaemonConfig.agentMemoryIntents` 的 `fetch`/`complete` transport、intent 账本、显式替换的 baseRevision 获取和投影进 ContextPack。P5b 加 edit-view 投影的完整性证明和 Host 派生基线。WO-01 v2 修订稿中的其他字段、披露授权、容量失败和保存后视图细节仍是建议，本次不把它们标为已定。（依据 R1）

#### 5.3.3 三端差距与证明切片

记忆写入权威有一个平台门（`agent-memory.ts` `isAgentMemorySecureFilesystemAvailable`）。intent 能力的广播另有两项证明（`agent-memory-intent.ts`：`conflictProvesNoRename`、`strictLedgerBarrier`）。现状：

| 端 | `memory_recall`/`memory_save` | `agent-memory-intent.v1` 广播 | 差距 |
|---|---|---|---|
| Linux | 可用。原生 `/proc/self/fd` 描述符后端。 | 有条件广播。transport、home、安全 filesystem、strict backend 和目录 probe 均须满足。native backend 声明两项为 true。 | 新 home/`.byok` 创建后缺父目录 sync（`agent-home.ts:280`）。当前 `strictLedgerBarrier=true` 依赖未证实的共享前提。P2-mac 修共享初始化和 Linux 屏障，并跑 Linux 回归 |
| macOS | 现需产品配置 Go helper（`packages/client/native/agent-memory-fs`）和 `agentMemoryFilesystem`。 | 不广播。helper backend 两项证明均为 false。conflict 会报 `uncertain`。 | helper 纳入 SDK 发布物。SDK 解析路径并按部署 digest 比对。消除严格 `F_FULLFSYNC` 路径的降级，补共享新目录屏障、产物与卷能力证明。产品重签策略是 P2 前置 |
| Windows | 不可用。`helperPlatformSupported()` 只认 darwin。现有 Go 测试不等于完整 reparse/junction 矩阵。 | 不广播。 | TS 平台门、TS/Go tagged identity、Go open admission、Node/Bun 空 env 启动、真实 reparse 矩阵和 NTFS ledger 后端。spec 故障模型决策稿与矩阵并行。共享新目录屏障接入获准的 NTFS 实现 |

上表依据 R2。Go `File.Sync()` 已尝试 Darwin `F_FULLFSYNC`，缺口含严格路径不降级。helper 的部署 digest 检查用于发现错误部署。产品重签会改变 bytes；macOS 签名/notarization 流程和 Windows Authenticode 的比对策略须先裁定，不能在 digest 不符时放行。

Aimpact 已定：不接受 Linux-only。v1 把 macOS 和 Windows 的证明都列入分期（§10 P2）。CI 已有 `macos-latest` 和 `windows-latest` runner，证明矩阵可以在 CI 跑。

#### 5.3.4 不采用

- 记忆审批门。v1 不做（Q2）。Host 将来要加审批，走同一条 intent 路径，不需要新 wire。
- Host 持有第二份可写记忆。违反 M1。
- 用 Summary 代替记忆，或把 forget 说成删 Summary。
- 扩展 `agent.home.projection` 来写记忆文件。它是 ≤ 64 KiB 的不透明 JSON，交给 Host 的 consumer hook，不是按路径写文件的通道。

### 5.4 待确认动作

- Bot 在 outcome 里交 `confirmable_action { action, summary, draft }`。`action` 是 Host 定义的 enum，例如 `send_email`、`send_message`、`delete_record`、`pay`。`draft` 的形状由 Host 为每个 action 定义的 schema 决定，必须有有限上界，最坏 ≤ 16 KiB。
- Host 应用 outcome 时建确认卡，key `H(taskId, 'confirmable_action', 下标)`。卡片有 `pending`、`confirmed`、`rejected`、`expired` 四态。（依据 R3）
- 用户确认后 Host 用自己的连接器执行。SDK 不执行，也不知道 action 的语义。
- 执行结果（成功、失败、外部 id）作为新 Turn 回到 Bot 的对话，来源 `action_result`。Bot 的下一次执行能看到它。
- 不变量 A1：Bot 执行拿不到任何有外部副作用的工具。`examples/salesko-connector-broker` 那种执行型连接器不进 Bot 执行的 toolset。
- `ask_user` 保留，用于只要答案的场景。

### 5.5 Bot 自管 routine

- Bot 在 outcome 里 `create_routine { localId, schedule, prompt, target }`。`localId` 是 Host 预发的槽位。`target` 默认是自己；Main Bot 可以指向团队 Bot（§12 Q12）。
- schedule 用结构化字段：`minute`（整数 0–59）、`hour`（整数 0–23）、`tz`（Host enum）。无日字段为每日；`daysOfWeek` 为 1–7 个 `mon`…`sun`；`dayOfMonth` 为 1–31，可再加 `month`（1–12）表示每年。星期和日期不能同时出现；`month` 必须带 `dayOfMonth`。重复星期在存储前去重。月末不存在的日期跳过。每天最多一个时点，不支持“每 N 小时”或“每月最后一天”。
- Host 应用时先调 `checkRoutineSchedule`。4 月 31 日报 `schedule_unreachable`，2 月 29 日报 `schedule_beyond_horizon`。不合法动作被拒，并写进下一次 ContextPack。通过后落 routine 账本（定义版本 1，owner 是发起的 Bot），用 `nextRoutineOccurrence` 算下一个时点，`wakes.schedule({ dedupKey: "<routineId>:<version>:<t>", availableAt: t })`。version 和 t 是规范十进制安全整数，从右往左解析。之后按平台 PRD §6 Topology L 和 §12 跑。
- routine 执行的输入是 `prompt` 加 Host 的 ContextPack。结果回 owner 的对话，来源 `routine`。
- `update_routine` 由 K8a 实现同 id 的 current/pending、调度 generation 和在途上限。有在途 occurrence 时，旧版本快照结算后才切换；无在途时立刻切换。暂停后恢复也服从这个条件（平台 PRD §12.3 第 6 条）。K4 定义不可变，改定义换新 id。`cancel_routine` 把 lifecycle 改为 `completed` 并 `wakes.cancel`；要停止运行中的执行，Host 另调 `tasks.cancel`。
- 用户在 UI 看得到 Bot 建的 routine，可以暂停、改、删。
- 不变量 R1：设备上没有调度工具。schedule 的校验和时点计算只在 Host，用 core 的纯函数。SDK 的 wake 队列只收时间点。设备上的 Host 算出的时点是调度权威；服务端的计算只用于可见性。tz 只用两端都认识的规范名。
- 每个 Bot 的 routine 数量有上限（暂定 8），超过时 Host 拒绝并写进下一次的 ContextPack。
- occurrence 身份为 `(routineId, version, t)`。trigger 不进身份；首次判定后持久化，重投读回。K4、K8a 都实现 armed 检查和持久调度恢复；outbox 单消费者按持久序号执行同一 routine 的操作，迟到 cancel 不得删除后续重用同 key 的 wake。日历抛错时，同一事务记审计、停止后继，状态 `calendar_error`；hook 正常返回，不触发重投。UI 显示原因，恢复入口是进程启动、用户重试和新的定义版本。（依据 R3、R6）
- 已定的 server wake 上限为 368 天，K8-S 修改 `MAX_FUTURE_MS` 和 `wakes.test.ts:48/:58` 两处边界断言。实现 PR 逐条说明测试改动。该视界不是所有时区间隔的证明；超视界时 Host 持久重试或显式显示失败。发布前仍按所用 SDK 的现行上限处理。（依据 R3）

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
- 归属：聊天、routine、崩溃恢复归 K4。委派和 `confirmable_action` 归 K8a。记忆页归 P5a/P5b，三端证明归 P2；Linux 先跑，其余两端在 P2 后补。（依据 R6）
- fake runtime 调用 `byokagentresult` 的 `submit_result` 交固定 outcome。真实 Pi 的 `memory_save` 和模型行为在 P6 用 Aiphabee 手动跑。
- 不单独建演示 Host 目录。

### 5.9 回复显示

S1 的"边写边显示"用 #500 的 draft lane。草稿只用于显示。接受的消息是唯一产品真相。群发言不用 `messageEgress`，所以群里的 Bot 发言没有草稿。这是 v1 接受的限制。

## 6. 与 #195 的关系

[#195] 是 Salesko 的 Host ContextPack → 同 home Summary → fresh 回复集成验收。它的 SDK 侧前提已齐（2026-10-17 评论）。Salesko 暂不做，所以 #195 不再是 Bot 模式的上线门槛，保持开放，作为 Salesko 自己的验收。

Bot 模式复用它定下的模式：ContextPack 在派发时冻结、同 home 的 strict fresh Summary 走 result-document 且无 `messageEgress`、消息处置和设备 terminal 分轴。Aiphabee 需要自己的等价链路，列在 §10 P6。群聊的共享对话也需要 ContextPack；v1 不为群对话做 Summary，群记录按条数和字节截断进 ContextPack，超出时显式阻塞。

## 7. OAR grok ACP：已定不做

Aimpact 已定（§12 Q4）：不做 grok ACP adapter。Grok 走 Pi + xAI profile。事实留档：

- 上游 OAR `c264f17` 的 `packages/oar/src/runtimes/grok/` 有 11 个文件，经 `shared/acp/`（19 个文件）驱动 Grok CLI。SDK 的 vendor 策略不带 ACP 和非 Codex runtime（PROVENANCE.md）。
- Grok CLI 由 xAI 脚本安装，认证是 CLI 自己的（OAR 优先 `cached_token`），不走 keys launcher。
- Grok 作为模型的路：Pi 加 `xai` profile。WO-04 快照中 #512、#513 均 OPEN。#512 是 `openai_compatible` profile 只能投影成 `openai-completions`，缺 Responses API 投影。#513 是 strict `PiModelConfigSchema.compat` 缺 `supportsLongCacheRetention` 和 `inputLimits`，不能从 pi-ai 1.2.0 的 xAI catalog 生成预设。主线无 xAI 预设；可手配 Chat Completions，tool calling 未验证。P6 仍等待这两项关闭。（依据 R4）
- Grok CLI 是否读 Agent home 里的指令文件没有核实。M0.7 是可选项，只在 Aimpact 要求时做。

## 8. 非目标

- SDK 里的 Conversation、Room、委派、待确认动作或 routine 账本（ADR-038 决策 8）。
- SDK 里的 per-Agent 队列（平台 PRD §9.7）。
- 运行中往返 Host 的动作通道（K9，推迟）。
- 记忆审批门（Q2）。
- 外部事件唤醒（§5.7）。
- 把 Bot 搬到另一台设备。跨 Agent 读记忆。
- 群对话的 Summary。向量检索、后台总结器、通用 Host 记忆服务。
- SDK 执行有后果的动作。SDK 运行时组件（daemon、embedded server、wake 队列、cloud）不解释周期规则；core 纯函数是 Host 调用的库。（依据 R3）
- grok ACP adapter（Q4）。Claude、Codex 作为 Bot 执行的 runtime（Q8）。
- 单独的演示 Host 目录（Q13）。把 K4、K8 提升为包（两个下游采用后再评估）。
- Salesko 接入。执行计量和价格。
- 复制 DeepSeek Bot、DS Bot App、Grok Bot 或 Hermes 的代码。
- 云端 `cloud-do` 跑 BYOK Bot（ADR-038 决策 4）。移动端传输、配对和推送。

## 9. 验收标准

| 块 | 验收 | 证据级别 |
|---|---|---|
| M0 | 每个核验项有命令输出或源码引用；每个 falsifier 落到"可表达"或"修订稿" | 文档 |
| K4 | 平台 PRD §13.1 K4 行；§14.1 Topology L 执行各行在 SDK 仓库合成 Host 跑通；服务端各行归下游（§5.1）；稳定 slot 身份、armed、持久恢复、outbox 单消费者和 `calendar_error` 有场景测试 | SDK 仓库合成 Host |
| 合成端到端 | §5.8 的各项按归属交付：K4 的聊天/routine/崩溃；K8a 的自委派续作/确认；K8b 的跨 Bot 委派；P5 的 replace/delete。Linux CI 先跑；记忆页三端在 P2 后补 | fake runtime |
| K8-S | api-surface 新增片段、组合函数和纯函数；片段通过 K7 子集校验；字段范围与 `oneOf` 组合有测试；core 覆盖 `schedule_invalid`、`schedule_unreachable`、`schedule_beyond_horizon`、`tz_invalid`，以及 DST gap/overlap、Lord Howe、Samoa、月末、闰年；server 368 天边界测试；workerd 定向样例 | SDK 单测 |
| K8a | `to` = 自己走续作预算；`confirmable_action` 四态；`create_routine` → wake → 执行 → 结果回 owner；取消后无新 occurrence；普通 Bot 不可用 `target` 指向别人；同 id 的结算后切换、pending 时暂停/恢复、update 与旧 hook 交错；定义并验证在途上限 | SDK 仓库合成 Host |
| K8a | `submit_result` 成功率在 Pi 上测量并记录 | 真实 runtime，付费调用另行授权 |
| K8b | 平台 PRD §14.2 的 Cross-Bot 行和已定 mention-only 群聊行；未被点名没有执行。委派覆盖 fan-in、取消仲裁、预算、续作 authority、生命周期和双设备 embedded-server 路径。hosted 和两进程 relay 行保持 OPEN，Q19 不豁免 | SDK 仓库合成 Host；真实设备和下游行另验收 |
| 平台证明 macOS | 配置 helper 后 `agent-memory-intent.v1` 广播；两项证明的定向测试在 `macos-latest` 通过；spec 的平台句子更新 | SDK 单测 + CI |
| 平台证明 Windows | reparse/junction 矩阵在 `windows-latest` 通过；`memory_recall`/`memory_save` 在 Windows 可用；intent 两项证明通过并广播；NTFS 屏障语义写进 spec | SDK 单测 + CI |
| 记忆页 | 改 → `applied` → 下一次执行 recall 到新内容；`conflict` 不合并；forget 不删对话和 Summary；`MEMORY.md` 删除被拒；8 KiB 上限阻塞 | SDK 集成测试，三端各跑 |
| Aiphabee | S1–S9 在固定 revision 上用真实 Pi 跑通，macOS 和 Windows 各一台；§14.1 routine 矩阵；空闲设备每 60 秒最多一次轻量调用 | native |
| 安全 | hosted 存储和请求日志里没有用户模型 key；Bot 执行的 toolset 里没有执行型连接器 | 平台 PRD §14.1 安全行 + A1 检查 |

## 10. 分期

依赖：M0 后可并行做 P1、P2 和 K8-S。P3 的 K8a 依赖 P1 和 K8-S；P4 依赖 P3。P5a 依赖 P1，Linux 验收不等 P2；P5b 和记忆页其余两端验收等 P2。P6 在 P1、P3、P4、P5a/P5b 之后；P7 最后。（依据 R1、R3、R6）

### M0 契约核验切片

- 目标：在写任何产品代码前，把 v2 新增内容里"没有证据"的点全部落到证据或修订稿。
- 范围：
  - M0.1 记忆页 apply 边：在 Linux 容器里用现 main 跑通 `replace MEMORY.md`、`delete notes/x.md`、`MEMORY.md` 删除被拒、`conflict{observed}`、`uncertain` 路径。
  - M0.2 `baseRevision` 获取：WO-01 已验证 EMPTY bootstrap 不是普通编辑的读取契约。已定不加 wire `sourceRevision`。P5a 为显式替换；P5b 用同 snapshot 的 edit-view 完整性证明，Host 对完整展示正文求 sha256。（依据 R1）
  - M0.3 三端差距清单：macOS helper 两项证明各缺什么，`F_FULLFSYNC` 的位置；Windows 的 reparse/junction 矩阵内容、NTFS 屏障语义的定义、`identity_windows.go` 的现状。产出 P2 的切片边界。
  - M0.4 outcome 表达能力：K7 受限 JSON Schema 子集能否表达 `confirmable_action`、routine 三动作和 `to` 含自己；每个动作的上限之和 ≤ 65 536。
  - M0.5 routine 片段对齐：schedule/tz 词汇（结构化字段）、`nextRoutineOccurrence`/`checkRoutineSchedule` 签名、`dedupKey` 派生、和 `wakes.schedule` 的字段对应；确认 I2 不破。（依据 R3）
  - M0.6 Aiphabee 前置清点：bot 聊天用的 Pi lane（ordinary 还是 prepared）及其记忆工具和 `submit_result` 的接法；A1–A4 进度；credits 执行计费（和 ADR-038 决策 1 冲突）；#512、#513；用户设备的 OS 分布；刷新基线。
  - M0.7（可选）Grok CLI 是否读指令文件。
- 依赖：无。
- 验收：一份核验记录（`docs/researches/`），每项有命令输出或 `file:line`；falsifier 成立的项有修订稿草案。
- 风险：P5b 仍需 projection edit-view 契约和完整性证明；Windows 需要的 tagged identity、admission 和 NTFS 后端已列入 P2，不能只开放 helper 门。（依据 R1、R2）

### P1 K4 Host 执行核心 + 合成端到端

- 目标：Host 执行核心可以 copy-and-own；SDK 仓库里有不依赖下游的端到端。
- 范围：§5.1 全部；§5.8 中的一轮聊天、routine 和崩溃恢复；Host 指南英文成文并从 README 链接。§14.1 服务端各行按平台 PRD 在 K2、A2 后由下游实现。委派和确认动作归 P3，记忆页归 P5，三端证明归 P2。K4 不提供同 id 定义更新。（依据 R6）
- 依赖：M0.4、M0.5（合成端到端里的 outcome 形状）。K2、K5、K6、K7 已合并。
- 验收：§9 的 K4 行和合成端到端行中归 K4 的部分。
- 风险：fake runtime 和真实 Pi 的行为差异；服务端同步、可见性、安全与成本证据要由下游补齐。（依据 R6）

### P2 跨平台记忆写入与 intent 屏障证明（SDK 切片）

- 目标：`memory_recall`/`memory_save` 和 `agent-memory-intent.v1` 在 Linux、macOS、Windows 三端都可用并广播。
- 范围：
  - P2-mac：先修三端共享的新 home/`.byok` 初始化边界和 Linux 父目录 sync，补 Linux 回归。helper 是 SDK 发布物，由 SDK 解析路径并按部署 digest 比对。严格 `F_FULLFSYNC` 路径不降级。产物、卷能力、初始化和退出/lease 边界通过证明后，`helperAgentMemoryIntentBackend` 两项才改 true 并广播。产品重签及对应 digest 范围须先裁定。
  - P2-win：TS 平台门、TS/Go tagged identity、Go open admission、Node/Bun 空 env 启动、`windows-latest` 的真实 reparse/junction 矩阵、NTFS ledger 后端、两项证明和广播。NTFS 故障模型 spec 决策稿与矩阵并行。Windows 接入自己的共享初始化屏障，复用 SDK helper 发布机制。
  - spec「Durable Agent homes」的平台句子和 v0.24.0 升级表的对应行更新。
- 依赖：M0.3；产品重签策略；Windows 的 NTFS 故障模型获准并有证据后才开放 proof。（依据 R2）
- 验收：§9 的两行平台证明。
- 风险：NTFS 若仅能证明 process-crash/文件级保证，须 Aimpact 明确接受；未决或未证实时 `strictLedgerBarrier` 保持 false，v1 仍受阻。Host 保留 applied 而设备 memory/ledger 回退由 [#522](https://github.com/Ancienttwo/byok-sdk/issues/522) 跟踪。helper 超时后 lease 可能先于退出释放由 [#521](https://github.com/Ancienttwo/byok-sdk/issues/521) 跟踪，仍是未复现的源码推断。Windows 矩阵另覆盖 alias、大小写和 DACL。（依据 R2）

### P3 K8a：自委派续作、待确认动作、routine 动作、长任务规则

- 目标：单 Bot 的全部动作在参考实现里跑通；outcome 片段进 SDK。
- 范围：K8-S（`@byok-sdk/protocol` 片段和预算组合函数 + `@byok-sdk/core` 结构化 schedule 纯函数 + server wake 上限 368 天及两处边界测试 + spec + api-surface）；`examples/bot-collaboration` 的自委派续作、`ask_user`、`confirmable_action`、routine 三动作；同 id `update_routine` 的 current/pending、调度 generation、在途上限和对应测试归 K8a，不归 K8-S 或 K4。长任务规则进示例 system prompt；`submit_result` 成功率在 Pi 上测量。（依据 R3、R6）
- 依赖：K8-S 依赖 M0.4、M0.5，可独立先做；K8a 依赖 P1 和 K8-S。
- 验收：§9 的 K8-S 行和两条 K8a 行。
- 风险：模型不调用 `submit_result` 会让执行 fail closed，比例现在没有数据；K8-S 改 api-surface，要走 `check:api-surface`；续作预算 4 次对多步任务可能不够，先按默认值测。

### P4 K8b：群聊、Main Bot、跨 Bot 委派

- 目标：群聊、团队管理和同团队跨 Bot 委派在参考实现里跑通。
- 范围：mention-only 群聊、席位预算、晚到发言、Main Bot 的 `create_bot`/`update_bot`/`delete_bot`/`create_room`/`update_room`/`team_note`。加 K8b X1–X6 和 X2M：单目标及 fan-in 委派、回复接受、取消与 uncertain、生命周期、root 预留和双设备路径。XS 的 `cancel_delegation` 是独立 SDK 切片，其余不改 SDK wire。
- 依赖：P3。Cross-Bot 先等 K4 #532、K8a #530 和群聊 #531 合并。X2M 另依赖 XS。
- 验收：§9 的 K8b 行，映射见 [VALIDATION](https://github.com/Ancienttwo/byok-sdk/pull/578)。hosted `submitAgentExecution`、两进程 Topology L relay、两台物理电脑和真实 Pi 仍需各自的执行证据。
- 风险：群记录不做 Summary。按已定历史规则截取最近记录并显示 notice；只有当前请求本身超限才阻塞。`create_bot` 后 persona 落设备要等 `readAgentHomeProjection` 确认。双设备合成测试不能替代 hosted、relay 或真实 Pi 证据。

### P5a 记忆页：显式整文件替换、删笔记和两层 ContextPack

- 目标：用户能显式替换整文件、删笔记；常驻档案每次进 ContextPack。
- 范围：`examples/host-execution-core` 的 `agentMemoryIntents` transport、intent 账本、已授权替换的 baseRevision 获取、投影进 ContextPack、8 KiB 上限阻塞；Linux 合成端到端的 replace/delete。沿用现 intent，不加 wire revision。
- 依赖：M0.1、M0.2；P1。Linux 可先做，其余两端在 P2 后补。
- 验收：§9 记忆页行中显式替换和删除部分；`MEMORY.md` 删除被拒；conflict 不自动重提。
- 风险：显式替换可能覆盖页面未展示的内容，用户必须知道替换范围。它不能当作基于脱敏正文的普通编辑。（依据 R1、R6）

### P5b 记忆页：edit-view 投影

- 目标：完整展示文件可普通全文编辑；incomplete 文件只读。
- 范围：edit-view 投影及同 snapshot 的 `contentComplete` 证明；Host 以 `sha256(utf8(展示正文))` 派生完整文件的 baseRevision；incomplete 文件只读。不加 wire `sourceRevision`。其余契约细节保留 WO-01 v2 的建议状态。
- 依赖：M0.2；P5a；P2 后验证三端 snapshot 接口。
- 验收：完整展示正文的 sha256 等于同 snapshot 的文件 revision；视图 A 后设备变 B，用 hash(A) 保存返回 conflict；incomplete 只读，不导出原文 hash。
- 风险：edit-view 契约尚未实现。投影是 latest-value，UI 显示采集时间。披露授权、容量失败和保存后基线的建议仍需后续切片闭合。（依据 R1）

### P6 Aiphabee 接入（外部仓库）

- 目标：Aiphabee 用真实 Pi 跑通 S1–S9。
- 范围：平台 PRD §13.2 的 A1–A4；删除 credits 执行计费；采用 K4、K8 参考实现；记忆页 UI；部署 macOS 和 Windows helper 并配置 `agentMemoryFilesystem`；执行改用 `agentMemory: read-write`（或 ordinary lane 的 reserved helper，按 M0.6）；关 #512、#513 让 `xai` profile 可用；Bot 执行的 toolset 按 A1 清理。
- 依赖：P1、P3、P4、P5a/P5b；M0.6。（依据 R1）
- 验收：§9 的 Aiphabee 行和安全行。
- 风险：Aiphabee 是 Workers 部署，空闲成本和 R3 的每 60 秒一次调用要先量；用户设备上 helper 的分发和升级是新运维面；credits 删除改收入模型，要产品确认。

### P7 上线门槛

- 目标：Bot 模式对 Aiphabee 用户可用。
- 范围：无新代码。关闭记录。
- 依赖：全部。
- 验收：§9 全表通过；关闭记录注明精确 SDK 版本、Aiphabee revision、source/packed/native 证据级别、未覆盖项。
- 风险：Windows 证明晚于其他阶段时，上线会被它卡住；按 Aimpact 决定不接受 Linux-only。

每个阶段运行根 `CLAUDE.md` 的必检：`bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`。P2 和 P3 改 protocol 或 spec 时另加 `bun run check:release-pack`。

spec 修改：P1 加 README 链接；P2 改平台句子；K8-S 加 outcome 片段一节，修改 wake 368 天和周期规则句子；P4、P5a 只改 `examples/` 和文档。P5b 的 edit-view 配套 protocol/spec 修改以 WO-01 v2 修订稿为输入，未定细节不在本次裁定。（依据 R1、R3）

回滚：P1、P4、P5a 只有参考实现、文档和测试，直接回退。P2、P3 发布前 revert；发布后没有兼容层（ADR-038 O10），按 release notes 处理。P5b 的发布和回滚安排随配套契约闭合。（依据 R1、R3）

## 11. 风险

- **Windows 是大部分用户的设备，而记忆读写在 Windows 现在完全不可用。** 不只是 intent 不广播：`helperPlatformSupported()` 只认 darwin，Bot 的 `memory_save`/`memory_recall` 在 Windows 也不可用。P2 是上线的硬前置。
- 新 home/`.byok` 的目录持久化缺口三端共享。macOS helper 要纳入 SDK 发布物并检查部署 digest；产品重签策略仍是 P2 前置。共享目录屏障、卷能力和两项 proof 均须验证。（依据 R2）
- NTFS 故障模型 spec 决策稿与矩阵并行。仅 process-crash/文件级保证要 Aimpact 接受，未定时 B 保持 false。Host applied 与设备回退见 [#522](https://github.com/Ancienttwo/byok-sdk/issues/522)；helper 超时 lease 竞态见 [#521](https://github.com/Ancienttwo/byok-sdk/issues/521)，后者未复现。（依据 R2）
- 模型不调用 `submit_result` 的比例没有测量数据。不调用会让执行 fail closed。P3 测量。
- P5b 的 edit-view 尚未实现；不新增 wire `sourceRevision`，但仍需同 snapshot 完整性与披露授权。P5a 不开放普通全文编辑。（依据 R1）
- outcome 总上限 64 KiB。Aimpact 接受 WO-03 v4 §2.5 作为 v1 提议值，未把每项上限标为已定。所测普通 Bot/Main Bot/群变体保守上界为 43 261/61 895/16 710 字节，不保证有等长合法见证。Host 的 enum 会消耗 schema 预算；96 个 64 字符 routine id 时 checked/flat 均超限，按 §5.2 阻塞或分批，不静默截断。（依据 R3）
- Aiphabee 已核验为 ordinary lane；未配置 filesystem helper，用户设备上的 SDK 记忆工具尚未注入。P6 需完成 Q2、M1–M3 迁移及 A1 工具约束，不能把换 lane 当作完整证明。（依据 R4）
- Aiphabee 对设备端执行收 credits，和 ADR-038 决策 1 冲突（平台 PRD §10.3）。
- #512、#513 挡着 `xai` profile。Grok 回复要等它们。
- 群聊不做 Summary，长群会撞 ContextPack 预算。v1 显式阻塞，不静默截断。
- 热门 Bot 反复被 busy 拒绝，每次消耗一个 `taskId` 代际和一行 mailbox。Host 保持每个 Agent 只有一个 writer 在途。
- 两个 Bot 写同一个共享仓库没有保护（ADR-031 的 WorkspaceRef 未实现）。
- Salesko 暂不做。它的 #195 链路留着，不影响 Aiphabee。

## 12. 决策表

| # | 问题 | 决定 | 状态 | 理由 |
|---|---|---|---|---|
| Q1 | Bot 模式的首个下游 | Aiphabee | 已定（Aimpact，2026-10-18） | 它已是 Topology L，没选 runtime 时用 Pi BYOK（R4）；routine 的 A1–A4 接入计划已有；Salesko 暂不做 |
| Q2 | v1 记忆是否要审批门 | 不要。Bot 直接 `memory_save`；用户有记忆页看/改/删/forget | 已定（Aimpact，2026-10-18） | 三个 SDK 原语已落地；审批将来走同一条 intent 路径 |
| Q3 | 记忆页改/删的 apply 边 | 沿用 `agent.memory.intent`；不加 wire `sourceRevision`；完整展示正文的 sha256 是编辑基线，incomplete 文件只读 | 已定（Aimpact，2026-10-18） | 保持 CAS 和 at-most-once；普通编辑不得用 observed 覆盖旧草稿（R1） |
| Q4 | OAR grok ACP adapter | 不做；Grok 走 Pi + xAI profile | 已定（Aimpact，2026-10-18） | Bot 模式不因此多出能力；vendor 策略不带 ACP |
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
| Q15 | 记忆页分期 | P5a：显式整文件替换、删笔记；P5b：edit-view 投影 | 已定（Aimpact，2026-10-18） | 现 intent 可先做显式写入；普通编辑等完整性契约（R1） |
| Q16 | routine schedule | 结构化 minute/hour、星期或日期、可选 month、tz；不用 cron | 已定（Aimpact，2026-10-18） | K7 子集不含 pattern；core 校验组合（R3） |
| Q17 | server wake 视界 | 368 天；修改 MAX_FUTURE_MS 和 wakes.test.ts 两处断言，实现 PR 逐条说明 | 已定（Aimpact，2026-10-18） | 年度 routine 跨闰日和 DST 可超过 366 天（R3） |
| Q18 | tasks.cancel 返回 attempt | 不做；取消后另读 tasks.attempt | 已定（Aimpact，2026-10-18） | 保持 SDK API；K4 允许 tasks.attempt/tasks.get，接受到期与 claim 竞态（R5） |
| Q19 | K4 与下游的验收边界 | Topology L 执行各行归 K4 合成 Host；§14.1 服务端各行归下游，在 K2、A2 后实现 | 已定（Aimpact，2026-10-18） | 同步、可见性、安全和成本需 Host 服务证据（R6） |
| Q20 | 合成端到端归属 | 聊天/routine/崩溃归 K4；委派/确认归 K8a；记忆页归 P5，三端证明归 P2 | 已定（Aimpact，2026-10-18） | 按实际功能块验收，不扩 K4（R6） |
| Q21 | 同 routine id 的版本切换 | current/pending、调度 generation、在途上限归 K8a；K4 定义不可变 | 已定（Aimpact，2026-10-18） | update_routine 与版本账本一起实现（R3、R6） |
| Q22 | outcome 每项上限 | 采用 WO-03 v4 §2.5 作为 v1 提议值 | v1 提议值；未标已定 | 组合函数在 Host 填 enum 后重算；不能把所测上下文当作全局最坏情况（R3） |

## 13. v3 修订依据

下表固定第一批证据和裁定。未推送的 WO 原报告和本地 `_ops/bot-wo/` 输入已摘录到[来源摘录](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md)。读者无需访问实现 pane。WO-05 使用已推送的固定 commit 链接。原 commit 和行号保留在摘录中，供核对来源。

| 标记 | 修订位置 | 可读来源 |
|---|---|---|
| R1 | §5.3.2、§10 M0.2/P5a/P5b 与依赖、§11、§12 Q3/Q15 | [WO-01 摘录](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r1)；[拆期和已定项原文](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r0)。只把裁定列明的项目标为已定，其余修订稿细节仍为建议 |
| R2 | §5.3.3、§10 P2、§11 三端风险 | [WO-02 摘录](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r2)；[事实修正清单原文](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r0) |
| R3 | §0 的 K8-S 依赖、§5.2/§5.4/§5.5、§8、§9 K4/K8、§10 M0.5/P3、§11、§12 Q16/Q17/Q21/Q22；平台 §5 I2、§6、§7、§9.3/§9.4、§12.1/§12.3/§12.4、§13.1 | [WO-03 v4 摘录](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r3)；[交付与依赖原文](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r0) |
| R4 | 依据快照、§2.1、§5.3.1、§7、§11、§12 Q1 的事实描述 | [WO-04 摘录](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r4)；[事实修正原文](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r0)。不改变 Q1/Q8 |
| R5 | §5.1 公开 API、到期取消、§12 Q18；平台 §9.2 第 6 条和 §12.4 第 9 条 | WO-05 已推送的 [owner 裁定](https://github.com/Ancienttwo/byok-sdk/blob/e5afad26b42108cb4aa5b14f9f674291bc168b81/examples/host-execution-core/VALIDATION.md#L268-L273)、[cancel → attempt](https://github.com/Ancienttwo/byok-sdk/blob/e5afad26b42108cb4aa5b14f9f674291bc168b81/examples/host-execution-core/README.md#L76-L79)；[返回值不改的裁定原文](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r0) |
| R6 | §5.1/§5.8、§9 K4/合成端到端、§10 P1/P3、§12 Q19–Q21；平台 §9.2、§12.3、§13.1 K4、§14.1 边界 | WO-05 已推送的 [下游服务、版本管理和合成边界](https://github.com/Ancienttwo/byok-sdk/blob/e5afad26b42108cb4aa5b14f9f674291bc168b81/examples/host-execution-core/README.md#L120-L130)；[WO-05 v3 裁定原文](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r0) |
| R7 | §5.2/§9 的群聊验收引用；平台 §9.1/§9.5/§14.2 的默认 mention-only 和预算矩阵 | [已定默认行为和原预算摘录](../researches/2026-10-19-bot-mode-prd-v3-source-excerpts.md#r7)。按 2026-10-19 只读验收意见写成可测试行；待裁定项不补决定 |

未裁定的产品重签策略、NTFS 故障模型和上限数值仍保持原状态。此次验收列出的长记录策略（§6 与 §11）、未点名消息隐私、后来加入成员的可见范围，以及 Q5/Q6 也保持待 Aimpact 裁定。

[#195]: https://github.com/Ancienttwo/byok-sdk/issues/195

---

## PRODUCT RULINGS 2026-10-19 (Aimpact approved 12:43 SGT)

Source: Aimpact approval batch. Also mirrored at `_ops/bot-wo/PRODUCT-RULINGS-2026-10-19.md` (local ops).

1. **History / context window** — recent-N truncate by token budget with an explicit truncation notice; do **not** block-when-full.
2. **Non-@ messages** — may enter model context as background only; must **not** trigger a reply.
3. **Late-joining Bots** — see only messages after join (no older history).
4. **K4 sequencing** — separate PR first (`codex/bot-k4-host-execution-core`, Draft #532); then restack #529/#530/#531 onto it; remove squashed K4 copy from #529.
5. **Cross-Bot delegation** — defer until after #530+#531 land; first WO of K8b.
6. **#525 hold** — `BOT_TURN_OUTCOME_LIMITS` public API freeze pending Aimpact confirm of numeric caps; do not merge #525 until PM confirms.


## K8b Cross-Bot 文档对齐（2026-10-20）

本次按已批准的 [K8b 计划](ADR-041-k8b-cross-bot.md) 对齐 §5.2、§9 和 §10 P4。
Q2 决定 fan-in 回报 key。Q7 决定取消片段和顺序。Q10 决定最坏预留。Q12 把取消项数定为 2。
历史批准记录保持原义。这里不增加裁定，不把合成或 Draft PR 当作产品上线验收。
