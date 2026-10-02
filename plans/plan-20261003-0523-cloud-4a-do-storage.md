# Plan: Cloud slice 4a DO SQLite storage and minimal AgentDO

> **Status**: Verified
> **Created**: 20261003-0523
> **Slug**: cloud-4a-do-storage
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: /tmp/byok-cloud-4a.md
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: native pi Storage local/workerd conformance and full required workspace checks
> **Rollback Surface**: local codex/cloud-4a-do-storage commits only
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md`
> **Task Review**: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md`
> **Implementation Notes**: `tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: /tmp/byok-cloud-4a.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261003-0523-cloud-4a-do-storage.md`
- Sprint contract: `tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md`
- Sprint review: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md`
- Implementation notes: `tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261003-0523-cloud-4a-do-storage.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261003-0523-cloud-4a-do-storage.md`.

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
- Contract file: `tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md`
- Review file: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md`
- Implementation notes file: `tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261003-0523-cloud-4a-do-storage.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: local codex/cloud-4a-do-storage commits only
- **Verification boundary**: native pi Storage local/workerd conformance and full required workspace checks
- **Review/acceptance boundary**: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20261003-0523-cloud-4a-do-storage.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md`, `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md`, and `tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: local codex/cloud-4a-do-storage commits only

## Captured Planning Output

## Goal
Execute the owner-approved /tmp/byok-cloud-4a.md in codex/cloud-4a-do-storage; local commits only. Slice 4a only.

## P1/P2/P3
P1: Local client replica admission/lock/reset/inspection owns the security boundary. Pi owns native Storage, schema and Harness. A private packages/cloud-do deployment package owns Cloudflare SQL adaptation, object identity and binding/RPC-only host. Retain existing packages umbrella capability; no unrelated capability repartitioning or new published exports.
P2: Local engine locks and resets its admitted file, calls the injected/default Storage factory, opens Harness and validates inspection. Cloud named namespace lookup hashes the JSON tuple tenant/workspace/agent with WebCrypto, DO opens native SqliteStorage through serialized async SQL adapter, Harness creates a fresh ownerless conversation each execution, passive entries round-trip to pi-prefixed SQL. Transactions queue unrelated operations and invalidate escaped handles.
P3: Preserve native pi contracts and local authority steps. Private deployment package follows ADR-035 runtime boundaries without changing the nine published artifacts. Async DO storage.transaction is required by installed pi 1.0's async executor; transactionSync cannot host a Promise. At 10x scale retention/DO row limits are first constraints; no speculative cleanup or scheduler in 4a.

## Scope
Allowed implementation: packages/client/src/adapters/pi-durable/engine.ts and storage.ts; additive client seam tests; packages/cloud-do/**; bun.lock; this plan/contracts/reviews/notes; scoped human architecture documentation and generated projection via authorized CLI only.
Out: 4b credentials, 4c tools/jobs, 4d wake/events, 4e consumption, Postgres, Node client cloud runtime imports, main checkout, pushing, assertion changes/skips/timeout increases.

## Task Breakdown
- [x] Extract native Storage factory seam while preserving local authority behavior.
- [x] Implement DO SQLite adapter, minimal fresh-conversation AgentDO, identity helper and SQLite migration config in private workspace.
- [x] Run one shared native conformance/BYOK contract suite for local and workerd backends; verify restart, isolation, prefixes, SQL boundaries and transaction queue.
- [x] Run all dispatch checks and strict workflow gate; inspect diff, make small local conventional commits, write required /tmp report.

## Verification
bun ci; bun run build; bun run typecheck; bun run check:api-surface; bun run check:version-authority; bun run test:scripts; BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun bun run test; repo-harness run check-task-workflow --strict. Capture actual exit codes and test totals. New cloud test script participates in root workspace test. No skip/only/assertion weakening/timeout increases. If projection needs refresh use codegraph init plus architecture-projection plan/apply/check only.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Extract native Storage factory seam while preserving local authority behavior.
- [x] Implement DO SQLite adapter, minimal fresh-conversation AgentDO, identity helper and SQLite migration config in private workspace.
- [x] Run one shared native conformance/BYOK contract suite for local and workerd backends; verify restart, isolation, prefixes, SQL boundaries and transaction queue.
- [x] Run all dispatch checks and strict workflow gate; inspect diff, make small local conventional commits, write required /tmp report.

## Local delivery evidence

Slice 4a is implemented and locally verified. Required command logs are under /tmp/byok-cloud-4a-*.log; the owner report is /tmp/byok-cloud-4a-report.md. Client seam commit ffa70944 and private cloud host commit ff12874e are local only. Full root tests: 6,294 passed, 160 existing conditional skips; added storage/workerd cases: 55 passed. Native release acceptance, push, deployment and downstream consumption were not requested and are not claimed.
