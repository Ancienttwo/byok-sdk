# Plan: Issue 105 bounded Cloud JSON ingress

> **Status**: Executing
> **Created**: 20260901-0058
> **Slug**: issue-105-json-body-limits
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #105
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly approved the next bounded security slice; unauthenticated and authenticated Cloud ingress currently buffers unbounded JSON before schema validation.
> **Verification Boundary**: Clean-base pre-fix guard, declared and streamed byte-bound tests, route parity, package/root checks, strict workflow verification, and independent acceptance.
> **Rollback Surface**: Revert the auth/messages ceiling constants, bounded-reader composition, declared-length cancellation, and regression tests together.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260901-0058-issue-105-json-body-limits.contract.md`
> **Task Review**: `tasks/reviews/20260901-0058-issue-105-json-body-limits.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md`

## Agentic Routing

- Selected route: security bugfix.
- Routing reason: attacker-controlled request bytes cross the fetch stream and JSON parser before any application-owned memory ceiling.
- Due diligence:
  - P1 map: `CloudRouteRegistry.fetch` routes public pair/challenge/token and authenticated messages handlers; all four call `readJsonBody`, while `readBoundedJsonBody` is the existing package-owned streamed byte authority.
  - P2 trace: request stream -> `c.req.json()` full retention/parse -> Zod schema -> 400/401 or message processing. An oversized or chunked body therefore consumes memory before rejection; messages authenticates first but remains unbounded after successful auth.
  - P3 decision rationale: use internal route-specific ceilings with the existing bounded reader: 16 KiB for small auth crypto DTOs and 2 MiB for messages, enough for one 1 MiB terminal document plus envelope overhead and normal batches. Keep unrelated callers unchanged, expose no runtime override, and preserve under-limit malformed status behavior.

## Workflow Inventory

- Active plan: `plans/plan-20260901-0058-issue-105-json-body-limits.md`
- Contract: `tasks/contracts/20260901-0058-issue-105-json-body-limits.contract.md`
- Review: `tasks/reviews/20260901-0058-issue-105-json-body-limits.review.md`
- Notes: `tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md`
- Checks: `.ai/harness/checks/latest.json`
- Execution isolation: `/Users/kito/Projects/byok-sdk-wt-issue-105-json-body-limits` on `codex/issue-105-json-body-limits`.

## Trade-offs

| Option | Decision | Reason |
|--------|----------|--------|
| Bound `readJsonBody` globally | rejected | Silently changes unrelated blob/board/presence/home routes without route-specific product budgets. |
| Public/configurable limits | rejected | Expands API and lets a deployment accidentally reopen the memory boundary. |
| Internal auth/messages ceilings | selected | Names the resource policy at the routes in issue scope and reuses one stream-counting implementation. |
| Rely on `Content-Length` | rejected | It is absent for chunked bodies and can lie; it is only an early rejection hint. |

## Scale Boundary

At 10x concurrent ingress, peak retained bytes are bounded by each route ceiling plus the reader's one bounded copy. The first remaining pressure point is aggregate concurrency, which belongs to edge/request concurrency controls; this slice removes the unbounded per-request multiplier without inventing a global scheduler.

## Task Breakdown

- [x] Freeze a clean-base oversized streamed-body guard and non-zero artifact.
- [x] Compose bounded reads into pair, challenge, token, and messages with stable 413 responses.
- [x] Cancel declared-over-limit streams before returning and keep streamed byte counting authoritative.
- [x] Cover exact-limit, plus-one, malformed under-limit, chunked/lying length, concurrency, and normal routes.
- [ ] Run focused, package/root, strict workflow, and independent acceptance gates.

## Evidence Contract

- **State/progress path**: `tasks/current.md`, this plan's `## Task Breakdown`, and `tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md`.
- **Verification evidence**: clean-base failing artifact, focused Vitest results, package/root build and typecheck output, strict workflow report, and a typed `AcceptanceReceipt`.
- **Evaluator rubric**: reject oversized declared and streamed bodies with 413 before JSON parsing or route side effects; preserve exact-limit, malformed-under-limit, authentication-order, and valid-route semantics; keep changes inside the declared file scope.
- **Stop condition**: stop only after all task-breakdown rows are evidenced, the independent gate passes, the final receipt verifies, and repo-harness reports the work package ready to stop.
- **Rollback surface**: revert the route ceilings, bounded-reader cancellation change, four route compositions, and the regression test as one local unit.
- Pre-fix guard must show an over-limit body reaches existing schema/auth behavior instead of 413.
- Fixed tests must distinguish early declared-length rejection from streamed overflow and prove the producer is cancelled before all chunks are retained.
- Exact-limit input is not 413; limit-plus-one is 413; malformed under-limit remains 400.
- Existing auth and messages valid-path suites remain green.
- No edits to protocol schemas, server package, unrelated Cloud routes, deploy, or external infrastructure.

## Promotion Gate

- **Verification boundary**: the exact isolated-worktree diff plus focused Cloud tests, Cloud package build/typecheck, root required checks, strict workflow verification, and independent read-only review.
- **Review/acceptance boundary**: one gatekeeper evaluates the frozen diff and records one typed acceptance receipt; no second review is implied.
- **High-risk surface**: attacker-controlled auth/messages request streams, cancellation semantics, authentication ordering, and peak per-request memory retention.
- **Why not checklist row**: promotion is a release-authority boundary, not implementation work; it stays declarative because merge, push, PR, issue close, publish, deploy, and production mutation are outside this approval.
- **Merge/PR unit**: complete #105 Cloud request-body boundary.
- **Rollback surface**: shared reader, four route compositions, and tests.
- **Review boundary**: exact final diff plus typed AcceptanceReceipt.
- **Not authorized**: merge, push, PR, issue close, publish, deploy, or production mutation.
