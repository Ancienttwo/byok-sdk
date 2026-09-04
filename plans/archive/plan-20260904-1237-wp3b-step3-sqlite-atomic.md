> **Archived**: 2026-09-04 13:05
> **Related Plan**: plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md
> **Outcome**: Completed
> **Lifecycle**: plan
> **Parent Run ID**: run-20260904-1305
> **Archive Projection V1**: `plans/plan-20260904-1237-wp3b-step3-sqlite-atomic.md` => `plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/notes/20260904-1237-wp3b-step3-sqlite-atomic.notes.md` => `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/contracts/20260904-1237-wp3b-step3-sqlite-atomic.contract.md` => `tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Archive Projection V1**: `tasks/reviews/20260904-1237-wp3b-step3-sqlite-atomic.review.md` => `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`

# Plan: WP3B Step 3: atomic SQLite embedded composition and example restart proof

> **Status**: Archived
> **Created**: 20260904-1237
> **Slug**: wp3b-step3-sqlite-atomic
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved the corrected Step 3 scope on 2026-09-04 after takeover proved that replacing `TaskAttemptStore` alone disconnects `TaskCancellationStore` from its task authority and cannot satisfy the commit-both-or-neither contract.
> **Verification Boundary**: SQLite conformance and atomic fault guards, server/example focused tests, `BYOK_STORE=sqlite` restart readback, then repository required checks.
> **Rollback Surface**: one branch commit based on `main@10bb9fc`; no migration is applied outside test/example-local database files.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §7 Step 3, amended by this plan.
> **Task Contract**: `tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Task Review**: `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`
> **Implementation Notes**: `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`

## Agentic Routing

- Selected route: direct implementation in one isolated worktree; no concurrent writer on this branch.
- Routing reason: the six interfaces share one schema, transaction coordinator, and composition seam; splitting writers would create overlapping ownership across the same invariants.
- Due diligence:
  - P1 map: `createByokServer` owns embedded composition; cloud owns task/cancellation/mailbox contracts; core owns object/mailbox contracts; the example is the only `BYOK_STORE` consumer. Step 4 is isolated in a client-only worktree.
  - P2 trace: dispatch opens a task and appends an offer; cancel must update the attempt and append its delivery in one transaction; blob create reserves an object manifest, writes bytes through the proxy, observes, commits, then reads a signed download URL. Restart must reconstruct both read models from one database.
  - P3 decision rationale: explicit mutually exclusive `memory | sqlite` composition; SQLite persists task, cancellation, mailbox, object manifest, blob metadata, and bytes in one database. All other ports remain in-memory. No dual write, fallback, or split sequence authority.

## Workflow Inventory

- Active plan: `plans/archive/plan-20260904-1237-wp3b-step3-sqlite-atomic.md`
- Sprint contract: `tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md`
- Sprint review: `tasks/archive/review-20260904-1305-wp3b-step3-sqlite-atomic.md`
- Implementation notes: `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`.
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-wp3b-step3-sqlite-atomic`, branch `codex/wp3b-step3-sqlite-atomic`.

## Approach

### Strategy

1. Add one shared SQLite database/coordinator and schema.
2. Implement task attempts, mailbox, and cancellation over that coordinator; cancellation uses one SQL transaction for tombstone plus delivery.
3. Implement object manifest and the paired blob grant/content proxy over the same coordinator.
4. Add an explicit server storage option and deterministic close ownership; leave the in-memory default unchanged.
5. Run the unmodified core/cloud conformance suites against the mixed composition, plus atomic fault and restart guards.
6. Restore the example's explicit `BYOK_STORE=sqlite` mode and prove task/blob/mailbox readback after reopening.

### Trade-offs

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Four-interface patch from the packet | Small | Breaks cancellation authority and has no façade injection seam | Reject |
| Mirror SQLite tasks into in-memory cancellation state | Keeps old scope wording | Dual authority and non-atomic failure | Reject |
| Persist task/cancellation/mailbox together | Satisfies current kernel contract | Persists outbox beyond the packet's original wording | Use; owner approved |
| Full 21-port SQLite bundle | Uniform durability | Large unrelated scope | Reject; other ports remain in-memory |

## Detailed Design

### File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/stores/sqlite/**` | Create | Shared connection/coordinator, schema, six contract implementations, composition factory, tests |
| `packages/server/src/{stores,index,types}.ts` | Edit | Explicit storage selection and lifecycle wiring |
| `packages/server/package.json`, `bun.lock` | Edit | Test-only conformance dependency if required |
| `examples/basic/**` | Edit | SQLite mode, browser blob URL, shutdown, restart proof command |
| `api-surface/server.d.ts` | Regenerate | Intentional additive storage surface |
| design packet / task artifacts | Edit | Record approved scope correction and evidence |

### Data Flow

`createByokServer({storage:{kind:'sqlite', path}})` → open owner-only DB → create in-memory core/cloud bundles → replace `core.mailbox`, `core.objects`, `cloud.tasks`, `cloud.cancellations`, `cloud.blobs`, and `blobContentProxy` with one SQLite composition → cloud kernel/facade unchanged above ports → `stop()` drains façade resources and closes the database.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Async interleaving on one `DatabaseSync` transaction | High | Unrelated calls accidentally join a transaction | One composition-level async mutex around every SQLite operation |
| Cancellation leaves only task or message | Medium | Contract violation | One SQL transaction plus injected rollback fault guard |
| Blob metadata and object manifest drift | Medium | Download/immutability error | Same database; conformance and restart finalize tests |
| BigInt/JSON decoding drift | Medium | Type/semantic mismatch | Central row decoders and unmodified conformance |
| SQLite becomes throughput bottleneck at 10x | Certain | Serialized embedded writes | Explicit embedded/reference scope; first pressure point documented, no hidden pool |

## Task Contracts

- Verification: `repo-harness run verify-contract --contract tasks/archive/contract-20260904-1305-wp3b-step3-sqlite-atomic.md --strict`.
- Stop on any need for a compatibility fallback, split mailbox authority, or changes to Step 4 client-owned paths.

## Promotion Gate

- **Merge/PR unit**: one Step 3 branch commit; no push, PR, merge, release, or deployment in this task.
- **Rollback surface**: revert the commit; example-local DBs are disposable and no production migration occurs.
- **Verification boundary**: conformance, focused SQLite restart/atomicity, example restart smoke, root gates.
- **Review/acceptance boundary**: exact committed subject reviewed against this corrected contract.
- **High-risk surface**: cancellation/mailbox atomicity and persisted blob/object ownership.
- **Why not checklist row**: this introduces a new durable composition and public configuration surface.

## Evidence Contract

- **State/progress path**: `tasks/archive/notes-20260904-1305-wp3b-step3-sqlite-atomic.md`.
- **Verification evidence**: focused and full command results recorded in the implementation notes, with final harness snapshots under `.ai/harness/runs/`.
- **Evaluator rubric**: unmodified conformance passes; cancel is all-or-nothing; second process reads task, mailbox, manifest, and bytes; in-memory behavior remains green.
- **Stop condition**: any required dual write/fallback or inability to prove rollback.
- **Rollback surface**: one branch commit based on `10bb9fc`; no external migration.

## Task Breakdown

- [x] T1 Land shared SQLite schema/coordinator and task-mailbox-cancellation atomic bundle.
- [x] T2 Land object/blob/proxy bundle and unmodified conformance composition.
- [x] T3 Wire explicit server storage selection, lifecycle, and API surface.
- [x] T4 Restore `examples/basic` SQLite mode and restart readback smoke.
- [x] T5 Run required checks, exact-subject review, acceptance, and closeout evidence.
