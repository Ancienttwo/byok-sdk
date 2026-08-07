# Plan: Sprint S0: Runtime Capability Honesty and Task-Level Steer Hardening

> **Status**: Approved
> **Created**: 20260807-1508
> **Slug**: s0-runtime-hardening
> **Artifact Level**: work-package
> **Promotion Reason**: First delivery sprint (S0) of the RAFT-aligned platform program: eight stories across `packages/server` and `packages/client` with a dual-side behavior change (capability generation + task-level steer gate) and a hard wire invariant (protocol golden zero drift). Too large and too cross-cutting for a checklist row.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `git diff --exit-code packages/protocol/src/__tests__/golden/`, `repo-harness run check-task-workflow --strict`, plus the S0.3 behavior acceptance criteria in `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`.
> **Rollback Surface**: Capability generation and the steer gate land as separate commits and are individually revertible. Wire shape is untouched (value-level honesty only), so rollback is a code revert with no migration. The task-record capability snapshot is an additive field consumed only by the new gate; reverting the gate makes it inert. Any fallback to "still send steer and let the adapter throw" counts as rollback failure per sprint S0.4.
> **Spec**: `docs/spec.md`
> **Research**: `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` (Sprint S0), `docs/architecture/sdk-architecture.md` §3.3 / §4.4 / §11.1 (GAP-001/002/003)
> **Task Contract**: `tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md`
> **Task Review**: `tasks/reviews/20260807-1508-s0-runtime-hardening.review.md`
> **Implementation Notes**: `tasks/notes/20260807-1508-s0-runtime-hardening.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: Sprint-level slice with a server/client dual-side contract change, a frozen-wire invariant to protect, and per-story delegation to execution subagents; orchestration and acceptance stay in the parent loop.
- Due diligence:
  - P1 map: `docs/architecture/sdk-architecture.md` §3 (`@byok/server`: ConnectionHub is task authority), §4 (`@byok/client`: TaskRunner/adapters/connection-manager), §2 (protocol v1 frozen, 17 messages). Entry surfaces: `createByokServer().dispatch/steer`, client `task-runner.ts` envelope handlers, three adapters' capability declarations.
  - P2 trace: steer today — server `hub.ts:1493-1503` `steerTask()` checks only `state === 'Running'` + device online, queues `task.steer`; client cursor advances only on handler success, so an adapter throw (Claude/Codex do not support mid-turn steer) freezes the cursor and triggers replay (§3.3, §8.3). The fix point: `claimedRuntime` is already recorded at claim (`hub.ts:145`, `hub.ts:766`); the gate is missing, not the data.
  - P3 decision rationale: capability truth must live in one place (`RuntimeAdapter.capabilities`) and flow outward; a second hardcoded table is how GAP-001 (`approvalInteractive=false` while Claude confirm is real and wired) happened. Task-level gating reads the task record, not connection-level flags, because "some adapter on this device can steer" cannot authorize steering *this* task's runtime (three-layer capability model, §4.4). Smallest coherent change: no protocol schema change, no new message types, value-level honesty + a server-side gate + client-side non-freezing rejection.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-1508-s0-runtime-hardening.md`
- Sprint contract: `tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md`
- Sprint review: `tasks/reviews/20260807-1508-s0-runtime-hardening.review.md`
- Implementation notes: `tasks/notes/20260807-1508-s0-runtime-hardening.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan `plans/plan-20260805-1659-byok-keys-package.md` stays Executing (its remaining K4 work is a cross-repo track in `aip-main-open`, currently waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure. It must not touch any K-line allowed path other than the shared ledgers (`plans/`, `tasks/todos.md`).
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-1508-s0-runtime-hardening.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-1508-s0-runtime-hardening.md`.

## Approach
### Strategy
Execute Sprint S0 of `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` exactly as scoped there: close GAP-001 (capability dishonesty), GAP-002 (unsafe task-level steer), and GAP-003 (`workspaceHint` ambiguity) before any platform-line work starts. Wire v1 stays byte-frozen; every change is value-level or additive-internal.

Four vertical moves, in dependency order:

1. **Capability source of truth** (H-002/H-003): `RuntimeAdapter.capabilities` becomes the only runtime-level truth; `RuntimeInfo` sent on the wire is generated from the adapter instances, deleting any second hardcoded table. Claude's generated info reports interactive approval consistent with its real confirm path; unknown capability defaults fail closed.
2. **Task-level capability snapshot** (H-004): at claim time the task record already gets `claimedRuntime` (`hub.ts:766`); extend the snapshot so the server can answer "can THIS task be steered" from the task record alone. Connection-level capability stays discovery-only.
3. **Steer gate, both ends** (H-005/H-006): server `steerTask()` rejects unsupported runtimes with a stable typed error before any envelope is sent; terminal-vs-steer races resolve terminal-first with a conflict/not-running error. Client treats a theoretically-impossible inbound steer as a protocol/authority error: record, ack/isolate, keep the cursor advancing — no permanent freeze, no duplicate side effect on redelivery.
4. **Honesty closure** (H-001/H-007/H-008): capability honesty contract tests pin adapter truth to wire output; `workspaceHint` is documented as reserved (ADR'd, no code claims it works); the architecture ledger moves GAP-001/002/003 to closed with CURRENT markers updated.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Gate steer by task-record capability snapshot taken at claim | Single authority already written at claim; survives device reconnect with different adapter set; testable without live connection | Snapshot can go stale if a device re-registers mid-task with different adapters | **Use** — a mid-task adapter change cannot retroactively make the running process steerable anyway; snapshot is the honest answer |
| Gate steer by live connection-level capability lookup | No new snapshot field | Wrong authority: "some adapter supports steer" ≠ "this task's runtime supports steer" (exact GAP-002 failure mode); racy against reconnect | Rejected — restates the bug |
| Keep sending steer, let the adapter throw, add client-side tolerance only | Smaller server diff | Leaves a known-bad envelope on the wire; burns redelivery; sprint S0.4 explicitly calls this rollback failure | Rejected |
| Regenerate RuntimeInfo from adapters (delete hardcoded table) | One truth source; GAP-001 cannot recur | Touches every adapter's declared capabilities; needs contract tests to hold the line | **Use** — H-008 adds the contract tests in the same slice |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/adapters/**` | Edit | Each adapter's `capabilities` declaration becomes the authoritative, accurate self-report (Pi: mid-turn steer yes; Claude: interactive approval yes, steer no; Codex: both no) |
| `packages/client/src/daemon/**` (runtime info assembly) | Edit | Generate wire `RuntimeInfo` from adapter instances; delete hardcoded capability values (`approvalInteractive: false` table) |
| `packages/server/src/hub.ts` | Edit | Claim-time capability snapshot on the task record; `steerTask()` gate: claimed-runtime capability check before enqueue, stable typed errors (unsupported runtime / not running / terminal conflict) |
| `packages/server/src/task-store.ts` (+ SQLite variant if the record shape surfaces there) | Edit | Additive task-record field(s) for the claim-time capability snapshot |
| `packages/server/src/index.ts` / public types | Edit | Expose the typed steer rejection on the public steer surface |
| `packages/client/src/daemon/task-runner.ts` | Edit | Inbound unsupported-steer handling: record protocol/authority error, ack/isolate, never stall the cursor |
| `packages/client/src/daemon/connection-manager.ts` (+ cursor path) | Edit/Verify | Ensure handler-level rejection acks the envelope so replay cannot loop; idempotent on redelivery |
| `packages/server/src/__tests__/**`, `packages/client/src/__tests__/**` (+ colocated `*.test.ts`) | Add | H-008 capability honesty contract tests; steer gate positive/negative; cursor non-freeze; redelivery idempotency |
| `docs/architecture/sdk-architecture.md` | Edit | Close GAP-001/002/003 in §11.1; update §3.3/§4.4 from gap-description to implemented behavior; task-capability layer marked CURRENT |
| `docs/protocol.md` | Edit | `workspaceHint` documented as reserved (no consumer); steer capability semantics note — no schema change |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | S0 progress/acceptance marks only |
| `packages/protocol/**` | Do not touch | Wire v1 frozen; golden must be byte-identical; any need to touch protocol non-golden files is a contract amendment, not a quiet widening |
| `packages/keys/**` | Do not touch | K-line active plan owns it |

### Code Snippets
Typed steer rejection (server public surface, shape indicative):

```ts
type SteerRejection =
  | { code: 'steer_unsupported_runtime'; runtime: RuntimeId }
  | { code: 'task_not_running'; state: TaskState }
  | { code: 'task_terminal'; state: TaskState };
```

Gate reads the task record, not the connection:

```ts
// hub.steerTask(taskId, ...)
// 1. record = taskStore.get(taskId)            — authority
// 2. record.state !== 'Running'  -> typed reject (terminal wins races)
// 3. !record.claimedRuntimeCapabilities.steer -> typed reject, no envelope
// 4. enqueue task.steer                        — only past the gate
```

### Data Flow
Claim: adapter capabilities → daemon claim payload (actual runtime) → hub `onClaim` writes `claimedRuntime` + capability snapshot → task record.
Steer: SaaS → `steerTask(taskId)` → task-record gate → (reject with typed error | enqueue `task.steer`) → client handler → Pi adapter mid-turn steer. Unsupported inbound steer (forged/replayed): client records protocol error, acks, cursor advances.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Steer fix still consults connection capability somewhere (R-002) | 中 | 高 | Claimed-runtime snapshot is the only gate input; negative E2E asserts Claude/Codex running tasks are rejected server-side with zero envelopes sent |
| Golden drift via incidental protocol import/change | 低 | 极高 | `packages/protocol/**` untouched; `git diff --exit-code packages/protocol/src/__tests__/golden/` in exit criteria |
| Cursor-freeze fix breaks redelivery idempotency | 中 | 高 | Dedicated test: same envelope redelivered after reconnect produces no second side effect and cursor still advances |
| Capability generation misses an adapter option surface (dynamic capabilities per options) | 中 | 中 | Contract tests enumerate all three adapters across their option matrix; unknown capability fails closed |
| Task-record shape change leaks into persisted SQLite rows with compat cost | 低 | 中 | Field is additive; if migration cost appears, keep optional migration in test fixture only, do not ship half-wired fields (sprint S0.4) |
| Docs drift: architecture claims fixed before merge | 低 | 中 | Doc closure commit is last in the slice, after tests green |

## Task Contracts
- Contract file: `tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md`
- Review file: `tasks/reviews/20260807-1508-s0-runtime-hardening.review.md`
- Implementation notes file: `tasks/notes/20260807-1508-s0-runtime-hardening.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR from the contract worktree; capability generation, steer gate, and doc closure as separately revertible commits (sprint §1.3 vertical slices).
- **Rollback surface**: Per-commit revert; no wire shape change, no migration; additive task-record field inert without the gate.
- **Verification boundary**: `pnpm -r run typecheck && pnpm -r run test && pnpm -r run build`, `git diff --exit-code packages/protocol/src/__tests__/golden/`, `repo-harness run check-task-workflow --strict`, Node 20/22 CI matrix.
- **Review/acceptance boundary**: Gatekeeper diff review against sprint S0.3 acceptance criteria + external acceptance receipt; reviewer and implementer are different execution contexts (program DoD §3).
- **High-risk surface**: `packages/server/src/hub.ts` (task authority), client cursor/redelivery path; both covered by negative tests and crash-free replay assertions.
- **Why not checklist row**: Dual-side behavior change over the frozen wire with eight stories and a security-adjacent invariant (no credential-isolation change) — needs contract-level scope authority and its own worktree.

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint S0 acceptance boxes in `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` §S0.3.
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md`.
- **Evaluator rubric**: All S0.3 boxes checkable with named test evidence; protocol golden byte-identical; review confirms no credential-isolation change.
- **Stop condition**: Any need to modify `packages/protocol/**` or `packages/keys/**`, or any design that keeps sending steer to unsupported runtimes — stop, amend contract or escalate.
- **Rollback surface**: Revert the PR; no persisted-state or wire compatibility residue.

## Annotations

## Task Breakdown
- [ ] H-002 Adapter capability truth: accurate per-adapter `capabilities` declarations (Pi/Claude/Codex), unknown-capability fail-closed
- [ ] H-003 Wire `RuntimeInfo` generated from adapter instances; hardcoded `approvalInteractive:false` table deleted; Claude reports interactive approval consistent with real confirm path
- [ ] H-004 Claim-time capability snapshot on the server task record (additive; `claimedRuntime` already at `hub.ts:145,766`)
- [ ] H-005 `steerTask()` task-level gate with stable typed errors (unsupported runtime / not running / terminal-first race); no envelope past a failed gate
- [ ] H-006 Client inbound unsupported-steer handling: protocol/authority error recorded, envelope acked, cursor never freezes, redelivery idempotent
- [ ] H-008 Capability honesty + steer contract tests (client adapter truth ↔ wire output; server gate positive/negative; cursor non-freeze)
- [ ] H-007 `workspaceHint` decision recorded: reserved, documented in `docs/protocol.md` + architecture, no code claims it works
- [ ] H-001 Architecture ledger closure: GAP-001/002/003 closed in `docs/architecture/sdk-architecture.md` §11.1, §3.3/§4.4 updated to implemented behavior
- [ ] Full gates green: typecheck / test / build / golden zero-diff / check-task-workflow --strict; review confirms no credential-isolation change
