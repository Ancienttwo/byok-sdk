# Implementation Notes: issue-110-auth-request-deadline

> **Status**: Complete
> **Plan**: plans/plan-20260901-0411-issue-110-auth-request-deadline.md
> **Contract**: tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md
> **Review**: tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md
> **Last Updated**: 2026-09-01 04:21
> **Lifecycle**: notes

## Design Decisions

- AuthManager is the sole owner of active auth request cancellation; create-daemon composes the deadline but does not own a competing controller.
- Timeout/cancellation is a stable non-revocation error; only an actual challenge/token HTTP 401 calls `markRevoked()`.
- The response parser is enclosed by the same request race as fetch, so a stalled `Response.json()` or `safeErrorText()` cannot reach the later credential write.

## Deviations From Plan Or Spec

- No source-scope deviations. `tasks/todos.md`'s generated timestamp noise was restored before verification.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Per-request controller held through body parse | selected | Bounds both fetch and a hung `json()`/`text()` read with one authority. |
| Fetch-only AbortSignal | rejected | A mocked or non-cooperative response body can still never settle. |
| Map abort to DeviceRevokedError | rejected | Revocation is server authority from an actual 401, not a local deadline. |

## Open Questions

- None. The configured deadline applies to each pair, challenge, or token HTTP/body operation, matching GitHub #110's requirement that every auth network operation be bounded.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix regression: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.pre-fix.txt` (`PRE_FIX_EXIT=1` after four deterministic guarded hangs).
- Focused post-fix: `bun run --cwd packages/client test -- src/__tests__/daemon-auth.test.ts src/__tests__/bin-config.test.ts` (43 passed, 1 skipped); client typecheck/build and root build/typecheck/test passed.
- Independent exact-diff review found no confirmed P0-P2 issue. A first root test run observed one scope-external Cloud Dataplane packaging timeout; isolated and full-suite reruns passed without source changes.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
