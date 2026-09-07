# Pending Agent message recovery before interrupted settlement

> **Status**: Blocked
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

Source fix, compiled SIGKILL and unchanged downstream candidate regression are complete. Root required test remains blocked only by the pre-existing cloud-dataplane worker-packaging 5s timeout. This plan does not claim all exit criteria passed or authorize its unrelated repair. Publication, native release matrix and beta rebuild follow the corrected stable artifact.
