# Implementation Notes: release-0-8-1-enrollment-read-model

> **Status**: Active
> **Plan**: plans/plan-20260824-1648-release-0-8-1-enrollment-read-model.md
> **Contract**: tasks/contracts/20260824-1648-release-0-8-1-enrollment-read-model.contract.md
> **Review**: tasks/reviews/20260824-1648-release-0-8-1-enrollment-read-model.review.md
> **Last Updated**: 2026-08-24 16:48
> **Lifecycle**: notes

## Design Decisions

- Base the release worktree exactly on accepted repair commit `bd24a106c462f79764a36f30080afc81dfd6c371` so 0.8.1 has one package/version authority.
- Integrate only the public credential-blind reader, type exports, focused tests, and documentation from the earlier isolated enrollment worktree.
- Keep npm, Git source/tag, GitHub Release, downstream Salesko pin, deploy, migration, and live-device rollout as separate gates.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Publish a separate later client-only patch | Reject | It would split an already prepared aligned train and create two competing release authorities. |
| Combine enrollment with accepted 0.8.1 repair | Adopt | 0.8.1/keys 0.3.2 are unclaimed and the full combined subject can be re-frozen. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Live npm: `ancienttwo` is authenticated; aligned 0.8.1 and keys 0.3.2 returned E404 before publication.
- Focused combined gate: 6 tests, 0 failures across `authenticated-enrollment-status.test.ts` and `agent-home-idempotent-repair.test.ts`; client typecheck/build and adapter-entry check passed.
- Fresh-worktree setup required `bun install --force --frozen-lockfile` and dependency-order builds for `core`, `protocol`, and `server`; manifests and `bun.lock` remained unchanged.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
