# Plan: Codex local team automatic notification relay

> **Status**: Approved
> **Created**: 20260906-0107
> **Slug**: team-codex-relay
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly instructed implementation after native capability probes and Claude review.
> **Verification Boundary**: Source tests, root checks, two real Codex sessions with one automatic room round trip, independent existing tmux Claude review. Not release or full three-harness acceptance.
> **Rollback Surface**: Revert relay/snapshot/CLI/doc additions; existing workspace messages and receipts remain intact.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-05_cross-harness-probe.md`
> **Task Contract**: `tasks/contracts/20260906-0107-team-codex-relay.contract.md`
> **Task Review**: `tasks/reviews/20260906-0107-team-codex-relay.review.md`
> **Implementation Notes**: `tasks/notes/20260906-0107-team-codex-relay.notes.md`

## Goal

Deliver a foreground `team relay` command for one room and exactly two explicitly registered operator-owned Codex sessions. Peer post triggers a fixed metadata-only Codex queue notification; the target reads/posts/acks through the existing Team MCP. No per-message manual notification.

## Agentic Routing

Codex implements on isolated `codex/team-codex-relay` worktree at base f993f8e. Existing tmux Claude %6 reviewed the narrow plan and will independently accept the final implementation. No concurrent writers.

## P1: Architecture Map

TeamWorkspace owns durable messages, membership, leases, delivered and ack. Add a read-only authenticated `team_notifications.snapshot` RPC to this authority; no model tool or cloud wire changes. Foreground CLI owns this relay's polling, ephemeral watermarks, budget and pause/stop. Native Codex owns sessions and queue execution. Operator owns registering the exact endpoint/UUID and configuring its matching member MCP grant. The relay does not launch/adopt processes, acquire AgentHome execution leases, or inspect screens.

## P2: Concrete Trace

Existing MCP post → authenticated daemon control → workspace atomic fsync → read-only snapshot validates lease and finds latest foreign message after max(ack, explicit start watermark, accepted notification watermark) → Codex queue CLI with exact loopback/Unix endpoint and UUID → native MCP read/reply/ack. Queue accepted is not model completion. Snapshot never advances delivered or ack. A queue attempt counts against budget before execution; any timeout/nonzero/malformed receipt halts with unknown delivery, never retries.

## P3: Decision

Reuse message authority and native queue, add only the missing local binding. Session/process/home lifecycle is out of scope because these sessions are operator-owned and already running. Binding identity is an explicit operator assertion, not a cwd/title heuristic. One foreground room lock prevents concurrent relay instances; stale ownership is fail-closed and never automatically stolen. No persistent secondary message cursor or retry authority. Across restart, operator explicitly chooses afterSeq from prior status/receipts; no exactly-once or automatic recovery claim.

At 10x traffic, snapshot scans the existing quota-bounded room, notifications coalesce by latest foreign seq and total attempts are capped. Future indexed storage/lease renewal/multi-room/Pi/Claude are separate contracts.

## Detailed Design

Private JSON binding file: version 1, exactly two bindings with opaque context, exact threadId, explicit local endpoint, and required nonnegative afterSeq. CLI also requires an absolute Codex executable and finite max-notifications. Validate both leases and room/member identities before any enqueue. Reject expired/revoked grants, remote endpoints, duplicate members/threads, malformed files/receipts and stale locks. Logs/status contain metadata only, never opaque context, credential or message body.

Pause/resume/status/stop are explicit foreground stdin commands; SIGINT/SIGTERM stop. Pause prevents further calls after any pending snapshot; already submitted native queue work cannot be recalled. The budget cannot be reset by resume. Whole-process restart is a new explicit operator epoch, not silent replay.

Claude planning review accepted the scope with eight evidence conditions. Keep member-lease snapshot in this slice to enforce the same grant expiry/revocation as the helper; the owner-only relay is already an operator control client, whose existing join surface can mint member grants. Context never enters argv or logs. An operator-only descriptor design would need a new independently validated grant-reference contract, deferred here. Keep requested pause/resume. Pin preflight to the qualified Codex CLI 0.153.4; no version fallback. Delivery is deliberately described as unknown-on-error, not a guaranteed at-least-once service.

The Codex-specific code stays under client/bin because this is the existing local operator CLI and control-client owner; no new package or TaskRunner ownership is introduced. This does not settle the concurrent public-package-topology plan. The additive exported workspace method requires refreshing api-surface/client.d.ts.

## File Changes

- packages/client/src/daemon/team-workspace.ts: read-only notification snapshot.
- packages/client/src/daemon/control-protocol.ts and create-daemon.ts: exact snapshot RPC.
- packages/client/src/bin/team-codex-relay.ts and commands/team-relay.ts: native queue transport, private bindings, serialized relay, lifecycle/lock.
- packages/client/src/bin/byok-agent.ts: CLI registration/help.
- packages/client/src/__tests__/team-codex-relay.test.ts: new behavior and read-only invariants; existing team-workspace.test.ts remains unchanged and is re-run.
- docs/spec.md, docs/architecture/sdk-architecture.md, packages/client/README.md: contract and usage.
- docs/researches/evidence/2026-09-05-cross-harness/: three probe corrections, real loop driver/evidence.
- plans/plan-20260905-2239-tmux-cross-harness-collaboration.md: stale table footnote.
- This plan's contract/notes/review/current/todos and generated capability architecture context.

## Workflow Inventory

Active plan and contract are this slice in the isolated worktree; main's provider-catalog active marker remains untouched. Required checks: build/typecheck/test/API/version/strict workflow. Prior probe acceptance does not replace source verification. No push, merge, publish or global configuration update.

## Task Breakdown

- [x] P1/P2/P3, operator scope and existing Claude planning review.
- [x] Fix three non-blocking probe issues.
- [x] Implement snapshot, relay and CLI.
- [x] Focused negative/race tests and two-session automatic room smoke.
- [x] Root checks and independent tmux Claude acceptance; address findings.
- [x] Record exact outcome and remaining capability boundaries.

## Promotion Gate

- **Merge/PR unit**: one isolated source slice; no merge or push in this execution.
- **Rollback surface**: remove relay and additive snapshot, preserving existing room state.
- **Verification boundary**: targeted tests, built-CLI two-session smoke, root required checks.
- **Review/acceptance boundary**: existing tmux Claude accepts this Codex slice, not all harnesses or release.
- **High-risk surface**: private member grants and automatic native queue calls; explicit binding, metadata-only argv and bounded attempts.
- **Why not checklist row**: new public CLI/control surface with asynchronous notification lifecycle.

## Evidence Contract

- **State/progress path**: this plan, corresponding contract/notes/review.
- **Verification evidence**: source checks in notes and redacted relay-smoke-results.json with offline verifier.
- **Evaluator rubric**: no receipt writes in snapshot; no self notification; exact thread receipts; both peers read and ack; finite attempt budget; no manual notification after seed; paused relay does not queue.
- **Stop condition**: unknown queue delivery, grant failure, rejected review, or three unsuccessful fixes for one issue.
- **Rollback surface**: isolated branch; no message-state migration or native process ownership change.

Final source outcome: Claude A PASS; all required checks passed after one unchanged root-test recheck (initial unrelated Wrangler timeout retained). Two-Codex smoke and source fingerprints remain valid. No merge or release.
