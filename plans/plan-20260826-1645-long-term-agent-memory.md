# Plan — 长期 agent 记忆（byok-sdk）

> Created: 2026-08-26 · Owner: Fable 主循环编排（planning authority）· Execution owner: Codex · Status: Phase 1 source complete / gate PASS; Phase 2 deferred
> Scope repo: `byok-sdk` · Capability: `root`（packages/client）
> Decision Packet: `docs/researches/2026-08-26_long-term-agent-memory-decision-packet.md`（owner 已裁 Q1 core / Q3 per-agent / Q2 A+B / Q4 hosted opt-in）

## Goal

给 byok-sdk 一个跨 session、runtime 无关、凭证隔离、与 compaction 解耦的长期记忆能力（A 本地文件 baseline + B 可选 hosted），支撑 salesko / aiphabee 这类长期专精 agent。

## P2 Concrete Trace（本刀已跑，2026-08-26）— A baseline 基础设施 ~80% 已存在

**已建好（不要重造）：**
- **per-agent 持久 cwd/home** = `<hostStorageRoot>/agents/<agentId>`（`agent-home.ts:257`，`AgentHomeLayout.resolve`）。**只按 agentId keyed**，`homeDir == canonicalHome == runtime cwd`（:73-79），跨 session 稳定（路径不含 session/task），collision-guarded（`agentIdByCanonicalHome`）。`profileRevision` 仅用于 projection staleness 排序，**不进路径**——故编辑同一 agent 的 profile 不换 home、不丢记忆。aiphabee 的"不同风格 agent"= 不同 agentId = 各自独立 home。✓
- **seed-if-absent**：`initializeAgentHome`（`agent-home.ts:536`，经 `startUnderLease`→`project`/`initialize` 每次 home 初始化调用）建 `notes/` 目录 + `ensurePreservedFile(MEMORY.md)`。`ensurePreservedFile`（:219）用 `open(wx,0600)`——**只在缺失时建、永不覆盖**。✓（幂等、不 clobber 已存在的 [[pi-compaction-ruling]] 风格记忆）
- **content-read 边界**：`MEMORY.md` 已在 `SDK_RESERVED_CONTENT_NAMES`（`agent-content-read.ts:206`）；hosted content-read 虽有 workspace/transcript/artifact 三 surface，但 reserved-name policy 明确拒绝读取 `MEMORY.md`。长期记忆不会因此隐式成为 SaaS 可读内容。✓
- **seed 内容 seam**：`AgentHomeProjection`（host `prepare`/`apply` 钩子，`agent-home.ts:697`）可把内容 project 进 home。✓
- **prepend 先例**：`prependGitWorkspaceGuidance`（`git-workspace.ts:498` → `GitWorkspaceManager.prependGuidance:410`）——已有"把 guidance 前置进 instruction"的模式。✓

**真实缺口（本刀要做的，小而精）：**
1. **无记忆纪律 prompt 注入**：adapter 只吃 task `instructions` 字符串，**没有**"先读 MEMORY.md 索引、按需拉 notes、用后更新"的 runtime 无关纪律。**这是让记忆真正生效的关键缺口**——不注入，seed 的文件就没人用。
2. **无 size-guard telemetry**（次要）。

**Phase 1 执行纠正（2026-08-26）：** `AgentRef` 只有 opaque `agentId/profileRevision`，SDK 没有 Agent name/role/description，也不得解析 Profile 来合成它们。因此空 `MEMORY.md` 不是需要由 SDK 模板修复的缺陷：create-if-missing 保持机械、内容继续 model/host-authored；startup guidance 仅在 strict Agent task 中要求模型在文件为空时初始化简短索引。

## Locked Decisions（来自 Decision Packet，不在此重议）

- A（本地文件 + prompt 纪律）= 默认 core primitive；SDK 只拥有 per-Agent home、隔离和 startup guidance，记忆内容仍由 model/host author，recall 用模型自身 file 工具、不 auto-inject。
- B（memory-MCP + 可选 hosted 后端）= embedder opt-in，默认关；hosted 是单向投影非第二权威；带 consent + redaction seam + metering hook + 审计，上传 fail-closed。变现策略/脱敏标准/法务留 embedder。
- C（pi compaction 扩展）拒绝。记忆与 compaction 解耦，禁碰 `session_before_compact`。
- 凭证隔离铁律：记忆目录零 runtime 凭证。

## Task Breakdown

### Phase 1 — A baseline 补齐（补 1 个真实缺口；写域 `packages/client`）

- [x] **T1 seed ownership 裁定**：保留现有空文件 create-if-missing + never-overwrite；不从 opaque AgentRef 合成 name/role/description，不让 SDK取得 Profile/记忆语义权威。首次内容由模型按 guidance 或 host projection author。
- [x] **T2 记忆纪律 prepend（核心）**：新增 `prependAgentMemoryGuidance(instruction)`，镜像 `prependGitWorkspaceGuidance`；内容 = runtime 无关的"启动先读 `MEMORY.md`（cwd 内）索引→按指针拉 `notes/`；权限允许且出现 durable value 时更新 MEMORY.md 索引与 notes；MEMORY.md 保持精简、自足；禁止写入 credential/secret"。只在 `agentBinding` 存在的 strict Agent task 中，经 task-runner 的共同 `RuntimeOperationStartInput.instruction` seam 前置，故 pi/claude/codex 共用；普通 task/Git workspace 不注入。该 seam 是 startup instruction guidance，不冒充 system/developer policy，也不保证 compaction 后机械重读。
- [ ] **T3（可选）size-guard telemetry**：MEMORY.md 字节数 + over-threshold 观测（只告警不阻断，阈值可配），复用现有可观测面。
- [x] **验收**：三 runtime 都经共同 seam 拿到记忆 guidance；普通 task 不注入；既有 seed 幂等/no-clobber 与 reserved-content negative 保持通过。`bun run build`、`bun run typecheck`、`bun run test`、`repo-harness run check-task-workflow --strict` 均通过；独立 gatekeeper PASS。一次无关 cloud-dataplane dry-run 5 秒超时经 focused 重跑与随后 full suite 证明为 transient，本 slice 未修改该模块。

### Phase 2 — B 可选能力（capability-gated，独立后续 slice，本刀只 scope 不实现）

- [ ] memory-MCP tool（`memory.recall`/`memory.save`，落"MCP 进程级插件"方向）。
- [ ] 可选 hosted 后端 + 护栏：opt-in capability flag（默认关）+ consent gate + redaction seam + per-agent metering hook + 审计；上传 fail-closed；hosted = 本地记忆单向投影。
- [ ] 前置 consumer contract：aiphabee 是否多方协作、backend/consent/authz/retention 如何定义、是否对记忆计量；hosted opt-in 方向不替代这些细节裁决。

## Verification

- `bun run build` / `bun run typecheck` / `bun run test`
- `repo-harness run check-task-workflow --strict`
- 针对性：既有 agent-home seed 幂等测试、三 runtime instruction 前置断言、普通 task negative、content-read 对 reserved `MEMORY.md` 的拒绝回归。

## Out of Scope

- pi compaction 扩展 / 任何 compact 中间件叠加。
- 改 pi native compaction 默认（见 `plan-20260826-1542-context-fold-compaction-poc.md`，DEFERRED）。
- Phase 2 的 hosted 实现（独立 slice + frozen consumer contract 后）。
- 记忆变现策略 / 脱敏标准（glue，留 embedder + 法务）。

## Risks

- **T2 是功能成败点，但不是强制执行面**：不注入纪律，seed 的文件全程无人用；注入后仍只是 startup instruction，模型是否遵循必须由 downstream live conformance 验证，不能从单元测试推断。
- **prompt 注入污染**：memory guidance 只前置进 strict Agent task instruction；普通 task/Git workspace 保持原路径，避免把不存在的 Agent-home contract 扩散出去。
- **升 ADR**：Phase 1 落地后把 Decision Packet 的 A 部分升成 canonical 架构文档（`docs/architecture/`，harness-gated），本刀不擅改架构契约。
