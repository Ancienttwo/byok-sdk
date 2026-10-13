# PRD：BYOK Bot 平台——routine、Bot 协作、成本与部署

> 初版：2026-10-13。同日并入 Bot 协作层和 SDK 重构 K5–K8。
> 状态：待 owner 批准。PR 合并即批准本文的需求、K2 契约草案、K5–K7 重构契约、Bot 协作契约和路线图。合并不授权实现、发布、issue 修改或下游迁移。每个切片单独开 issue 和 PR。
> 权威关系：[docs/spec.md](../spec.md) 是产品权威。本文只定义计划中的变化。每个切片落地时，在同一个 PR 中修改 spec。决策另记在 [ADR-038](../architecture/adr-2026-10-13-bot-platform.md)。
> 依据：byok-sdk `main@c3ca6a84`；首个下游 Aiphabee `main@31b7280e`；RAFT Computer 的 reminder 实现（`botiverse/raft-source`）。Bot 协作和 K5–K7 依据 byok-sdk `main@b597b93e`，以及 DeepSeek Bot `c57d25b4`、DS Bot App `aea9380c`（Apache-2.0，只借鉴设计，不复制代码）。

## 1. 结论与问题

BYOK Host 需要定期运行的 Bot 工作，下文称 routine。例如每个交易日检查一次自选股，或每周整理一次研究笔记。

现状有四个问题：

- SDK 没有设备端定时能力。Host 只能自己写调度循环。Aiphabee 现在有两个：`LocalResearchMonitorScheduler` 和 `LocalWatchlistScheduler`。
- `@byok-sdk/cloud-do` 有 inbox 和 alarm，但只用平台 key（[ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md) D2）。BYOK routine 不能用它。
- 存储是收费单位。可是 mailbox 字节从不记账，mailbox 配额从不生效（[#411]）。
- 设备空闲时，hosted 真相层仍每 250 ms 读一次 mailbox（[#410]）。ADR-036 D7 还写着"Cloudflare 优先，Node + Postgres 仅预留"。

方向：执行在设备上，用用户自己的 key 或 runtime。时钟也放在设备上。云端只做真相层。SDK 不计量执行，收费单位是超额存储。部署以 VPS 为优化目标，Workers 继续可用。

Host 还需要 Bot 之间协作：Main Bot 按用户的一句话建 Bot、建群；一个 Bot 把任务委派给另一个 Bot，结果回来后接着做；群里多个 Bot 按顺序发言。DeepSeek Bot（DeepSeek Harness 插件）和 DS Bot App 已经做出了这种产品形态。它们的每个 Bot 都是同一进程里常驻的 DSH Session，靠 `steer`、正文里的 `@名字` 和 `[PASS]` 驱动，这些机制搬不到 BYOK。

现状对协作有五个缺口：

- Bot 的意图没有结构化出口。结果文档要靠设备上的 Host 代码（`DaemonConfig.resultDocument.extract`）对整段最终文本做 `JSON.parse`。只跑 daemon 的设备没有这段代码。runtime 没调用 `send_agent_message` 时，daemon 用同一段最终文本代写回复，回复和结果文档抢同一段文本。
- 结果文档有两套产出机制：extractor 和 durable Pi 自己写的 `{text}`。
- fresh 执行有两个提交入口：`recurring.submit` 和 `dispatchFreshAgentEgress`。前者的名字只对应 routine；后者返回进程内的 `TaskHandle`，现有使用方都丢掉它，靠读回恢复。
- home busy 只体现在以 `agent home busy:` 开头的 reason 文本里。Host 要靠前缀判断能否换代，和对话 PRD「不解析 reason 文本」的规则冲突。
- Host 没有委派和群聊的账本模型。[对话 PRD](2026-09-09_conversation-turn-fresh-mvp-prd.md) 只定义了用户输入这一种输入来源。

方向：Bot 是持久的 Agent，它的执行有三种触发来源：用户输入、routine、其他 Bot。三种来源进同一个 Host 执行核心。协作由 Host 编排多次 fresh 执行。Bot 需要读的内容由 Host 放进 ContextPack，Bot 的意图在执行结束时以结构化 outcome 交回 Host。SDK 做三项破坏性重构（K5–K7），不留别名和兼容层。

| 判断 | 状态 |
|---|---|
| 方向成立 | 是。符合 ADR-036 D3：BYOK key 只在本地。Bot 协作符合 ADR-036 D1：每次唤醒都是新的执行。 |
| 可以开始实现 | K1 和 K3 已有 issue，范围清楚。K2 已开 [#420]。K5–K8 要先按 §8–§9 开新 issue。每个切片的实现仍由 owner 逐个放行。 |
| 可以上线 | 否。routine 需要 K1–K3 和 K5 落地（A2 依赖 K5），并且首个下游通过 §14.1 的验收。Bot 协作还需要 K4–K8 落地，并且通过 §14.2 和 §14.3。 |

## 2. Owner 决策

owner 已定（2026-10-13）：

| # | 决策 |
|---|---|
| O1 | BYOK routine 不需要官方 key。云端是真相层，保存定义、结果投影和可见性状态。执行和时钟在设备上，用用户自己的 key 或 runtime。 |
| O2 | 不按 token、流量或执行次数计费。收费单位是超出存储额度的部分。平台成本主要是存储和服务器。 |
| O3 | 先完成 byok-sdk 的改动，再由下游 Host 接入。Host 不重建 SDK 负责的层。 |
| O4 | 部署以 VPS 为优化目标，因为 Workers 在流量大时成本高。SDK 同时支持 VPS 和 Workers。 |
| O9 | 加 Bot 协作层，和 routine 合在同一份计划里。 |
| O10 | 项目还没上线：该重构的直接重构。破坏性变更不保留别名、兼容层或并行路径。 |

本 PRD 提出，合并即批准：

| # | 决策 |
|---|---|
| O5 | O4 的"同时支持"覆盖真相层：`@byok-sdk/cloud` 和 `@byok-sdk/cloud-dataplane`。`@byok-sdk/cloud-do` 保持只在 Cloudflare 上运行。它只用平台 key，BYOK 产品不走它。 |
| O6 | 设备端时钟由 embedded server 的 wake 队列提供（K2，§7）。队列只接收一次性的时间点。周期规则留在 Host。 |
| O7 | hosted 真相层不为 routine 计时：没有 cron，没有 DO alarm，没有服务端定时器。 |
| O8 | O1 的例外：设备上没有 Host 进程的 Host（§6 的 Topology H）可以用自己服务端的定时器提交 routine 执行。执行仍在设备上，用用户的 key。理由：这类 Host 在设备上没有地方运行时钟。 |
| O11 | Bot 的执行有三种触发来源：用户输入、routine、其他 Bot。三者进同一个 Host 执行核心：每个 Agent 一个 FIFO，按 intent 派生 `taskId` 和代际，执行结算和 intent 结论分开记录（§9.2）。核心以 copy-and-own 参考实现交付，不进 SDK API。两个下游 Host 采用同一形状后，再评估是否提升为包。 |
| O12 | Bot 协作由 Host 编排多次 fresh 执行（ADR-036 D1）。SDK 不加 Conversation 或 Room 存储。Local TeamWorkspace 不作为 Bot 协作的底座。 |
| O13 | 上下文进，outcome 出。Bot 要读的内容（花名册、群记录、可用模型、团队笔记）由 Host 放进 ContextPack。Bot 的意图（委派、点名、PASS、提问、建 Bot、改 Bot、建群、团队笔记）在执行结束时以结构化 outcome 提交，Host 按 `taskId` 只应用一次。不从模型正文推导语义。缺 outcome 或执行失败都不算 PASS。运行中往返 Host 的动作通道推迟为 K9（§13.1）。 |
| O14 | K5：`executions.submit` 取代 `recurring.submit` 和 `dispatchFreshAgentEgress`，`messageEgress` 改为可选（§8.1）。 |
| O15 | K6：home busy 的 decline 带 typed `code`。Host 只看 `code`，不再解析 `agent home busy:` 前缀（§8.2）。 |
| O16 | K7：结构化 outcome 由 SDK 保留的 MCP 工具 `submit_result` 提交，按 offer 里冻结的 JSON Schema 校验。只有已落盘的成功 terminal 才交付 outcome。删除 `DaemonConfig.resultDocument.extract`，durable Pi 用同一个校验入口。K7 把 wire major 升到 3，没有 v2 reader，先排空，server 和 client 再一起升级（§8.3）。 |

## 3. 目标用户与成功标准

- Host 开发者：按一套规则实现 routine。定时、崩溃恢复和去重不需要自己写。委派和群聊用同一个执行核心实现，不在设备上放 Host 代码。
- 最终用户：Bot 按计划运行。设备休眠后只补跑一次。错过和离线状态可见。让 Main Bot 一句话建好 Bot 和群；委派和群聊每一步的结果都看得到，失败和不确定也看得到。
- 平台运营者：成本主要随存储增长。空闲设备只产生低频的兜底读取。

成功标准：

1. 设备休眠三天后醒来，每个 routine 只补跑一次，错过的时点不补齐。
2. 一个 occurrence 只对应一个 execution identity。进程崩溃或响应丢失后，Host 读回同一个 offer，不启动第二次执行。
3. 用户 key 不离开设备。hosted API 不接受用户模型凭据。
4. Node + Postgres 部署中，空闲设备的 `GET /byok/events` hold 只按兜底间隔读取 mailbox，不再每 250 ms 读取。
5. mailbox 用量计入存储用量。超过 `mailboxLimitBytes` 的追加返回 `storage_quota_exceeded`。有流量的租户也能完成保留清理。
6. SDK 不新增按 token、流量或执行的计量 API。推理用量仍只是遥测。
7. 真相层的新端口都有 Node 实现和测试。Workers 入口继续通过 `worker-packaging` 测试。
8. Bot A 委派给另一台设备上的 Bot B，B 的回复作为 A 的新一轮输入到达。Host 崩溃、重复投递、设备离线和取消都不会产生第二个 B 执行，A 只收到一个委派结论。
9. 只跑 daemon 的设备（Topology H）上，Bot 的结构化 outcome 不需要任何 Host 代码。
10. 群聊的发言顺序、点名和 PASS 全部来自结构化输入或 outcome。模型输出空文本或执行失败显示为失败，不算 PASS。
11. SDK 只剩一个 fresh Agent 提交入口；busy 拒绝带 `code`；`DaemonConfig` 没有 `resultDocument`。
12. 每条用户输入派生的 Bot 自发执行有预算，委派链有 hop 上限。超过时 Host 明确拒绝，并显示原因。

## 4. 范围

### 纳入

- K1：存储记账与保留（[#411]、[#412]）。
- K2：embedded server 的设备端 wake 队列（[#420]，契约见 §7）。
- K3：空闲成本（[#410]、[#391]）。
- K4：Host 执行核心参考实现（routine 和 Bot 触发共用，§9.2）、routine 冒烟测试、Host 指南独立成文、设备端中间产物保留（扩展 [#418]、[#399]）。
- K5：统一 fresh 执行提交（契约见 §8.1）。
- K6：busy decline 的 typed code（契约见 §8.2）。
- K7：结构化 outcome 通道 `submit_result`（契约见 §8.3）。
- K8：Bot 协作参考实现：委派、群聊、Main Bot 管理（契约见 §9）。
- ADR-038：成本模型、部署目标、routine 时钟与 Bot 协作。它部分取代 ADR-036 D7。

### 不纳入

- `cloud-do` 的 VPS 版本（O5）。
- hosted 真相层里的 routine 时钟（O7）。
- 任何执行计量，以及具体价格和额度。价格和额度是产品决定。
- 自由指令的 routine。routine 类型由 Host 定义。
- 消息和回调进入 wake 队列。ADR-036 研究稿 §8.2 的统一 inbox 收窄为只处理时间点。消息仍走现有 dispatch 路径。
- presence 规则统一（[#413]）和 SQLite 锁机制替换（[#414]）。[#403] 已经合并了另一种实现，剩余范围由 owner 另行决定。
- 下游 Host 的整体部署迁移，例如 Aiphabee 从 Workers 迁到 VPS。
- 运行中往返 Host 的动作通道（K9，推迟，触发条件见 §13.1）。
- Local TeamWorkspace 的退役或扩展。它只做本机 operator 协调，是否退役由 owner 另定。
- 共享工作区写入。ADR-031 的 WorkspaceRef 还没实现，两个 Bot 写同一个仓库没有保护。
- 移动端和远程客户端的传输、配对和推送。这些属于 Host。
- web search、secret 管理界面、LLM 记忆复盘任务、桌面参考 app 的界面。
- DSH 专有机制：`llm/stream` 中间件伪造工具调用、cordis 插件、每个群成员一个隐藏 Session。
- ADR-034 列出、至今没做的 legacy 移除（`task.offer`、`task.offer_with_toolsets`、`strictAgentOnly`）。由 owner 另定。
- 复制 DeepSeek Bot 或 DS Bot App 的代码。

## 5. 权责与不变量

| 对象 | 权威 | 说明 |
|---|---|---|
| Routine 定义、版本、lifecycle | Host 服务端 | 设备保存镜像。 |
| Occurrence 账本、重试、补跑策略 | 设备上的 Host 进程 | 见 §6 的 Topology L。 |
| 定时与崩溃后的重新投递 | SDK embedded server 的 wake 队列（K2） | 只知道时间点，不解释周期规则。 |
| Execution | SDK：`executions.submit`（K5 之前是 `recurring.submit` 和 `dispatchFreshAgentEgress`） | 每个 Agent home 同时只有一个 writer。 |
| 结果投影 | Host | 从设备上传到 Host 服务端，按投影 id 去重。 |
| 存储用量与额度 | SDK `QuotaStore` | 收费只读 entitlement 和用量。 |
| Bot 档案、花名册、Main Bot 身份 | Host 服务端 | 每个 Bot 对应一个 AgentRef。persona 经 `enqueueAgentHomeProjection` 落到设备。 |
| Conversation、Turn、输入来源 | Host | 每个 Bot 一条 canonical 对话，每个群一条共享对话。 |
| 群：成员、admin、模式、轮次 | Host | 见 §9.5。 |
| 委派账本与结论 | Host | 执行结算来自 SDK 证据，结论由 Host 给出。 |
| Host 执行核心：per-Agent FIFO、`taskId` 代际 | Host | 用户输入、routine 和 Bot 触发共用（§9.2）。 |
| 结构化 outcome 的格式校验 | SDK daemon（K7） | 按 offer 里冻结的 schema 校验。语义校验和应用在 Host。 |
| 团队笔记 | Host | 放进 ContextPack。不读其他 Agent 的记忆。 |

不变量：

- I1：用户 key 只在设备上（ADR-036 D3）。
- I2：周期规则只在 Host。SDK 只接收时间点。spec 已经写明 "Recurring schedules remain Host-driven; the device does not interpret cron"（[Durable Pi lane](../spec.md#durable-pi-lane-experimental-flag-gated)）。
- I3：每个 occurrence 只有一个 execution identity。只有原 task 已经有设备 terminal，并且符合 §12.4 第 9 条时，才换新一代 `taskId`。
- I4：唤醒只是提示，持久化的行才是事实。唤醒丢失只会推迟工作，不会丢失或重复工作。#410 用同一条规则。
- I5：mailbox 字节只有一个权威：保留的行（#411）。
- I6：推理用量只是遥测，不作为 billing、quota 或 entitlement 的依据（[Terminal inference usage observation](../spec.md#terminal-inference-usage-observation)）。
- I7：hosted 真相层不为 routine 计时（O7）。
- I8：每个委派只有一个结论，并且回报给发起方（发起方已删除的除外）。执行结算（SDK 证据）和委派结论（Host）分开记录。
- I9：结果按执行身份绑定：`taskId`、AgentRef 和 Host 侧的 `destinationBinding`。不按正文匹配。
- I10：不从模型正文推导语义。点名、PASS 和委派对象只来自结构化输入或 outcome。
- I11：一个 Agent home 同时只有一个 writer，跨用户输入、routine 和 Bot 触发。
- I12：每条用户输入派生的 Bot 自发执行有预算，委派链有 hop 上限。

## 6. 端到端流程

### Topology L：Host 在设备上有进程（主路径）

Aiphabee 属于这一类。它的 local agent 在同一个进程里运行 embedded server（SQLite）和 daemon（Aiphabee `apps/local-agent/src/research-pass-host.ts`）。

```text
Host 服务端（定义真相）             设备上的 Host 进程（embedded server + daemon）
  routine r1 定义 v3 ──设备拉取──▶ 镜像 ──▶ 计算下一个时点 t
                                           │
                                           ▼
                                server.wakes.schedule({ dedupKey: "r1:v3:t", availableAt: t })
                                           │   SQLite 持久化；只有一个定时器
                                           ▼   到期
                                wake hook ──▶ Host 账本事务：
                                                1. 插入 occurrence（key 唯一）
                                                2. 从当前时间计算下一个时点 t'
                                                3. wakes.schedule("r1:v3:t'")
                                           │
                                           ▼
                                server.executions.submit(input)，taskId 由 occurrence 派生
                                           │
                                           ▼
                                daemon 用用户的 key 执行 ──▶ messageEgress ──▶ Host 结果 outbox
  结果投影 ◀──────────────上传（幂等）───────────────┘
```

步骤：

1. Host 从服务端拉取定义，保存镜像。
2. Host 计算下一个时点，调用 `wakes.schedule`。`dedupKey` 包含 routine、定义版本和时点。
3. 时点到期后，SDK 调用 Host 的 wake hook。
4. hook 在一个事务里写 occurrence 和下一个时点 t'。t' 从当前时间算起。事务提交后，hook 调度下一次 wake。
   - 重复投递时，occurrence 已经存在。hook 读取账本里的 t'，不重新计算，然后再次调度。`dedupKey` 相同，所以不会产生第二个待投递的 wake。
5. hook 用由 occurrence 派生的 `taskId` 调用 `executions.submit`。提交前先持久化完整输入。
6. daemon 用用户自己的 key 执行。结果经 `messageEgress` 回到 Host。
7. Host 把结果写入 outbox，然后上传到服务端。

设备休眠时，wake 不会运行。设备醒来后，过期的 wake 立即投递一次。hook 比较 `availableAt` 和当前时间。延迟超过 Host 定义的阈值时，hook 把这次记为补跑（trigger 为 `catch_up`），并从当前时间计算下一个时点。每个 routine 只有一个待投递的 wake，所以补跑只发生一次。

### Topology H：Host 在设备上没有进程

例如 Host 服务端在云端，设备只运行 SDK daemon。这时 Host 用自己服务端的定时器，按时调用 `submitAgentExecution(tenant, input)`。执行仍在设备上，用用户的 key。SDK 的 hosted 真相层不提供定时器（O7）。设备离线时，这次执行要等设备上线。

这是 O8 定义的例外。这种调度属于 Host 自己的业务：spec「Execution receipts, bounded startup and custom harness identity」一节写明 "Business scheduling and device choice stay with the host"。本 PRD 的主路径是 Topology L。

### 委派（Topology L 和 H 相同）

```text
Bot A 的执行（由用户输入、routine 或另一个 Bot 触发）
  ├─ messageEgress：A 的回复
  └─ submit_result：{ actions: [{ kind: "delegate", to: "B", request: "…" }] }
        │  A 的设备 terminal（带 outcome）
        ▼
Host 事务：
  1. 插入委派（key = H(A.taskId, 动作序号)），检查 hop 和预算
  2. 在 B 的 canonical 对话里插入 Turn（来源 bot_request）
  3. 在 B 的 Agent 队列里排 intent
        │  轮到 B
        ▼
executions.submit（taskId 由 B 的 intent 派生；先持久化完整输入）
        │
        ▼
B 的执行：回复（messageEgress）+ outcome（可以继续委派）
        │  B 的设备 terminal
        ▼
Host 事务：结算 B 的 Turn → 委派结论 answered
           → 在 A 的对话里插入 Turn（来源 bot_reply，内容是 B 被接受的回复）
           → 在 A 的队列里排 intent
```

A 的执行在交出委派后就结束，不等 B。细节和失败处理见 §9.4。

### 群聊一轮

```text
用户在群 R 里发言（UI 传结构化 mention：botId 列表）
  ▼
Host 事务：写入群对话；按模式和点名算出发言席位；每个席位排进对应成员的 Agent 队列
  ▼
成员 M 的执行：ContextPack = 群记录 + 群公告 + 成员列表；persona 来自 M 的 home
  └─ submit_result：post 或 pass，可以附 room_call
  ▼
Host：M 的 terminal 到达 → 发言写入群对话，或记为 PASS → room_call 在预算内追加席位
      超过宽限还没结束 → 本轮继续；之后到达的发言作为晚到发言写入一次
```

细节见 §9.5。

## 7. K2 契约草案：embedded server 的 wake 队列

### 7.1 位置

- 包：`@byok-sdk/server`。memory 和 SQLite 两种组合都提供。memory 组合重启后丢失 wake，不能用于需要 routine 的部署。
- 不进入 `@byok-sdk/cloud` 的 kernel 端口，所以 hosted 部署没有这个能力（O7）。
- SQLite 组合把 schema 从 4 升到 5，新增一张表（`packages/server/src/stores/sqlite/index.ts` 的 `SQLITE_SCHEMA_VERSION`）。升级沿用现有的显式 adoption 规则：先停止所有 writer，再备份。
- 单一 owner 由 [#403] 保证。同一个数据库文件第二次打开时抛出 `SqliteOwnershipError`，所以一个 wake 只由一个进程投递。

### 7.2 API

wake hook 是 `createByokServer` 的 `wake` 选项，形状和 `agentMessage` 一致：一个异步的 `consume` 方法，至少投递一次，由产品持久去重。

```ts
interface CreateByokServerOptions {
  /** 至少投递一次，可能并发重投。Host 必须按 dedupKey 或自己的 occurrence key 持久去重。 */
  wake?: {
    consume(wake: DueWake, signal: AbortSignal): Promise<void>;
  };
}

interface ByokServer {
  readonly wakes: {
    /** 没有配置 wake hook 时抛出 WakeHookMissingError，不写任何行。 */
    schedule(input: WakeScheduleInput): Promise<WakeScheduleResult>;
    /** 删除 queued 状态的 wake。返回是否删除了一行。 */
    cancel(dedupKey: string): Promise<boolean>;
    /** queued 和 delivering 状态的 wake，按 availableAt 排序。 */
    pending(): Promise<readonly WakeRecord[]>;
  };
}

interface WakeScheduleInput {
  /** 1–256 个字符，由 Host 定义，例如 `routine:<id>:<version>:<slotMs>`。 */
  dedupKey: string;
  /** epoch 毫秒。最多比当前时间晚 366 天。 */
  availableAt: number;
  /** 不透明的 Host 关联数据，最多 4 KiB。 */
  payload?: string;
}

interface WakeScheduleResult {
  wakeId: string;
  /** 新建为 true；同一个 key 已经存在并且内容相同为 false。 */
  accepted: boolean;
}

interface DueWake {
  wakeId: string;
  dedupKey: string;
  availableAt: number;
  /** 本次投递时的墙钟时间。 */
  deliveredAt: number;
  /** 第几次投递，从 1 开始。 */
  delivery: number;
  payload?: string;
}

interface WakeRecord {
  wakeId: string;
  dedupKey: string;
  availableAt: number;
  state: 'queued' | 'delivering';
  deliveries: number;
  /** 上一次 hook 拒绝时的错误消息，最多 1 KiB。 */
  lastError?: string;
  /** hook 拒绝后的下一次投递时间。 */
  retryAt?: number;
  payload?: string;
}
```

### 7.3 语义

1. `schedule` 按 `dedupKey` 幂等：
   - 同一个 key，`availableAt` 和 `payload` 相同：返回原来的 `wakeId`，`accepted: false`。
   - 同一个 key，内容不同：抛出 `WakeConflictError`。
   - 投递完成的 wake 保留 7 天，用于去重。所以 Host 重新调度一个已经投递过的 key 时，不会再次触发。
2. 投递：
   - SDK 只用一个定时器，指向最早的投递时间。投递时间是 `availableAt`，被拒绝过的 wake 用 `retryAt`。队列为空时不设定时器。
   - 每次最多等待 60 秒，然后用墙钟和 `availableAt` 比较。理由：系统休眠时单调时钟可能不前进，一个长定时器会晚到。这个上限让设备醒来后最多晚 60 秒投递。
   - 到期的 wake 按 (投递时间, `wakeId`) 的顺序逐个投递给 hook。
   - hook resolve：wake 完成。
   - hook reject：wake 回到 `queued`。SDK 把 `retryAt` 设为 60 秒后，不修改 `availableAt`。其他到期的 wake 照常投递。SDK 不限制投递次数，只记录 `deliveries` 和 `lastError`。重试上限和放弃由 Host 的账本决定。
   - 投递期限：每次投递最多 60 秒。到期时，SDK 中止传给 hook 的 `signal`，按 reject 处理这次投递，然后继续投递下一个 wake。所以一个挂起的 hook 不会卡住整个队列。这个 promise 之后再 settle，属于旧的投递编号，SDK 忽略它。同一个 wake 因此可能同时有两个 hook 调用。Host 的去重必须覆盖并发调用，和 `agentMessage` 的要求相同。
3. 崩溃恢复：启动时，`delivering` 状态的 wake 回到 `queued`，然后重新投递。投递语义是至少一次。hook 必须幂等：Host 用 occurrence key 去重；`executions.submit` 遇到已经投递的重复输入时返回冲突，要求精确读回，不创建新的执行（[Host exact Agent message disposition readback](../spec.md#host-exact-agent-message-disposition-readback)）。
4. 过期的 wake：SDK 不丢弃过期的 wake。设备醒来后立即投递，`deliveredAt - availableAt` 就是延迟。是否补跑，是否记为 missed，都由 Host 决定。
5. 取消：`cancel(dedupKey)` 只删除 `queued` 的 wake。`delivering` 的 wake 不中断，所以 hook 要自己检查 routine 是否已经暂停。
6. hook 不能等待执行结束。它只写账本、调度下一次 wake、提交执行，然后返回。投递期限只用来隔离故障，不是正常的执行时间。
7. 清理：wake 端口提供有界的 `collectExpired(now, limit)`，删除完成超过 7 天的记录。server 在启动时和每批投递后调用它。#412 的 `runMaintenance` 落地后，也调用同一个方法。

### 7.4 与研究稿 §8.2、cloud-do 的差异

| 项 | ADR-036 研究稿 §8.2 统一 inbox | cloud-do inbox | K2 wake 队列 |
|---|---|---|---|
| 来源 | message、schedule、callback | message、schedule、invocation | 只有时间点 |
| 周期规则 | `bot_schedule` 表，cron 或单次 | 无，单次 | 无，单次；规则在 Host |
| 过期 | 未定义 | `expiresAt`，默认 `availableAt` 加 1 天 | 无；过期的 wake 也投递 |
| 最远时间 | 未定义 | 30 天 | 366 天 |
| 合批 | 无 | 一次唤醒最多 16 项 | 无，逐个投递 |
| 执行 | daemon 直接启动 execution | DO 内执行，平台 key | 回调 Host，Host 用 `executions.submit` 提交 |

两处差异的理由：

- 去掉 `expiresAt`：Host 只在 hook 里调度下一次 wake。如果 wake 在设备休眠时过期并被丢弃，下一次 wake 就不会产生，routine 会停止。
- 最远时间 366 天：每月和每年的 routine 超过 30 天。上限只用来发现时间单位错误。

### 7.5 K2 验收

- 同一个 key、同样的内容调度两次，只有一行；内容不同时抛出 `WakeConflictError`。
- 没有 wake hook 时，`schedule` 抛出 `WakeHookMissingError`，不写行。
- 到期的 wake 按顺序逐个投递。
- hook reject 后，60 秒后再次投递（假时钟）。
- hook 60 秒内没有 settle：`signal` 被中止，wake 回到 `queued`，下一个到期的 wake 照常投递；旧的 promise 之后 resolve，不改变 wake 的状态。
- 进程在 `delivering` 状态被 SIGKILL：重启后再投递一次；Host 按 occurrence key 去重，只有一个 execution。
- 墙钟前跳 3 天、单调时钟不动（注入时钟）：60 秒内投递一次，`availableAt` 保持原值。
- 队列为空时没有定时器，也没有周期唤醒。
- 第二个进程打开同一个数据库：`SqliteOwnershipError`。
- schema 4 的数据库没有显式 adoption 时，新版本拒绝启动；adoption 后保留已有数据。
- `collectExpired` 只删除完成超过 7 天的记录，每次不超过 `limit` 行。

## 8. SDK 重构契约：K5–K7

三项都是破坏性变更（O10）。删掉的入口不保留别名；`createDaemon` 和 server 遇到旧字段直接抛出带类型的错误。

### 8.1 K5：统一 fresh 执行提交

现状：

- 所有 `enqueue*` 共用一个幂等内核：Host 指定 `taskId`，offer 回执和 delivered 回执去重，重复返回 `agent_task_already_exists`（`packages/cloud/src/cloud.ts:1138-1253`）。
- `submitRecurringExecution` 只比它多一层更严的 schema 和 consumer 检查（`packages/cloud/src/recurring.ts`）。
- `dispatchFreshAgentEgress` 返回进程内的 `TaskHandle`（`packages/server/src/index.ts:740`）。`examples/basic` 的使用方丢掉它，失败后靠 `tasks.offer` 读回恢复（`goal-btw.ts:199`、`clarification.ts:144`）。

契约：

```ts
interface ByokServer {
  readonly executions: {
    /** Host 先持久化 input 再调用。已经投递的 taskId 再提交返回冲突，要求精确读回，不产生新的执行。 */
    submit(input: AgentExecutionInput): Promise<EnqueuedOffer>;
  };
}
// cloud 侧：submitAgentExecution(tenant, input)
```

- `AgentExecutionInputSchema` 由 `RecurringExecutionInputSchema` 改名而来，并做两处修改：`messageEgress` 改为可选；只有选了 `messageEgress` 时，才要求 `agentMessageContext` 和已注册的 Agent message consumer。
- `taskId`、`deviceId`、显式 `runtime`、AgentRef、`egressPolicy`、`terminalProjection` 仍然必填。`sessionRef` 和未知字段仍然拒绝。
- 设备离线时照常入队，设备上线后投递。是否先查在线状态由 Host 决定。
- 删除：`recurring.submit`、`submitRecurringExecution`、`RecurringExecutionInputSchema`、`dispatchFreshAgentEgress`、公开的 `enqueueFreshAgentEgressOffer`。exact resume 用的 `dispatch()` 和 prepared 提交不变。
- 迁移：`scripts/release/recurring-smoke.mjs`、`scripts/integration/salesko-recurring.test.ts`、`scripts/integration/salesko-recovery-postgres.test.ts`、`examples/basic`、spec 的 [Recurring Host composition requirements](../spec.md#recurring-host-composition-requirements) 和相关段落、`docs/protocol.md`、`packages/server/README.md`、`api-surface/` 的 server 和 cloud golden。

验收：

- api-surface 只剩一个 fresh Agent 提交入口；没有 fresh 路径返回 `TaskHandle`。
- 已经投递的 `taskId` 再提交：冲突加读回，没有第二个执行。
- 没有 `messageEgress`、只有 result-document 的提交被接受。带 `messageEgress` 但没有注册 consumer 的提交被拒绝，不写任何行。
- 原 recurring 的集成、重启和 Postgres 恢复测试改名后通过。

### 8.2 K6：busy decline 的 typed code

现状：`task.decline` 的 payload 是 `{reason, retryable?, agentRef?}`（`packages/protocol/src/messages.ts:864-868`）。home busy 只体现在 reason 文本里（`packages/client/src/daemon/task-runner.ts:3151`）。

契约：

- `task.decline` 增加可选字段 `code`，取值是封闭枚举：`agent_home_writer_busy`、`agent_home_reader_busy`。home busy 的拒绝（`task-runner.ts:3151` 和 `AgentHomeBusyError` 路径，`:2230`）必须带 `code`；其他 decline 不带。
- 按协议 v2 的冻结规则，这是新增的可选字段，不升协议版本。freeze-guard golden 按新增更新。
- `code` 投影到 cloud 的 terminal 结果和 server 的 `tasks.deviceTerminal`。
- Host 只看 `code`。reason 文本只用于显示，不解析。

验收：端到端的 busy 拒绝带 `code`，其他拒绝不带；§9.2 第 4 条、§12.4 第 9 条和 §12.5 都按 `code` 判断。

### 8.3 K7：结构化 outcome 通道

现状：

- 结果文档由设备上的 `DaemonConfig.resultDocument.extract(output, task)` 产出（`packages/client/src/daemon/create-daemon.ts:588`）。这是 Host 放在设备上的代码，CLI daemon 没有，所以只跑 daemon 的设备用不了。
- 例子对整段最终文本做 `JSON.parse`（`examples/basic/clarification.ts:85-87`），文本前面多一个字就失败。
- runtime 没调用 `send_agent_message` 时，daemon 用同一段最终文本代写回复（`task-runner.ts:3960-3980`），回复和结果文档抢同一段文本。
- durable Pi 另有一套：自己写 `{text}` 结果文档。
- result-document 的 `terminalProjection` 是 `.strict()` 的 discriminated union（`packages/protocol/src/terminal-projection.ts:13-19`）。wire 只接受 major 2（`packages/protocol/src/version.ts:38`）：cloud 拒绝其他 major 的 envelope，也拒绝不含 2 的 hello（`packages/cloud/src/inbound.ts:499,521`）。
- daemon 解不开一条可执行消息时冻结 mailbox 游标，后面的消息也不确认（`packages/client/src/daemon/long-poll-transport.ts:498-510`）。
- daemon 重启时，没有落盘 terminal 的任务一律记为 `task.fail{reason:'daemon_interrupted', retryable:false}`（`packages/client/src/daemon/create-daemon.ts:2069-2088`）。已落盘的 terminal 按原字节重发（`create-daemon.ts:2443-2455`）。

契约：

- offer：result-document 的 `terminalProjection` 增加必填字段 `schema`，形状是 `{ mode: 'result-document', contract, schema }`。
- wire：这改了现有的 strict schema，按冻结规则属于破坏性变更。K7 把 wire major 从 2 升到 3（`PROTOCOL_VERSION = 3`），没有 v2 reader，做法和 v1→v2 相同（[docs/protocol.md](../protocol.md) 开头一段）。freeze-guard golden 按 v3 重新生成。不用 capability 协商，也不新增 mode：那样新旧两种 result-document 会同时存在，违反 O10。
- `schema` 是 JSON Schema 2020-12 的受限子集，最大 16 KiB。允许的关键字：`type`、`properties`、`required`、`additionalProperties`（只能为 `false`）、`items`、`enum`、`const`、`oneOf`、`minLength`、`maxLength`、`minItems`、`maxItems`、`minimum`、`maximum`、`description`。其他关键字在提交时（Host 侧）和 daemon 准入时都拒绝。
- outcome 文档最大 64 KiB，在现有 `task.complete.document` 的 1 MiB 上限之内。
- 设备：SDK 新增保留的 MCP server `byokagentresult`，只有一个工具 `submit_result`，`inputSchema` 就是 offer 里的 `schema`。
  - daemon 校验通过后，先把 outcome 持久化到 `.byok/`（fsync），再确认这次工具调用。确认表示 outcome 已暂存，不表示执行成功：runtime 之后还会继续，可能失败或被中断。
  - 同一个执行再交一份不同的 outcome 被拒绝；交同样的内容返回同一个回执。规则和 message draft 相同。
  - 校验失败时工具返回错误详情，没有存任何东西，模型可以改了重交。
- terminal：
  - runtime 成功结束且有暂存的 outcome：daemon 生成带 `document` 的 `task.complete`，按现有 journal 规则先落盘再发出。崩溃后只重放这个已落盘的 terminal，同一份文档只投递一次。
  - runtime 成功结束但没有暂存 outcome：`task.fail`，不可重试。
  - runtime 失败、被取消，或者成功 terminal 落盘之前 daemon 中断：按现有规则产生失败、取消或 `daemon_interrupted` 的 terminal，不带 `document`。暂存的 outcome 只作本地审计记录，跟随这个 task 的本地记录保留和清理，不交给 Host。
- durable Pi：注册同一个工具，走同一个校验入口，terminal 规则相同。删除它自己写 `{text}` 的路径。
- 删除：`DaemonConfig.resultDocument`、`ResultDocumentExtractor`。`createDaemon` 遇到这个字段抛出带类型的错误。
- prepared lane：SummaryJob 现在是零工具记录（spec「Explicit internal result projection under Agent egress」）。改为一个工具的记录，`submit_result` 计入冻结的工具面，按 prepared 记录现有的版本规则切一次。这次切换和 wire v3 在同一次升级里完成，共用一次排空。
- 校验库：仓库里现在没有 JSON Schema 校验器。K7 的 issue 选定实现（第三方库或自写子集校验），并在 package.json 声明依赖。本节列出的子集和拒绝规则是规范。
- 迁移：`examples/basic` 的 clarification 和 goal-btw（含测试和使用文档）、SummaryJob、durable Pi、spec 的 result projection 和 prepared lane 段落、下游 Salesko 的 SummaryJob（不在本仓库）。

升级与排空（K7 发布时）：

- 准入：v3 的 server 只接受 `v: 3` 的 envelope 和声明了 3 的 hello。v2 daemon 在握手时被拒（`hello_protocol_version_unsupported`），收不到 v3 offer；v3 daemon 也连不上 v2 server。
- 顺序：先在旧版本上停止提交新执行，等所有 pending 行被处理并确认、在途执行都有 terminal、daemon 的 pending terminal 都已被 server 确认。然后升级 server 侧（embedded server、`@byok-sdk/cloud`、`@byok-sdk/cloud-dataplane`），再升级 daemon。Topology L 的 Host 同时升级 embedded server 和 daemon，在应用更新前停止提交并等待排空。Topology H 的设备在升级之前一直被拒绝连接。
- 启动检查。三处都 fail closed，不改写也不删除任何行：
  - embedded server：现有的 SQLite 检查（`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`，`packages/server/src/stores/sqlite/index.ts:291-301`）以 `PROTOCOL_VERSION` 为准，升到 3 后自动拒绝 pending 的 v2 行。
  - cloud-dataplane：现在没有这项检查。K7 补上同样的 pending 行检查：有 pending 的 v2 行时，组合在初始化阶段失败。
  - daemon：现在也没有。v3 解码器会在恢复循环里抛出泛化的解析错误（`create-daemon.ts:2069-2074`）。K7 增加带类型的启动错误：未结清的恢复任务或 pending terminal 里有非 v3 的 envelope 时拒绝启动。
- 检查失败时：保留数据库或 store，用旧 SDK 完成排空（SQLite 的检查语句见 [docs/protocol.md](../protocol.md#sqlite-startup-check-for-wire-major-upgrades)）；或者换新的状态目录并重新 enrollment，由 Host 按自己的 intent 重新提交没完成的工作。

验收：

- outcome 已暂存、runtime 还没结束时 SIGKILL daemon：恢复后是 `task.fail{reason:'daemon_interrupted'}`，不带 document；暂存的 outcome 只在本地审计记录里。
- runtime 成功结束、带 outcome 的 `task.complete` 已落盘、发出之前 SIGKILL daemon：恢复后这个 terminal 只投递一次。
- outcome 暂存之后 runtime 失败或被取消：terminal 不带 document。
- 不调用 `submit_result`：`task.fail`，不可重试。
- schema 不符：工具返回错误，模型重交后只有一份 outcome；第二份不同的 outcome 被拒绝。
- durable Pi 和 prepared lane 交出的文档形状相同。
- 只跑 CLI daemon、没有任何 Host 代码的设备上，带 outcome 的执行跑通（Topology H 冒烟）。
- `createDaemon({ resultDocument })` 抛出带类型的错误；api-surface 里 `DaemonConfig` 没有 `resultDocument`。
- v2 daemon 连接 v3 server：hello 被拒，没有 offer 投递给它。
- 有 pending v2 行的 SQLite 或 Postgres、有未结清 v2 journal 的 daemon store：启动失败并返回带类型的错误，没有行被改写或删除。

### 8.4 顺序

K5 和 K6 可以并行，也可以和 K1–K3 并行。K7 在两者之后：它用 K5 的提交 schema，并且和 K6 改同一个协议文件。K7 是 wire major 切换，发布时按 §8.3 的顺序先排空再升级。

## 9. Bot 协作契约

本节定义 Host 侧的协作模型。实现是 K8 的 copy-and-own 参考实现，放在 `examples/`，不是 SDK API。表里的数值是参考实现的默认值，Host 可以调整，但必须有上限。

### 9.1 模型

| 对象 | 内容 | 权威 |
|---|---|---|
| Bot | 名字、角色、persona、模型、toolsets、是否 Main Bot、所在设备；对应一个 AgentRef | Host 服务端 |
| Conversation | 每个 Bot 一条 canonical 对话；每个群一条共享对话 | Host |
| Turn | 一次输入、它的执行和结算。输入来源：`user`、`routine`、`bot_request`、`bot_reply`、`room_slot` | Host |
| 群（Room） | 成员（最多 12 个）、admin、模式（`everyone` 或 `admin`）、公告、轮次预算 | Host |
| 委派（Delegation） | 发起方 Turn、目标 Turn、回传 Turn、hop、结论 | Host |
| Execution | 一个 SDK task：offer、attempt、message、outcome、terminal | SDK |

- 一个 Bot 只在一台设备上。它的 home、persona 文件和 `MEMORY.md` 都在那台设备上。把 Bot 搬到另一台设备不在本计划内。
- Bot 改资料时，Host 推进 AgentRef 的 `profileRevision`，用 `enqueueAgentHomeProjection` 把新 persona 落到设备。已经提交的执行继续用旧的 AgentRef，下一次执行用新的。
- 对话 PRD 的绑定约定继续适用：`destinationBinding = conversationId`，`freshnessCursor = turnId`。群发言的 `destinationBinding` 是群的 conversationId。

### 9.2 Host 执行核心

用户输入、routine 和 Bot 触发共用这一层。每种触发来源有自己的账本（Turn、occurrence、委派、群席位），账本只向核心排 intent。

1. 每个 Agent（tenant、deviceId、agentId）一个 FIFO 队列。默认按入队顺序。Host 要调优先级（例如用户输入先于 routine），必须写成明确的策略。
2. 每个 Agent 同时最多一个 writer 执行在途（I11）。
3. `taskId = H(intentKey, generation)`。提交前持久化完整输入，然后调用 `executions.submit`。不确定提交是否成功时，用 `tasks.offer(taskId)` 读回，用同样的输入恢复。
4. 只有读到设备 terminal 后才换代。允许换代的只有两种：decline 的 `code` 是 `agent_home_writer_busy` 或 `agent_home_reader_busy`（K6）；或者执行失败，并且触发来源的重试策略允许。只取消、读不到 terminal 时不换代。
5. 执行结算和 intent 结论分开记录。执行结算来自 SDK 证据：消息处置、设备 terminal、outcome 文档。intent 结论由 Host 给出，回报给触发来源的账本，每个 intent 只有一个结论。
6. 每个 intent 的等待时间有上限。超过上限还没开始执行时，Host 取消还没被认领的 offer（还没被 lease 的 offer 取消后立即生效，不会再运行），结论为 `expired`。
7. Host 读到成功的 terminal 后，在一个事务里按 `taskId` 应用 outcome，只应用一次。应用时按当前状态重新校验。某个动作已经不合法时（例如目标 Bot 已删除），只拒绝这个动作，并写进发起方下一次的 ContextPack。
8. 恢复靠服务端的持久 outbox 扫描（对话 PRD 的规则），不靠浏览器轮询。
9. Topology L 的定时（等待上限、退避）用 K2 的 wake 队列；Topology H 用 Host 服务端的定时器。消息和回调不进 wake 队列。

### 9.3 Bot 执行的 outcome 契约

每个 Bot 执行使用两条通道：

- `messageEgress`：Bot 说的话。自己对话里的执行和被委派的执行用它；群发言不用（§9.5）。
- result-document（K7）：Bot 要 Host 做的事。contract 是 `bot-turn-outcome.v1`，schema 由 Host 在提交时生成，冻结在 offer 里。

Host 按这次执行的情况生成 schema：

- 花名册里的 Bot id、群 id 和可用模型写成 `enum`，模型交不出不存在的对象。
- 只有 Main Bot 的 schema 包含管理类动作。普通 Bot 的 schema 里没有这些动作，交不出来；Host 应用时再按角色校验一次。
- 只有群发言执行的 schema 包含 `post`、`pass` 和 `room_call`。

动作（参考实现 v1）：

| `kind` | 字段 | 谁能用 | Host 的处理 |
|---|---|---|---|
| `delegate` | `to`、`request`（≤ 8 KiB） | 所有 Bot | 新建委派（§9.4） |
| `ask_user` | `question`、`answerKind`（`text` 或 `single_choice`）、`options` | 所有 Bot | 建问题卡片。回答作为新一轮 `user` 输入，同 `examples/basic/clarification.ts` 的做法 |
| `post` | `text`（≤ 16 KiB） | 群发言执行 | 写入群对话 |
| `pass` | 无 | 群发言执行 | 本席位不发言 |
| `room_call` | `members` | 群发言执行 | 在本轮预算内追加席位 |
| `create_bot` | `localId`、`name`、`role`、`persona`、`model` | Main Bot | 见 §9.6 |
| `update_bot` | `botId`、要改的字段 | Main Bot | 推进 `profileRevision` |
| `delete_bot` | `botId` | Main Bot | 见 §9.6 |
| `create_room`、`update_room` | 名称、成员、admin、模式、公告 | Main Bot | 写群账本 |
| `team_note` | `text`（≤ 300 字） | Main Bot | 追加团队笔记 |

- `actions` 可以为空，表示只有回复。
- 执行没交 outcome 就结束是 `task.fail`（K7）：回复照常显示，动作一个都不应用。执行失败、被取消或中断时，即使暂存过 outcome，terminal 也不带它，动作同样一个都不应用。
- 同一份 outcome 里引用新建的 Bot，用 `localId`。

### 9.4 委派

1. A 的 outcome 里有 `delegate`。Host 在应用 A 的 outcome 的事务里：
   - 插入委派，key 是 `H(A.taskId, 动作序号)`。同一个 terminal 应用两次也不会产生第二个委派。
   - 计算 `hop`：A 这一轮的 hop 加 1，用户输入的 hop 是 0。默认上限 4，超过时结论为 `refused`。
   - 检查这条用户输入派生的 Bot 自发执行预算，默认 12 次。超过时结论为 `refused`。
   - 在 B 的 canonical 对话里插入 Turn，来源 `bot_request`，用结构化元数据记录发起方和委派 id；在 B 的队列里排 intent。
2. B 的执行照常排队。B 正在自己的对话里执行时，委派等待；busy 拒绝只在读到设备 terminal 后换代。
3. B 的 terminal 到达后，Host 结算 B 的 Turn，给出委派结论，并在 A 的对话里插入 Turn（来源 `bot_reply`），内容是 B 被接受的回复和委派结论；在 A 的队列里排 intent。回传 Turn 的 key 是 `H(delegationId)`，所以只有一个。
4. 每个委派只有一个结论：

| 结论 | 条件 |
|---|---|
| `answered` | B 的执行成功，回复已接受 |
| `failed` | B 的执行失败，或不可重试地拒绝 |
| `cancelled` | 用户或 Main Bot 取消，按对话 PRD 的取消仲裁 |
| `refused` | 超过 hop 或预算；目标 Bot 已删除；发起方没有权限 |
| `expired` | 等待上限内没有开始执行（§9.2 第 6 条） |
| `abandoned` | 用户结束一个不确定的委派 |

5. 不确定：B 的执行已经请求取消但读不到 terminal，或者 B 的设备掉线超过 Host 的阈值。两边的对话都显示「不确定」，Host 不自动重派，委派暂时没有结论。读到 terminal 后按第 4 条给出结论；用户也可以结束它，结论为 `abandoned`。结论给出之后才到达的 terminal 只留作 B 对话里的审计记录，不转给 A。这和 §12.4 第 9 条对 occurrence 的处理一致：都不换代、不重派。区别是委派允许用户关闭，发起方不用一直等。
6. 发起方 A 已被删除时，回传 Turn 不再创建，结论只记在账本里。
7. 跨设备委派走同样的流程。Topology L 下，两台设备上的 Host 进程经 Host 服务端同步，每一跳最多多等一个同步间隔。

### 9.5 群聊

1. 群是一条共享对话。成员每次发言是该成员 AgentRef 的一次 fresh 执行：ContextPack 是群记录、群公告和成员列表，persona 来自成员自己的 home。不为每个成员维护隐藏会话。
2. 群发言执行只选 result-document，不选 `messageEgress`。发言内容是 outcome 里的 `post`。
3. 一轮由用户发言触发，也可以由群内 outcome 的 `room_call` 在预算内追加席位。Host 计算席位：
   - `admin` 模式下，普通消息只给 admin，被点名的成员排在 admin 后面。
   - 点名来自 UI 传来的 botId 列表，或 outcome 里的 `room_call`。Host 不扫描正文里的 `@名字`。
   - 只有用户或 admin 可以点全体。
4. 默认预算取自 DeepSeek Bot 的实际值：一轮的发言上限是初始席位数加 4，有 admin 时再加 4；每个成员一轮最多 2 次，admin 最多 4 次；用户不说话时，Bot 最多自己开 3 轮；晚到发言最多 10 条。
5. 每个席位都是成员 Agent 队列里的一个 intent，和成员自己对话里的执行排同一个队。成员忙时席位等待；超过群的宽限（默认 240 秒）还没开始，记为 `busy` 并跳过。
6. 成员开始执行后超过宽限还没结束，本轮继续往下走。它之后到达的 `post` 作为晚到发言写入一次，计入晚到预算。
7. 成员的执行失败或没交 outcome，席位记为失败并显示，不算 PASS。
8. 只有用户或 Main Bot 可以加人、移除成员或换 admin。被移除的成员还没开始的席位作废；已经在执行的，结果只进审计。

### 9.6 Main Bot 与团队管理

1. Bot 档案里有 `mainBot` 标记，可以有多个。Host 首次创建团队时建一个默认 Main Bot。
2. `create_bot`：Host 建档案和新的 AgentRef，用 `enqueueAgentHomeProjection` 把 persona 落到目标设备。`readAgentHomeProjection` 确认已应用后，才向新 Bot 派发执行。
3. `delete_bot`：Host 归档档案。它队列里还没开始的 intent 结论为 `cancelled`，指向它的委派结论为 `refused`。SDK 不删除它的 home。
4. 团队笔记只有 Main Bot 能写，条数和长度都有上限，放进每个团队 Bot 的 ContextPack。每个 Bot 的 `MEMORY.md` 仍然只属于它自己，不跨 Agent 读取。

### 9.7 不采用

| 方案 | 理由 |
|---|---|
| 把 Local TeamWorkspace 扩成云端群 | 它只在本机，没有云端协议，也没有跨设备的群（spec「Local TeamWorkspace」）。扩展会连带重做成员授权、存储、离线投递和生命周期。 |
| 用 `agent.message.publish` 的正文携带意图 | 正文只能是 `text/plain` 或 `text/markdown`；同一个 task 只有一份不可变正文；目的地只在 Host 侧。 |
| 同步阻塞的委派 | 发起方占着执行名额等目标，目标又排在同一类队列后面，容易死锁。 |
| `steer` 作为投递路径 | 尽力而为，没有处置结果。Claude 不支持，durable Pi 关闭了它。 |
| 设备上的 Host MCP 可执行文件 | 每个 Host 都要自己做 MCP 程序、nonce 交换、校验和 IPC，违背 O3；Topology H 还要分发可执行文件。 |
| 远程 MCP | toolset registry 只接受 `command` 和 `args`（`packages/client/src/daemon/toolset-registry.ts:178-182`）。 |
| 运行中往返 Host 的动作通道 | 正确性上不需要。成本是两种新消息、一个能力、一个 offer 字段、一个 outbox 和一张表，而且执行失败后副作用可能已经发生。推迟为 K9。 |
| SDK 里的 per-Agent 队列 | 队列混合了触发来源、优先级、等待上限和放弃策略，属于 Host 的策略（ADR-027「Run intent 与 policy：SaaS」）。O7 不允许 hosted 定时器，SDK 队列只能放进 `@byok-sdk/server`，Topology H 还要再做一遍。 |
| 照搬 DeepSeek Bot 的 `runRound`、`isPass`、`mentionsIn` | 它们从模型正文推导点名和 PASS，违反 I10。 |

## 10. 成本模型

### 10.1 收费单位

- 收费单位是超出 `TenantStorageEntitlement` 的存储。相关字段：`hardLimitBytes`、`mailboxLimitBytes`、`retentionPolicyId`、`downgradeGraceUntil`。
- 准入不变量：`committed + reserved + expected <= hardLimitBytes`（`packages/cloud-dataplane/src/stores/core/quota.ts`）。
- 价格和额度大小由产品决定。
- SDK 不计量 token、流量或执行（I6）。

### 10.2 服务器成本的设计规则

- R1：hosted 真相层不为 routine 计时（O7）。
- R2：空闲设备的数据库读取由唤醒驱动。兜底间隔只用来保证正确性，#410 建议默认 5 秒。
- R3：每个 Host 设计都要算出"每台空闲设备每分钟的服务器调用数"。目标是每 60 秒最多一次轻量调用。定义和命令用一个带版本的条件请求同步，不为每类数据各开一个轮询路由。
- R4：存储用量只有一个权威。有流量的租户也能完成保留清理（#411、#412）。
- R5：outcome 文档（K7）和 mailbox 一样计入存储用量，单份上限 64 KiB。

### 10.3 首个下游的现状

Aiphabee 现在和本节冲突（`main@31b7280e`）：

- `LOCAL_SUBSCRIPTION_OPERATION_POLICIES` 对 4 类设备端执行收 credits：`connector_test` 1、`mcp_tool_call` 5、`research_monitor_cycle` 20、`watchlist_check` 20（`packages/local-execution-protocol/src/index.ts:45-62`）。每次计费操作还会调用服务器：开始时 authorize，运行中每 60 秒一次 heartbeat，结束时 finish。
- 空闲设备每 60 秒至少调用 3 次 Worker，没有前置条件：`getBotBootstrap`、`getResearchMonitorBootstrap`、`registerResearchProjectionKey`（`apps/local-agent/src/connected.ts`）。最后一个每次都注册同一个 key。

调整见 §13.2 的 A1 和 A4。

## 11. 部署目标

### 11.1 现状

| 包 | Node / VPS | Workers |
|---|---|---|
| `@byok-sdk/cloud` | 支持（Hono） | 支持 |
| `@byok-sdk/cloud-dataplane` | 根入口：Postgres（`pg`）、R2/S3 对象存储、迁移、清理和维护 | `runtime` 入口：`nodejs_compat` + Hyperdrive + R2。每次测试都 dry-run `wrangler deploy`。迁移和维护不在这个入口里。 |
| `@byok-sdk/server` | 支持（`@hono/node-server`，memory 或 SQLite） | 不适用 |
| `@byok-sdk/cloud-do` | 不支持 | 只在 Cloudflare 上（Durable Objects） |

依据：[cloud-dataplane README「Deployment compositions」](../../packages/cloud-dataplane/README.md#deployment-compositions)、`packages/cloud-dataplane/src/runtime.ts`、[README「Choose a composition」](../../README.md#choose-a-composition)。

### 11.2 规则

1. VPS 是优化目标和主测试目标。参考组合：Node 24、`@byok-sdk/cloud`、`cloud-dataplane` 根入口、Postgres、S3 兼容对象存储。
2. Workers 继续支持。保留现有的 `worker-packaging` 和 `worker-e2e` 测试。
3. 新端口先有 Node 实现。Workers 实现可以晚一些，或者明确降级。例如 #410 的 `MailboxWake`：Node + Postgres 用 `LISTEN/NOTIFY`；Hyperdrive 不支持 `LISTEN/NOTIFY`，所以 Workers 按兜底间隔读取。
4. 维护任务（#412）只有一个入口。VPS 上由进程内计划或系统定时器调用；Workers 上由 Cron Trigger 调用。
5. `cloud-do` 保持只在 Cloudflare 上运行（O5）。

### 11.3 对 ADR-036 D7 的修订

D7 写在 cloud generic agent 的 ADR 里，原文是"Cloudflare 优先（DO / DO SQLite）；Node + Postgres 仅预留接口、不实现"。Postgres 真相层（`cloud-dataplane`）已经实现，和"仅预留"不一致。ADR-038 把 D7 限定为 `cloud-do` 的 backend，并把真相层的部署目标改为 §11.2。

## 12. 下游 Host 指南

本节是通用规则。K4 把它和 §9.2 的执行核心整理成独立的英文 Host 文档，并从 README 链接。

### 12.1 模型

| 对象 | 内容 | 权威 |
|---|---|---|
| Routine | 做什么、什么时候（规则和时区）、目标 Agent、结果去向、lifecycle、定义版本 | Host 服务端；设备保存镜像 |
| Occurrence | 一个计划时点：trigger、尝试次数、结算 | 设备上的 Host 账本 |
| Execution | 一个 SDK task：offer、attempt、terminal | SDK |

例子："每个交易日 09:00 检查自选股"是一个 routine。"2026-10-14 09:00 那次检查"是一个 occurrence。运行这次检查的 SDK task 是一个 execution。

### 12.2 时钟

- Topology L：用 K2 的 wake 队列。K2 之前，Host 自己的定时器要满足 §7.3 的同样语义。
- Topology H：用 Host 服务端的定时器调用 `submitAgentExecution`（O8）。
- 在任何拓扑中，都不在云端执行 BYOK 工作，也不在服务端保存用户的模型 key。

### 12.3 定义与命令

1. 服务端保存不可变的定义版本。每次修改产生一条命令回执，用 state version 做 CAS。
2. 每个 routine 同时最多一条待应用命令。上一条没有确认之前，新命令返回 `409`。
3. 设备用设备凭据拉取命令。拉取并入已有的同步调用，并按版本做条件响应（R3）。
4. 设备先持久化回执，再应用命令，最后确认。同一个命令 id 返回同一个确认。过期的版本返回 `version_conflict`，设备不做合并。
5. 命令不经过浏览器。没有打开浏览器时，routine 也要能同步。
6. 定义版本变化后，先完成当前 occurrence，再切换到新版本。

### 12.4 Occurrence 与 execution

1. `occurrence_key = SHA-256(routine_id, definition_version, trigger)`。trigger 包含类型（`scheduled` 或 `catch_up`）和计划时间。这个 key 在账本中唯一。
2. 写 occurrence 和推进下一个时点在同一个事务中完成。下一个时点从当前时间算起。错过的时点跳过。休眠后只补跑一次。
3. quiet hours 内的时点推迟到 quiet hours 结束，不丢弃。
4. 尝试次数有上限，例如 3 次，间隔至少 5 分钟和 15 分钟。下一个时点到期时，旧的重试作废。
5. 每个 routine 最多一个执行中的 occurrence 和一个待执行的 occurrence。
6. 时区存在定义里。用一个纯函数计算时点，设备和服务端共用。这样两边算出同样的期望时间。
7. `taskId` 由 occurrence 和 pass 派生，不含尝试次数。提交前持久化完整输入。
8. 不确定提交是否成功时，用 `server.tasks.offer(taskId)` 读回，和持久化的输入比较，然后用同样的输入恢复。不生成新的 `taskId`。
9. 只有原 task 已经有设备 terminal 时，才换新一代 `taskId`。用 `server.tasks.deviceTerminal(taskId)` 读取。允许换代的 terminal 只有两种：
   - decline，`code` 为 `agent_home_writer_busy` 或 `agent_home_reader_busy`（K6）；
   - 失败，并且尝试策略允许再试一次。

   只取消、读不到 terminal 时，不换新一代。只取消不会产生设备 terminal，原 task 仍可能在设备恢复连接后运行（[Host exact Agent message disposition readback](../spec.md#host-exact-agent-message-disposition-readback)）。这时 occurrence 保持未结算，Host 继续读回，直到读到 terminal。

### 12.5 并发

- 每个 Agent home 同时只有一个 writer attempt（[Durable Agent homes](../spec.md#durable-agent-homes)）。第二个 writer 被拒绝，decline 带 `code`（K6），可以重试。Host 只看 `code`，不解析 reason 文本。
- Host 按 Agent 排队，FIFO，等待时间有上限。不要依赖 daemon 排队。这个队列是 §9.2 执行核心的一部分，用户输入、routine 和 Bot 触发排同一个队。

### 12.6 结果

- `executions.submit` 要求 payload 带 `runtime` 和 `terminalProjection`。`messageEgress` 可选，选了就是 `required` 模式（K5）。给用户看的结果走 `messageEgress`，结构化结果走 `submit_result`（K7）。选了 `messageEgress` 也不保证 Host 一定收到消息：执行可能在发布消息之前就以失败结束。例如回复超过 `maxBytes` 时，daemon 的 outbox 拒绝这条消息（`packages/client/src/daemon/agent-message-outbox.ts`）。
- Host 用两条路径结算 occurrence：收到消息时，按消息结算；没有消息时，用 `server.tasks.deviceTerminal(taskId)` 读到失败 terminal，按失败结算。不能只等消息，否则 occurrence 会一直悬空，并显示为 `missed`。带结构化结果的执行以设备 terminal 为准，outcome 在 terminal 里（K7）。只有成功的 terminal 带 outcome；失败、取消和 `daemon_interrupted` 不带。
- "没有变化就不通知"是 Host 的投递过滤。
- 结果和待上传记录在一个事务里写入 outbox。上传可以重试，服务端按稳定的投影 id 去重。

### 12.7 Lifecycle

- 只存三个值：`active`、`paused`、`completed`。
- `paused` 阻止新的 occurrence，同时调用 `wakes.cancel`。正在执行的 occurrence 继续完成。要停止它，显式调用 `server.tasks.cancel(taskId, reason)`。
- `completed` 结束后续调度，保留历史。删除走单独的隐私流程。
- "已到期"在读取时由结束条件推导，不存储。

### 12.8 可见性

服务端在读取时推导两类状态，不运行 watchdog 或 cron。

同步状态：

| 状态 | 条件 |
|---|---|
| `synced` | 已应用版本等于当前版本，最后一次确认是 applied |
| `pending_sync` | 已应用版本为空或较旧，命令还没有确认 |
| `sync_failed` | 设备拒绝了命令。显示设备给出的错误码 |

运行健康只对 `active` 并且 `synced` 的 routine 计算：

| 状态 | 条件 |
|---|---|
| `device_offline` | 设备最后一次同步早于约 3 个同步间隔 |
| `missed` | 期望时间加宽限期已经过去，并且没有在期望时间之后完成的结果 |
| `on_schedule` | 其他情况 |

- 期望时间：取当前版本最后一个结果里的下一个时点。还没有结果时，用共享的时点函数从定义计算。
- 宽限期：至少是一个 occurrence 最长耗时的两倍。耗时包括同步间隔、排队等待和执行超时。
- 服务端只需要多存一个字段：设备最后一次同步的时间。这个字段的写入可以节流，例如距离上次写入超过一个同步间隔才写。

### 12.9 成本与凭据

- 不计量执行（O2）。
- 每台空闲设备每 60 秒最多一次轻量调用（R3）。
- 不用官方 key，不在服务端保存用户 key，不用 `cloud-do` 运行 BYOK 工作。

### 12.10 检查清单

- [ ] 定义和命令在服务端，有版本和 CAS。
- [ ] 设备拉取命令，同步不需要浏览器。
- [ ] 设备先持久化回执，再应用命令。确认是幂等的。
- [ ] occurrence key 唯一。下一个时点在同一个事务中推进。
- [ ] 错过的时点跳过，休眠后只补跑一次。
- [ ] 尝试次数有上限，旧的重试会作废。
- [ ] `taskId` 由 occurrence 和 pass 派生。提交前持久化完整输入。
- [ ] 不确定的提交用读回恢复，不生成新的 `taskId`。
- [ ] 只有读到设备 terminal 后才换新一代 `taskId`。只取消不算。
- [ ] busy 只看 decline 的 `code`，不解析 reason 文本。
- [ ] 每个 Agent 有 FIFO 队列，等待时间有上限。用户输入、routine 和 Bot 触发排同一个队。
- [ ] 暂停阻止新的 occurrence，取消正在执行的工作需要显式调用。
- [ ] 结果和上传在同一个 outbox 事务里。
- [ ] 没有消息的执行用 terminal 读回结算。
- [ ] 同步、离线和错过状态在读取时推导。
- [ ] 每台空闲设备每 60 秒最多一次轻量服务器调用。
- [ ] 没有官方 key，没有服务端 key 托管，没有执行计量。

### 12.11 与 RAFT 的对照

RAFT 也把时钟放在执行端：服务端管理 reminder 的生命周期和周期规则，Computer 持有定时器和唤醒，服务端的 watchdog 从不触发 reminder。差异如下：

| RAFT | 本指南 |
|---|---|
| 服务端推送更新；`armState` 和 watchdog 补推设备没有确认的行 | 设备按版本拉取；服务端在读取时推导状态，没有 watchdog |
| 晚到的触发从 `max(slot, now)` 推进：补跑一次，然后跳过 | 相同 |
| provider key 存在服务端，启动 agent 时下发给 Computer | key 不离开设备 |
| 没有 Computer 的 agent 创建 reminder 时返回 409 | Topology H 用 Host 服务端的定时器 |

## 13. 路线图

### 13.1 SDK（先做）

K1、K2、K3、K5、K6 互不依赖，可以并行。K7 在 K5、K6 之后；K4 在 K2、K5、K6、K7 之后；K8 在 K4 之后。每个阶段单独合并后，系统都处于可用状态。

| 阶段 | 范围 | 依赖 | 验收 |
|---|---|---|---|
| K1 存储记账与保留 | [#411]（P1）、[#412]（P2） | 无 | 成功标准 5 |
| K2 设备端 wake 队列 | [#420] | [#403]（已合并） | §7.5 |
| K3 空闲成本 | [#410]（建议从 P3 提到 P1）、[#391] | 无 | 成功标准 4；空 mailbox 的设备能冷启动，不等待 long-poll |
| K5 统一提交 | 新 issue，正文取 §8.1 | 无 | §8.1 |
| K6 busy typed code | 新 issue，正文取 §8.2 | 无 | §8.2 |
| K7 结构化 outcome 通道 | 新 issue，正文取 §8.3 | K5、K6 | §8.3 |
| K4 收尾 | Host 执行核心参考实现（§9.2，routine 和 Bot 触发共用）、routine 冒烟测试（扩展 [#418]）、Host 指南独立成文、[#399] | K2、K5、K6、K7 | 用默认配置跑通一个 routine 的调度、补跑和崩溃恢复；一个 routine 和一个 Bot 触发共用同一个 per-Agent FIFO；busy 拒绝只在读到设备 terminal 后换代；README 链接 Host 指南 |
| K8 Bot 协作参考实现 | 新 issue，正文取 §9；放在 `examples/` | K4 | §14.2 |
| K9 运行中动作通道（推迟） | 有证据时才开 issue | 见下 | — |

K9 的触发条件：下面任一项有测量数据，并且超过 owner 定的阈值。

- 委派目标的开始延迟（A 的执行结束到 B 开始）影响产品体验。
- ContextPack 放不下 Bot 需要读的内容，必须在运行中按需读取。
- 因 hop、预算等策略被拒、要到下一轮才知道的比例过高。
- 产品需要立刻停止某个 Bot，现有的取消做不到。

每个阶段都运行：

```sh
bun run build
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

K1 和 K3 的 dataplane 测试还需要 `docker compose -f docker-compose.test.yml up -d --wait`。K7 还要运行 `bun run check:release-pack`。

每个阶段在同一个 PR 中修改 spec：

- K1：存储记账和维护契约。
- K2：新增 embedded wake 队列一节，并修改 [Embedded SQLite device and receipt authority](../spec.md#embedded-sqlite-device-and-receipt-authority) 的 schema 版本。
- K3：events hold 的唤醒规则。
- K4：README 链接 Host 指南。
- K5：把 [Recurring Host composition requirements](../spec.md#recurring-host-composition-requirements) 改为统一提交，并修改 [Host exact Agent message disposition readback](../spec.md#host-exact-agent-message-disposition-readback) 里关于 recurring 提交的段落。
- K6：`task.decline` 的 `code` 及其投影。
- K7：result projection 和 prepared lane 的段落；新增保留名 `byokagentresult`；`docs/protocol.md` 的 wire major 和升级排空步骤。
- K8：只改 `examples/` 和文档。参考实现暴露出 SDK 缺口时另开 issue，不在 K8 里改 SDK。

回滚：

- K1、K3：按各自 issue 的迁移说明回滚。#410 写明部署顺序不影响正确性：没有 trigger 时，新代码退化为兜底间隔读取。
- K2：恢复 adoption 前的备份。旧版本拒绝 schema 5。
- K4、K8：只有参考实现、文档和测试，直接回退。
- K5、K6、K7：发布前直接 revert。发布后不提供兼容层（O10），按 release notes 的升级步骤处理。K7 发布后回退也是一次 wire major 切换，同样先排空。

### 13.2 下游接入：Aiphabee（不在本仓库）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| A1 | 命令同步：命令并入现有的 research monitor bootstrap 响应，按版本做条件响应。删除浏览器投递。服务端记录设备最后同步时间。projection key 只在 fingerprint 变化时注册。 | 无 |
| A2 | 用 K2 的 wake 队列替换两个本地调度循环 | K2、K5 |
| A3 | `watchlist_monitor` 作为 capability，运行在同一个 routine 核心上 | A2 |
| A4 | 删除 `LOCAL_SUBSCRIPTION_OPERATION_POLICIES` 的执行计费，改为存储超额解锁 | 无 |

A1 和 A4 不依赖 SDK，可以提前。

首个采用 Bot 协作的下游由 owner 另定。Salesko 的 recurring 测试随 K5 迁移，SummaryJob 随 K7 迁移。

## 14. 端到端验收矩阵

### 14.1 Routine

Topology L，在 K2 和 A2 之后执行：

| 类型 | 场景 | 期望 |
|---|---|---|
| 正常 | 设备在线，时点到期 | 一个 occurrence，一个 execution，结果进入历史 |
| 正常 | 没有打开浏览器时创建 routine | 一个同步间隔内应用 |
| 错误 | 设备拒绝定义 | `sync_failed`，显示错误码 |
| 错误 | 两个客户端修改同一个版本 | 第一个成功，第二个返回 `409` |
| 错误 | 提交的响应丢失 | 读回同一个 offer，没有第二个 execution |
| 错误 | wake hook 抛错 | 60 秒后再次投递，最终只有一个 execution |
| 错误 | wake hook 挂起 | 60 秒后中止这次投递，其他 routine 照常投递 |
| 错误 | 执行在发布消息之前失败 | Host 读到失败 terminal，按失败结算，occurrence 不悬空 |
| 错误 | 取消超时，读不到 terminal | 不换新一代 `taskId`；occurrence 保持未结算，直到读到 terminal |
| 边界 | 进程在投递中被杀 | 重启后再次投递；occurrence 去重，只有一个 execution |
| 边界 | 设备休眠三天 | 醒来后 60 秒内只补跑一次 |
| 边界 | 时点落在 quiet hours 内 | quiet hours 结束时运行 |
| 边界 | Agent 正忙 | occurrence 在 Host 队列中等待，只保留一个待执行 |
| 边界 | 运行中暂停 | 当前 occurrence 完成，之后没有新的 occurrence |
| 边界 | Host 进程停止超过 3 个同步间隔 | `device_offline` |
| 边界 | 设备在线，但调度没有运行 | 宽限期后显示 `missed` |
| 安全 | 检查服务端存储和请求日志 | 没有用户模型 key |
| 成本 | 空闲设备运行 1 小时 | 设备每 60 秒最多调用一次 Host 服务端 |

### 14.2 Bot 协作

K8 参考实现，Topology L 和 H 各跑一遍：

| 类型 | 场景 | 期望 |
|---|---|---|
| 正常 | A 委派同设备的 B | 一个委派，一个 B 执行；A 收到一个 `bot_reply` 输入 |
| 正常 | A 委派另一台设备上的 B（Topology H） | 同上；B 的设备上没有 Host 代码 |
| 正常 | Main Bot 一次建 3 个 Bot 和 1 个群 | persona 落到设备并确认后，才向新 Bot 派发执行 |
| 错误 | Host 在写入委派后、提交前崩溃 | 重启后用同样的输入提交，读回同一个 offer，只有一个 B 执行 |
| 错误 | B 的 terminal 或消息重复投递 | B 的 Turn 只结算一次，A 只收到一个回传 |
| 错误 | B 的设备离线 | B 的 Turn 显示等待设备；超过等待上限后取消未认领的 offer，结论 `expired`，A 收到一次 |
| 错误 | B 运行中掉线，取消后读不到 terminal | 显示不确定，不重派；用户结束后结论 `abandoned`；之后到达的 terminal 只进审计 |
| 错误 | B 执行失败或中断（即使已暂存 outcome），或没调用 `submit_result` | 结论 `failed`，A 收到一次；B 的动作一个都不应用 |
| 错误 | outcome 不符合 schema | 工具返回错误，模型重交后只有一份 outcome |
| 边界 | 委派链超过 hop 上限 | 结论 `refused`，A 收到一次 |
| 边界 | 一条用户输入派生的 Bot 执行超过预算 | 后续委派 `refused`，并显示原因 |
| 边界 | B 正在自己的对话里执行 | 委派在 B 的队列里等待；busy 拒绝只在 terminal 后换代 |
| 边界 | 委派进行中，Main Bot 改了 B 的资料 | 进行中的执行用旧 `profileRevision`，下一次用新的 |
| 群聊 | `admin` 模式下用户发普通消息 | 只有 admin 发言 |
| 群聊 | 成员交 `pass` | 不发言 |
| 群聊 | 成员输出空文本或执行失败 | 席位显示失败，不算 PASS |
| 群聊 | 成员超过宽限仍在执行 | 本轮继续；完成后作为晚到发言写入一次 |
| 群聊 | 成员正在自己的对话里执行 | 席位等待；超过宽限记为 `busy` 并跳过 |
| 安全 | 普通 Bot 的 outcome schema | 不含管理类动作；Host 应用时再校验角色 |

### 14.3 SDK 重构

| 阶段 | 场景 | 期望 |
|---|---|---|
| K5 | 已经投递的 `taskId` 再提交 | 冲突加读回，没有第二个执行 |
| K5 | 只有 result-document、没有 `messageEgress` 的提交 | 被接受 |
| K6 | home busy 的 decline | 带 `code`；其他 decline 不带 |
| K7 | outcome 已暂存、runtime 未结束时 SIGKILL daemon | 恢复后是 `daemon_interrupted` 失败，不带 document |
| K7 | 带 outcome 的 `task.complete` 已落盘、发出前 SIGKILL daemon | 恢复后这个 terminal 只投递一次 |
| K7 | outcome 暂存后 runtime 失败或被取消 | terminal 不带 document |
| K7 | `createDaemon({ resultDocument })` | 抛出带类型的错误 |
| K7 | 只跑 CLI daemon 的设备 | 带 outcome 的执行跑通 |
| K7 | v2 daemon 连接 v3 server | hello 被拒，没有 offer 投递 |
| K7 | 未排空的 v2 数据（SQLite、Postgres、daemon journal） | 启动失败，带类型的错误，不改写也不删除 |

## 15. 风险与最脆弱的假设

- 最脆弱的假设：需要 routine 的 BYOK Host 在设备上有进程（Topology L）。如果不成立，K2 帮不上忙，Host 改用 Topology H，在自己的服务端计时。SDK 不需要为此改动。
- 设备关机或休眠时，routine 不运行。这是 BYOK 的固有限制。用户通过 `missed` 和 `device_offline` 看到它。
- Workers 部署的空闲成本仍然高于 VPS，因为它按兜底间隔读取。O4 接受这一点。
- 只按存储收费时，服务器成本要靠 R1–R3 控制。下游不减少空闲调用，收入和成本就会脱节。
- schema 5 需要显式 adoption。已经部署的 embedded server 升级时，要停止 writer 并备份。
- 系统休眠会推迟定时器。K2 用 60 秒的等待上限加墙钟比较处理它，并用注入时钟的测试覆盖。
- 模型不调用 `submit_result` 的比例因 runtime 而不同，现在没有测量数据。不调用会让执行 fail closed。K8 验收前按 runtime 测量。
- Topology L 的跨设备委派经 Host 服务端同步。R3 限制了空闲调用，所以每一跳最多多等一个同步间隔。
- 热门 Bot 在 terminal 到 home 释放之间可能反复被 busy 拒绝，每次消耗一个 `taskId` 代际和一行 mailbox。Host 保持每个 Agent 只有一个 writer 在途来限制它。
- K5–K7 是破坏性变更。Salesko 的 recurring 测试和 SummaryJob、durable Pi、examples 都要在对应 PR 里迁移；下游升级没有兼容期。
- K7 升 wire major。跳过排空直接升级时，server、cloud-dataplane 或 daemon 启动失败，要用旧 SDK 排空，或者换新的状态目录并重新 enrollment。离线设备上的 pending 行会拖住排空。
- 两个 Bot 写同一个共享仓库没有保护（ADR-031 的 WorkspaceRef 没有实现）。

## 16. 实施与上线门槛

实施入口：

- 每个阶段先有 issue（K2 是 [#420]，K5–K8 按 §8–§9 开新 issue），再开 PR。
- 每个 PR 同时修改 spec，并通过 §13.1 的检查。

上线门槛：

- K1–K3 和 K5 合并并发布（A2 依赖 K5）。
- 首个下游完成 A1 和 A2，并通过 §14.1 的矩阵。
- 首个下游测量每台空闲设备每分钟的服务器调用数，记录部署前后的对比。
- Bot 协作上线另需：K4–K8 合并，K5–K7 发布；K8 参考实现通过 §14.2 和 §14.3；按 runtime 测量 `submit_result` 的成功率并记录。

[#391]: https://github.com/Ancienttwo/byok-sdk/issues/391
[#399]: https://github.com/Ancienttwo/byok-sdk/issues/399
[#403]: https://github.com/Ancienttwo/byok-sdk/pull/403
[#410]: https://github.com/Ancienttwo/byok-sdk/issues/410
[#411]: https://github.com/Ancienttwo/byok-sdk/issues/411
[#412]: https://github.com/Ancienttwo/byok-sdk/issues/412
[#413]: https://github.com/Ancienttwo/byok-sdk/issues/413
[#414]: https://github.com/Ancienttwo/byok-sdk/issues/414
[#418]: https://github.com/Ancienttwo/byok-sdk/issues/418
[#420]: https://github.com/Ancienttwo/byok-sdk/issues/420
