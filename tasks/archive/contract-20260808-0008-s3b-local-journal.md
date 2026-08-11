> **Archived**: 2026-08-08 00:08
> **Related Plan**: plans/archive/plan-20260807-2242-s3b-local-journal.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260808-0008

# Task Contract: s3b-local-journal

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-2242-s3b-local-journal.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 22:44
> **Review File**: `tasks/reviews/20260807-2242-s3b-local-journal.review.md`
> **Notes File**: `tasks/notes/20260807-2242-s3b-local-journal.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S3b is the durability half of Sprint S3 (amendment D-5) and the program's silent-failure surface: an ack-before-commit daemon passes every happy-path test and loses tasks only under power-cut timings, and a cleanup path that can see protected records deletes recovery evidence exactly once, in production. Architecture §12.7.2 makes SQLite the hosted-production canonical with an explicit no-silent-downgrade rule; §12.7.3's load-bearing ordering — durable local append **then** cursor ack — is invariant 5/11 of §14.4. The mailbox side landed in S3a; without this slice the hosted alpha gate stays open and every crash window between poll and ack is a task-loss window.

## Goal

Deliver sprint stories L-001/L-002/L-003 + P-007 inside `packages/client`: a `LocalTaskJournal` port (S3.3 minimum API verbatim) with the production `SqliteLocalTaskJournal` on `node:sqlite` (single DB `<storeDir>/daemon.db`, the eight §12.7.2 tables, `WAL` + `foreign_keys=ON` + ack-critical `synchronous=FULL`, single-writer queue with bounded busy timeout, multi-table `BEGIN IMMEDIATE` transactions — first in the repo, idempotency by envelope/transition id, corrupt-DB timestamped quarantine that never deletes); an opt-in hosted-journal config section whose envelope-chain placement makes ack-before-commit unrepresentable (journal append at the head of the daemon's `onEnvelope` chain — the existing "cursor advances only on handler success" semantics at `connection-manager.ts:605-630` provide the ordering, transport untouched); fail-closed construction when `node:sqlite` is absent (typed error, no plain-file impersonation); `LocalStoragePolicy` with per-category usage (journal/cache/log/workspace/quarantine), the §12.7.2.1 watermark state machine, classified GC whose cleanup path cannot enumerate protected categories at the type level, and bounded off-hot-path WAL checkpoint/compaction; a TaskRunner admission-guard seam that declines new offers (retryable) under hard pressure while terminal flush/delete/export continue; and the S3.4 twelve-point crash/disk-pressure matrix as tests. The default (no-journal-config) daemon path constructs no journal and stays byte-equivalent. Ride-alongs from the S3a gate: receipt-seam comment fix, unwrapped-fetch guard, GAP-015 label.

## Scope

- In scope:
  - `packages/client/src/daemon/journal/**` — port, `SqliteLocalTaskJournal`, client-local sqlite-support (mirror of `server/src/sqlite-support.ts` shape; server's module is internal and stays untouched), storage policy + watermark engine + classified GC
  - `packages/client/src/daemon/create-daemon.ts` — optional config section following the `gitWorkspace` three-part idiom (type at `:82`-style declaration, conditional construction at `:425-430`-style, overrides seam); `onEnvelope` chain wrap at `:696-699`
  - `packages/client/src/daemon/task-runner.ts` — `admissionGuard?` optional dep following the existing single-purpose callback idiom (`:189-251`); wired into `handleOffer` (`:927-1026`) as a pre-claim decline (retryable)
  - `packages/client/src/daemon/control-protocol.ts` + `control-server.ts` + `bin/commands/status.ts` + `bin/format.ts` — storage usage/pressure on the status surface (name it `storage*`, NOT `watermark*` — `queueWatermarks` at `control-protocol.ts:355` is a different concept)
  - `packages/client/src/index.ts` — export the port + config types
  - `packages/client/src/__tests__/**` — journal unit suites, crash matrix (S3.4 points 1-6), pressure matrix (points 7-12)
  - `packages/cloud/src/cloud.ts` + `inbound.ts` + one cloud test — ride-alongs P2-1 (comment: canonical re-encode, not verbatim) and P2-3 (fetch-identity guard; a test-only seam is acceptable, no public-surface widening)
  - `docs/architecture/sdk-architecture.md` — GAP-015 closure + label fix, GAP-006 full closure, §12.7.2/§12.7.2.1 CURRENT marks, §12.5 durable-half note
  - `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` — S3.5 boxes 3-9 marks + alpha-gate note
- Out of scope:
  - `packages/server/**`, `packages/protocol/**`, `packages/keys/**`, `examples/**` — zero change, machine-checked
  - New dependencies of any kind (`node:sqlite` is built-in); doctor/support-bundle (S7); board/truth handlers; daemon-side capabilities consumption
  - `connection-manager.ts` — no change needed (the ordering comes from handler-chain placement); touching it requires an amendment
- Taste constraints: the never-delete list is enforced by construction (cleanable-category types), not by runtime filtering; no wall-clock races in matrix tests (injected clocks, DI fault seams, fake usage providers); typed errors; journal records bounded (no full prompt/tool output by default; artifacts stay on the filesystem).

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any design lets the cursor advance before the journal transaction commits, lets the cleanup path see a protected category, or requires a plain-file journal to stand in for SQLite in hosted mode.

## Falsifier

Direction is wrong if durability is procedural instead of structural. Cheapest proof points: (1) crash point 2 (after SQLite commit, before ack) — reopen must show the envelope durable and redelivery deduped by the receipt, with zero second side effect; (2) crash point 1 (before append) — mailbox redelivery is the recovery, journal shows nothing; if either needs test-side special-casing of the ack path, the ordering is not structural. (3) The default-path equivalence: with no journal config, no journal object is constructed and the entire existing client suite passes unchanged — if any existing test needs edits (beyond additive fixtures), the opt-in claim is false.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-2242-s3b-local-journal.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-2242-s3b-local-journal.review.md`
- Notes file: `tasks/notes/20260807-2242-s3b-local-journal.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260807-2242-s3b-local-journal.contract.md
  - tasks/reviews/20260807-2242-s3b-local-journal.review.md
  - tasks/notes/20260807-2242-s3b-local-journal.notes.md
  - .ai/context/capabilities.json
  - docs/researches/
  - docs/architecture/
  - packages/client/src/
  - packages/cloud/src/
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/daemon/journal/journal.ts
    - packages/client/src/daemon/journal/sqlite-journal.ts
    - packages/client/src/__tests__/journal-crash-matrix.test.ts
    - packages/client/src/__tests__/journal-pressure-matrix.test.ts
  files_contain:
    - path: packages/client/src/daemon/journal/journal.ts
      pattern: "LocalTaskJournal"
    # Ack-critical durability pragma present in the production impl.
    - path: packages/client/src/daemon/journal/sqlite-journal.ts
      pattern: "synchronous"
    # Multi-table transaction idiom exists.
    - path: packages/client/src/daemon/journal/sqlite-journal.ts
      pattern: "BEGIN IMMEDIATE"
    # Ride-along P2-1 landed.
    - path: packages/cloud/src/cloud.ts
      pattern: "re-encoded"
  files_not_contain:
    # The stale overstatement is gone.
    - path: packages/cloud/src/cloud.ts
      pattern: "verbatim, as the device sent it"
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-2242-s3b-local-journal.notes.md
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - git diff --exit-code packages/protocol/src/__tests__/golden/
    - git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/ examples/
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior (sprint S3.5 boxes 3-9): ack watermark cannot advance before SQLite commit (structural, crash points 2/3); crash matrix 1-6 and pressure matrix 7-12 pass with no lost task, no duplicate side effect, stable recovery status, protected data intact; usage reports the five categories separately; soft pressure cleans only rebuildable/expired categories; hard pressure declines new admission (retryable) while terminal flush/delete/export continue; unacked/running/recovery/quarantine records never auto-deleted (by construction); WAL checkpoint/compaction bounded and observable on the status surface.
- Edge cases: redelivery after append deduped by envelope receipt; corrupt DB at open → timestamped quarantine + fail-closed error, never deletion; `node:sqlite` absent + journal mode on → typed construction error (test runs on all Node versions); journal tests skip on Node 20 via the `isSqliteAvailable` idiom; Windows path/security coverage for the journal directory.
- Regression risks: default daemon path byte-equivalent (no journal constructed; existing client suite unchanged); server/protocol/keys/examples zero-diff; status-surface naming does not collide with `queueWatermarks`.

## Rollback Point

- Commit / checkpoint: branch `codex/s3b-local-journal` off `main@8078519`; ride-alongs / journal / integration / pressure / matrices / docs as separately reviewable commits.
- Revert strategy: revert the PR; the integration is config-gated so the default path never changes, and no rollback deletes `daemon.db`, WAL files, or quarantine evidence (sprint S3.6).
