# Plan: Pi context usage public observation gap

> **Status**: Executing
> **Created**: 20261001-0132
> **Slug**: context-usage-gap
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: 用户派发独立观测设计与文档commit
> **Verification Boundary**: static source trace + workflow strict + Claude document review
> **Rollback Surface**: 仅新研究和任务文档
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261001-0132-context-usage-gap.contract.md`
> **Task Review**: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
> **Implementation Notes**: `tasks/notes/20261001-0132-context-usage-gap.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261001-0132-context-usage-gap.md`
- Sprint contract: `tasks/contracts/20261001-0132-context-usage-gap.contract.md`
- Sprint review: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
- Implementation notes: `tasks/notes/20261001-0132-context-usage-gap.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261001-0132-context-usage-gap.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261001-0132-context-usage-gap.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261001-0132-context-usage-gap.md`.

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
- Contract file: `tasks/contracts/20261001-0132-context-usage-gap.contract.md`
- Review file: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
- Implementation notes file: `tasks/notes/20261001-0132-context-usage-gap.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261001-0132-context-usage-gap.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261001-0132-context-usage-gap.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: 仅新研究和任务文档
- **Verification boundary**: static source trace + workflow strict + Claude document review
- **Review/acceptance boundary**: `tasks/reviews/20261001-0132-context-usage-gap.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: 用户派发独立观测设计与文档commit

## Evidence Contract

- **State/progress path**: `plans/plan-20261001-0132-context-usage-gap.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261001-0132-context-usage-gap.contract.md`, `tasks/reviews/20261001-0132-context-usage-gap.review.md`, and `tasks/notes/20261001-0132-context-usage-gap.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261001-0132-context-usage-gap.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: 仅新研究和任务文档

## Captured Planning Output

## Brief
只读核对 main12ca4402 的 Pi usage 到公开 Host 读回。只写研究及任务文档，commit授权，不push/PR。主 checkout仅已授权ff-only pull，旧worktree不动。
## Scope
Safe path /Users/chris/Projects/byok-sdk-context-usage，branch codex/context-usage-gap。无SDK/API/wire/Pi/provider/plugin/index修改。architecture/daemon gate停报。
## P1/P2/P3
Host自有UI分类；Pi native usage→AgentEvent→lastUsage→terminal→tasks.deviceTerminal。仅来源明确的last-observed/initial/peak展示；当前余量不可冒充观测，missing=unknown，estimate不入admission。
## Task Breakdown
- [x] 独立worktree与真实source trace。
- [x] 写字段来源三类映射与Host消费例。
- [x] source locators/diff/workflow strict，声明未跑代码checks。
- [x] 五份文档范围核对，按授权commit并交Claude文档验收；不push/PR。
- [ ] Claude独立文档验收（外部）。

### Amendment 2026-10-01：Pi context 占用切片（仅计划，未实现）

来源与证据：[docs/researches/2026-10-01_oar-extraction-assessment.md](../docs/researches/2026-10-01_oar-extraction-assessment.md)「重探结果」一节（本机实测，原始帧不入库）。本 amendment 只改计划，不含产品代码；以下各项在实现前须先过 contract 与 architecture/daemon gate，wire 变更还须过 `docs/spec.md` 的 additive 规则。

前置：official Pi pin 已由 0.99.1 升到 0.99.2（分支 `pi-0.99.2-context-usage`，未提交）。0.99.1 与 0.99.2 在 `dist/modes/rpc`、`rpc-types.d.ts`、`agent-session.js` 的 RPC/stats 部分 grep 级无差异，但 `get_session_stats` 形状只在 0.99.2 上实测过。

Owner 决定（已定，不再重议）：

- Claude 的 context 窗口取 `result.modelUsage[model].contextWindow`。`modelUsage` 的 key 是 init 模型串，不是 assistant 帧里的 API model id，须遍历取值，不能按 assistant 帧的 model 精确索引。`get_context_usage.maxTokens`（实测 500000，对 contextWindow 1000000）不作窗口。
- Codex 的占用取 `thread/tokenUsage/updated` 的 `tokenUsage.last` 对 `modelContextWindow`；`total` 是累计花费，不是占用。仅 app-server 路径有此数据，`codex exec --json` 只有 `turn.completed.usage`，无窗口、无 total，不能提供占用。`modelContextWindow` 在 schema 里是可选字段，缺失按 unknown。

- [ ] **P-1 Pi 调用 `get_session_stats`。** RPC handler 在 `dist/modes/rpc/rpc-mode.js:466`，计算在 `dist/core/agent-session.js:3371`。把返回的 `contextUsage {tokens, contextWindow, percent}` 映射进 usage 观测。实测：空会话 `{tokens:0, contextWindow:1000000, percent:0}`（默认 `claude-opus-4-8`）。
- [ ] **P-2 来源标记。** Pi 的 `contextUsage.tokens` 是 Pi 本地估算，不是 provider 上报的 usage（实测 prompt 返回 401 时 `tokens` 仍变为 3640）。映射时必须带来源标记，estimate 不得进入 admission 判断，也不得与 provider usage 混为同一字段。真实 provider usage 下 `tokens` 的取值路径未验证，实现时补一次 live 探测。
- [ ] **P-3 `tokens: null`。** 压缩后若没有带 usage 的 assistant 消息，`get_session_stats` 返回 `{tokens:null, percent:null}`（仅源码所见，未触发）。映射为 unknown，不回填 0，不沿用上一次的值。prepared lane 下 compaction 关闭（`packages/client/src/adapters/pi/prepared-session.ts:324-327`），该分支在 prepared lane 不应出现；非 prepared 的 native lane 仍须处理，并加单测与一次触发压缩的实测。
- [ ] **P-4 窗口来源核对。** prepared lane 下窗口是否取自 Host 配置的 `pi_model`，实现前先验证（未验证）；`contextWindow` 与 Host 配置不一致时以哪个为准，需要 owner 决定。
- [ ] **W-1 wire `usage` additive 修订。** 现有 `usage` 需新增可选字段：`contextWindow`，以及来源标记（provider-reported / local-estimate）。三家 adapter 共用同一组字段：Claude 填 `modelUsage[model].contextWindow`，Codex 填 `modelContextWindow`，Pi 填 `contextUsage.contextWindow`。旧 client 与旧 server 互相忽略新增字段，缺失一律读作 unknown。具体字段名与枚举值在 contract 中定，本 amendment 不预设。
- [ ] **V-1 验收。** Pi 切片：`get_session_stats` 形状的 fixture 单测（含 `tokens:null`）、一次 0.99.2 真实 binary 的 live 探测、Host 读回确认来源标记不丢；跨 adapter：Claude `contextWindow`、Codex app-server `last` 与 `modelContextWindow`、exec 路径明确回 unknown。

未覆盖（沿用研究文档）：Pi 真实 provider usage 路径；Codex exec usage 是否逐请求；`modelContextWindow` 缺失的实际频率。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->
