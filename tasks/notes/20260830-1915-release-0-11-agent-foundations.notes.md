# Implementation Notes: release-0-11-agent-foundations

> **Status**: Active
> **Plan**: plans/plan-20260830-1915-release-0-11-agent-foundations.md
> **Contract**: tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md
> **Review**: tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md
> **Last Updated**: 2026-08-30 19:16
> **Lifecycle**: notes

## Design Decisions

- Compose from two already accepted local branches; do not treat either branch's standalone package projection as the final release authority.
- Reuse `d8e36b6` as the version-train input, then verify its manifests and lockfile against the combined final source.
- Run exact `pack-and-smoke` once after the combined source is frozen; publication and registry readback remain separate gates.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Re-bump versions manually on the foundations branch | Rejected | It would create a second 0.11.0 release authority and risk divergence from the accepted memory train. |
| Merge the accepted memory/release line into an isolated composition branch | Selected | It preserves source ancestry and gives the combined candidate one verifiable identity without touching main or external state. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Combined release source commit: `4f76deb9558ed6ef7a6d9ac066daa007f072f292`.
- Frozen install and package graph: 9 aligned packages at `0.11.0`; `@byok-sdk/keys` remains `0.3.7`.
- Focused cross-feature guard: Pi adapter, TeamWorkspace, and memory-tool grant suites passed 47/47.
- Root gates: build, typecheck, full test, and strict task-workflow passed; client passed 1,558 tests with 11 skipped and all other workspace suites passed.
- Exact artifact evidence: `.ai/harness/runs/20260830-release-0-11-agent-foundations/artifacts/release-manifest.json` records 10 tarballs, isolated install closure, and source SHA `4f76deb9558ed6ef7a6d9ac066daa007f072f292`.
- External state: no push, npm publish, registry readback, tag, GitHub Release, deploy, downstream pin, or production rollout was performed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
