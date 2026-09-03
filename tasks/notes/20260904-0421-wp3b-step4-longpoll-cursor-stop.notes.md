# Implementation Notes: wp3b-step4-longpoll-cursor-stop

> **Status**: Verified
> **Plan**: plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md
> **Contract**: tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md
> **Review**: tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md
> **Last Updated**: 2026-09-04 04:34
> **Lifecycle**: notes

## Baseline

- Published base: WP3B Step 2 main publication `10bb9fc76b0a1ee3a533f50a42e869235c5c7bd1`; the original accepted worktree head `426c1161b76d28648d26a77bf8b6950dac16834c` was replaced by its tree-equivalent publication during closeout.
- Worktree: `/Users/kito/Projects/byok-sdk-wt-wp3b-step4-daemon-longpoll`.
- Branch: `codex/wp3b-step4-daemon-longpoll`.

## Design Decisions

- P1: the kernel mailbox and `GET /byok/events` handler own acknowledgement semantics; the client transport supplies the acknowledged position.
- P2: `getCursor: () => dedupWatermark()` sent eager `deliveredSeq` before FIFO handler settlement. The next GET irreversibly acked the row; a later `stalledAtSeq` rollback could no longer make the kernel replay it. `stop()` only flipped a boolean, so the held GET and delay timer remained live.
- P3: keep the wire shape unchanged. Long-poll sends only `ConnectionManager.cursor` (advanced after successful processing), while `deliveredSeq`, `inFlightSeqs`, and `processedSeqs` remain local duplicate suppression. Duplicate-only/no-progress reads use retry backoff. One per-start `AbortController` cancels the held GET and retry/idle delays; POST drain behavior is unchanged.

## Regression-First Evidence

- Artifact: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.pre-fix.txt`.
- Unfixed run: 4 files failed, 5 tests failed, 8 passed, `PRE_FIX_EXIT=1`.
- The in-flight offer guard passed before the source fix only after a new response counter proved the same offer was read at least twice; the pass was non-vacuous and exercised local dedup.

## Implemented Change

- `ConnectionManager.deliver()` returns whether it admitted a handler; the long-poll loop uses that only to identify duplicate-only cycles.
- Long-poll query cursor now reads the successfully processed cursor, not the eager local watermark.
- `LongPollClient` owns an AbortController per loop generation; stop and device revocation abort it. Intentional abort does not emit a route failure.
- Restored all five deferred `it.skip` guards. The Agent-home exact cursor assertion is `1`: the projection is the kernel mailbox's first and only row, and retry acknowledges that same row.
- Removed the two fulfilled Step 4 backlog rows from `tasks/todos.md`.

## Verification Evidence

- Focused regressions: 4 files, 13 tests passed.
- Full client suite: 164 files passed, 2 environment-gated files skipped; 1613 tests passed, 11 skipped.
- Revocation/stop follow-up: 3 files, 10 tests passed.
- `bun run build`: passed.
- `bun run typecheck`: passed across all workspaces.
- `bun run test`: passed across all workspaces; client 1613 passed, cloud 316, cloud-dataplane 74, conformance 156, core 252, keys 387, protocol 349, server 190, plus remaining workspace suites.
- `bun run check:api-surface`: 9 package goldens matched.
- `bun run check:version-authority`: passed for `byok-sdk@0.12.0` and `@byok-sdk/keys@0.3.9`.
- `git diff --check`: passed.
- `repo-harness run check-task-workflow --strict`: passed.
- `repo-harness run verify-contract --contract tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md --strict`: 27/27 passed; contract status `Fulfilled`.
- Exact-subject acceptance remains pending until the artifacts are finalized and committed.

## Deviations From Plan Or Spec

- No wire split was introduced: protocol §9 already requires long-poll to report the last successfully processed cursor, and the approved Step 4 write boundary excludes cloud. The split is between wire ack state and local delivery/dedup state.
- The AbortController also cancels retry/idle delays and device-revocation loops; these share the same loop lifecycle and avoid a shorter residual shutdown hold.

## Open Questions

- None for this slice. WS transport deletion and public `ConnectionState` narrowing remain separate Step 4 work.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Candidates

- Obsidian project memory: preserve the durable rule that the long-poll query cursor is an irreversible kernel ack and must never reuse an eager dedup watermark.
