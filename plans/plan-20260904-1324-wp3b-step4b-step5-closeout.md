# Plan: WP3B Step 4b + Step 5: long-poll-only daemon and documentation closeout

> **Status**: Executing
> **Created**: 20260904-1324
> **Slug**: wp3b-step4b-step5-closeout
> **Artifact Level**: work-package
> **Promotion Reason**: Owner authorized completing all remaining WP3B Sprint work, including merge, push, and PR. Step 4b changes the public client transport surface, so Step 5 documentation and API golden updates must land in the same coherent PR.
> **Verification Boundary**: full client suite, repository required checks, API/version/package-graph gates, architecture sync, exact-subject review, and GitHub CI.
> **Rollback Surface**: one PR based on the accepted Step 4a head; revert the PR as a unit because the code, public declaration golden, and current-state documentation must remain aligned.
> **Task Contract**: `tasks/contracts/20260904-1324-wp3b-step4b-step5-closeout.contract.md`
> **Task Review**: `tasks/reviews/20260904-1324-wp3b-step4b-step5-closeout.review.md`
> **Implementation Notes**: `tasks/notes/20260904-1324-wp3b-step4b-step5-closeout.notes.md`

## P1 Architecture Map

- `ConnectionManager` owns the daemon's single transport lifecycle and delivery FIFO; `LongPollClient` owns authenticated GET/POST, cancellation, and retry cadence.
- `@byok-sdk/cloud` and `@byok-sdk/server` already expose the same long-poll kernel path. No production consumer remains for the client WebSocket branch.
- Public ownership crosses `packages/client/src/index.ts`, client declaration golden, protocol route constants, current docs, and the architecture module. Historical research stays historical.
- Out of scope: wire v2, WP3A/WP4/WP5 implementation, npm release, deployment, and downstream rollout.

## P2 Concrete Trace

`createDaemonWithAdapters` constructs `ConnectionManager`; start obtains the current bearer and starts `LongPollClient`; each GET carries the last successfully processed cursor, each response updates current server capabilities and enters the FIFO handler, and outbound envelopes drain through authenticated POST. Stop/revocation aborts the active GET and delays, then performs the existing bounded outbox drain. The removed branch formerly attempted WS first, counted failures, entered `degraded`, and periodically probed WS recovery even though the reference server no longer serves WS.

## P3 Decision

- Delete the WS implementation and all retry/fallback/probe state rather than preserving aliases or compatibility flags.
- Keep one transport contract: long-poll is the normal bidirectional path, not a degraded fallback. Narrow connection state accordingly and remove WS-only configuration.
- Remove the protocol WS route constant because no runtime owns that route; retain generic codec support for byte input.
- Update current documentation and generated API goldens in the same PR. Research/proposal history may describe the superseded design but must not masquerade as current behavior.
- At 10x load the first pressure point is repeated post-cursor polling and serialized handler latency; existing bounded backoff, dedup, and cancellation remain the control surface.

## Evidence Contract

- State/progress path: `tasks/notes/20260904-1324-wp3b-step4b-step5-closeout.notes.md` and this plan's Task Breakdown.
- Verification evidence: `.ai/harness/checks/latest.json`, full client/root command output, API/version/package-graph checks, and the final GitHub exact-head checks.
- Evaluator rubric: no WS product authority remains; long-poll lifecycle/redelivery/shutdown tests pass; built declarations and current docs match the cutover; architecture queue is clear.
- Stop condition: any required cloud/server semantic change, compatibility path, wire-v2 change, or failure to preserve ack-after-processing and bounded shutdown.
- Rollback surface: revert the final Step 4b + Step 5 PR as one unit because runtime, public declarations, and current documentation are one cutover.
- Source authority: this plan, its task contract, and the WP3B design packet Step 4/5.

## Promotion Gate

- Merge/PR unit: Step 4b runtime cut plus Step 5 docs/goldens; they cannot be split without making the public source, declaration golden, or current documentation false.
- Verification boundary: full client suite, repository build/typecheck/test, API/version/package-graph/architecture/workflow checks, and zero-reference falsifiers.
- Review/acceptance boundary: one frozen commit after all local gates. Any post-review source edit invalidates the receipt and requires a new gate.
- High-risk surface: at-least-once mailbox acknowledgement, transport failure capability invalidation, revocation, and daemon shutdown drain.
- Why not checklist row: this removes a public transport and configuration surface across runtime, protocol, tests, documentation, and generated declarations.
- Rollback surface: revert the final PR; do not roll back goldens or docs independently from the runtime cutover.
- Delivery boundary: push the accepted branch, open a non-draft PR, require exact-head CI success, then merge and read back `origin/main`.
- Excluded authority: no npm publish, tag, GitHub Release, deployment, migration, or downstream rollout.

## Task Breakdown

- [x] T1 Delete client WS transport and make `ConnectionManager` long-poll-only without compatibility paths.
- [x] T2 Update tests and public types for the narrowed connection lifecycle.
- [x] T3 Update current architecture/protocol/security/example/release documentation and API goldens.
- [x] T4 Resolve the accumulated root architecture request with the refreshed architecture module and run all local gates.
- [ ] T5 Record exact-subject acceptance, push PR, wait for exact-SHA CI, merge, and refresh local/remote main.
