# Implementation Notes: wp3b-ci-smoke-longpoll-status

> **Status**: Active
> **Plan**: plans/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md
> **Contract**: tasks/contracts/20260904-1428-wp3b-ci-smoke-longpoll-status.contract.md
> **Review**: tasks/reviews/20260904-1428-wp3b-ci-smoke-longpoll-status.review.md
> **Last Updated**: 2026-09-04 14:29
> **Lifecycle**: notes

## Verification Evidence

- Pre-fix `bun run --filter @byok-sdk/client smoke:adapters`: failed after 20 seconds waiting for deleted `daemon.status().degraded`.
- Corrected built smoke: passed all three adapter task lifecycles plus root/descendant/grandchild cancellation disposal.
- Focused real-cloud long-poll test: 3/3 passed.
- Strict contract: 16/16 passed, including root build, typecheck, full tests, API surface, version authority, workflow, architecture, and diff checks.

## Design Decisions

- The built smoke must consume `DaemonStatus.connected`, the same public fact used by current integration tests.
- Remove obsolete WS threshold/retry keys rather than leaving ignored configuration in executable CI code.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Restore `degraded` compatibility status | Rejected | Reintroduces the removed transport authority. |
| Wait for `connected` and retain server machine readback | Selected | Uses the current public contract and preserves an independent server-side observation. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix local command: `bun run --filter @byok-sdk/client smoke:adapters` timed out at `daemon long-poll transport` after 20000ms.
- GitHub pre-fix jobs: credential isolation audit and built adapter lifecycle smoke on Ubuntu failed on PR #133 exact head.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
