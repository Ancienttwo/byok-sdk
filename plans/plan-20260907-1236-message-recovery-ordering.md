# Pending Agent message recovery before interrupted settlement

> **Status**: Completed
> **Task Contract**: tasks/contracts/20260907-1236-message-recovery-ordering.contract.md

## Authorization

User approved the SDK pending-message/interrupted-terminal recovery fix, compiled-host proof and downstream candidate validation. No registry publication or production mutation in this source slice. Preserve both primary worktrees.

## P1 Architecture Map

AgentMessageOutbox owns immutable draft bytes and exact durable dispositions. SqliteLocalTaskJournal owns immutable terminal bytes. TaskRunner restores outboxes; create-daemon composes recovery and ConnectionManager delivers authenticated envelopes. Cloud owns first-message lifecycle admission and cancellation. No cloud protocol/storage change is required.

## P2 Concrete Trace

Salesko's unchanged restart regression persists a draft then returns HTTP503 before cloud admission. On restart create-daemon records daemon_interrupted and queues it before TaskRunner retries the draft. Cloud closes the task, rejects the never-admitted message, and the consumer remains uncalled. Existing logs and four-field evidence are in the Salesko beta-rebuild worktree research report dated 20260907.

## P3 Design Decision

Keep terminal recording before transport, but defer recovery terminal delivery while the corresponding activated draft lacks an exact persisted disposition. Derive this gate from the two existing durable authorities on each restart. An exact accepted/held/refused disposition releases the terminal; mismatches, outages and transport rejection do not fabricate a decision. No runtime rerun, timeout release, second persisted queue, cloud terminal-admission weakening or journal disablement. Tasks without pending drafts remain independent. At 10x scale existing bounded outbox/journal capacity fails first, visibly; no global wait blocks unrelated terminals.

## Task Breakdown

- [x] Verify source identity, isolate worktree and trace failure.
- [x] Add compiled SIGKILL regression and prove pre-fix failure.
- [x] Implement durable disposition gate and focused semantic tests.
- [x] Run required SDK checks and unchanged Salesko candidate regression.
- [x] Record exact evidence and handoff; registry/rebuild remain separate.

## Verification Boundary

Compiled daemon and cloud with real SQLite, 503 before admission, repeated restart, stable draft and terminal bytes, one consumer application and no runtime rerun. Include held/refused and cancellation boundaries. Required build/typecheck/test/API/version/workflow gates and diff check. Downstream uses disposable candidate artifact only; published pins remain unchanged.

## Rollback Surface

Revert this isolated source diff. No new dependency or durable schema. Existing fixture extensions avoid a second test harness.

## Closeout boundary

Source fix, compiled recovery and unchanged downstream candidate regression are complete. The explicitly approved packaging follow-up and one directly blocking fixture repair now close all required local source gates. Publication, exact final CI/release artifact, native release matrix and beta rebuild remain separate.

## Approved follow-up: Worker packaging gate — 2026-09-07

User approved resolving the named packaging blocker. Scope is only `packages/cloud-dataplane/src/__tests__/worker-packaging.test.ts` and existing evidence/lifecycle artifacts. No publication/deployment or runtime code change.

P1: The packaging test invokes the installed Wrangler entry with Node against worker-smoke, imports built dist/runtime, and inspects the emitted bundle. This fixture is excluded from shipped source/declarations. Root Vitest defaults remain global authority for ordinary unit tests.

P2: `it` (default5000ms) -> spawnSync (explicit120000ms) -> wrangler deploy --dry-run -> emitted JS -> four bundle inclusion/exclusion assertions. Full-suite evidence failed at the outer5000ms despite the child being permitted120000ms. A warmed standalone diagnostic passes all6 original tests; a controlled6s Wrangler startup is the deterministic pressure case.

P3: Build once in beforeAll with the existing120s child bound plus5s harness margin; afterAll owns scratch cleanup even when setup fails. Keep all four semantic bundle assertions and positive control unchanged. No global timeout increase, skip, retry, dependency or product fallback. At10x concurrent load the existing child120s hard bound still fails visibly; no unbounded wait is introduced.

- [x] Prove controlled slow-start failure with unchanged test.
- [x] Align fixture lifecycle/bounds and pass the same slow-start probe.
- [x] Run required final source checks; reuse unchanged shipped-artifact/downstream evidence by content identity.
- [x] Record source-gate closeout and the remaining stable-release boundary.

### One directly blocking fixture repair

The first final root run exposed two execution-recovery tests failing with runtime adapter contract violation, in one fixture family. P1: parent `finish()` owns the test completion file; compiled ControlledSession polls that file. P2: parent fs.writeFile opens/truncates the public path before writing bytes; child existsSync/readFile/JSON.parse can observe incomplete JSON, which the runtime boundary correctly refuses. P3: prove a deliberately paused file write reproduces the same failure, then publish complete fixture input by same-directory rename. This uses the user's one directly blocking out-of-scope fix allowance; no second outside issue will be repaired. Product parsing remains fail-closed. Scope: existing execution-recovery-kill.test.ts only.

## Final local source gate

All required commands passed: build, typecheck, full test3757pass134skip0fail, API surface, version authority, strict workflow, diff check. The final change after candidate7941c5e is confined to two build-excluded test files and documentation; no runtime source, dependency, lockfile or release script changed. Existing canonical pack and Salesko candidate behavior evidence is reused for the identical shipped code, not relabeled as an exact final-commit release artifact. No push, registry publish, deployment or live-device mutation.
