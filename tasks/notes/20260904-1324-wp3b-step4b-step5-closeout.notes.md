# Implementation Notes: wp3b-step4b-step5-closeout

> **Status**: Verified
> **Plan**: plans/plan-20260904-1324-wp3b-step4b-step5-closeout.md
> **Contract**: tasks/contracts/20260904-1324-wp3b-step4b-step5-closeout.contract.md
> **Review**: tasks/reviews/20260904-1324-wp3b-step4b-step5-closeout.review.md
> **Last Updated**: 2026-09-04 13:24

## Baseline

- Parent: merged Step 4a PR #132, `main@c7c53357e138bd82f716243589157dd58cbaa038`.
- Target: `main` containing Step 3 and Step 4a.
- Branch: `codex/wp3b-step4b-step5-closeout`.

## Verification Evidence

- `repo-harness run verify-contract --contract tasks/contracts/20260904-1324-wp3b-step4b-step5-closeout.contract.md --strict`: 19/19 checks passed; contract status `Fulfilled`.
- Full client suite: 164 files passed, 2 skipped; 1603 tests passed, 11 skipped.
- Root `build`, `typecheck`, and full package test suites passed.
- API surface, version authority, package graph, strict task workflow, architecture sync, and `git diff --check` passed.
- Zero-reference falsifiers passed for WS production symbols and current-document WS claims; architecture queue reports `pending=0`, `blocking=0`.
- Gatekeeper first rejected the frozen subject because outbound-POST revocation left the last advertised server capabilities visible. `enterRevoked()` now clears them, and the real TestServer regression proves the value changes from `['approval_resolved']` to `[]` after revocation.
- Gatekeeper PASS and typed AcceptanceReceipt are bound to the corrected normalized subject at `35a871614976a7a2a0adccdcd3901f8ffef9f484`; GitHub CI and merge remain in T5.

## Implemented Change

- Removed the client WebSocket transport, WS route constant, WS URL derivation, retry/fallback/probe state, and the direct `ws`/`@types/ws` package edges.
- `ConnectionManager` now owns a single long-poll lifecycle and exports the narrowed connection state; current capabilities come only from the active poll response.
- Poll failure, stop, terminal cursor gaps, and revocation all invalidate the server capability advertisement before further capability-gated sends.
- Updated tests, current architecture/protocol/security/spec/example documentation, changelog, and public declaration goldens as one breaking cutover.

## Deviations From Plan Or Spec

- None.
