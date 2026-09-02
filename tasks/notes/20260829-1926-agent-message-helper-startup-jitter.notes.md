# Implementation Notes: agent-message-helper-startup-jitter

> **Status**: Active
> **Plan**: plans/plan-20260829-1926-agent-message-helper-startup-jitter.md
> **Contract**: tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md
> **Review**: tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md
> **Last Updated**: 2026-08-29 19:26
> **Lifecycle**: notes

## Design Decisions

- Preserve a single exact helper attempt and the existing `initialize` plus `tools/list`
  identity proof. Only the bounded startup window changes from three to ten seconds.
- Do not cache a prior helper proof: a replaced single-file executable must still be
  revalidated on the next task.
- Do not retry or fan out helper processes. A genuinely broken helper remains one bounded
  pre-claim failure with no runtime or message side effect.
- Retire the unpublished RC1 candidate and advance the complete immutable prerelease train
  to RC2 before any registry write.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Cache successful helper preflight | Rejected | On-disk executable replacement could make the cached proof stale. |
| Retry after timeout | Rejected | It can leave overlapping helper children and changes one failure into process fan-out. |
| Ten-second single attempt | Accepted | Absorbs observed single-file/macOS startup jitter while remaining bounded and fail closed. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix: `tasks/evidence/20260829-1926-agent-message-helper-startup-jitter-pre-fix.log`
- Production failure: exact resume task reached the bound device and declined before claim with
  `helper handshake timed out after 3000ms`; no runtime or Agent message side effect occurred.
- Same-binary probe: twenty exact installed-helper handshakes completed in 167-321ms after the
  failure, proving the helper identity was not durably broken.
- Focused regression: 3 pass / 0 fail; delayed exact helper completed after the old boundary.
- Required BYOK gates: release graph, build, typecheck and full test pass. One unchanged Wrangler
  packaging test exceeded its five-second deadline once, then passed alone and in the full rerun;
  no out-of-scope source was changed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
