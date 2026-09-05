# Plan: Audit log records pre-spill byte sizes for spilled tool events

> **Status**: Executing
> **Created**: 20260906-0433
> **Slug**: audit-log-spill-size
> **Artifact Level**: work-package
> **Promotion Reason**: After PR #149, `redactAgentEvent` records `inputSize`/`outputSize` as the byte size of the shipped value, which for a spilled event is the preview object, not the tool content. The audit record under-reports and the read-side placeholder repeats the wrong number.
> **Verification Boundary**: client typecheck/build/test, `check:api-surface`, strict workflow check.
> **Rollback Surface**: two write-side branches, two read-side branches, tests, CHANGELOG, todos row.
> **Spec**: `docs/spec.md`
> **Research**: `docs/protocol.md` §11.6
> **Task Contract**: `tasks/contracts/20260906-0433-audit-log-spill-size.contract.md`
> **Task Review**: `tasks/reviews/20260906-0433-audit-log-spill-size.review.md`
> **Implementation Notes**: `tasks/notes/20260906-0433-audit-log-spill-size.notes.md`

## Agentic Routing
- Selected route: main-loop planning; `fast-worker` execution in a contract worktree; orchestrator verifies directly (single-file mechanical change).
- Routing reason: one module, two branches each side, existing test file.
- Due diligence:
  - P1 map: `packages/client/src/bin/audit-log.ts:203-220` (`redactAgentEvent`, write side: every content field becomes a `*Size`), `:367-385` (`reconstructAgentEvent`, read side: `[redacted: N bytes]` placeholder via `placeholderFor`), tests in `packages/client/src/__tests__/bin-audit-log.test.ts`.
  - P2 trace: spilled `tool_result` → `redactAgentEvent` → `outputSize = valueByteSize(output)` = bytes of `{ preview: {...} }` → JSONL line → `reconstructAgentEvent` → `[redacted: <preview bytes> bytes]`.
  - P3 decision rationale: the audit record's invariant is "sizes, identifiers, counts; never content". `spill.totalBytes` is a count of the original content and belongs in the record; `blob` (a locator) and `unstoredReason` (free text) do not. So: when `spill` is present, `inputSize`/`outputSize` = `spill.totalBytes`, plus a boolean `inputSpilled`/`outputSpilled`; the read side renders `[redacted: N bytes, spilled]`. No locator, no reason text, no reconstruction of a `spill` object.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260906-0433-audit-log-spill-size.md`
- Sprint contract: `tasks/contracts/20260906-0433-audit-log-spill-size.contract.md`
- Sprint review: `tasks/reviews/20260906-0433-audit-log-spill-size.review.md`
- Implementation notes: `tasks/notes/20260906-0433-audit-log-spill-size.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260906-0433-audit-log-spill-size.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260906-0433-audit-log-spill-size.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260906-0433-audit-log-spill-size.md`.

## Approach
### Strategy
1. Write side: for `tool_use`/`tool_result`, if `event.spill` is present, size = `event.spill.totalBytes` and `inputSpilled: true` / `outputSpilled: true`; otherwise unchanged.
2. Read side: `placeholderFor(size, spilled)` renders `[redacted: N bytes, spilled]` when the flag is truthy.
3. Tests: spilled `tool_result` writes `outputSize === spill.totalBytes` and `outputSpilled === true`, and the raw line contains neither `blobId` nor the `unstoredReason` text; read-back placeholder carries `spilled`; unspilled events unchanged.
4. CHANGELOG entry; remove the delivered todos row.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `totalBytes` + boolean (chosen) | Honest size, no content | Two new record keys | Use |
| Record the `spill` object | Full fidelity | Leaks locator / reason text into the audit log | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/bin/audit-log.ts` | Edit | write and read sides |
| `packages/client/src/__tests__/bin-audit-log.test.ts` | Edit | cases |
| `CHANGELOG.md`, `tasks/todos.md` | Edit | entry; row removed |

### Code Snippets
```ts
case 'tool_result':
  return event.spill
    ? { type: 'tool_result', tool: event.tool, outputSize: event.spill.totalBytes, outputSpilled: true }
    : { type: 'tool_result', tool: event.tool, outputSize: valueByteSize(event.output) };
```

### Data Flow
Unchanged JSONL format with two optional boolean keys.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Older readers see unknown keys | Certain | None; reader ignores unknown keys | Reader already tolerant |

## Task Contracts
- Contract file: `tasks/contracts/20260906-0433-audit-log-spill-size.contract.md`
- Review file: `tasks/reviews/20260906-0433-audit-log-spill-size.review.md`
- Implementation notes file: `tasks/notes/20260906-0433-audit-log-spill-size.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260906-0433-audit-log-spill-size.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one small PR.
- **Rollback surface**: revert the PR.
- **Verification boundary**: client typecheck/build/test, api-surface, strict workflow.
- **Review/acceptance boundary**: orchestrator verification; no gatekeeper round.
- **High-risk surface**: audit record must not gain content; guarded by test.
- **Why not checklist row**: touches the audit record shape.

## Evidence Contract

- **State/progress path**: this plan, contract, notes.
- **Verification evidence**: command outputs in notes.
- **Evaluator rubric**: spilled events record `totalBytes` and the flag; no locator or reason text on disk; unspilled unchanged.
- **Stop condition**: none foreseeable.
- **Rollback surface**: revert the PR.

## Annotations

- [RESOLVED]: `totalBytes` is a count and the flags are booleans; `blob` and `unstoredReason` are never written. A test asserts the raw JSONL line contains neither `blobId` nor the reason text.

## Task Breakdown
- [x] Write and read side changes; tests.
- [x] CHANGELOG; remove the todos row; notes.
- [ ] Verify; PR.
