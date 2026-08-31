# Implementation Notes: issue-108-control-rpc-ids

> **Status**: Active
> **Plan**: plans/plan-20260901-0335-issue-108-control-rpc-ids.md
> **Contract**: tasks/contracts/20260901-0335-issue-108-control-rpc-ids.contract.md
> **Review**: tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md
> **Last Updated**: 2026-09-01 03:37
> **Lifecycle**: notes

## Design Decisions

- A request ID is the connection-local ownership key for both unary and stream operations.
- Known handlers register one unique request record before invocation and release it only when `activeRequests.get(id)` still equals that record.
- A duplicate active ID receives the stable `duplicate_request_id` protocol error and never starts another handler.
- Disconnect clears bookkeeping and aborts each tracked stream controller; unary handlers retain their existing non-cancellable public contract.
- Invalid versions and unknown methods remain immediate protocol errors and never occupy the registry.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Unified per-connection request registry | selected | The wire response-correlation namespace is shared across unary and stream methods. |
| Stream-only guard | rejected | It leaves unary/unary and cross-kind collisions possible. |
| Replacement semantics | rejected | It cannot establish which handler owns later frames or teardown. |
| Include dirty-main outbound writer changes | rejected | Outbound backpressure belongs to separate issue #109. |

## Open Questions

- Distinct long-lived IDs remain bounded only by handler lifetime; request timeouts/cancellation are intentionally outside this slice.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix failure: `tasks/notes/20260901-0335-issue-108-control-rpc-ids.pre-fix.txt`
- Audit baseline failed the authenticated duplicate stream and stream/unary collision guards with `PRE_FIX_EXIT=1`.
- Focused control server/protocol/client regression suite passed: 3 files, 54 tests; the exact contract guard passed 24 tests.
- Client typecheck/build passed after workspace dependency artifacts were built.
- Frozen-source root build, typecheck, and test passed; client reported 1568 passed / 11 skipped.
- Strict workflow and exact diff whitespace checks passed before acceptance.

## Residual Risks

- The connection registry grows with genuinely active distinct request IDs; a never-settling handler still retains ownership until disconnect.
- Outbound response/event backpressure is unchanged and belongs to #109.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
