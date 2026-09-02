# Plan: Codex reserved Agent message permission

> **Status**: Fulfilled
> **Created**: 20260829-1240
> **Slug**: codex-reserved-message-permission
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User-approved generic Codex reserved-message permission regression
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260829-1240-codex-reserved-message-permission.md`; after execution revert branch `codex/codex-reserved-message-permission` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md`
> **Task Review**: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md`
> **Implementation Notes**: `tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md`

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

- Active plan: `plans/plan-20260829-1240-codex-reserved-message-permission.md`
- Sprint contract: `tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md`
- Sprint review: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md`
- Implementation notes: `tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260829-1240-codex-reserved-message-permission.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260829-1240-codex-reserved-message-permission.md`.

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
- Contract file: `tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md`
- Review file: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md`
- Implementation notes file: `tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260829-1240-codex-reserved-message-permission.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260829-1240-codex-reserved-message-permission.md`; after execution revert branch `codex/codex-reserved-message-permission` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User-approved generic Codex reserved-message permission regression

## Evidence Contract

- **State/progress path**: `plans/plan-20260829-1240-codex-reserved-message-permission.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md`, `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md`, and `tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260829-1240-codex-reserved-message-permission.md`; after execution revert branch `codex/codex-reserved-message-permission` or the explicitly reviewed diff.

## Captured Planning Output

## Why
A real packed-host Codex can invoke the SDK-injected `send_agent_message` MCP tool, but Codex rejects it because the adapter globally pins `approval_policy=never`. The SDK must permit only its exact reserved terminal message tool without broadening arbitrary MCP/tool approval.

## P1 Architecture
The client adapter owns Codex CLI/config composition. TaskRunner owns authenticated task-scoped message capability, durable outbox, and completion gate. Salesko remains product-schema and cloud-route authority. No protocol, cloud route, stdout parser, or global approval weakening is in scope.

## P2 Trace
A required-message Agent offer injects the SDK-owned MCP server, Codex discovers `mcp__byokagentmessage__send_agent_message`, then native permission composition rejects the call before the MCP helper receives it. No disposition exists and required completion remains blocked.

## P3 Decision
Add the narrowest Codex-native permission composition that grants only the SDK-reserved server/tool for offers carrying the bounded task-scoped message capability, while retaining global `approval_policy=never`. Freeze a pre-fix/native-faithful falsifier, fail closed before runtime if the exact permission cannot be expressed, and preserve all other MCP/tool approval behavior.

## Task Breakdown
- [x] Freeze a failing Codex permission-composition regression for the exact reserved message MCP tool.
- [x] Implement task-scoped adapter composition with no arbitrary MCP trust or global policy change.
- [x] Verify focused Pi/Codex/Claude/message tests and required repository gates.
- [x] Produce one unpublished aligned packed RC, exact manifest/integrities, and Salesko consume command.

## Evidence Contract
State/progress is the active plan checklist. Evidence includes the pre-fix regression, adapter argv/config assertions, build/typecheck/full tests, strict workflow, pack-and-smoke, and compiled packed-host helper smoke. Stop when the frozen packed RC is ready for Salesko acceptance. Rollback is the isolated branch commits and ignored RC artifact directory; no registry, tag, merge, push, deploy, or downstream production mutation is authorized.

## Promotion Gate
The merge/PR unit is the client Codex permission slice plus aligned RC manifests. Rollback is branch deletion and artifact disposal. Independent verification is the real Salesko packed-host Codex canary after handoff. The high-risk surface is native tool permission; the contract therefore forbids global approval relaxation and arbitrary MCP trust. This cannot remain a checklist row because it changes a public runtime-security boundary across TaskRunner and the Codex adapter.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze a failing Codex permission-composition regression for the exact reserved message MCP tool.
- [x] Implement task-scoped adapter composition with no arbitrary MCP trust or global policy change.
- [x] Verify focused Pi/Codex/Claude/message tests and required repository gates.
- [x] Produce one unpublished aligned packed RC, exact manifest/integrities, and Salesko consume command.
