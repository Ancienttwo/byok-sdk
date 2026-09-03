# Plan: Canonical Agent home single active Attempt gate (WP0)

> **Status**: Archived
> **Created**: 20260903-0436
> **Slug**: agent-home-single-writer
> **Artifact Level**: work-package
> **Promotion Reason**: Since 0.12.0 different sessions of one Agent may execute concurrently in the same canonical Agent home (`packages/client/src/agent-home.ts:600-632`), every lease uses that home as cwd, and no concurrency cap exists anywhere in the daemon. Two runtimes writing `MEMORY.md`, `notes/`, `.git/index` or build output at once is the only live runtime-correctness risk found by `docs/researches/2026-09-03_architecture-review.md` (V2, §11 下一刀 A). `README.md:87` and `docs/host-local-storage-layout.md:64` still promise one mutable writer per home, and the only downstream (Salesko, pinned 0.11.0) enqueues chat and research offers for the same `agentId` concurrently while relying on the SDK to decline a busy home (review §13).
> **Verification Boundary**: New client tests (same-home second session declined on every lane; different homes parallel; release after terminal / cancel / disposal failure / crash residue; status readback counts only), `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface -- --update` (public `DaemonConfig` gains one field — golden regenerated deliberately), `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`.
> **Rollback Surface**: One client-package change plus spec/CHANGELOG wording; revert the single commit. No wire, cloud, store, or migration change.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_architecture-review.md` §8 WP0, §11, §12, §13
> **Task Contract**: `tasks/contracts/20260903-0436-agent-home-single-writer.contract.md`
> **Task Review**: `tasks/reviews/20260903-0436-agent-home-single-writer.review.md`
> **Implementation Notes**: `tasks/notes/20260903-0436-agent-home-single-writer.notes.md`

## Agentic Routing
- Selected route: code-change (client daemon admission), delegated to `deep-worker`, accepted by `gatekeeper`
- Routing reason: Touches the admission ordering contract in `TaskRunner.handleOffer` and the lease manager; must land right in one pass.
- Due diligence:
  - P1 map: `AgentHomeExecutionLeaseManager` (`packages/client/src/agent-home.ts:600-632`) hands out one lease per `(taskId | sessionRef)` and returns `cwd: resolution.canonicalHome` for every lease; the process-owned home activity marker excludes a second daemon process but not a second session in the same process. `TaskRunner.handleOffer` (`packages/client/src/daemon/task-runner.ts:1482`) runs receive → dedup → pre-cancel → `strictAgentOnly` gate (`:1560-1573`) → admission (`prepare()`) → seal manifest → `task.claim` → `start()`. `task.decline` with a retryable reason already exists (the strict gate uses it). `DaemonConfig` is validated inline in `create-daemon.ts` (~37 fields); `Daemon.status()` and the authenticated control status project counts. Spec `docs/spec.md:551-556` states the 0.12.0 concurrency rule; `CHANGELOG.md` 0.12.0 lists it as "Breaking (Agent home execution)"; `README.md:87` and `docs/host-local-storage-layout.md:64` state one mutable writer.
  - P2 trace: offer arrives → ordering gates → **new gate**: resolve canonical home for the offer's `agentRef` (already resolved by admission for Agent offers) → count active Attempts bound to that home (lease manager registry) → if count ≥ `maxConcurrentMutableSessionsPerAgentHome` (default 1) emit retryable `task.decline` (`reason: 'agent home busy: <n> active attempt(s)'`, no paths, no prompt) before `prepare()`, claim, workspace or process side effects → otherwise proceed; the count decrements only when the attempt reaches terminal AND `Session.close()` succeeded (quiescent disposal), or on cancel/failure after disposal; a failed disposal keeps the slot held (fail closed, consistent with `runtime-disposal-failed`); crash residue is reclaimed by the same stable daemon owner identity on restart (existing marker semantics).
  - P3 decision rationale: The invariant to restore is the one the docs and the downstream already assume — one mutable writer per canonical home — while WP3A's AgentHome/Workspace split is not yet built. Counting per **home** (correctness) rather than per **lane** (usage) is what actually prevents `claude session + pi session` from co-writing; a lane cap would not. The knob defaults to 1 and can only be raised explicitly, so an operator who genuinely wants 0.12.0 behaviour opts in knowingly; no silent fallback. Salesko's contract is the 0.11.0 busy-decline, so default 1 is not a downstream break. The knob name says "mutable sessions per Agent home" so that WP3A can move the same count to Workspace without renaming the concept.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260903-0436-agent-home-single-writer.md`
- Sprint contract: `tasks/contracts/20260903-0436-agent-home-single-writer.contract.md`
- Sprint review: `tasks/reviews/20260903-0436-agent-home-single-writer.review.md`
- Implementation notes: `tasks/notes/20260903-0436-agent-home-single-writer.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-0436-agent-home-single-writer.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-0436-agent-home-single-writer.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-0436-agent-home-single-writer.md`.

## Approach
### Strategy
One daemon-local admission gate keyed by canonical Agent home, one `DaemonConfig` field with a fail-closed default, count readback in status, spec/CHANGELOG/README wording made consistent, tests for every release path.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Per-home active-Attempt cap, default 1, explicit raise (chosen) | Restores the documented invariant; matches downstream contract; no wire change; WP3A moves the same count to Workspace | Reverses 0.12.0's concurrent-session feature by default | Use |
| Per-lane cap (`maxConcurrentSubscriptionTasks`) | Governs vendor usage | Does not stop cross-lane co-writing of one home; owner ruled ToS is not a design constraint | Reject |
| Serialize by home in the lease manager only (no config) | Smallest | No way to keep 0.12.0 behaviour for a host that wants it; hidden semantics | Reject |
| Wait for WP3A Workspace split | Final shape | Leaves the live race open for the whole WP2/WP3 window | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/agent-home.ts` | Edit | Lease manager tracks active Attempts per canonical home; exposes `activeAttemptCount(home)`; release only after quiescent disposal |
| `packages/client/src/daemon/task-runner.ts` | Edit | New gate after `:1560-1573` ordering gates and before admission/prepare/claim: decline retryable when count ≥ limit; release hook on terminal-after-close |
| `packages/client/src/daemon/create-daemon.ts` | Edit | `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome?: number` (positive safe integer, default 1); validate up front like `maxTaskOutputBytes`; project count into `Daemon.status()` / control status |
| `packages/client/src/types.ts` | Edit | Config type + status shape (public surface → golden regenerated deliberately) |
| `packages/client/src/__tests__/agent-home-single-writer.test.ts` | Create | Same home, second session on a different lane → retryable decline before `prepare()`; different homes parallel; release after terminal+close; disposal failure keeps slot; cancel releases; crash residue reclaimed; limit 2 admits two |
| `docs/spec.md` | Edit | `:551-556` rewritten: execution serialized per canonical home by default (`maxConcurrentMutableSessionsPerAgentHome`, default 1); raising it is an explicit host choice with the co-writing caveat |
| `CHANGELOG.md` | Edit | Unreleased entry: "Breaking (Agent home execution): default returns to one active Attempt per canonical Agent home; 0.12.0 concurrent sessions require explicit `maxConcurrentMutableSessionsPerAgentHome > 1`" |
| `api-surface/client.d.ts` | Regenerate | Deliberate golden update for the new config/status fields |
| `README.md`, `docs/host-local-storage-layout.md` | Verify | "one mutable writer" statements become true again; no edit expected |

### Code Snippets
```ts
// task-runner.ts, after the strictAgentOnly gate, before admission:
const home = resolution.canonicalHome;
const active = this.deps.agentHomeLeases.activeAttemptCount(home);
if (active >= this.deps.maxConcurrentMutableSessionsPerAgentHome) {
  this.decline(taskId, `agent home busy: ${active} active attempt(s)`, /* retryable */ true);
  return;
}
```

### Data Flow
offer → ordering gates → home busy gate → prepare → seal → claim → start → … → terminal → `Session.close()` ok → slot released.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A host relied on 0.12.0 concurrency | Low (Salesko does not; aiphabee unverified) | Second session declined instead of running | Explicit knob; CHANGELOG breaking note; owner confirms before merge |
| Slot leak on disposal failure | Medium | Home stays busy until restart | That is the fail-closed intent; status readback shows the count; restart reclaims via owner identity |
| Gate placed before ordering gates | Low | Breaks dedup/pre-cancel precedence | Test asserts a duplicate or pre-cancelled offer never consumes a slot |

## Task Contracts
- Contract file: `tasks/contracts/20260903-0436-agent-home-single-writer.contract.md`
- Review file: `tasks/reviews/20260903-0436-agent-home-single-writer.review.md`
- Implementation notes file: `tasks/notes/20260903-0436-agent-home-single-writer.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-0436-agent-home-single-writer.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one branch, one PR, one commit.
- **Rollback surface**: see header.
- **Verification boundary**: see header.
- **Review/acceptance boundary**: `gatekeeper` read-only review; owner confirms the default (1) and the CHANGELOG breaking note before push.
- **High-risk surface**: admission ordering in `TaskRunner.handleOffer` (correctness contract at `:1560-1573`).
- **Why not checklist row**: changes a released concurrency semantic; needs a reviewed unit and an owner decision.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260903-0436-agent-home-single-writer.notes.md`
- **Verification evidence**: test names and command tails in the notes file; `.ai/harness/checks/latest.json`
- **Evaluator rubric**: second session for the same home is declined on every lane before any side effect; two homes run in parallel; slot released only after quiescent close; count visible in status; spec/CHANGELOG/README agree
- **Stop condition**: the gate cannot be placed before `prepare()` without reordering the existing precedence at `:1560-1573`
- **Rollback surface**: see header

## Annotations
- Resolved: default value and opt-in semantics recorded below.
- Decisions taken under the owner's overnight delegation (2026-09-03, "授权并行派工、验收、提交 PR 与合并"): (1) default is `1`, backed by the Salesko audit (review §13: chat and research enqueue concurrently for one `agentId` and rely on the SDK's busy decline); (2) any host that needs concurrent sessions in one home (aiphabee is unverified) opts in explicitly via `maxConcurrentMutableSessionsPerAgentHome > 1`; (3) CHANGELOG carries an Unreleased "Breaking (Agent home execution)" note for the next train.

## Task Breakdown
- [x] T1 Lease manager: per-home active Attempt count + release on quiescent close
- [x] T2 `handleOffer` gate after ordering gates, before admission; retryable decline
- [x] T3 `DaemonConfig` field + validation + status readback
- [x] T4 Tests (same home / lanes / homes / release paths / crash residue / limit 2)
- [x] T5 spec `:551-556`, CHANGELOG breaking note, README + storage-layout re-check
- [x] T6 Regenerate `api-surface/client.d.ts` deliberately; run the verification boundary; notes
