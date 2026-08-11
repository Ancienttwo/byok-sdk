# Plan: Sprint S3b: SQLite Durable Local Journal with Crash and Disk-Pressure Matrices

> **Status**: Archived
> **Created**: 20260807-2242
> **Slug**: s3b-local-journal
> **Artifact Level**: work-package
> **Promotion Reason**: Second half of Sprint S3 (sprint amendment D-5): the daemon-side durability core — `LocalTaskJournal` port with the production `SqliteLocalTaskJournal`, cursor-ack-only-after-commit, local storage watermarks with classified GC, and the twelve-point crash/disk-pressure injection matrix (sprint S3.4). This is the program's silent-failure surface: an ack-before-commit implementation passes every happy-path test and loses tasks only under specific power-cut timings. Needs contract-level scope authority, its own worktree, and dedicated review depth.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `git diff --exit-code packages/protocol/src/__tests__/golden/`, `git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/ examples/`, `repo-harness run check-task-workflow --strict`, plus sprint S3.5 boxes 3-9 and the S3.4 twelve-point matrix.
> **Rollback Surface**: The journal integration ships behind an explicit hosted/journal config section — the default (self-hosted) daemon path is byte-equivalent to today (no journal object constructed). Rollback disables hosted journal mode but preserves `daemon.db`, WAL files, workspaces, and recovery evidence; no rollback path converts to a lossy file journal or deletes the database (sprint S3.6 verbatim). Cloud-side changes are limited to the S3a-gate P2 fixes (comment + one test guard).
> **Spec**: `docs/spec.md`
> **Research**: `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` (§S3.3 journal contract, §S3.4 matrices, §S3.5 boxes 3-9, §S3.6, D-5), `docs/architecture/sdk-architecture.md` §12.7.2 (eight tables + PRAGMAs, no-silent-downgrade), §12.7.2.1 (watermarks, cleanup order, never-auto-delete list), §12.7.3 (read/ack semantics), §14.4 invariants 5/11
> **Task Contract**: `tasks/contracts/20260807-2242-s3b-local-journal.contract.md`
> **Task Review**: `tasks/reviews/20260807-2242-s3b-local-journal.review.md`
> **Implementation Notes**: `tasks/notes/20260807-2242-s3b-local-journal.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: Durability semantics with silent failure modes; parent pins the transaction/ack ordering and the never-delete list as hard constraints, two sequential deep-workers build journal-then-pressure, fast-worker closes docs + the S3a P2 ride-alongs, gatekeeper runs the matrices as the acceptance artifact.
- Due diligence:
  - P1 map: the journal lives in `packages/client` (daemon side). Integration point is the daemon's envelope-handling chain: cursor advances only on handler success (existing `ConnectionManager.process()` semantics, hardened in S0), so a journal append placed at the head of the handler chain makes "ack after durable commit" structural rather than procedural. Admission gating for hard pressure hooks the TaskRunner's existing pre-claim admission sequence. SQLite idiom exists in-repo (`server/src/sqlite-task-store.ts`, `isSqliteAvailable()` Node 20 skip pattern); secure-dir/atomic-write utilities exist under `client/src/util/`.
  - P2 trace (§12.7.3 verbatim): cloud append → daemon poll → **journal transaction (envelope bytes + task record + idempotency receipt + cursor-advance eligibility, `synchronous=FULL`)** → hand to scheduler → next poll's cursor is the ack → cloud retires acked rows. Crash before append → mailbox redelivers; after append before ack → redelivery deduped by the journal's envelope receipt; after ack → journal recovery owns it (`listRecoverable`/`markRecovered`). The ack is never allowed to outrun the fsync — that single ordering is what the whole slice defends.
  - P3 decision rationale: `node:sqlite` (Node ≥22.5) as the production driver with zero new dependencies; on runtimes without it, hosted journal mode **refuses to start** (§12.7.2 no-silent-downgrade — a plain-file fallback impersonating durability is the named anti-pattern). Watermark defaults per sprint §8: host-configured max bytes + min free bytes with soft/hard thresholds. Crash injection follows the repo's durable-state idiom: kill the in-memory instance at the injection point, re-open the SQLite file, assert what survived — plus fault-injection hooks at the journal boundary for the ordering windows. Categories (journal/cache/log/workspace/quarantine) are measured separately because the cleanup order and the never-delete list are category-scoped (§12.7.2.1).

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-2242-s3b-local-journal.md`
- Sprint contract: `tasks/contracts/20260807-2242-s3b-local-journal.contract.md`
- Sprint review: `tasks/reviews/20260807-2242-s3b-local-journal.review.md`
- Implementation notes: `tasks/notes/20260807-2242-s3b-local-journal.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-2242-s3b-local-journal.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan stays Executing (cross-repo K4 waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure, per the S0-S3a pattern.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-2242-s3b-local-journal.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-2242-s3b-local-journal.md`.

## Approach
### Strategy
Land the durability chain in dependency order, each stage carrying its own falsification tests:

1. **L-001 — the journal itself**: `LocalTaskJournal` port (sprint S3.3 minimum API verbatim: `appendEnvelope`/`recordAdmission`/`recordTransition`/`recordTerminal`/`listRecoverable`/`markRecovered`/`measureUsage`/`listCleanupCandidates`/`markCleanupResult`/`compact`) + production `SqliteLocalTaskJournal` on `node:sqlite`: single DB `<storeDir>/daemon.db`, the eight §12.7.2 tables, `WAL` + `foreign_keys=ON` + ack-critical `synchronous=FULL`, single-writer queue with bounded busy timeout, bounded record sizes (artifacts stay on the filesystem), idempotency by envelope/transition id, corrupt-DB quarantine (timestamped move, fail closed, never delete).
2. **L-002 — ack ordering**: an explicit daemon config section (hosted journal mode) that wraps the envelope-handling chain: journal transaction commits before the handler returns success, so the existing "cursor advances only on handler success" semantics make ack-before-commit unrepresentable. Redelivery after append is absorbed by the envelope receipt. Runtime without `node:sqlite` + journal mode on → construction fails closed with a typed error. Default path (no journal config) is byte-equivalent to today.
3. **L-003 — pressure**: `LocalStoragePolicy` config (maxStoreBytes/minFreeBytes/soft/hard); `measureUsage` reports journal/cache/log/workspace/quarantine separately; watermark state machine normal→pressure→hard→emergency (§12.7.2.1 table); classified GC in the §12.7.2.1 order with the never-auto-delete list enforced structurally (protected categories are not enumerable by the cleanup path at the type level, not filtered at runtime); WAL checkpoint/compaction bounded and off the hot path; hard pressure declines new admissions (retryable) via the TaskRunner admission seam while terminal flush/delete/export/doctor continue.
4. **P-007 — the matrices**: sprint S3.4's twelve points as tests — crash 1-6 via kill-and-reopen at injection hooks; pressure 7-12 via fake usage/free-space providers and fault injection (disk-full before commit, WAL checkpoint pressure, cleanup worker crash between file delete and metadata mark and vice versa). Each point asserts: no lost task, no duplicate side effect, stable recovery status, protected data intact.
5. **Ride-alongs (S3a gate P2s, first-commit)**: cloud receipt comment corrected (canonical re-encode, not verbatim bytes), unwrapped-fetch guard test, GAP-015 label S3→S3b.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `node:sqlite`, fail-closed where absent | Zero new deps; §12.7.2 verbatim; Workers irrelevant (daemon is Node) | Node 20 hosts cannot run hosted journal mode | **Use** — no-silent-downgrade is the named invariant; Node 20 CI covers via `isSqliteAvailable()` skip + a fail-closed construction test that runs everywhere |
| better-sqlite3 dependency | Works on Node 20 | New native dep across three platforms; against the zero-dep posture | Rejected |
| Journal append inside ConnectionManager | Explicit ack coupling | Touches transport internals; handler-chain head achieves the same ordering with zero transport change | Rejected — wrap at the daemon's envelope entry, transport untouched |
| Runtime-filtered never-delete list | Simple | A filter bug deletes recovery evidence; the list must be unrepresentable, not checked | Rejected — cleanup path can only see cleanable categories by construction |
| Real process-kill crash tests | Maximum fidelity | Slow, flaky, platform-dependent | Rejected for CI — kill-and-reopen on the durable file plus boundary fault hooks covers the ordering windows; the fsync itself is `synchronous=FULL`'s contract |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/journal/journal.ts` | Create | `LocalTaskJournal` port (S3.3 API), record types, typed errors, `JournalReceipt` |
| `packages/client/src/daemon/journal/sqlite-journal.ts` | Create | `SqliteLocalTaskJournal`: eight tables, PRAGMAs, single-writer queue, transactions, idempotency, quarantine hook |
| `packages/client/src/daemon/journal/storage-policy.ts` | Create | `LocalStoragePolicy`, usage categories, watermark state machine, classified GC engine (cleanable-only category types), WAL checkpoint/compaction scheduling |
| `packages/client/src/daemon/create-daemon.ts` | Edit | Optional hosted-journal config section (validation, fail-closed construction, envelope-chain wrap, admission guard wiring); default path unchanged |
| `packages/client/src/daemon/task-runner.ts` | Edit (minimal) | Injectable admission guard seam (hard-pressure decline, retryable) if no existing seam fits |
| `packages/client/src/index.ts` | Edit | Export the port + config types (library surface) |
| `packages/client/src/__tests__/journal-*.test.ts` | Create | Unit: transactions, idempotency, reopen semantics, quarantine, usage categories, GC order, never-delete enforcement, WAL bounds |
| `packages/client/src/__tests__/journal-crash-matrix.test.ts` | Create | S3.4 points 1-6 (kill-and-reopen + fault hooks), against the real-cloud fixture where cloud interaction matters |
| `packages/client/src/__tests__/journal-pressure-matrix.test.ts` | Create | S3.4 points 7-12 (fake usage/free providers, disk-full injection, cleanup-crash both orders) |
| `packages/cloud/src/cloud.ts` + `inbound.ts` | Edit (comment) | P2-1: "verbatim" → canonical re-encode wording at the receipt seam |
| `packages/cloud/src/__tests__/route-inventory.test.ts` (or sibling) | Edit | P2-3: unwrapped-fetch guard |
| `docs/architecture/sdk-architecture.md` | Edit | GAP-015 closure (+ P2-4 label fix), §12.7.2/§12.7.2.1 CURRENT marks, GAP-006 full closure, §12.5 durable-half note |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | S3.5 boxes 3-9 marks; S3 complete = alpha gate note |
| `packages/server/**`, `packages/protocol/**`, `packages/keys/**`, `examples/**` | Do not touch | Machine-checked zero diff |

### Code Snippets
The ordering that must be unrepresentable to violate:

```ts
// daemon envelope entry (hosted journal mode):
// handler success ⇒ journal transaction committed ⇒ cursor may advance
async function onEnvelopeHosted(envelope: Envelope): Promise<void> {
  await journal.appendEnvelope(toRecord(envelope)); // tx: bytes + receipt + eligibility; FULL sync
  await runner.handleEnvelope(envelope);            // admission → scheduler handoff
} // ConnectionManager advances the cursor only after this resolves — unchanged transport
```

Fail-closed construction:

```ts
if (config.hostedJournal && !isSqliteAvailable()) {
  throw new JournalUnavailableError('hosted journal mode requires a runtime with node:sqlite; refusing to start');
}
```

### Data Flow
Poll → envelope → journal tx (envelope+receipt+eligibility, FULL) → scheduler handoff → handler resolves → cursor advances (= ack) → cloud retires. Terminal: runtime terminal → journal `recordTerminal` (hash + retry state) → cloud receipt (idempotent) → journal completion mark. Recovery on start: `listRecoverable` → re-admit or surface, `markRecovered`; interrupted rows never auto-deleted. Pressure: usage snapshot → watermark state → (pressure) clean rebuildable categories / (hard) admission declines, terminal flush continues / (emergency) no ack, evidence preserved.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Ack outruns commit in some path (R-006) | 中 | 极高 | Ordering is structural (append at handler head; cursor advance is post-success); crash points 2/3 assert it; no alternative ack path exists |
| Cleanup deletes protected data (R-008) | 中 | 极高 | Never-delete list enforced by type-level category separation; point 12 both-orders crash test; quarantine never enumerable |
| Journal integration regresses self-hosted daemon | 中 | 高 | Default path constructs no journal; full existing client suite green is a gate; config section is opt-in |
| `node:sqlite` API drift / Node 20 CI | 中 | 中 | `isSqliteAvailable()` skip idiom (server precedent); fail-closed construction test runs on all Node versions |
| Single-writer queue starves the hot path | 中 | 中 | Bounded busy timeout; checkpoint/vacuum scheduled off-path; WAL-bound test (point 11) |
| Matrix tests flaky on CI | 中 | 中 | No wall-clock races: injected clocks, fake usage providers, kill-and-reopen determinism |

## Task Contracts
- Contract file: `tasks/contracts/20260807-2242-s3b-local-journal.contract.md`
- Review file: `tasks/reviews/20260807-2242-s3b-local-journal.review.md`
- Implementation notes file: `tasks/notes/20260807-2242-s3b-local-journal.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-2242-s3b-local-journal.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR; journal / integration / pressure / matrices / ride-alongs+docs as separately reviewable commits.
- **Rollback surface**: Config-gated; default path byte-equivalent; disable hosted mode preserves all durable evidence (S3.6).
- **Verification boundary**: five standard gates + server/protocol/keys/examples zero-diff + S3.4 twelve-point matrix + S3.5 boxes 3-9; CI Node 20/22 (journal tests skip on 20, fail-closed construction test runs everywhere).
- **Review/acceptance boundary**: Gatekeeper re-runs the matrices as the acceptance artifact + receipt; reviewer and implementer are different execution contexts.
- **High-risk surface**: ack ordering, cleanup safety, recovery semantics — the silent-failure trio.
- **Why not checklist row**: The program's durability core; S3 alpha gate closes here (D-5).

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint §S3.5 boxes 3-9.
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260807-2242-s3b-local-journal.contract.md`.
- **Evaluator rubric**: All twelve S3.4 points with named tests; boxes 3-9 checkable; default daemon path proven unchanged (existing suite + no-journal-constructed assertion); no-silent-downgrade proven by the fail-closed construction test.
- **Stop condition**: Any `packages/server/**`/`packages/protocol/**`/`packages/keys/**` edit; any design where ack can precede commit; any cleanup path that can enumerate protected categories; any plain-file journal presented as hosted-production-capable — stop, amend or escalate.
- **Rollback surface**: Revert the PR; config-gated integration leaves the default path untouched.

## Annotations

## Task Breakdown
- [x] Ride-alongs (first commit): P2-1 receipt-seam comment, P2-3 unwrapped-fetch guard, P2-4 GAP-015 label
- [x] L-001 `LocalTaskJournal` port (S3.3 API verbatim) + typed errors + record types
- [x] L-001 `SqliteLocalTaskJournal`: eight tables, PRAGMAs (WAL/foreign_keys/FULL), single-writer queue, transactions, idempotency, corrupt-DB quarantine
- [x] L-002 Hosted-journal config section: validation, fail-closed construction without `node:sqlite`, envelope-chain wrap (ack structurally after commit), default path byte-equivalent
- [x] L-002 Admission guard seam in TaskRunner (hard-pressure decline, retryable)
- [x] L-003 `LocalStoragePolicy` + per-category usage measurement + watermark state machine + classified GC (type-level never-delete) + bounded WAL checkpoint/compaction
- [x] P-007 Crash matrix: S3.4 points 1-6 (kill-and-reopen + fault hooks; no lost task, no duplicate side effect, stable recovery)
- [x] P-007 Pressure matrix: S3.4 points 7-12 (fake providers; soft cleans only rebuildable; hard declines admission but allows terminal flush/delete/export; emergency preserves evidence; cleanup-crash both orders)
- [x] Docs: GAP-006/GAP-015 closure, §12.7.2/§12.7.2.1 CURRENT marks, sprint S3.5 boxes 3-9, alpha-gate note
- [x] Full gates green incl. zero-diff machine check and existing client suite unchanged
