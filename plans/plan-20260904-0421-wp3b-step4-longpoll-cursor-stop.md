# Plan: WP3B Step 4a: durable long-poll ack and cancellable stop

> **Status**: Executing
> **Created**: 20260904-0421
> **Slug**: wp3b-step4-longpoll-cursor-stop
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved the bounded next slice on 2026-09-04: long-poll read/ack separation and `LongPollClient.stop()` cancellation, including restoration of the five deferred end-to-end guards.
> **Verification Boundary**: focused client regression set, full client suite, then repository required checks.
> **Rollback Surface**: one commit on `codex/wp3b-step4-daemon-longpoll`, based on published Step 2 main `10bb9fc`.
> **Task Contract**: `tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md`
> **Task Review**: `tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md`
> **Implementation Notes**: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md`

## P1 Architecture Map

- Authority boundary: the cloud mailbox route interprets the query `cursor` as the acknowledgement from the prior read; the client must therefore send only its successfully processed cursor, not its eager delivery/dedup watermark.
- Client boundary: `LongPollClient` owns GET lifecycle and retry cadence; `ConnectionManager` owns handler FIFO, durable cursor advancement, and in-session duplicate suppression.
- Out of scope: wire/schema changes, cloud/server route changes, WS transport deletion, public `ConnectionState` narrowing, push/PR/merge/release.

## P2 Concrete Trace

`GET /byok/events?cursor=C` acknowledges through `C` in the kernel, then reads rows after `C`. Today `ConnectionManager` supplies `dedupWatermark()` (normally eager `deliveredSeq`), so the next GET can irreversibly acknowledge an envelope before `processingChain` settles. On handler failure the local cursor falls back to the earlier committed value, but the kernel has already retired the row. Separately, `stop()` only flips `running`, leaving the active GET alive for the server hold period.

## P3 Decision

- Keep the existing one-field wire contract. Split client concerns: long-poll query/ack uses the successfully processed `cursor`; `dedupWatermark`, `inFlightSeqs`, and `processedSeqs` remain local read/delivery suppression only.
- Preserve bounded polling when a non-empty replay makes no committed cursor progress; do not replace kernel authority or introduce a second ack endpoint.
- Give each active GET an `AbortController`; `stop()` aborts that GET. POST drain semantics remain unchanged because aborting an accepted outbound batch would create a different delivery ambiguity.
- At 10x load the first pressure point is repeated post-cursor replay while a handler is stalled; existing retry backoff plus duplicate suppression is the bounded control.

## Workflow Inventory

- Active plan: `plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md`
- Task contract: `tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md`
- Review: `tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md`
- Notes: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md`
- Deferred ledger: `tasks/todos.md`

## Task Contracts

- Scope authority is the contract's `allowed_paths` list.
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md --strict`.

## Evidence Contract

- State/progress path: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md`.
- Verification evidence: focused and full command results recorded in the implementation notes, with final harness snapshots under `.ai/harness/runs/`.
- Pre-fix evidence: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.pre-fix.txt` contains the named guard command and non-zero `PRE_FIX_EXIT`.
- Evaluator rubric: five formerly skipped real-kernel cases execute and pass; held GET ends promptly after stop; no protocol/cloud/server diff.
- Stop condition: any required wire/kernel change or failure to make the existing guards non-vacuous.
- Rollback surface: one commit based on published Step 2 main `10bb9fc`.

## Promotion Gate

- Merge/PR unit: one dependent Step 4a commit; this task does not push, open a PR, or merge.
- Verification boundary: focused regressions, full client suite, and all root required checks.
- Review/acceptance boundary: exact committed subject, no skipped named guards, no protocol/cloud/server diff.
- High-risk surface: at-least-once delivery acknowledgement and daemon shutdown lifecycle.
- Why not checklist row: this changes transport correctness and restores end-to-end regression authority across restart and stalled-handler paths.
- Rollback surface: revert the Step 4a commit.

## Task Breakdown

- [x] T1 Restore the five skipped redelivery guards and add a held-GET stop regression; capture pre-fix failures.
- [x] T2 Route long-poll acknowledgement through the successfully processed cursor and preserve stalled/no-progress backoff.
- [x] T3 Abort the active long-poll GET on stop without classifying intentional cancellation as an operational route failure.
- [x] T4 Run focused tests, client suite, repository required checks, review, and workflow acceptance.
