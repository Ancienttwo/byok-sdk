# Execution recovery and durable terminal settlement

> **Status**: Executing
> **Artifact Level**: work-package
> **Promotion Reason**: Cross-package durable execution recovery with real compiled crash evidence
> **Verification Boundary**: Required source gates plus compiled Node 22.22.0 SIGKILL oracle; no registry/deployment claim
> **Rollback Surface**: Revert the isolated recovery commit and its generated API/docs artifacts together
> **Owner**: tmux %8, coordinated by %7 Astra
> **Task Contract**: tasks/contracts/20260906-0500-execution-recovery.contract.md

## Authorization

User approved overnight implementation, acceptance, commits, push and PRs. This worktree is independent of the completed audit-log task. Its worker may complete this plan/contract and implement the named recovery surfaces; it must not modify the original primary worktree. Coordinator owns final publication of PRs. No npm publish, tag or production mutation.

## P1 Architecture Map

Protocol owns validated offer and lifecycle identities. Daemon journal owns durable local task and terminal facts. ConnectionManager currently queues outbound envelopes in memory. Cloud attempt/receipt stores own authenticated final execution state. Existing Agent egress spool covers distinct message families and cannot simply substitute for task terminals.

## P2 Concrete Trace

Offer -> journal append -> runner -> claim/start -> terminal hash -> memory send -> cloud receipt. Current restart writes interruption marker but sends no settlement; terminal bytes and local acknowledgement confirmation are absent. Implement durable decisions before runtime side effects and restart-safe outbound settlement.

## P3 Design Decision

Persist canonical terminal bytes and exact acknowledgement in one authority; atomically persist interruption report with marker. Reuse immutable task identity where proven to be a unique execution; introduce required epoch only if existing task reuse makes fencing insufficient. Every replay validates original tenant/device/AgentRef/execution. Retry is explicit new execution. No optional compatibility fence, synthetic success, or automatic runtime replay.

## Task Breakdown

- [x] Isolate from local main21adf71 and trace current authority gaps.
- [x] Complete concrete design, affected files and identity proof; bounded Claude decision requested through coordinator.
- [x] Implement durable execution admission, terminal/interruption delivery and cloud settlement.
- [x] Converge observer offer classification and unknown executable-message disposition.
- [x] Prove real compiled daemon SIGKILL schedules and reconstruct durable cloud stores (13/13).
- [x] Run required source/API/version/workflow checks and final acceptance (client/cloud full suites pass; unrelated cloud-dataplane packaging timeout is recorded as report-only).
- [x] Commit and deliver single handoff to %7 (`d52c1e0`; handoff `/tmp/byok-execution-recovery-handoff.md`).

## Acceptance

Unacknowledged offers redeliver idempotently. Acknowledged running work settles interrupted without runtime re-execution. Terminal commit/send/POST/response/local-confirm crash windows preserve original bytes, converge local confirmation and cloud final facts. Repeated restarts cannot drop pending reports. Late/cancelled/stale execution events cannot overwrite another execution or accepted terminal. Existing unrelated WIP remains intact.

## Scope

Recovery-related packages/client, cloud, core, protocol, server, cloud-dataplane and conformance implementation/tests; associated SQL, architecture/spec, generated API and own workflow artifacts. Excludes package versions, lockfile, CHANGELOG and audit-log module/tests. Worker must narrow files after concrete trace and preserve this goal.

## Concrete file inventory and ownership

- Parent: client daemon create-daemon, task-runner, connection-manager, long-poll-transport, observer; journal port/SQLite implementation; transport tests; docs and generated API.
- Cloud lane: cloud enqueue/inbound/in-memory attempts and focused tests; Postgres claim CAS and tests; server SQLite claim CAS and tests.
- Consumer lane: existing journal suites and observer/identity mock consumers only.
- Runtime fixture lane: new execution-recovery-kill test plus two execution-recovery fixtures only.

Cloud identity proof: tasks/notes/20260906-0500-execution-recovery.notes.md (source evidence copied from /tmp/byok-execution-identity-proof.md). Immutable tenant/taskId is the existing execution authority; caller-supplied control-plane IDs are reservation/idempotency inputs. Delivery retirement outlives mailbox rows. No attempt generation/name alias is introduced.

Original bytes remain pending until accepted POST disposition commits local confirmation. Unknown executable types freeze the cursor. Hash-only predecessor journal format fails closed without moving/quarantining its valid database; no migration or fabricated terminal replay is claimed.

## Evidence Contract

- **State/progress path**: This plan task breakdown, `tasks/contracts/20260906-0500-execution-recovery.contract.md`, `tasks/reviews/20260906-0500-execution-recovery.review.md`, `tasks/notes/20260906-0500-execution-recovery.notes.md`, and `/tmp/byok-execution-recovery-handoff.md`
- **Verification evidence**: The compiled daemon SIGKILL suite on Node 22.22.0, reconstructed SQLite/cloud authorities, exact terminal bytes, and runtime invocation count; plus all required source commands below. Old journal matrix cases 5/6 are not crash evidence.
- **Evaluator rubric**: Review records pass only when all crash windows, fencing, cancellation race, cursor stall, and exact original receipt/terminal bytes are demonstrated.
- **Stop condition**: Three bounded fix/reverify rounds exhausted, immutable task identity cannot be proven, or an excluded release/audit surface would need modification.
- **Rollback surface**: Revert the isolated recovery commit and generated API/docs/notes together; no external migration or production mutation.

## Promotion Gate

- **Merge/PR unit**: One coherent source diff plus generated API/docs and the plan/contract/notes/review artifacts; coordinator owns integration and PR.
- **Rollback surface**: Revert this isolated branch commit as one unit; no package publication, tag, deployment, version, lockfile, CHANGELOG, or audit-log mutation.
- **Verification boundary**: Required commands and compiled SIGKILL oracle below; coordinator reruns subject-bound checks after integration.
- **Review/acceptance boundary**: This worktree supplies source and crash evidence; coordinator owns final integration acceptance and release authority.
- **High-risk surface**: Terminal bytes/confirmation, interruption atomicity, cloud CAS fencing/cancellation race, unknown executable cursor stall, and stale terminal rejection.
- **Why not checklist row**: This cross-package durable behavior change has storage, protocol, cloud authority, and compiled crash invariants requiring an independent contract.

## Verification Boundary

Run `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`, `git diff --check`, and the compiled SIGKILL suite. Source acceptance does not claim registry, deployment, downstream, or production state.

## State/progress path

Progress is recorded in this plan's checked task breakdown, `tasks/notes/20260906-0500-execution-recovery.notes.md`, and the final handoff `/tmp/byok-execution-recovery-handoff.md`; the active marker is switched to this plan in the isolated worktree.

## Verification evidence

The required evidence is the 13-test compiled Node 22.22.0 SIGKILL suite with reconstructed durable SQLite/cloud authorities, plus the repository build, typecheck, full test, API-surface, version-authority, workflow, and diff checks. Evidence records exact terminal bytes, payload hashes, confirmed state, receipt body, and runtime invocation count.

## Evaluator rubric

Pass requires durable redelivery/settlement across every listed crash window, exact tenant/device/AgentRef fencing, cancellation tombstone convergence, no runtime replay, unknown executable cursor stall, and no hash-only replay claim. Any missing durable bytes or late-terminal overwrite is a failure.

## Stop condition

Stop and report to `%7` if a required gate cannot pass after three bounded fix/reverify rounds, if the existing task identity cannot prove immutable execution fencing, or if verification would require changing excluded version, lockfile, CHANGELOG, audit-log, or publication surfaces.

## Rollback surface

The merge unit is this isolated branch commit. Rollback reverts the execution-recovery commit and its generated API/docs/notes together; no migration or external production mutation is performed by this worktree.

## Merge/PR unit

One clean commit (or an explicitly split sequence with no partial cherry-pick requirement) containing only the owned recovery source, tests, generated API, docs, plan/contract/notes/review artifacts. `%7` performs integration and publication.

## Review/acceptance boundary

This worktree supplies source and real compiled restart evidence only. Coordinator's integration worktree must rerun fresh subject-bound checks after merge; this handoff does not claim registry, deployment, downstream, or production acceptance.

## High-risk surface

The high-risk invariants are terminal bytes durability and confirmation, interruption marker/report atomicity, cloud CAS fencing and cancellation races, cursor non-acknowledgement for unknown executable messages, and stale terminal rejection.

## Promotion reason

Promote only because all named crash windows and fencing invariants are covered by the compiled oracle and source checks, while the coordinator retains final integration and release authority.

## Why not checklist row

This is a cross-package behavior change with durable storage, protocol disposition, cloud authority, and compiled crash evidence; it requires a dedicated contract and review boundary rather than a checklist-only task.
