# ADR-026 – ADR-034：领域模型与权威边界（2026-09-03）

> **来源**：`docs/researches/2026-09-03_architecture-review.md`（v3，Fable 主循环裁决）§0、§6、§7、§8（WP 表与 D1–D5）、§12、§13。
> **输入稿**：`docs/researches/20260903-GPT-review.md`、`docs/researches/20260903-GPT-review-2.md`。两稿与审查报告冲突处以审查报告为准。
> **授权**：owner 已转发 v3 稿并要求按其修正方案执行（review §8 D1–D5）；本文件按该委托把裁决转写为可被后续 contract 引用的规范条款。
> **帐本**：九条同时登记进 `sdk-architecture.md` 附录 A，编号从当时最大值 ADR-025 续起。
>
> **状态图例**：`Accepted (owner-delegated 2026-09-03)` = 裁决已定，实施进度看各 WP；`Supersedes ADR-0NN` = 同一议题上取代既有 Accepted 裁定，取代理由必须给出审查报告出处。
> **本文件不改变**：`docs/spec.md`（WP0 并发持有），也不宣称任何条款已在代码里落地。所有 `file:line` 是 `main@4cc765f` 树上复核过的当前状态，用来标定「今天违反本裁定的位置」，不是实施说明。

---

## ADR-026　领域词汇冻结：Tenant / Computer / Installation / Agent / Session / Run / Attempt / Workspace / ResultContext

**Context**　review §7 V1 与 §4「computer / agent / session」行：computer 今天被拆在三个不完全相同的概念里——client 侧哈希 `machineId`（`packages/protocol/src/http-api.ts:51`）、enrollment 身份 `deviceId`（`packages/server/src/types.ts:131`）、server 观测面 `MachineInfo`（`packages/server/src/types.ts:261`）；session 在云端没有可寻址实体，`TaskAttempt` 不带 `sessionRef`（`packages/cloud/src/stores/ports.ts:251-269`）；用户请求与执行尝试共用一个 `taskId`（同上 `:233-242` 的 `TASK_ATTEMPT_STATUSES`）。review §8「保留原样」明确不预先引入完整 Computer aggregate。

**Decision**
- WP3A/WP3B/WP4/WP5 的设计文档、类型名、store schema 与 wire 字段必须只使用这九个词：Tenant、Computer、Installation、Agent、Session、Run、Attempt、Workspace、ResultContext。嵌套关系为 Tenant → Computer → Installation → Agent → Session → Run → Attempt，Workspace 与 ResultContext 分别挂在 Session 上。
- `deviceId` 的语义必须被读作 Installation（某产品在某台机器上的一次 enrollment），auth、公钥、revoke、capability 上报与 daemon release 全部归 Installation。v2 主 API 只接受 `installationId`。
- Computer 必须留在宿主侧：SDK 不建 Computer aggregate、不铸 `computerId`、不做跨 installation 归并。只有出现「同一台机器上多个 installation 必须被产品当成一台机器」的真实需求时才重开此项。
- `machineId` 与 `MachineInfo` 必须降为 observation，禁止被任何准入、路由或授权判断读取。
- 一个 Run 的重试必须复用同一 `runId` 并铸新 `attemptId`；禁止用新 `taskId` 表达重试。

**Consequences**　WP4 的 `run.offer` 按此命名，目标 Installation 由 mailbox target 固化、不进 payload。WP3A 的本地类型同名。禁止在 v2 里同时出现 `deviceId` 与 `installationId` 两个字段名表达同一事实。ADR-025（Device / Agent / placement / runtime session 分权）继续成立，本条只把它的 Device 一格确认为 Installation。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-027　一事实一权威矩阵

**Context**　review §6「session 服务端实体」裁决与 §8 WP2 要求先冻结权威矩阵；GPT 稿 §十一 给出 SaaS / Local Agent 两列的分配表，review 采纳并按铁律 3（云端不持执行态）与 D3（可证明本地）收紧。今天的反例：server 公开 `dispatch()` 仍允许 ambient 选设备（`packages/server/src/types.ts:131` 的 `deviceId?`），同一事实在 server 与 cloud 两处各有实现（review §7 V4）。

**Decision**　下表每一行只有一个权威，另一侧只能持投影或 observation；任何实现不得让两侧同时可写同一事实。

| 事实 | 权威 | 另一侧 |
|---|---|---|
| Tenant、product、user permission | SaaS | 只持 opaque binding |
| Computer 展示身份 | SaaS（宿主产品） | Local Agent 只报 observation |
| Installation 认证身份与 revoke | SaaS 登记 public identity | Local Agent 独占 private credential |
| Agent / Profile | SaaS，versioned | revision-bound 只读投影 |
| provider 原生凭证 | 无 | Local Agent 唯一权威 |
| native session locator | 无（只存 opaque `sessionId`） | Local Agent 唯一权威（ADR-028） |
| transcript / tool trajectory / workspace bytes | 无，除非显式导出（ADR-033） | Local Agent 唯一权威 |
| Run intent 与 policy | SaaS | frozen manifest 投影 |
| Attempt 身份与 leaseEpoch | SaaS store 铸造（ADR-029） | 携带并校验 |
| Result context | SaaS，bounded CAS（ADR-033） | 产出 `ResultEnvelope` |
| runtime 进程生命周期 | 无权直接启动 | Local Agent 唯一启停权威 |

- ambient device selection 必须标为 legacy 并在 v2 cutover 中删除（ADR-034）；显式 placement 不得静默 fallback 到另一台 Installation。
- 新增任何跨层字段前，必须先在本表定位它属于哪一行；不在表内的事实必须先扩表再实现。

**Consequences**　WP3B 收敛协调面时按本表判断哪一份实现该留。WP4 的 schema review 以本表为准入清单。任何「两侧都写、后写覆盖」的设计一律拒绝。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-028　native session locator 永不上云；`sessionId` 由 SDK 铸造；Session 不存运行时中间态

**Context**　review §6 第一行裁决与 §9：厂商原生 session id 今天由 adapter 从 runtime 取得（claude 的 `packages/client/src/adapters/claude/claude-adapter.ts:456` `waitForInit()`；pi 取不到即 fail-closed，`packages/client/src/adapters/pi/pi-adapter.ts:486-500` 的 F8），并落在本机 `<agentHome>/.byok/runtime-sessions/` 的 append-only 账本里（`packages/client/src/daemon/agent-session-handoff-store.ts:245-250`）。云端今天没有 Session 实体（`packages/cloud/src/stores/ports.ts:251-269`），fresh 与 resume 因此被摊成两种 offer。

**Decision**
- 云端 Session 必须只存：`sessionId`、AgentRef、Installation residency、WorkspaceRef、RuntimeRef、`contextVersion`、产品级 open/closed。
- 云端 Session 必须不存运行时中间态：没有 `running` / `thinking` / `awaiting_approval` / live turn / PID / 当前工具调用。这些属于当前 Attempt 的执行态，或 TTL activity/presence observation（ADR-006 的 presence 权威不变）。
- `sessionId` 必须由 SDK 铸造为 opaque 值；厂商原生 locator 必须只存在本机，映射 `sessionId → nativeLocator` 由 Local Agent 独占。协议层不得表达该 locator。
- v2 前的过渡期只允许两件事：`TaskAttempt.sessionRef` 字段，以及从 first-terminal-wins 回执派生的只读 `listAgentSessions(tenant, agentRef)` 投影。禁止在 `task.started` 时向云端写 session status。
- resume 必须按 exact 绑定 fail-closed：Installation、Agent revision、runtime、cwd、native session evidence 任一不符即拒绝，不得回退为 fresh。

**Consequences**　WP4 v2.3 按此定 Session store；fresh/resume 合并为一种 `run.offer` 的 `session.mode: create|resume`。WP3A 拥有 `sessionId → nativeLocator` 的本地 WAL。禁止把 Session status 做成 UI 实时状态源——UI 读 activity relay（ADR-033）。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-029　Attempt 由 store 原子铸造；leaseEpoch fencing 覆盖每一次权威副作用

**Context**　review §8 WP4 v2.2 与 GPT 稿 §七：今天 `TaskAttempt` 用 `taskId` 同时表达用户请求与执行尝试，状态机是 `offered/claimed/running/cancel_requested/complete/failed/cancelled`（`packages/cloud/src/stores/ports.ts:233-242`），claim 归属靠 `ownerDeviceId`（同上 `:259`），没有 epoch，所以设备离线改派、daemon crash 恢复、旧进程迟到 terminal 三种情况无法在权威层区分。

**Decision**
- Attempt 必须由 store 在一次原子操作里铸造 `{attemptId, leaseEpoch}`；`leaseEpoch` 在同一 `runId` 上单调递增。调用方不得自铸 attemptId。
- 下列每一个权威副作用必须携带并校验当前 Attempt：`claim`、approval、message egress、artifact finalize、terminal、result commit。校验不通过一律拒绝。
- 旧 `leaseEpoch` 的消息必须只进 audit evidence，禁止改变任何产品状态——包括禁止用它推进 terminal、推进 context head、触发外部 message 副作用。
- Attempt 凭证分层（Installation → Connection → Attempt token）不是 fencing 正确性的前提，必须拆为独立后续安全 package，不阻塞 v2 首发；但一旦引入，attempt credential 失败后禁止降级回 installation credential。
- first-terminal-wins 与 host cancellation 的既有优先级不变（ADR-008 terminal immutable 继续成立），fencing 叠加在其上而非替换它。

**Consequences**　WP4 v2.2 实现，且只在 WP3B 统一后的单一 kernel 上实现一次（ADR-032）。WP5 的 `SessionResultCommitter` 把「当前 Attempt 有效」作为事务内第一个校验（ADR-033）。验收场景：新 Attempt 建立后，旧 Attempt 的 progress、message、terminal 只保留为 audit evidence（review §9 采纳的 GPT 稿 §十五 第 5 条）。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-030　capability 收敛为一个 FeatureRegistry，三个独立 authority，准入取交集

**Context**　review §7 V5 与 §12「capability」行（GPT-2 稿 §五 的修正被采纳）：今天有两套互不校验的词汇——wire 侧 `CAPABILITY_FLAGS` 20 个（`packages/protocol/src/version.ts:108-129`），core 侧 ADR-010 的 `CapabilityDeclarationSchema`（`packages/core/src/capabilities.ts:22`）。两者没有共同 registry，也没有交叉校验；`interactive-approval` 冻结在 flag 列表里却无生产路径（`packages/protocol/src/version.ts:35`，review §7 V9）。

**Decision**
- 必须建立一个 canonical `FeatureRegistry`，它是且只是这五样东西的权威：feature id、version、dependencies、compatibility rule、readback schema。
- 必须保留三个独立 authority，各报各自的事实，禁止合并成一个对象：`DeploymentCapabilities`（云端部署实际提供什么 route/store/feature）、`InstallationCapabilities`（本机 daemon / runtime / toolset / isolation 实际能做什么）、`RuntimeCapabilities`（具体 runtime adapter 声明）。
- `RunRequirements` 必须显式声明本次 Run 需要什么；准入判定必须是交集：`RunRequirements ⊆ Deployment ∩ Installation ∩ Runtime`，不满足即 fail-closed 拒绝整个 offer。
- `CAPABILITY_FLAGS` 与 ADR-010 声明必须收敛到 registry 的同一份 id/version 上，而不是把三种事实塞进一个声明对象。ADR-010 的「靠声明、不做 status code 嗅探」继续成立。
- 无生产路径的 feature 必须在 registry 里显式标注为 reserved 并给出触发条件，否则不得占用 id。

**Consequences**　WP4 的 `run.offer.requirements` 引用 registry id。WP3A 的 Installation capability 上报与 WP6 的 `IsolationClass` / `minimumIsolation` 都是 registry 里的 feature，`minimumIsolation` 走同一条交集准入。禁止再新增第三套 capability 词汇；也禁止用「云端支持」推断「本机允许」或反之。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-031　AgentHome / SessionState / Workspace 三分；mutable Workspace 单写者；Git worktree 作 backend

**Context**　review §7 V2（唯一的运行时正确性风险）：同一 Agent 的多个 session 共用一个 canonical home 作 cwd（`packages/client/src/agent-home.ts:613` 的 `cwd: resolution.canonicalHome`，lease 按 `(taskId, sessionRef)` 计而非按 home，`:600-607`），且 daemon 内无并发上限；文档一源真相已经断裂——`README.md:87` 与 `docs/host-local-storage-layout.md:64` 写「one mutable writer per canonical Agent home」，`docs/spec.md:551-553` 写同一 home 内跨 session 并发。review §8 D4 与 GPT-2 稿 §七采纳三分与 backend 化。

**Decision**
- 必须把今天的一个概念拆成三个：**AgentHome**（identity / profile / memory）、**SessionState**（`sessionId → native locator`、本地 WAL）、**Workspace**（本次执行实际可变的文件）。AgentHome 必须不再等于 cwd。
- 每个 mutable Workspace 在任一时刻必须最多一个 active Attempt，所有 lane（subscription / byok / byok-profile）统一计数。不同 Workspace 并行不受影响。
- 同一 Session 的多个 Run 必须串行，禁止两个并发 Run 进入同一 native Session。
- Workspace backend 现在必须只有两种：`plain-directory` 与 `git-worktree`。`copy-on-write`、`external-project` 等其余 kind 在出现真实消费者前不得引入。
- WP0 加在 canonical Agent home 上的临时单写者门必须在 WorkspaceRef 落地后整体迁到 Workspace，不得两个门长期并存。
- 释放必须发生在 session 终态 / cancel / disposal 成功之后；status readback 只报计数，不报正文。

**Consequences**　WP0 先按 home 止血（默认 1，只能显式提高），WP3A 把锁迁到 Workspace 并加 Installation 级资源配额。ADR-023（`workspaceHint` 维持 reserved）在 WorkspaceRef 落地后才具备它要求的 resolver 设计前提。验收场景：同 Agent 不同隔离 Workspace 可并行完成；第二个请求同一 mutable Workspace 的 Session 在 claim 前被拒。本条偏离 RAFT「home 即 cwd」是有意的。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-032　协调面单一权威：`@byok-sdk/server` 折叠为 cloud kernel 的 embedded façade

**Supersedes ADR-004**（「`@byok-sdk/server` 留作 self-hosted，不演化为 hosted Hub」）。取代理由：ADR-004 让 server 保有一套与 cloud 零共享的独立协调权威，review §7 V4 已实证该双权威在语义与安全姿态上漂移；§6 O1 两轨一致、§8 D1 采纳折叠。折叠不改变 self-hosted 的交付形态——server 继续存在、继续 self-hosted，只是不再拥有第二套语义。

**Context**　review §2、§7 V4、§8 WP3B、§13：`packages/server/src/hub.ts` 2,639 行自带 pairing / auth / task / terminal / cancellation 状态机，零处 import `@byok-sdk/cloud`（`packages/server/src/index.ts:139` 的注释本身承认 production durability 属于 cloud stores），公开工厂是 `packages/server/src/index.ts:203` 的 `createByokServer`。WS 只有 server 与 daemon 两处引用（`packages/server/src/ws-server.ts:9`、`packages/client/src/daemon/url.ts:15`）。

**Decision**
- `@byok-sdk/server` 必须成为 `@byok-sdk/cloud` 同一 async domain kernel 的 embedded façade，附带 in-memory/SQLite 异步 stores。pairing、capability admission、offer reservation、inbound ownership、cancellation、first-terminal-wins、message side-effect admission 这七项语义必须只有一份实现。
- `hub.ts` 的独立状态机必须删除；`TaskHandle` 必须降为对统一 store / read model 的便利 façade，禁止持有第二套 task state。
- WS server 与 daemon WS transport 必须删除（消费者审计已回证无消费者，review §13）。低延迟需求只允许另加非权威的 SSE wake hint，不得成为第二条语义通道。
- 这一收敛必须先于任何 v2 代码落地；v1 characterization tests 必须在收敛前后全过。

**Consequences**　WP3B 承担，与 WP3A 并行，两者都在 WP4 之前完成。ADR-017（`TaskStore` 改 async，Deferred）的触发条件由本条满足，实施随 WP3B 一并进行。禁止在 server 与 cloud 里各实现一遍 Session / Run / Attempt / fencing 再删一套。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-033　数据 policy profile：`local-first-v1` 为默认；结果事务权威是 `SessionResultCommitter`

**Context**　review §7 V8 与 §6「`contentful-trajectory` 是否违规」行：需求原话是「中间态记录留在用户本地」，但今天它只是默认 policy——`contentful-trajectory` 由 host policy + capability 就能打开（`packages/protocol/src/agent-egress.ts:87`），content-read 路由与 memory projection 同理。review §8 D3 裁定走「可证明本地」。结果侧：core truth 层已有 per-key `expectedRev` CAS，缺的是 session 级 context version 与 terminal/Attempt 的绑定（review §9 事实核对；GPT-2 稿 §八）。

**Decision**
- `local-first-v1` 必须是默认部署 profile，且必须由 capability readback 可证明。该 profile 下部署必须同时满足：不声明 contentful trajectory capability；不挂载 transcript/workspace/artifact content-read route；不配置 cloud memory projection store；ActivityStore 只接受无内容 status event；单个 task 不得临时放宽。
- contentful 能力不删除，必须移入显式 `shared-observability-v1` profile，其准入条件为：SaaS host 明示、终端用户授权、retention policy、route inventory readback、export receipt、UI 明示哪些内容离开本机。
- 命名必须分开：`ActivityRelay` = 实时、可丢、非持久；`ActivityStore` = 明确 durable、受 retention 控制。禁止用一个名字同时表达两种存续语义。
- 结果提交必须由专门的 `SessionResultCommitter` 承担，在一个事务内依次校验当前 Attempt 与 epoch、读 winning terminal、校验 `expectedContextVersion`、插入不可变 `ResultEnvelope`、推进 Session context head、记幂等回执；结果只能是 `applied | idempotent | context-conflict | stale-attempt`。
- 可以复用 TruthStore 的 canonicalization / CAS 原语，但 generic TruthStore 必须不成为结果事务权威。context 版本前进后禁止 last-write-wins 覆盖；SDK 不得自动合并自由文本 memory；原始 transcript 不得成为云端 context authority。

**Consequences**　WP5 承担。`local-first-v1` 是 Salesko 今天已经在跑的形态（review §13；该审计是 grep 驱动的静态审计，Salesko 仍钉 0.11.0，运行时行为未验证，见 review §10），因此默认值在已核实范围内不构成下游 breaking。每次内容导出必须能读回 actor、policy revision、hash、size 与 receipt。ADR-009（云端不做语义推导）与 ADR-008 继续成立，本条给它们补上部署级可证明性与结果事务边界。

**Status**　Accepted (owner-delegated 2026-09-03)

---

## ADR-034　legacy cutover policy：一次性切 v2，不做双读双写

**Supersedes ADR-002**（「protocol v1 冻结，新能力一律走 wire 外的 HTTP 面」）。取代理由：review §7 V6 实证该策略已经失效——v1 号下累积出 5 种 offer 变体、20 个 capability flag 与一个拒绝门，版本号不再传达形状；§8 D2 裁定 1.0 前切 wire v2。v1 本身仍然冻结，取代的是「永不开 v2、能力一律外挂 HTTP」这一条。

**Context**　今天 legacy `task.offer` / `task.offer_with_toolsets` 仍在 wire 上（`packages/protocol/src/envelope.ts:63-64`），并与 Agent 路径共用同一个 `handleOffer`（`packages/client/src/daemon/task-runner.ts:1482`）；`strictAgentOnly` 是可选配置（`packages/client/src/daemon/create-daemon.ts:289`，需配 `agentHome`，`:1160-1161`），拒绝门在 `packages/client/src/daemon/task-runner.ts:1569-1573`；task-scoped git workspace authority 仍在 `packages/client/src/daemon/session-workspace-store.ts:14,21,99` 与 `packages/client/src/bin/config.ts:63-67`；server 公开面仍允许 ambient 选设备（`packages/server/src/types.ts:131`）。review §13 已把「无 legacy 消费者」从推断变为 verified。

**Decision**
- 下列五项必须在同一次 v2 cutover release 中删除，不得分批保留：legacy `task.offer` 与 `task.offer_with_toolsets`；`strictAgentOnly` 配置项（v2 只有一条 Agent 路径，无需开关）；task-scoped `gitWorkspace` 作为与 AgentHome 并列互斥的 workspace authority，连同 `SessionWorkspaceStore` schema；ambient device selection（`packages/server/src/types.ts:131`）；fresh/resume 两种 offer 的分裂（并入 ADR-028 的 `session.mode`）。
- 删除的是旧 authority 与旧 store schema，不是 Git worktree 能力本身——该能力必须以 Workspace backend 形式保留（ADR-031）。
- 必须不存在 v1/v2 长期双读双写、字段别名、形状翻译或语义 fallback。v2 schema 整体 strict，未知字段拒绝整个 offer。
- 迁移必须是一次性的：下游按 exact pin 升级（Salesko 今天钉 0.11.0，review §13），切换后 v1 路径不再接纳。
- v2 本身必须只在 ADR-032 收敛后的单一 kernel 上实现一次。

**Consequences**　WP4 承担，内部拆 v2.1 身份与消息形状、v2.2 Attempt 与 fencing、v2.3 Session 本地绑定、v2.4 凭证分层（后置，不阻塞首发），但对外只有一个 cutover release。ADR-023（`workspaceHint` 维持 reserved）随 v1 一并退场，其能力由 v2 的 `workspaceRef` 承接。Salesko 的一次性迁移授权仍需 owner 单独点头（review §8 D2）。

**Status**　Accepted (owner-delegated 2026-09-03)
