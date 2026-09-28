# Plan: Hermes Bot Mode adoption: memory, identity and tools

> **Status**: Executing
> **Created**: 20260928-0217
> **Slug**: hermes-bot-adoption
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: Claude planning session 4b64b581-4869-4367-862f-170022f2cdb8 plus current source traces
> **Artifact Level**: work-package
> **Promotion Reason**: User requested file-backed plan and delegation
> **Verification Boundary**: WP1-I SDK implementation: protocol/identity/helper/runtime/ACL focused evidence and root required checks; downstream adoption remains separate
> **Rollback Surface**: Revert only this worktree owned implementation/documentation patch; preserve original checkout and concurrent WIP
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md`
> **Task Review**: `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md`
> **Implementation Notes**: `tasks/notes/20260928-0217-hermes-bot-adoption.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: Claude planning session 4b64b581-4869-4367-862f-170022f2cdb8 plus current source traces
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260928-0217-hermes-bot-adoption.md`
- Sprint contract: `tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md`
- Sprint review: `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md`
- Implementation notes: `tasks/notes/20260928-0217-hermes-bot-adoption.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260928-0217-hermes-bot-adoption.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260928-0217-hermes-bot-adoption.md`.

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
- Contract file: `tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md`
- Review file: `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md`
- Implementation notes file: `tasks/notes/20260928-0217-hermes-bot-adoption.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260928-0217-hermes-bot-adoption.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert only this worktree owned implementation/documentation patch; preserve original checkout and concurrent WIP
- **Verification boundary**: WP1-I SDK implementation: protocol/identity/helper/runtime/ACL focused evidence and root required checks; downstream adoption remains separate
- **Review/acceptance boundary**: `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User requested file-backed plan and delegation

## Evidence Contract

- **State/progress path**: `plans/plan-20260928-0217-hermes-bot-adoption.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260928-0217-hermes-bot-adoption.contract.md`, `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md`, and `tasks/notes/20260928-0217-hermes-bot-adoption.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert only this worktree owned implementation/documentation patch; preserve original checkout and concurrent WIP

## Captured Planning Output

## Goal

将 Hermes Bot Mode 的记忆分层、持久身份、session-scoped 工具能力转为 BYOK 可实施的分阶段工作包。最初「落plan派工」及后续批准已完成机制研究与契约修订；当前授权扩至 WP1-I SDK prepared memory 实现与本地验证。发布、部署、Host adoption 与生产迁移不在当前切片。

## Scope and Decisions

- 首轮 WP0、WP1-D、WP2-D 已完成。当前执行 WP1-I，受 accepted memory contract 与父 code-change contract 的准确 allowed_paths 约束。
- [ASSUMED] Salesko 是首个真实 Host 消费者；理由：已有 Bot/prepared 工作流。main是旧聊天路径，不代表全部已有实现；同时只读核查 salesko-new-wt-c07-host 候选树，任何新实现先查已有候选，禁止重复建设。不在其checkout写代码。
- 保留 SDK AgentRef/home/lease/CAS、opaque content、official Pi provider/runtime authority、prepared 预计数和冻结工具面。Host 拥有 persona、用户事实、记忆提议/审批语义、conversation 与 epoch。
- 不导入 Hermes runtime，不按 title/UI marker 授权，不增加跨 Agent memory 读取，不用 tool visibility 代替 invocation authorization。
- 不新增 SDK 自动 memory 注入、memory proposal 业务数据库、第二套 conversation authority 或无真实消费者的 provider abstraction。
- native 文件/命令工具与 memory 工具分开定界。WP1-D 必须说明 memory-only 是否能成为独立完整切片；不能为解锁 memory 一并开放 terminal/filesystem。
- 桌面参考 app、Hermes安装配置、插件市场、自动skill生成、跨Bot协作、版本发布与部署均不在本轮。

## P1: Architecture Map

- Hermes参考：profile承载Bot；SOUL.md/USER.md/MEMORY.md/skills/history分离；Bot Chat保留用户关系；runtime可按capability fingerprint重建。
- BYOK：docs/spec.md为产品权威；client daemon拥有Agent home与运行lease、memory CAS、工具准入；Pi负责模型/provider/agent loop；云端不持有provider secrets。
- Host：身份/placement/profile及conversation的业务权威；记忆内容治理与审批在Host/本地Agent组合层，SDK只暴露通用能力和可验证回执。
- 初始基线证据（base e83e685）：prepared lane 未注入 reserved memory helper，非空 native 工具被拒绝；memory-guidance 只提示读取。WP1-I 已修改 prepared memory 边界，当前规范见 docs/spec.md 与 accepted memory contract；native 和自动 snapshot 边界保持原契约。
- 当前deferred ledger已登记P0b prepared native/agent-memory；本计划消费该缺口的memory部分，不宣称整条P0b完成。

## P2: Concrete Trace

Host构造prepared输入及所需工具 -> device preparation/accounting -> immutable artifact -> offer_prepared -> admission live tools/list与implementation identity -> compare/seal/pin -> claim -> prepared runtime工具执行 -> canonical terminal/message回执。
压力点：memory helper目前不属于prepared工具集合；只在fresh lane有memory API不代表prepared Bot能调用。WP1-D须定位精确拒绝点、工具schemas/实现身份/secret晚绑定及真实请求字节如何同一闭合。
Host侧另追踪一次用户input -> canonical conversation/epoch -> ContextPack -> preparation -> settlement，找记忆读取/写回唯一合法入口，不用假任务或云端第二份原始memory补齐流程。

### Current-source findings from WP0-C

- SDK：task-runner.ts:2254 明确以 preparation===undefined 允许reserved memory，prepared-tool-surface.ts:560与prepared-session.ts:305要求同一已计数manifest。现成reserved helper不进入billing artifact；简单挂taskMcpServers不可达。需要先建立countable schema/executor/identity，再安全绑定执行上下文。
- Host：Salesko候选已有ContextPack/同snapshot取数/preparation document/request/write-once lane与ready gate。入口为apps/api/src/private-agent-chat-context-pack.ts、private-agent-chat-preparation-document.ts、private-agent-chat-preparation-request.ts、private-agent-chat-preparation-lane.ts、private-agent-chat-preparation.ts。不得按main旧路径重做。
- Host候选Summary只有reader/coverage consumer，无生产SummaryJob writer；这条既有工作不归本计划顺带实现，也不能将未完成SummaryJob当已具备。
- SDK AgentMemoryProjection为本地authoring的单向redacted projection，明确排除remote authoring/import/history/RAG（packages/protocol/src/agent-memory-projection.ts:84）。Host审批不能借此直接写回本机。WP2-D必须明示审批到device CAS的尚缺契约。

## P3: Rationale and Falsifier

Thesis：可复用现有Agent home/CAS与prepared MCP准入来建立可治理的Bot记忆，而无需重建Agent存储或引入Hermes runtime。置信度中等，memory helper跨preparation与execution的绑定尚待WP1-D证明。
最便宜proof：从当前source及现有focused tests证明prepared确实排除memory，再给出一条工具descriptor ->计数->seal->实际handler的完整候选链和跨Agent/漂移负控。优先复用已有证据，不为green特征重复写镜像测试。
Falsifier：若reserved memory身份/安全filesystem/授权上下文无法在现有prepared机制中明确表达，则交具体最小反例与所需契约修订，不静默注入snapshot，不绕过计数，也不删除fail-closed检查。
10x压力（推断，未benchmark）：常驻memory/tool目录体积、同Agent并发CAS冲突、后台记忆提议积压。首个切片保持容量有界、显式冲突、无自动覆盖；不先建向量库或通用后台scheduler。
Claude planning session已完成，session 4b64b581-4869-4367-862f-170022f2cdb8。采用分阶段与并行ownership建议；拒绝将其未经核验的memory snapshot envelope、SDK proposal事件、统一tool grant新wire设为既定方案。其引用链次序由源码核查纠正，session输出不替代证据。

## Workflow Inventory

- 唯一总体进度：本文件 ## Task Breakdown。原checkout旧active plan与用户WIP保留。
- 隔离worktree：/Users/kito/Projects/byok-sdk-wt-hermes-bot-adoption；branch codex/hermes-bot-adoption；base e83e685fa8a7e27b714b0fb7b90668b19fc14a8e。
- 参考源：Hermes 6f7a7991bb069db07ae74a479823ce8310f8c7e0；Salesko main 83bcbfc5d8a005987d87b9bac75eb9ca0c284e38。Salesko prepared候选另以 salesko-new-wt-c07-host HEAD 5670f5d1 核查（已有todos WIP保留）；mutable worktree状态与行号须交付时复核。
- Delegation contracts：tasks/contracts/20260928-hermes-prepared-memory-design.contract.md 与 tasks/contracts/20260928-hermes-host-lifecycle-design.contract.md。
- 收取与核验：tasks/notes/20260928-0217-hermes-bot-adoption.notes.md；tasks/reviews/20260928-0217-hermes-bot-adoption.review.md。
- Deferred ledger：tasks/todos.md保持原状；P0b未关闭。当前执行不写到deferred ledger中冒充完成。
- Checks：隔离worktree .ai/harness/checks/latest.json；runs .ai/harness/runs/。旧checkout PASS不可借用。
- 同时最多两个worker；每个写worker独占下表路径。root独占plan/contract/notes/review，不能与worker同时编辑其交付文档。
- 第一轮只写研究/计划/契约。产品实施须在命名worktree签发准确source/test allowed_paths，不使用packages/**通配授权。

## Dispatch and Write Ownership

| Work package | Worker responsibility | Exclusive write scope | Dependencies | Delivery criterion |
|---|---|---|---|---|
| WP0-C SDK | explorer bot_sdk_readiness | none | existing source | P1/P2/P3、精确拒绝点、复用面、focused test入口 |
| WP0-C Host | explorer bot_host_readiness | none | existing Host source | input→ContextPack→prepared→settlement及memory authority |
| WP1-D | fast-worker `/root/prepared_memory_design`（已派） | docs/researches/2026-09-28-hermes-prepared-memory-design.md | SDK evidence | 一条候选链、来源表、明确未知、最小实施文件集、正负验收 |
| WP2-D | fast-worker `/root/host_lifecycle_design`（已派） | docs/researches/2026-09-28-hermes-host-lifecycle-design.md | Host evidence | local/Host authority、提议/审批/CAS/forget语义、身份与工具scope矩阵、准确后续ownership |
| WP0-G | root | 本plan、上述两份contracts、notes/review | 两份文档 | current-source citation核验、无伪造PASS、下一实施包可判定 |

## Acceptance Matrix

- 记忆：A不能读写B；stale revision拒绝；重复提议不可二次执行；拒绝的提议无memory副作用；forget的范围及历史/summary/cache残留须显式说明，不能把删文件等同全系统遗忘。
- prepared：实际model-visible工具必须与冻结surface/预算一致；tool schema/implementation/policy/profile变更必须拒绝或重新preparation；secret不进入artifact；工具副作用前验授权。
- 身份：同display name不共享AgentRef/home；会话压缩或runtime重建不创造新Bot；title和SOUL不得变授权principal。
- 权限：工具可发现不等于可调用；通用tool_call不越过当前execution grant；审批模块故障拒绝执行。
- 首轮为docs-only：contract preflight、源码引用存在性与含义、限定路径diff/whitespace、repo-harness strict工作流检查即可；不跑全量build/test、不把测试文件存在说成测试已通过。
- 产品实现按root required checks执行：bun run build、bun run typecheck、bun run test、bun run check:api-surface、bun run check:version-authority、repo-harness run check-task-workflow --strict；另加机制对应focused tests与真正Host/device边界证据。昂贵证据在freeze后只产一次。

## Stop Conditions

- 每问题fail→fix→verify最多三轮；范围外故障只报告，禁止借研究修CI/旧计划/插件配置。
- 出现第二authority、跨Agent泄漏、未计数的runtime注入、需要未批准的产品语义取舍时交最小反例并停止该dependent slice；独立设计包仍可继续。
- 当前已有实现或exact subject证据覆盖目标时复用，不复制实现或重复重跑。
- 未核验的Host候选/生产状态标UNKNOWN；不把main源码或doc PASS升格为已启用。

## Completion Boundary

首轮请求已完成 plan、派工与机制交付。当前 WP1-I 完成条件为 accepted contract 的 SDK source 闭环、focused 正负验证与 required checks；实际 disposition 见同 stem review。WP2-I 至 WP5 仍保留独立边界，不能将整个 program 标 Complete。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] WP0-A：完成Hermes memory/identity/tools研究并核对BYOK现有边界。
- [x] WP0-B：独立Claude planning session；parent筛选方案，拒绝未经证据的新authority。
- [x] WP0-C：收取SDK与Host explorer的当前链路证据，固化为首批brief输入。
- [x] WP1-D：prepared memory-only可达性与实现合同设计；交付 docs/researches/2026-09-28-hermes-prepared-memory-design.md。
- [x] WP2-D：Host记忆生命周期、身份与工具边界设计；交付 docs/researches/2026-09-28-hermes-host-lifecycle-design.md。
- [x] WP0-G：parent一次核验两份交付的证据、依赖、ownership与负控；更新本plan和notes，不重复外部review。
- [x] WP1-I-E：用户批准的 memory-only descriptor 表达能力验证已完成；通用 schema/artifact 可复用，但当前 selector/registry/probe/runtime 没有 SDK-owned capability 闭环。严格协议反例通过；装配探针缺依赖未运行，源码反例见 WP1-D 文末。
- [x] WP1-I-C：memory-only 契约修订完成，权威为 `docs/researches/2026-09-28-prepared-agent-memory-contract.md`；明确agentMemory选择/ceiling、SDK descriptor角色与真实helper identity、逐操作授权、双digest与claim后绑定。设计阶段的v7基线已由随后批准的WP1-I切换为v8源码；上线状态不由本项证明。
- [x] WP1-I：SDK prepared memory 闭环 + WP1-I-R operator retirement 命令（仅实现与测试，未对真实 store 执行）已验收。冻结 subject `09a81ce1…f616`（1366 文件），TMPDIR=/private/tmp/bk-wp1i-r2/ 下 required checks 各一次全 PASS；Bun MCP 超时根因为默认 $TMPDIR 泄漏膨胀（diagnosis-mcp/DIAGNOSIS.md）。两轮独立 gate 的阻断项均已关闭，已知偏差与后续见同 stem review。commit/push/发布、Host adoption 仍为独立边界。
- [ ] WP2-I（依赖WP1-I与Host契约）：Host单Bot显式记忆提议 -> 审批/拒绝 -> 当前revision CAS ->下一次合法执行读取 ->纠正/forget；拒绝跨Agent、过期提议、重复应用。存储authority由WP2-D定位，不预设新DB。
- [ ] WP3（依赖WP2-D）：在既有AgentRef/profileRevision与canonical conversation上增加身份/能力变更的可见反馈；运行中的sealed execution不变，新执行采用新revision。不是新建Bot registry。
- [ ] WP4（依赖WP1-I、WP3）：工具/skill渐进发现限于已准入集合；先测实际schema预算压力，有证据再实施。超出sealed集合必须重新prepare/admit。
- [ ] WP5（依赖对应实现）：实现级required checks、一次独立gate、不可变SDK候选与Host adoption验证。source、packed、registry、部署与live验证分别记录；发布/部署不由本计划自动授权。


## WP1-I implementation dispatch and evidence boundary

- Approval: user approved the bounded full SDK implementation following WP1-I-C. All edits remain in `byok-sdk-wt-hermes-bot-adoption`; base `e83e685fa8a7e27b714b0fb7b90668b19fc14a8e`.
- Sequential ownership: identity worker completed implementation-identity files, then admission/Pi-tool assembly plus their two tests; helper worker completed descriptor/helper files, then Pi adapter/host plus their tests. Root owns protocol, preparation, task lifecycle and integration. Each earlier scope was handed back before reuse.
- P1: local/remote strict requests and trusted grant -> generic preparation compiler/store; SDK helper identity and descriptor -> selected tools; prepared task lane -> Pi host and existing daemon memory CAS.
- P2: requested mode vs local ceiling -> reserve -> task-free descriptor -> count/freeze -> offer mode/live descriptor compare -> manifest/pin -> claim -> private execution token -> physical spawn reverify -> execution descriptor parity -> model/tool call -> helper and daemon operation checks -> existing quiesce/revoke.
- P3: preserve the existing compiler/artifact, AgentRef/home/lease/CAS and provider authority. Use a finite SDK helper role and one schema/operation table. Only the preparation lane performs a paired v8 cut; old modes/readers are refused. At 10x load descriptor process count and current memory I/O serialization remain the first pressure points; caching or a new store is outside this slice.
- Focused evidence before freeze: preparation suites 143 pass; new ACL/authority and descriptor suites 87 pass; admission/Pi tools 57 pass; protocol 402 pass; cloud relay/enqueue 23 pass; identity role tests 5 pass. Runtime mocks distinguish private serialization/handshake behavior from physical install attestation.
- Build/test logs: ignored `_ops/hermes-memory-implementation/`. Final status and residual boundaries are recorded in the review and notes; these focused counts are not release/adoption proof.


## Current verification blocker

`packages/client/src/__tests__/pi-mcp-launch-cwd.test.ts:125` 的 Bun preload negative/positive control 在三轮候选验证均10秒超时。base client source 的一次隔离运行3/3通过，但共享当前依赖/dist，且不是同负载完整baseline，因此尚不能区分候选回归与Bun/stdout调度问题。不得提高timeout、删负控、标flaky后放行，或宣称已证实旧问题。

下一有界切片：只定位该测试的 initialize/tools/list 管道在哪个进程阶段停止，以相同依赖/解释器/执行形状做base与candidate对照；先取证再修复。入口是该测试、`src/mcp/client.ts` 和 `_ops/hermes-memory-implementation/mcp-timeout-records.json`。本轮停止继续重试；WP1-I不勾选，Host adoption与发布继续留在后续边界。
