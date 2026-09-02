# byok-sdk 架构审查（2026-09-03）

> 对象：`main@4cc765f`（0.12.0 train）。审查人角色：架构师（Fable 主循环裁决）。
> 方法：两路只读 explorer（代码地图 / RAFT 对照）+ 一路联网调研（deep-reasoner）+ Opus 与 Codex 对同一份 decision packet **盲审**（互不见对方产出）+ 主循环裁决；随后与 owner 提供的两版 GPT 稿对照（`20260903-GPT-review.md` → §9，`20260903-GPT-review-2.md` → §12）；Salesko 下游仓只读审计（§13）。原始产物见 `docs/researches/evidence/2026-09-03-architecture-review/`。
> 事实等级：`verified` = 本轮读源码 / `wc` / `grep` 复核；`fetched` = 调研 agent 当日抓取网页；`[inferred]` = 推断；`[owner]` = 需 owner 拍板。
> 修订记录：v1 首刀 = 并发上限（条款驱动，owner 否决）；v2 首刀 = 集成面 golden；**v3（本版）按 GPT-2 稿修正：首刀 A = canonical Agent home 单写者止血，首刀 B = 集成面 golden（已实现、gatekeeper PASS）；协调面收敛先于 v2 代码；capability 改为一个 registry + 三个独立 authority；v2 拆四个 work package；Salesko 审计把 V3 与 D1/D4 的前置条件从推断变为已验证。**
> 未启动 RAFT 探针：本轮所有 RAFT 事实均来自 `raft-study` 已有 CONFIRMED 结论，没有出现需要新探针才能回答的问题（见 §10）。

## 0. 结论

1. 设计方向没有违背 owner 的五条需求，但有三处与 owner 自己立的工作规则冲突：`@byok-sdk/server` 与 `@byok-sdk/cloud` 是两套**零共享代码**的协调面权威；legacy `task.offer` 路径作为**默认接纳**的稳态兼容路径与 Agent 路径并存；wire v1「冻结 + 只增」把 Agent-first 转向摊成 5 种 offer 消息 + 20 个 capability flag，版本号不再传达形状。
2. 「computer / agent / session」三个单位里，**session 在服务端没有可寻址句柄**：`TaskAttempt` 不带 `sessionRef`，没有按 agent 列 session 的读口；computer 被拆在 `machineId` / `deviceId` / `MachineInfo` 三个不完全相同的概念里，其中 `deviceId` 的真实语义是 Installation（某产品在某机器上的 enrollment）。
3. 并行能力存在（0.12.0 起按 `(agentId, sessionRef)` 串行、跨 session 并发）但**同一 Agent home 是所有 session 的共同 cwd，且没有并发上限**；README:87 与 `docs/host-local-storage-layout.md:64` 仍写「one mutable writer per canonical Agent home」，与 spec:551 直接矛盾。这是当前唯一的运行时正确性风险（MEMORY.md / notes / `.git/index` / build 产物多写者）。Salesko 仍钉 0.11.0，其 chat 与 research 两个调用点会对同一 `agentId` 并发 enqueue，并把「busy home」仲裁完全交给 SDK——它是按 0.11.0 的「同 home 拒绝」写的。
4. 社区没有能替换 byok 任一层的成品：ACP 成熟但其 Claude/Codex 适配器不驱动用户本机二进制；设备注册/信箱形状与 GitHub Actions runner 独立同构；没有 TS 库覆盖「不受信硬件的配对 + outbound 任务队列」。
5. 重组顺序（§8）：WP0 止血同 home 多写者 → WP1 集成面 golden + 版本 authority → WP2 领域 ADR → WP3A 本地执行边界（AgentHome / Workspace / SessionState）‖ WP3B 协调面收敛（server = cloud kernel 的 embedded façade，删 WS）→ WP4 一次性 wire v2（Installation / Session / Run / Attempt + fencing）→ WP5 结果与数据 policy（SessionResultCommitter、local-first-v1）→ WP6 runtime parity（codex app-server、IsolationClass）。**不建议**：ACP 作为 adapter 边界、14 个 port 合并、TaskRunner 预先分三段、包名整体重命名、把 Computer/Run/Attempt 完整树塞进当前 slice。

## 1. 第一轮地图的纠错（两轨各自复核后）

| packet 原文 | 实际（verified） |
|---|---|
| `hub.ts` 1,689 行 | **2,639** 行 |
| 19 个 wire capability flag | 20 个（`packages/protocol/src/version.ts:108-129`） |
| MCP toolsets 只有 claude 注入；Pi/Codex 拒绝 toolset offer | 三个 adapter 都声明 `mcpToolsets: true`（`claude-adapter.ts:180`、`codex-adapter.ts:103`、`pi-adapter.ts:165`）。真实差异是 `steer` 仅 pi（`pi-adapter.ts:163`），claude 以常驻进程 + `followUp()` 覆盖同一需求（`claude-adapter.ts:585-659`，`steer:false` 是有意的 fail-closed），codex 每轮重起进程、没有常驻 session；`approvalInteractive` 仅 claude（`claude-adapter.ts:179`）；pi 对 toolset 只接受 `auto` 模式 |
| pi 拿不到 session id 时回退 `randomUUID()` | 已修为 fail-closed（`pi-adapter.ts:486-500` 注释记为 F8） |
| cloud 21 条路由 | 基线 19 条 + capability/composition 条件注册；稳定事实只有「cloud 无 WS 路由」 |

以上纠错已反映在本文所有判断里；原 packet 保留在 evidence 目录供追溯。

## 2. P1 地图

```
@byok-sdk/protocol  wire v1 FROZEN（28 message types，5 offer 变体，20 flags）      ← 无依赖
@byok-sdk/core      protocol-free 契约 + in-memory stores；truth 层 per-key expectedRev CAS  ← zod
@byok-sdk/keys      BYOK key 保管 + byok-pi-provider-launcher（进程边界，不进 dispatch 图） ← core
@byok-sdk/cloud     无状态 hono handlers，14 个必填 CloudStores port，无 WS           ← core, protocol
@byok-sdk/cloud-dataplane  Postgres + R2，migrations 0001–0017                        ← cloud
@byok-sdk/server    自托管 ConnectionHub 2,639 行 + WS + 同步 TaskStore/sqlite；0 处 import cloud；`DispatchInput.deviceId` 可选（types.ts:131，ambient 选设备）
@byok-sdk/client    daemon 41,981 行（daemon/ 26,347；adapters/ 5,738；bin/ 4,387）
@byok-sdk/ui-runtime / testkit / conformance(private) / sdk(umbrella)
```

- 源码约 84K 行，测试约 1:1（client 165 个测试文件 41.5K 行）。
- 最大文件：`daemon/task-runner.ts` 4,159 行（一个 `handleOffer` 用布尔参数吞下 5 种 offer，`:1447-1461,1482`）；`daemon/create-daemon.ts` 3,283 行（单个工厂函数内联校验约 37 个 `DaemonConfig` 字段）。
- 本地持久化 11 处（device.json、daemon.db + quarantine、git-workspaces.json、daemon-owner.json、`.byok/runtime-sessions/*.jsonl`、skill-packs、team-workspaces、content-read audit、cursor、OS 凭证库）。
- 上行通道 11 条（终态三种、egress reliable、egress latest-value、agent.message、memory projection、home projection、presence、approval、content read/blob、proof receipt），各带独立 store / ack / capability gate。
- 发布节奏：0.1.0（08-09）→ 0.12.0（09-02），24 天 18 版，几乎每版对 `CloudStores` port、core `MailboxStore`、`BlobStore`、server config 做 breaking。
- 文档漂移：`docs/architecture/sdk-architecture.md` 标 CURRENT，基线 `f8bccbd` 落后 main **409** 个 commit；`README.md:10,52,118` 仍写 `byok-sdk@0.8.1` / `keys@0.3.2`（spec、CHANGELOG 与 npm 都是 0.12.0 / 0.3.9，WP1 已修）；`docs/spec.md` 标 Draft，800 行逐特性 authority 条款，没有 computer/agent/session 总览。

## 3. P2 具体路径（fresh Agent offer → 结果）

1. cloud 把 `task.offer_for_agent_with_egress_fresh` 放进设备 mailbox；daemon 长轮询 `GET /byok/events`（cloud 无 WS；`BYOK_WS_PATH` 只被 `server/src/ws-server.ts:9` 与 `client/src/daemon/url.ts:15` 引用）。
2. `TaskRunner.handleEnvelope` 把 5 种 offer 全部路由到 `handleOffer(taskId, payload, strictAgentOffer)`；`strictAgentOnly` 默认 `false`（`create-daemon.ts:881`），开启时在 `task-runner.ts:1569-1573` 拒绝 legacy。
3. 准入：adapter `prepare()` 无副作用 → daemon 封 immutable operation manifest → `task.claim`。
4. `start()`：claude = CLI `--resume <id>`（`claude-adapter.ts:400`，sessionRef 来自 `waitForInit()` `:456`）；codex = `codex exec` / `codex exec resume`，**每轮新起进程**，resume 不继承上一轮 `-c` 覆写（`codex-adapter.ts:285-296,527`）；pi = `pi --mode rpc`（`pi-adapter.ts:345-357`），session id 取不到即 fail-closed。
5. SDK 把 handoff fsync 到 `<agentHome>/.byok/runtime-sessions/<runtime>-<sessionRef>.jsonl`（`agent-session-handoff-store.ts:245-311`）；执行 lease 按 `(agentId, sessionRef)`，但每个 lease 的 cwd 都是同一个 canonical home（`agent-home.ts:600-632`）。
6. `task.started` → `AgentEvent` → egress controller（reliable lane 有 ack；latest-value lane 有损）。
7. 终态 `task.complete` → cloud `inbound.ts` → `terminal-result.ts` → `TaskAttemptStore`；memory head → `POST /byok/agent-memory-projections` → `agent_memory_projection_head`，PK `(tenant_id, agent_id)`，512 KiB 上限，只存 head。

压力点：第 2 步的单函数多形状分派，与第 5 步「多 session 同 cwd、无上限」。

## 4. 需求对照

| owner 需求 | 现状 | 判定 |
|---|---|---|
| 可集成的开源 local agent 组件 | 结构成立（npm 库 + 参考组合 + testkit）；但集成面每版 breaking、CURRENT 架构文档失真 409 commit、README 版本落后四个 train（WP1 已修）、spec 无模型总览 | 方向满足，**采纳成本高** |
| 接手用户已订阅的 Codex / Claude，或内置 pi | 三条 lane 都通，全部经厂商原生 CLI（claude `-p` / codex exec / pi rpc），daemon 不碰凭证；parity 差在 codex（无常驻 session、无 steer）与交互审批（仅 claude） | 满足。订阅条款：owner 判定走原生 `claude -p` 即为用户自身用量，不构成设计约束（调研记录见 §5 L4；发布清单项见 §8 末） |
| 省掉每用户沙箱 | 前提成立；沙箱底价 $4–10/用户/月（fetched）。但省掉的是云端沙箱，本地执行隔离（cwd 约定、daemon 级限额）仍是「约定不是沙箱」（`docs/security.md:765,847`，`docs/host-runtime-isolation-matrix.md`） | 满足，**有条件** |
| computer / agent / session 为单位，可并行 | computer 拆在 `machineId`（client hash）/ `deviceId`（enrollment = Installation）/ `MachineInfo`（server 观测）；agent=`AgentRef` ✔；session 本地有句柄、**服务端没有**；并行 = 跨 session 并发（0.12.0）但同 cwd、无 cap，与 README/存储布局文档「one mutable writer」矛盾；RAFT 是 per-agent bridge lock（一个 agent 一次一个） | **部分偏离** |
| 服务端有限持久化「以结果为导向」的上下文；中间态留本地 | 终态 / memory head / 有界 blob 回执 = 结果；activity / presence / approval = TTL 提示；transcript、workspace、journal、runtime session 全在本地 ✔。但「留本地」是**默认 policy 而非部署级可验证约束**：`contentful-trajectory`、transcript/workspace/artifact content read、memory projection 三条都可由 host policy + capability 打开（`protocol/src/agent-egress.ts:87`）。Salesko 生产只用 metadata-status、transfers 全 disabled、测试断言拒绝 contentful | 满足「默认本地」，不满足「可证明本地」；D3 裁定走「可证明本地」（§12） |

## 5. 社区调研（deep-reasoner，当日联网核实；全文见 evidence 目录 `community-research.md`）

| 层 | 成熟方案 | 对 byok 的意义 | 建议 |
|---|---|---|---|
| L1 runtime 桥接 | Agent Client Protocol：SDK 1.4.0（Apache-2.0），v1 稳定，注册表 39 个 agent；`claude-agent-acp` 0.73.0 / `codex-acp` 1.8.0（2026-09-01） | `claude-agent-acp` 依赖 `@anthropic-ai/claude-agent-sdk`，`codex-acp` 内置 `@openai/codex`：**都不驱动用户本机二进制**；ACP v2 是 breaking draft（删 `session/load`、`fs/*`、`terminal/*`）；provider 绑定与远程传输都还是 RFD | 不做 adapter 边界；无第二个真实消费者前不加 `AcpAdapter`；adapter SPI 的**概念**可向 ACP 对齐 |
| L2 设备注册/派工 | GitHub Actions runner：配置期生成密钥对、JWT 换短期 token、`_lastMessageId` 单调游标；Buildkite 三级 token（agent → session → 单 job JAT）与心跳常数；GitLab 服务端下发进度刷新间隔 | byok 的 Ed25519 设备密钥 + 游标信箱是同一形状的独立实现；无可复用 TS 库 | 保留；Buildkite 三级 token 作为 v2 之后的独立安全 work package（WP-v2.4） |
| L3 UI 事件流 | AG-UI `@ag-ui/core` 0.0.59（16 个月未到 0.1）；Vercel AI SDK data-stream（`ai` 7.0.90） | AG-UI 不能当 wire；Vercel 流是稳定渲染目标 | 保留 React-free fold；词汇向 `ActivitySnapshot/Delta` 靠 |
| L4 厂商条款 / 原生竞品 | Anthropic `code.claude.com/docs/en/legal-and-compliance`（fetched，GPT-2 稿当日复核一致）：允许终端用户用自己订阅登录**未修改的 Claude Code 二进制**，「including where a platform hosts Claude Code」，条件：未修改；不移除内置 auth；不代付/转售/中介用量；接受 Commercial Terms；禁止收集/存储/中介 Claude.ai 凭证。同页有「usage limits assume ordinary, individual usage」一句。OpenAI 帮助页允许 Codex 客户端用 ChatGPT 账号登录，但无「第三方产品运行用户自有订阅 Codex」的同等许可文本。Claude Code Remote Control 已原生上线 | byok 走原生 `claude -p`，四条件全部满足。**owner 裁定**：订阅用量是用户自身事项，不作为 SDK 设计约束。Remote Control 是 byok L2 的单 runtime 原生版，byok 可守之地是跨 runtime + 第三方 SaaS 可嵌 | 不推导设计动作；发布清单保留两行（§8 末） |
| L5 托管沙箱 | E2B / Daytona ≈ $4–5，Modal / Cloudflare / Vercel ≈ $8–10，Anthropic Managed Agents ≈ $4.80 会话时长（每用户每月，日活 2h） | 省沙箱的论点成立 | 只作对照 |
| L6 直接类比 | RAFT CLI `@botiverse/raft` 0.0.20；OpenHands Agent Canvas（MIT）走 ACP、自托管产品；Warp Oz「执行面在你的机器、控制面托管」 | **没有人在发布 MIT TS SDK 让第三方 SaaS 用用户机器当算力** | 位置空着 |

## 6. 双轨分歧与裁决

两轨一致：O1 折叠 server（b）、O2 1.0 前切 v2 删 legacy（b）、O3 保留 `RuntimeAdapter` 拒绝 ACP 作边界并把 codex 迁 app-server、O5 保留 14 个 port 拒绝合并、O7 集成面做 golden（b）、legacy 路径与 server 重复与文档失真三条违规。分歧如下：

| 议题 | Opus | Codex | 裁决（v3） | 理由 |
|---|---|---|---|---|
| session 服务端实体 | 加最小 session index，`task.started` 与终态各写一次 | 不加；`task.started` 时写 `status` 就是被禁止的云端 runtime-session 状态；若要，只做从终态回执派生的只读投影 | 过渡期（v2 前）：`TaskAttempt.sessionRef` + 从 first-terminal-wins 回执派生的 `listAgentSessions(tenant, agentRef)` 只读投影（无 running / live turn / PID）；v2：SDK 铸造 opaque `sessionId`，native locator 只留本地，云端 Session 只存身份、residency、WorkspaceRef、RuntimeRef、contextVersion、open/closed | 铁律 3 禁的是云端持有执行态；SDK 身份与 runtime 身份是两个 datum 各一权威；这也消掉 fresh/resume 两种 offer 的分裂根因 |
| WS 去留 | 随 O1 一起删 | 保留为 transport adapter | **拆成两个决策**：先消双权威（server = cloud kernel façade）；WS 去留按 consumer audit 裁——Salesko 审计（§13）已证实生产不 import `@byok-sdk/server`、无 WS 引用、显式选 long-poll capability，所以 WS 与 daemon WS transport 随 WP3B 一起删；低延迟需求另加非权威 SSE wake hint | 不变量是「语义只有一份实现」，不是「只能有一种 transport」；但单消费者 transport 违反两消费者规则，且消费者审计已回证 |
| `contentful-trajectory` 是否违规 | 未提 | 违反铁律 3，第一刀删除 | 不判违规；D3 裁定「可证明本地」：`local-first-v1` 为默认部署 profile（不声明 contentful、不挂 content-read route、不配 memory projection store、ActivityStore 只收无内容 status、单 task 不可放宽、readback 可证明）；contentful 进 `shared-observability-v1` 显式 profile（host 明示 + 终端用户授权 + retention + route readback + export receipt + UI 提示） | 需求原话「中间态留本地」是产品级承诺，「默认不传」不够；能力不删，只把它从隐藏 host flag 变成显式部署形态；Salesko 今天就是 local-first 形态 |
| TaskRunner 拆分方式 | 只删 legacy 分支；不拆三段；`create-daemon.ts` 按配置段拆 | v2 后分阶段抽三段 | 先删 legacy，再量；`create-daemon.ts` 按生命周期子系统拆；三段抽取不预先承诺 | 删除同时去掉一个决策；拆分只搬行 |
| ACP | 拒绝；v2 稳定且厂商维护时对新 runtime 做 gated PoC | 只允许作单个 adapter 内部 transport | **不加**；触发条件 = 具名下游需要 ACP-only runtime + ACP v2 出 draft + 适配器 spawn 用户已安装二进制 | 前置条件今天不成立；准入模型不同（prepare→seal→start vs tool-call 时交互授权） |
| 首刀 | 并发上限（条款驱动） | 删 contentful-trajectory | **首刀 A = canonical Agent home 单写者止血（所有 lane 统一计数）；首刀 B = 集成面 golden（已实现、PASS）** | 见 §12：golden 只防接口漂移，挡不住当前文件状态损坏；lane 上限挡不住「Claude session + Pi session 同写一个 home」 |

## 7. 违规清单（按严重度）

| # | 内容 | 证据 | 违反对象 | 严重度 |
|---|---|---|---|---|
| V1 | session 不可寻址：`TaskAttempt` 无 `sessionRef`（`cloud/src/stores/ports.ts:251-268`）；无 list-sessions 路由；`agent_memory_projection_head` 按 agent 一行；computer 拆在 `machineId`/`deviceId`/`MachineInfo` | verified | owner 需求（三单位） | 阻碍目标 |
| V2 | 同 Agent home 多 session 共 cwd、无并发上限：`agent-home.ts:600-632`；daemon 内 `maxConcurrent*` 零命中；README:87 / `host-local-storage-layout.md:64` 写「one mutable writer」，spec:551 写跨 session 并发；Salesko chat + research 两处对同一 `agentId` 并发 enqueue 且依赖 SDK 的 busy 拒绝（`apps/byok-control/src/private-agent-chat.ts:163-183`、`research.ts:197-204`） | verified | owner 需求（可并行）+ 文档一源真相 + 下游契约 | **现在就可能损坏文件状态**（MEMORY.md / notes / `.git/index` / build 产物），规模化阻碍 |
| V3 | legacy `task.offer` 默认接纳，与 Agent 路径共用实现；`agentHome` 与 `gitWorkspace` 已互斥（spec:576-580），Agent 部署里它是死分支；server `dispatch()` 的 `deviceId` 可选（`server/src/types.ts:131`），公开面仍保留 ambient 选设备 | verified；Salesko 生产 `strictAgentOnly: true`（`apps/local-agent/src/daemon.ts:67`），legacy offer 只出现在断言拒绝的测试里，`gitWorkspace` / `SessionWorkspaceStore` 零命中 → 无消费者 **verified** | owner 工作规则（无稳态兼容） | 降级 |
| V4 | `server` 与 `cloud` 双权威零共享；安全姿态已漂移（`tasks/todos.md:17` hosted bearer 缺 product 检查）；Salesko 生产零 import `@byok-sdk/server` | verified | owner 工作规则（一源真相） | 降级，漏一个安全修复即阻碍 |
| V5 | 两套 capability 词汇（wire `CAPABILITY_FLAGS` 20 个 vs core ADR-010 `CapabilityDeclaration`）无共同 registry、无交叉校验 | verified | 一源真相（registry 层） | 降级 |
| V6 | wire 冻结失去意义：v1 号下 5 种 offer、20 flag、一个拒绝门 | verified | 工作规则 | 10x 集成者时阻碍 |
| V7 | CURRENT 架构文档落后 409 commit；README 版本落后四个 train（WP1 已修）；`create-daemon.ts:690` 注释说没有 adapter 支持交互审批，`claude-adapter.ts:179` 声明支持 | verified | 证据规则 | 降级 |
| V8 | 「中间态留本地」只是默认 policy，不是服务端可验证约束 | verified | owner 需求（产品承诺） | 降级；D3 已裁定 |
| V9 | `interactive-approval` flag 冻结但无生产路径（`version.ts:35`） | verified | 工作规则 | 表面 |

## 8. P3 建议、顺序与需 owner 拍板项

**保留原样（被否的重组）**：14 个 `CloudStores` port（事务边界）；keys 的进程边界隔离；设备密钥 + 游标信箱；React-free fold；包名（对外三个组合入口 `createLocalAgentHost()` / `createEmbeddedCoordinator()` / `createHostedControlPlane()` 用 re-export 达成，不重命名）；不预先引入完整 Computer aggregate（`deviceId` 语义逐步澄清为 Installation，宿主自己决定多个 installation 是否同一 Computer）；不预先拆 TaskRunner 三段；不加 `AcpAdapter`。

**Work package 顺序（GPT-2 稿修正后）**：

| WP | 内容 | 关掉什么 | 成本 / 依赖 |
|---|---|---|---|
| **WP0 止血** | canonical Agent home 视作 mutable Workspace：**一个 home 最多一个 active Attempt**，所有 lane（subscription / byok / byok-profile）统一计数；`DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` 默认 1，只能显式提高；在 `handleOffer` 的 receive/dedup/pre-cancel/strict 顺序门之后、`prepare()` / `task.claim` / 进程启动之前 retryable decline；不同 home 并行不变；session 终态 / cancel / disposal 成功后才释放；status readback 只报计数不报正文；测试覆盖 cancellation、disposal failure、crash residue、跨 lane | V2 的文件状态损坏 | 低，只动 daemon。推翻 0.12.0 CHANGELOG「Breaking (Agent home execution)」的跨 session 并发；**Salesko 审计证实它是按 0.11.0「同 home busy 拒绝」写的，默认 1 与其契约一致**；spec:551 与 CHANGELOG 同刀改回。计划：`plans/plan-*-agent-home-single-writer.md`（Draft，待 owner 放行） |
| **WP1 契约与版本 authority** | 九包 `.d.ts` closure golden + CI diff 门（有意 breaking 门，不宣称 API 稳定）；`check:version-authority`（README / spec 对 `packages/core|keys/package.json`）；README 0.8.1→0.12.0 | V7 的集成漂移 | **已实现，gatekeeper PASS**（分支 `codex/api-surface-golden`）；follow-up：CHANGELOG 顶部版本与 `packages/client` 的 pi 精确版本纳入同一检查；不引入生成式 manifest（第二权威）；`bin` 入口面不在 golden 内，已在 `api-surface/README.md` 说明 |
| **WP2 领域 ADR** | 冻结词汇 Tenant / Computer / Installation / Agent / Session / Run / Attempt / Workspace / ResultContext；一事实一权威矩阵；native session locator 永不上云；Session 不存 runtime 中间态；store-minted Attempt/epoch；**capability = 一个 canonical FeatureRegistry（id / version / dependency / compatibility / readback schema）+ Deployment / Installation / Runtime 三个独立 authority 各报事实 + RunRequirements 声明需求，准入取交集**；local-first profile；legacy cutover policy；ambient 选设备标 legacy | 让 v2 有目标形状；修 V5 | 低（文档），决策密度高 |
| **WP3A 本地执行边界** | AgentHome（identity / profile / memory）/ SessionState（sessionId → native locator、本地 WAL）/ Workspace（实际可变文件）三分；mutable Workspace 单写者；同 Session Run 串行；**Git worktree 作 Workspace backend**（只做 `plain-directory` 与 `git-worktree` 两种，其余等消费者）；Installation 资源并发配额；终态后 memory/result CAS；WP0 的 home 锁迁到 Workspace | V2 根因 | 中；偏离 RAFT「home 即 cwd」 |
| **WP3B 协调面收敛（先于 v2 代码）** | `server` = `cloud` domain kernel（pairing / capability admission / offer reservation / inbound ownership / cancellation / first-terminal-wins / message side-effect admission）+ in-memory/SQLite 异步 stores + `TaskHandle` 便利 façade；删 `hub.ts` 独立状态机与重复 auth / pairing / task / terminal / cancellation；删 WS + daemon WS transport（Salesko 审计已回证无消费者）；v1 characterization tests 全过 | V4 | 中高；推翻 proposal §3.3「TaskStore 不做 async 迁移」。WP3A ‖ WP3B 可并行，都在 v2 代码前完成 |
| **WP4 一次性 wire v2** | 一个 cutover release，内部四个 package：**v2.1 身份与消息形状**（一种 `run.offer`：agentRef、`session {sessionId, mode: create\|resume}`、runId、workspaceRef、runtime、requirements、dataPolicyProfile；schema 整体 strict，未知字段拒绝整个 offer；目标 Installation 由 mailbox target 唯一固化，不进 payload）；**v2.2 Attempt 与 fencing**（store 原子铸造 `{attemptId, leaseEpoch}`；claim / approval / message egress / artifact finalize / terminal / result commit 校验当前 Attempt，旧 epoch 只进 audit）；**v2.3 Session 本地绑定**（云端存 sessionId / AgentRef / residency / WorkspaceRef / RuntimeRef / contextVersion / open-closed；本地存 sessionId → native locator）；**v2.4 凭证分层**（Buildkite 式 Installation → Connection → Attempt token，独立后续安全 package，不阻塞 v2 首发）；删 legacy offer / `strictAgentOnly` / 旧 task-scoped gitWorkspace authority 与 `SessionWorkspaceStore` schema（Git worktree 能力本身进 WP3A backend）；Salesko exact-pin 后一次性迁移，无 v1 fallback | V1 / V3 / V6 | 中高；只在统一 kernel 上实现一次 |
| **WP5 结果与数据 policy** | `SessionResultCommitter`：一个事务内校验当前 Attempt/epoch → 读 winning terminal → 校验 expectedContextVersion → 插入不可变 `ResultEnvelope` → 推进 Session context head → 记幂等回执；结果 `applied \| idempotent \| context-conflict \| stale-attempt`；复用 TruthStore canonicalization/CAS 原语，但 generic TruthStore 不直接当结果事务权威；`local-first-v1` 默认 + `shared-observability-v1` 显式；ActivityRelay / ActivityStore 分名；content export receipt | V8；「结果导向上下文」有版本语义 | 中 |
| **WP6 runtime parity** | codex → `codex app-server`（fresh / resume / cancel / close-quiescence / MCP exact grants / permission parity / 三平台 / native session identity / 凭证隔离全过才替换 `codex exec`）；IsolationClass 声明 + `minimumIsolation` 准入（codex 原生 sandbox 作 observation 上报）；`RuntimeRef` 本地预注册（云端只能选本地已声明 id）；`create-daemon.ts` 按生命周期子系统拆（enrollment / transport / journal-storage / agent-home-egress / control-plane / presence / runtime composition）；删 legacy 后再量 TaskRunner | codex parity；隔离能力声明 | 中，独立 workstream |

**D1–D5 裁决（GPT-2 稿裁定，owner 以转发本稿并要求修正方案确认；剩余条件列在括号内）**：
- D1 折叠 `server` 为 cloud kernel 的 embedded façade：**采纳**，代码实施先于 v2；WS 删除条件已由 Salesko 审计满足。
- D2 1.0 前切 wire v2：**采纳**，Session / Run / Attempt / fencing 是核心，三级 token 拆后续；禁 v1/v2 长期双读双写（Salesko 一次性迁移授权仍需 owner 点头）。
- D3 中间态承诺：**选「可证明本地」**，`local-first-v1` 默认，contentful 进 `shared-observability-v1`。
- D4 AgentHome 不再等于 cwd：**采纳**；WP0 立即加 home 级单写者（默认 1 已由 Salesko 契约回证），最终按 mutable Workspace 单写者。
- D5 codex 迁 app-server：**原则采纳**，独立 workstream，不是 v2 首发 blocker。

**发布清单（非架构约束，owner 已裁定不驱动设计）**：Claude lane 正式公开推广前完成 Commercial Terms review；Codex lane 的「第三方产品运行用户自有订阅 Codex 二进制」无同等许可文本，作为独立书面确认项。

## 9. GPT 稿（`20260903-GPT-review.md`）对照

**一致**：方向正确不推倒重写；Session 不是一等对象；同 Agent home 并行写是最明确的架构风险；ACP 只作 adapter SPI 概念参照；Buildkite / GitHub runner 是配对与租约的正确参照；README 版本漂移。

**GPT 稿补上、本报告采纳的**：Installation 作为 auth/capability 载体；AgentHome / Workspace / SessionState 三分与「mutable Workspace 单写者」规则；`sessionId` 由 SDK 铸造、native locator 只留本地（这同时解释了 0.7.0 fresh/resume 死锁的根因）；Run / Attempt + leaseEpoch fencing；五级数据分类 + `local-first-v1` + Relay/Store 分名；IsolationClass；`RuntimeRef` 本地预注册；14 条验收场景（§十五）作 v2 conformance 清单。

**GPT 稿没看到、本报告坚持的**：`server` 与 `cloud` 零共享的双权威；wire v1 的 5 offer / 20 flag 累积（GPT 说「保留 frozen wire」，但其 P0 全是 wire 改动）；两套 capability 词汇；legacy 路径默认接纳。

**事实核对**：README 0.8.1 vs 0.12.0（verified）；「one mutable writer」文档矛盾（verified）；server `DispatchInput.deviceId` 可选（verified）；`TaskAttemptStatus` 含 `offered/claimed/cancel_requested`（verified）；「尚无 result-context CAS」不完全对：core truth 层已有 per-key `expectedRev` CAS（`truth.ts:7-8,74,109`），缺的是 session 级 context version 与 terminal/Attempt 的绑定；Microsoft AHP `[unverified]`，不作 load-bearing 证据；`@byok/*` 包名重组不采。

## 10. 未验证与不确定项

- Anthropic 法务页内容来自两次抓取（本轮调研 agent、GPT-2 稿），owner 已裁定不作为设计约束。
- RAFT 服务端持久化在 `raft-study` 里全是 `[static-client-contract]`，本地 `raft-computer` 探针无法回答服务端问题，未启动 reverse 探针；`raft-study` 内 WS 控制通道两处文档与 08-26 结论矛盾，属研究文档自身未对账。
- `sdk-architecture.md` §15 与附录 A 标「目标设计」的内容未逐条与当前源码比对。
- AHP 存在性与内容未核实。
- Salesko 审计是 grep 驱动的静态审计，`apps/web` / `apps/mobile` / `apps/sidecar` 未逐文件读；Salesko 仍钉 0.11.0，其在 0.12.0 语义下的实际行为未运行验证。

## 11. 下一刀

**下一刀 A**
建议切 `canonical Agent home 单写者止血（WP0）`：`DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` 默认 1，所有 lane 统一计数，在 `task-runner.ts:1482` `handleOffer` 里、`:1560-1573` 顺序门之后、admission/prepare/claim 之前按 canonical home 计 active Attempt，超限走既有 retryable `task.decline`；终态 / cancel / disposal 成功后释放；不同 home 并行不变；status readback 只报计数。理由是 `同一 Agent 的多个 session 今天就共用一个 cwd 且无任何上限`（`agent-home.ts:600-632`，daemon 内 `maxConcurrent*` 零命中），MEMORY.md / notes / `.git/index` 的多写者损坏是当前唯一的运行时正确性风险，golden 门挡不住它，而唯一下游 Salesko 本就按「同 home busy 拒绝」写（§13）。这一刀足够，因为 decline 路径与 lease manager 都已存在，只加一个计数与一个门，不碰 wire、cloud、store；它推翻 0.12.0 的跨 session 并发是有意的，spec:551 与 CHANGELOG 同刀改回。入口是 `packages/client/src/agent-home.ts`（`AgentHomeExecutionLeaseManager`）+ `packages/client/src/daemon/task-runner.ts:1482` + `create-daemon.ts` 的 `DaemonConfig` 校验；验证面是「同 home 第二个 mutable session 无论哪个 lane 都被 decline、不同 home 并行、cancel/disposal 失败/crash residue 后计数正确」的测试，然后四个 required checks。

**下一刀 B**（已完成、PASS）：集成面 golden + 版本 authority 门，分支 `codex/api-surface-golden`，一次提交，不推送；首个 Linux CI 跑是 tsc 跨平台确定性的唯一证明。

## 12. GPT-2 稿（`20260903-GPT-review-2.md`）对照与采纳

GPT-2 稿是对本报告 v2 的逐条回应。采纳其中五处修正（均已并入 §6 / §8 / §11）：

| 修正 | 采纳理由（第一性） |
|---|---|
| 首刀改为「同 home 单写者止血」，golden 退为第二刀 | golden 只防接口漂移；当前共 cwd 无上限是**运行时**正确性问题。lane 上限挡不住「Claude subscription session + Pi BYOK session 同写一个 home」，所以并发控制必须按 home（正确性）而非按 lane（用量）计数 |
| server/cloud 收敛先于 v2 代码 | 否则 Session / Run / Attempt / fencing 在两套权威里各实现一遍再删一套；报告自己的核心发现正是双权威已漂移 |
| capability：一个 FeatureRegistry + Deployment / Installation / Runtime 三个独立 authority + RunRequirements 求交 | 云端支持 transcript read ≠ 本机允许；本机有 codex sandbox ≠ 部署允许上云；Run 要求某 toolset ≠ 设备已配置。要统一的是 id / version / prerequisite / readback schema，不是各 actor 的事实 |
| v2 拆 v2.1–v2.4 四个 package、一个 cutover；三级 token 后置；Git worktree 能力保留为 Workspace backend，只退旧 authority | 把 token issuance / renewal / revocation 塞进 v2 会把身份迁移拖成安全大项目；worktree 能力正好是同 repo 并行的实现，删的是「与 AgentHome 并列互斥的旧 workspace authority」 |
| `SessionResultCommitter` 作为专门事务权威，不让 generic TruthStore 直接当结果权威 | 需要同时校验 winning Attempt、epoch、first-terminal-wins、expectedContextVersion、幂等，这是一个事务，不是一次 CAS 写 |

**不采纳 / 保留原判**：生成式 release manifest（仍是第二版本权威；CHANGELOG 与 pi 版本改为纳入现有检查）；法务两行只进发布清单，不进设计。

**GPT-2 稿对我方 v2 的三处文字修改要求**：已全部执行（§11 下一刀 A/B；§8 WP3B 先于 WP4；§8 WP2 capability 表述）。

## 13. Salesko 下游审计（只读，`/Users/kito/Projects/salesko-new@1ec6ca9`）

| 问题 | 结果 | 证据 |
|---|---|---|
| 钉的版本 | 全部 `@byok-sdk/*@0.11.0`、`keys@0.3.8`，无 0.12.0 引用 | `apps/local-agent/package.json:22-30`、`apps/byok-control/package.json:23-26` |
| 同 agent 并发 session | 无客户端按 agent 串行；chat 与 research 两个调用点可对同一 `agentId` 并发 enqueue，注释明写把「busy home」仲裁交给 SDK、不换设备不换模式 | `apps/byok-control/src/private-agent-chat.ts:163-183`、`research.ts:197-204`；`apps/api/src/private-agent-dispatch.ts:44-58` 一个 Profile 一个 `agentId` |
| legacy 路径 | 生产 `strictAgentOnly: true`；`task.offer` / `task.offer_with_toolsets` 只在断言拒绝的测试里；`gitWorkspace` / `SessionWorkspaceStore` 零命中；`workspaceRoot` 是在用的现行 config 字段 | `apps/local-agent/src/daemon.ts:64-67`、`gate-b/production-composition.consumer.test.ts:109-193` |
| server / WS | 生产零 import `@byok-sdk/server`；`ws://` / `wss://` / `BYOK_WS_PATH` / `/byok/ws` 零命中；显式声明 `eventsLongPoll` 等 capability；`apps/byok-control`（Cloudflare Worker）组合 `createByokCloud` + `cloud-dataplane/runtime` Postgres | `apps/byok-control/src/config.ts:88-94`、`main.ts:1-16` |
| egress / capability | policy 硬编码 `metadata-status` + `latest-value`，workspace/transcript/artifact transfers 全 `disabled`；测试断言拒绝 `contentful-trajectory`；`agentMemory` / `agent-content-*-read` 零命中 | `packages/contracts/src/index.ts:5041-5054`、`apps/local-agent/src/daemon.ts:70`、`apps/byok-control/src/research.test.ts:112` |
| 在用的 `DaemonConfig` 字段 | localAgentRelease、productName、productId、serverUrl、deviceName、workspaceRoot、storeDir、agentHome{hostStorageRoot, projection}、strictAgentOnly、agentEgress、branding、runtimePreference、runtimeAllowlist、permissionDefaults、sdkHelperHost、deviceAssertion、mcpToolsets、resultDocument、piByokLauncher、runtimeEnvironment | `apps/local-agent/src/daemon.ts:47-103` |

对本报告的影响：V3「无 legacy 消费者」由推断变为 verified；D1 的 WS 删除条件满足；WP0 默认 1 与 Salesko 现行契约一致；D3 的 `local-first-v1` 就是 Salesko 今天的形态；WP1 golden 覆盖的 `DaemonConfig` 字段集合即上表。
