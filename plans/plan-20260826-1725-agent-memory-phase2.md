# Plan: Agent Memory Phase 2

> **Status**: Review
> **Created**: 20260826-1725
> **Slug**: agent-memory-phase2
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260826-1725-agent-memory-phase2.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260826-1725-agent-memory-phase2.md`; after execution revert branch `codex/agent-memory-phase2` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260826-1725-agent-memory-phase2.contract.md`
> **Task Review**: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md`
> **Implementation Notes**: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260826-1725-agent-memory-phase2.md`
- Sprint contract: `tasks/contracts/20260826-1725-agent-memory-phase2.contract.md`
- Sprint review: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md`
- Implementation notes: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260826-1725-agent-memory-phase2.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260826-1725-agent-memory-phase2.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260826-1725-agent-memory-phase2.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260826-1725-agent-memory-phase2.contract.md`
- Review file: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md`
- Implementation notes file: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260826-1725-agent-memory-phase2.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260826-1725-agent-memory-phase2.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260826-1725-agent-memory-phase2.md`; after execution revert branch `codex/agent-memory-phase2` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260826-1725-agent-memory-phase2.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260826-1725-agent-memory-phase2.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260826-1725-agent-memory-phase2.contract.md`, `tasks/reviews/20260826-1725-agent-memory-phase2.review.md`, and `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260826-1725-agent-memory-phase2.md`; after execution revert branch `codex/agent-memory-phase2` or the explicitly reviewed diff.

## Captured Planning Output

# Plan — 长期 agent 记忆（byok-sdk）

> Created: 2026-08-26 · Owner: Fable 主循环编排（planning authority）· Execution owner: Codex · Status: Approved / Phase 2 in progress
> Scope repo: `byok-sdk` · Capability: `root`（packages/client, packages/protocol, packages/cloud, packages/cloud-dataplane, deploy/sql, packages/conformance）
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
- [x] **T3（裁定不纳入）size-guard telemetry**：本 work-package 不引入 SDK-owned 语义阈值；现有 256 KiB hard bound 已执行安全上限，产品级 warning/telemetry 留给有真实 consumer 阈值的后续独立 slice。
- [x] **验收**：三 runtime 都经共同 seam 拿到记忆 guidance；普通 task 不注入；既有 seed 幂等/no-clobber 与 reserved-content negative 保持通过。`bun run build`、`bun run typecheck`、`bun run test`、`repo-harness run check-task-workflow --strict` 均通过；独立 gatekeeper PASS。一次无关 cloud-dataplane dry-run 5 秒超时经 focused 重跑与随后 full suite 证明为 transient，本 slice 未修改该模块。

### Phase 2 — B 可选能力（capability-gated，本刀实现）

- [x] **Local memory MCP**：SDK-owned reserved stdio server，只向 strict Agent task 注入 `memory.recall` / `memory.save`；请求绑定 active task/session/runtime + exact AgentRef，不接受 model 传 identity/root path。读写仅限 `MEMORY.md` 和 `notes/**/*.md`，sha256 revision + CAS + atomic replace/delete，路径逃逸/symlink/secret/.byok 全部 fail closed。Linux 使用 native descriptor backend；macOS 仅在 product 显式配置通过本机 race proof 的 absolute-path helper 时注入；Windows 仍 fail closed。
- [x] **Local projection boundary**：Agent-home 文件继续是唯一 authoring authority；hosted 是 bounded deterministic full snapshot 的单向 redacted projection。redactor 必须显式注入，无 identity/pass-through 默认；outbox 只持久化 redacted bytes，quiescence 捕获 native file-tool direct writes。
- [x] **Hosted contract**：显式 capability + `MemoryGrantAuthorizer` + `MemoryProjectionStore`，缺任一不宣告/不上传。mutation 验证 tenant/device/task/exact AgentRef/session/runtime/grant/writerEpoch/sourceSeq/mutationId/policyRevision/redacted hash/bytes；model boolean 不是 consent authority。
- [x] **Durable projection**：Postgres bounded `bytea` latest snapshot，key=`(tenantId, agentId)`，单 writer epoch + gap-free source sequence，exact replay 返同 receipt 且不双计量；accepted redacted bytes 与 immutable meter receipt 同事务写入；server-side erase 不依赖 device online。
- [x] **Hard negatives**：不做 hosted→local import/restore、multi-device merge、RAG/search/history browser、product facts adapter、compaction hook；不解除 hosted content-read 对 `MEMORY.md` 的 deny。
- [x] **Consumer-owned remains**：consent UI、商业定价、法务 retention policy、identity BFF 的具体实现不属于 SDK 本刀；SDK 只提供 fail-closed ports 和可验证 contract。

### Phase 2 P1 remediation — Claude reject follow-up

- [x] **P1 helper admission**：Linux native backend 与 macOS-only helper config 不得形成 admitted-then-runtime-fail；显式 helper config 在 unsupported platform 构造期 fail closed。
- [x] **P1 outbox replay/erase**：证明并修复 pending record 跨 task/session 与 server erase 后的 sequence wedge，同时保留 exact task authorization、single-writer epoch、gap-free sequence 与 no merge/import 边界。
- [x] **P1 bounded local logs**：outbox 与 audit 必须有 bounded compaction/rotation；任何日志维护失败不得在 source file 已成功 replace/delete 后把 save 伪装成失败。
- [x] **P1 helper EPIPE**：helper stdin 的 stream-level error 必须被客户端捕获并转为 bounded operation failure，不得成为 daemon uncaught exception。
- [x] **重验**：每个 P1 均保留 unfixed regression evidence；focused/full strict checks、remote CI 与后续 exact-subject review 已完成，历史 reject 已由更晚的 typed receipt 取代。

### Phase 2 P1 remediation round 2 — second Claude reject follow-up

- [x] **P1 helper internal-state bounds**：统一为 1 MiB bounded v2 state + base64-only helper v2 wire + 2 MiB request/response line；真实 helper stdio guard 覆盖上限成功、+1 byte 与 user-file 256 KiB negative，无 unbounded transport。
- [x] **P1 portable EPIPE guard**：EPIPE regression 在 Linux CI 显式模拟 darwin helper admission 后触发 stream error，不再依赖本机 macOS 偶然可达。
- [x] **P1 observable replay outcome**：initial drain 与 trailing publish 的 `accepted:false` 都产生 typed、body-free projection pending failure；pending 未清空时不 capture/audit，也不分配新 sequence。
- [x] **P1 historical grant authority**：同 writer epoch 下 prior task/session 的 exact permits 可共存；更高 epoch retire 旧 permits，stale lower grant 不复活，tenant/device/task/AgentRef/session/runtime/policy binding 不放宽。
- [x] **Round 2 重验**：四个 P1 各有 pre-fix red guard；focused、真实 macOS helper、Linux CI-equivalent、disposable dataplane、full strict checks 与该轮 Claude review 均已完成。

### Post-review medium remediation — Darwin `st_dev`

- [x] **Darwin `st_dev` wire parity**：red guard 以 synthetic negative `syscall.Stat_t.Dev` 证明 helper 原先输出负十进制、与 libuv/Node 的 unsigned 64-bit bigint 不一致；Unix helper 现在对 dev/ino 显式做 `uint64` normalization，保持单一 decimal identity shape。
- [x] **真实 helper focused verification**：Go targeted/full tests 通过；使用本机 freshly built helper 的 TypeScript integration 2 files / 6 pass、4 platform skips。
- [x] **可选 LOW tool-name 变更暂缓**：`memory.recall` / `memory.save` 是 public MCP surface；没有 approved one-shot migration contract 时不重命名、不加 alias/fallback。
- [x] **Owner re-gate / push authority**：owner 后续分别授权并完成 local re-gate、push、CI 与 fresh external review；merge 仍是独立 authority，未获授权。

### Post-regate P1 remediation — metadata-only audit concurrency

- [x] **Regression-first evidence**：同一 canonical Agent home 的 recall/recall、recall/save 与 recall/snapshot 均可并发读取相同 audit CAS revision；另证明 recall 已成功读取 source 后仍会因 metadata-only audit 持久化失败而 hard fail。red guard 与 pre-fix artifact 均已保留。
- [x] **单一 per-home writer queue**：把现有 save queue 提升为 module-owned home queue；save mutation+audit 继续作为一个临界区，recall 与 snapshot 只串行化 audit writer，不把 source reads 全部单线程化。
- [x] **一致 failure disposition**：recall 的 source read 成功后，audit failure 与 save 一样返回 `agent_memory_audit_unavailable` warning；不伪造 source failure 或 rollback。
- [x] **重验**：focused client guards、package typecheck/build/test 与 strict contract checks 已通过；后续 push、remote CI 与 fresh external review 已按独立授权完成，merge 仍未授权。

### Post-CI external-review P1 remediation — terminal/CI/ingress bounds

- [x] **Regression-first evidence**：三个独立 guard 分别证明 hosted publish 可无限阻塞 quiescence/lease release、macOS Go helper 与 TS↔Go contract 未接入 CI、projection route 在 schema bound 前无界读取 chunked JSON；三个 pre-fix artifact 均保留 `PRE_FIX_EXIT=1`。
- [x] **Bound terminal publish**：hosted projection 的每次 `port.publish` 必须在 10 秒内 settle；timeout 转为现有 observable projection failure，pending redacted outbox 保留供后续 replay，task close 可继续释放 Agent-home lease。
- [x] **Reproducible macOS helper CI**：新增独立 macOS job，使用 module-owned Go 1.26.5 authority 执行 Go tests/build，并以 built helper 设置 `BYOK_TEST_AGENT_MEMORY_FS_BIN` 跑 TS↔Go integration；source-scan guard 防止 job 静默消失。
- [x] **Pre-parse projection body bound**：authenticated projection route 在 JSON parse 前同时约束 declared 与 streamed bytes；超过 envelope hard ceiling 返回 413，不以 schema 422 掩盖资源上限。
- [x] **本地重验**：三个 focused guards、真实本机 Go helper integration、client/cloud package checks 与 full strict contract 全绿，new subject 已冻结。本 slice 不修 P2；push、remote CI、fresh external review 与 merge 仍需后续独立授权。

### Post-external-pass blocker promotion — adapter MCP capability + projection reconciliation

- [x] **Regression-first evidence**：strict Agent task 在 `mcpToolsets:false` adapter 上仍收到 reserved `byokagentmemory` server；focused guard 先红并在 `.ai/harness/runs/agent-memory-mcp-toolsets-p2-pre-fix.log` 保留 `PRE_FIX_EXIT=1`。
- [x] **Capability fail-closed**：Agent-memory MCP requirement 进入既有 `pickAdapter` capability gate；显式不支持 runtime 在 claim 前 non-retryable decline，自动选择跳过不支持 adapter，并以同一 predicate 控制 reserved MCP 注入，不允许 silent downgrade。
- [ ] **Projection reconciliation isolation**：冻结 source 后重新生成 capability/architecture projections；将 `.ai/context/context-map.json`、`docs/architecture/index.md`、`docs/architecture/requests/root.md`、`packages/AGENTS.md`、`packages/CLAUDE.md` 转移到独立 `codex/agent-memory-projection-reconciliation` branch，Phase 2 subject 不混入 generated authority WIP。
- [ ] **新 subject 重验**：focused guard、client build/typecheck/test 与 full strict contract 通过后冻结新 normalized subject。旧 `external_pass` 因 production source 变化转 stale；push、remote CI、fresh external review 与 merge 继续需要独立授权。

## Verification

- `bun run build` / `bun run typecheck` / `bun run test`
- `repo-harness run check-task-workflow --strict`
- 针对性：既有 agent-home seed 幂等测试、三 runtime instruction 前置断言、普通 task negative、content-read 对 reserved `MEMORY.md` 的拒绝回归。

## Out of Scope

- pi compaction 扩展 / 任何 compact 中间件叠加。
- 改 pi native compaction 默认（见 `plan-20260826-1542-context-fold-compaction-poc.md`，DEFERRED）。
- 记忆变现策略 / 脱敏标准（glue，留 embedder + 法务）。
- hosted 向本地的恢复/导入、多设备并发写和语义 merge。

## Risks

- **T2 是功能成败点，但不是强制执行面**：不注入纪律，seed 的文件全程无人用；注入后仍只是 startup instruction，模型是否遵循必须由 downstream live conformance 验证，不能从单元测试推断。
- **prompt 注入污染**：memory guidance 只前置进 strict Agent task instruction；普通 task/Git workspace 保持原路径，避免把不存在的 Agent-home contract 扩散出去。
- **升 ADR**：Phase 1 落地后把 Decision Packet 的 A 部分升成 canonical 架构文档（`docs/architecture/`，harness-gated），本刀不擅改架构契约。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] **T1 seed ownership 裁定**：保留现有空文件 create-if-missing + never-overwrite；不从 opaque AgentRef 合成 name/role/description，不让 SDK取得 Profile/记忆语义权威。首次内容由模型按 guidance 或 host projection author。
- [x] **T2 记忆纪律 prepend（核心）**：新增 `prependAgentMemoryGuidance(instruction)`，镜像 `prependGitWorkspaceGuidance`；内容 = runtime 无关的"启动先读 `MEMORY.md`（cwd 内）索引→按指针拉 `notes/`；权限允许且出现 durable value 时更新 MEMORY.md 索引与 notes；MEMORY.md 保持精简、自足；禁止写入 credential/secret"。只在 `agentBinding` 存在的 strict Agent task 中，经 task-runner 的共同 `RuntimeOperationStartInput.instruction` seam 前置，故 pi/claude/codex 共用；普通 task/Git workspace 不注入。该 seam 是 startup instruction guidance，不冒充 system/developer policy，也不保证 compaction 后机械重读。
- [x] **T3（裁定不纳入）size-guard telemetry**：本 work-package 不引入 SDK-owned 语义阈值；现有 256 KiB hard bound 已执行安全上限，产品级 warning/telemetry 留给有真实 consumer 阈值的后续独立 slice。
- [x] **验收**：三 runtime 都经共同 seam 拿到记忆 guidance；普通 task 不注入；既有 seed 幂等/no-clobber 与 reserved-content negative 保持通过。`bun run build`、`bun run typecheck`、`bun run test`、`repo-harness run check-task-workflow --strict` 均通过；独立 gatekeeper PASS。一次无关 cloud-dataplane dry-run 5 秒超时经 focused 重跑与随后 full suite 证明为 transient，本 slice 未修改该模块。
- [x] **Local memory MCP**：SDK-owned reserved stdio server，只向 strict Agent task 注入 `memory.recall` / `memory.save`；请求绑定 active task/session/runtime + exact AgentRef，不接受 model 传 identity/root path。读写仅限 `MEMORY.md` 和 `notes/**/*.md`，sha256 revision + CAS + atomic replace/delete，路径逃逸/symlink/secret/.byok 全部 fail closed。Linux 使用 native descriptor backend；macOS 仅在 product 显式配置通过本机 race proof 的 absolute-path helper 时注入；Windows 仍 fail closed。
- [x] **Local projection boundary**：Agent-home 文件继续是唯一 authoring authority；hosted 是 bounded deterministic full snapshot 的单向 redacted projection。redactor 必须显式注入，无 identity/pass-through 默认；outbox 只持久化 redacted bytes，quiescence 捕获 native file-tool direct writes。
- [x] **Hosted contract**：显式 capability + `MemoryGrantAuthorizer` + `MemoryProjectionStore`，缺任一不宣告/不上传。mutation 验证 tenant/device/task/exact AgentRef/session/runtime/grant/writerEpoch/sourceSeq/mutationId/policyRevision/redacted hash/bytes；model boolean 不是 consent authority。
- [x] **Durable projection**：Postgres bounded `bytea` latest snapshot，key=`(tenantId, agentId)`，单 writer epoch + gap-free source sequence，exact replay 返同 receipt 且不双计量；accepted redacted bytes 与 immutable meter receipt 同事务写入；server-side erase 不依赖 device online。
- [x] **Hard negatives**：不做 hosted→local import/restore、multi-device merge、RAG/search/history browser、product facts adapter、compaction hook；不解除 hosted content-read 对 `MEMORY.md` 的 deny。
- [x] **Consumer-owned remains**：consent UI、商业定价、法务 retention policy、identity BFF 的具体实现不属于 SDK 本刀；SDK 只提供 fail-closed ports 和可验证 contract。
