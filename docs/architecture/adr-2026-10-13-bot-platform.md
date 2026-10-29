# ADR-038：BYOK Bot 平台——成本模型、部署目标、routine 时钟与 Bot 协作

> **来源**：owner 2026-10-13 的决定，整理在 [PRD：BYOK Bot 平台——routine、Bot 协作、成本与部署](../researches/2026-10-13_bot-platform-prd.md) §2。决策 1、2、3、5 对应 PRD 的 O1–O4。决策 4、6 对应 PRD 的 O5–O8。决策 7–12 对应 PRD 的 O11–O16，决策 13 对应 PRD §9.4–§9.5（I8、I10、I12）。决策 7–13 依据 owner 同日的两项决定：O9（加 Bot 协作层）和 O10（项目未上线，该重构的直接重构，不留兼容层）。决策 4、6–13 由同一个 PR 提出。
> **取代**：[ADR-036](adr-2026-10-03-cloud-generic-agent.md) D7 中"Cloudflare 优先（DO / DO SQLite）；Node + Postgres 仅预留接口、不实现"对真相层的约束。D7 的其余内容不变。
> **关联**：ADR-036 D1（Bot 模式：每次唤醒都是新的执行）是决策 7–9、13 的基础。ADR-027 的权威表把「Run intent 与 policy」划给 SaaS，所以 per-Agent 队列留在 Host。ADR-037 的最小 guardrail 不变。
> **范围**：只记录决策。不授权实现、发布、issue 修改或下游迁移。实现切片见 PRD §13。

## Context

- ADR-036 D2–D4 已定：云端只用平台 key，BYOK key 只在本地。所以 BYOK 工作只能在设备上执行。
- 下游 Host 需要定期运行的 Bot 工作（routine）。SDK 没有设备端定时能力，Host 各自写调度循环。
- SDK 已有存储 entitlement 和额度准入（`TenantStorageEntitlement`、`QuotaStore`）。spec 把推理用量定义为遥测，不作为 billing、quota 或 entitlement 的依据。
- 真相层已经能在 Node 和 Workers 上运行：`@byok-sdk/cloud` 两边都能加载；`@byok-sdk/cloud-dataplane` 的根入口在 Node 上运行，`runtime` 入口在 Workers 上运行。D7 却写着 Node + Postgres 仅预留。
- 设备空闲时，events hold 每 250 ms 读一次 mailbox（#410）。Workers 按请求和 CPU 计费，流量大时成本高。
- Host 还需要 Bot 之间协作：Main Bot 建 Bot 和群，Bot 之间委派，群里多个 Bot 按顺序发言。DeepSeek Bot 和 DS Bot App 做出了这种形态，但它们依赖同一进程里常驻的 DSH Session、`steer`，以及正文里的 `@名字` 和 `[PASS]`，搬不到 BYOK。
- 现有 SDK 对协作有四个缺口：结果文档靠设备上的 Host 代码（`DaemonConfig.resultDocument.extract`）解析整段最终文本，只跑 daemon 的设备没有这段代码；结果文档有 extractor 和 durable Pi 两套产出机制；fresh 执行有 `recurring.submit` 和 `dispatchFreshAgentEgress` 两个提交入口；home busy 只体现在 reason 文本里。
- 项目还没有上线，破坏性变更没有存量用户需要兼容。

## Decision

1. **不计量执行**：BYOK 不按 token、流量或执行次数计费。SDK 不提供执行计量 API。推理用量只作遥测。
2. **存储是收费单位**：收费单位是超出 `TenantStorageEntitlement` 的存储。价格和额度由产品决定。存储用量只有一个权威。
3. **部署目标**：真相层（`@byok-sdk/cloud`、`@byok-sdk/cloud-dataplane`）以 VPS 为优化和主测试目标，即 Node + Postgres + S3 兼容对象存储。Workers（Hyperdrive + R2）继续支持。新端口先做 Node 实现；Workers 实现可以晚一些，或者明确降级。
4. **`cloud-do` 范围**：`@byok-sdk/cloud-do` 保持只在 Cloudflare 上运行，不做 Node 版本。它只用平台 key，BYOK 产品不走它。
5. **执行与时钟在设备上**：BYOK routine 不需要官方 key。执行和时钟都在设备上，用用户自己的 key 或 runtime。云端只保存定义、结果投影和可见性状态。
6. **hosted 真相层不为 routine 计时**：没有 cron，没有 DO alarm，没有服务端定时器。设备端时钟由 `@byok-sdk/server` 的 wake 队列提供（PRD §7）。周期规则留在 Host。设备上没有 Host 进程的 Host 可以用自己服务端的定时器提交 routine 执行，执行仍在设备上（PRD O8）。
7. **Bot 与 Host 执行核心**：Bot 是持久的 Agent，即一个 AgentRef 加它的 home。它的执行有三种触发来源：用户输入、routine、其他 Bot。三者进同一个 Host 执行核心：每个 Agent 一个 FIFO；按 intent 派生 `taskId` 和代际；只有读到设备 terminal 才换代；执行结算和 intent 结论分开记录（PRD §9.2）。核心是 SDK 的一部分，以 `@byok-sdk/server/execution-core` 子路径发布，Host 直接依赖，不再复制（2026-10-29 修订，见文末）。per-Agent 队列的策略仍归 Host，SDK 只提供这个核心。
8. **协作由 Host 编排**：委派和群聊是 Host 编排的多次 fresh 执行（ADR-036 D1）。SDK 不加 Conversation 或 Room 存储。Local TeamWorkspace 只做本机 operator 协调，不作为 Bot 协作的底座。
9. **上下文进，outcome 出**：Bot 要读的内容由 Host 放进 ContextPack。Bot 的意图在执行结束时以结构化 outcome 提交，Host 按 `taskId` 只应用一次。Host 生成的 schema 就是权限边界：花名册写成 enum，管理类动作只出现在 Main Bot 的 schema 里。不从模型正文推导语义；缺 outcome 或执行失败不算 PASS。运行中往返 Host 的动作通道推迟，只有测量数据证明需要时才做（PRD K9）。
10. **统一提交（K5）**：`executions.submit`（cloud 侧 `submitAgentExecution`）取代 `recurring.submit` 和 `dispatchFreshAgentEgress`，`messageEgress` 改为可选。旧入口直接删除，不留别名。
11. **busy 带 typed code（K6）**：home busy 的 `task.decline` 带封闭枚举 `code`：`agent_home_writer_busy`、`agent_home_reader_busy`。按协议 v2 的冻结规则，这是新增的可选字段。Host 只看 `code`，不解析 reason 文本。
12. **结构化 outcome 通道（K7）**：offer 里的 result-document 带冻结的 JSON Schema（受限子集）。SDK 保留的 MCP server `byokagentresult` 提供 `submit_result`。daemon 校验并持久化后才确认，确认只表示暂存。runtime 成功结束后，daemon 把带 outcome 的 `task.complete` 先落盘再发出，崩溃后只重放这个已落盘的 terminal。执行失败、被取消或中断时，暂存的 outcome 不交付，只作审计。成功结束但没有提交 outcome 时，以不可重试的失败结束。删除 `DaemonConfig.resultDocument` 和 `ResultDocumentExtractor`。durable Pi 用同一个校验入口。这改了 strict 的 result-document 形状，所以 K7 把 wire major 升到 3，没有 v2 reader：先排空，server 和 client 再一起升级。embedded server、cloud-dataplane 和 daemon 在启动时拒绝未排空的 v2 数据（PRD §8.3）。
13. **委派与群聊的语义**：委派是异步的，发起方的执行交出委派后就结束。每个委派只有一个结论，并回报给发起方；不确定时不自动重派，用户可以关闭它。委派链有 hop 上限，每条用户输入派生的 Bot 自发执行有预算。群聊由 Host 调度：点名来自 UI 的结构化 mention 或 outcome，PASS 是显式动作。

## Consequences

- ADR-036 D7 只约束 `cloud-do` 的 backend。
- #410 决定空闲设备的服务器成本，建议优先级从 P3 提到 P1。
- #411 和 #412 在收费路径上：mailbox 字节必须记账，保留清理必须能在有流量的租户上提交。
- 下游 Host 的设计要算出每台空闲设备的服务器调用数（PRD §10.2）。
- 下游的执行计费与决策 1 冲突。例如 Aiphabee 对本地操作收 credits，需要删除。
- 设备在线时 routine 才运行。离线和错过由服务端在读取时推导，不用 watchdog。
- Host 不再需要在设备上放代码来取得结构化结果，只跑 daemon 的设备也能参与 Bot 协作。
- K5–K7 是破坏性变更。`examples/basic`、Salesko 的 recurring 测试和 SummaryJob、durable Pi、prepared lane 的 SummaryJob 记录都要迁移。发布后不提供兼容期。
- K7 发布需要一次协调升级：先在旧版本上排空，再升级 server 和 daemon，和 v1→v2 的切换相同。cloud-dataplane 和 daemon 要补上未排空数据的启动检查。
- 按 `agent home busy:` 前缀判断换代的规则改为按 `code` 判断。
- K4 扩大为 Host 执行核心，依赖 K2、K5、K6、K7；Bot 协作参考实现 K8 在 K4 之后。K4 自 #1106 起作为 `@byok-sdk/server/execution-core` 发布。
- 模型能否可靠调用 `submit_result` 是新的前提，要按 runtime 测量。
- per-Agent 队列、hop 和预算、群聊调度都是 Host 的策略。不同 Host 可以选不同的数值，但都必须有上限。

## Status

决策 1、2、3、5：**Accepted（owner，2026-10-13）**。决策 4、6–13：**Proposed（2026-10-13）**，PR 合并即视为 owner 接受。仅记录决策；实现未开始。

## 修订记录

- **2026-10-29（owner 批准 Q7，#1106）**：决策 7 原文是「核心以 copy-and-own 参考实现交付，不进 SDK API」，改为「K4 是 SDK 的一部分」。AiphaBee 原样复制了 K4，又自写 `PROVENANCE.json` 逐文件核对版本，每次修复都要重新复制才到达下游，所以收回 SDK。
  - 执行核心（FIFO、ledger、routines、transitions、schedule、submit、model、sealed routine）和 Host 记忆恢复（`memory.ts`、`memory-restore.ts`）一起发布为 `@byok-sdk/server/execution-core`。记忆代码与执行 ledger 共用同一个 SQLite 事务，拆不开，所以没有并入 `@byok-sdk/client/agent-memory`。
  - `@byok-sdk/server/execution-core/canonical` 只导出 `hash` 与 `canonical`，只依赖 `node:crypto`，供 Workers 上的 K8 `rules/` 使用（#884）。
  - 记忆核心与设备共用的契约（`AgentMemoryFile`、`AgentMemorySnapshot`、`AgentMemoryExport`、`AgentMemoryProjectionPort`、`AgentMemoryIntentFetchInput`、`AgentMemoryIntentTransport`、`validateAgentMemoryPath`、`AgentMemoryError`、`AgentMemoryValidationError`）从 `@byok-sdk/client` 移到 `@byok-sdk/protocol/agent-memory`，作为唯一定义。server 不能依赖 client，`@byok-sdk/core` 不能依赖 protocol，protocol 是两边都能依赖的那一层。这个子路径不含 zod，`@byok-sdk/client/agent-memory` 仍不加载 schema。
  - 公开 package 仍是 9 个。`examples/host-execution-core` 改为演示：组合发布的 API，跑依赖真实 daemon 的集成测试，不再保存核心源码。
  - K8 仍按 vendor 契约复制（#886），不在本次修订内。
