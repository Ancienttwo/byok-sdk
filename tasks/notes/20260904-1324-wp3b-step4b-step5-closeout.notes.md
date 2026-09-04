# Implementation Notes: wp3b-step4b-step5-closeout

> **Status**: Executing
> **Plan**: plans/plan-20260904-1324-wp3b-step4b-step5-closeout.md
> **Contract**: tasks/contracts/20260904-1324-wp3b-step4b-step5-closeout.contract.md
> **Review**: tasks/reviews/20260904-1324-wp3b-step4b-step5-closeout.review.md
> **Last Updated**: 2026-09-04 13:24

## Baseline

- Parent: merged Step 4a PR #132, `main@c7c53357e138bd82f716243589157dd58cbaa038`.
- Target: `main` containing Step 3 and Step 4a.
- Branch: `codex/wp3b-step4b-step5-closeout`.

## Verification Evidence

- Pending implementation and exact-subject gate.

## Implemented Change

- Removed the client WebSocket transport, WS route constant, WS URL derivation, retry/fallback/probe state, and the direct `ws`/`@types/ws` package edges.
- `ConnectionManager` now owns a single long-poll lifecycle and exports the narrowed connection state; current capabilities come only from the active poll response.
- Updated tests, current architecture/protocol/security/spec/example documentation, changelog, and public declaration goldens as one breaking cutover.

## Deviations From Plan Or Spec

- None.
