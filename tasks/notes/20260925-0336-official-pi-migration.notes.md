# Implementation Notes: official-pi-migration

> **Status**: Active
> **Plan**: plans/plan-20260925-0336-official-pi-migration.md
> **Contract**: tasks/contracts/20260925-0336-official-pi-migration.contract.md
> **Review**: tasks/reviews/20260925-0336-official-pi-migration.review.md
> **Last Updated**: 2026-09-25 03:44
> **Lifecycle**: notes

## Design Decisions

- ...

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## Current checkpoint

Read prior PRs #210–#213 at `a64d86915d5e62a4c43786801f31441027ce069f`; reused unchanged P08 and harness in `/tmp/byok-official-public-surface.6Vg9nI`. Exact official coding-agent and pi-ai 0.87.1 roots imported. P08 execution checks pass, capability **partial**, five requested exports absent. Static assistant declarations still require provider provenance; runtime history behavior was not rerun. Product cutover remains blocked and no full migration acceptance is claimed.

Required baseline checks, after report scope freeze: build, typecheck, test, API surface, version authority and strict task workflow all EXIT 0. Full tests: **5461 passed, 141 skipped**. These run against unchanged fork-based production source at `3dd7ba6f`, not an official-runtime candidate. No official package/release smoke is claimed.

| Log | SHA-256 |
| --- | --- |
| `/tmp/byok-official-migration-build.log` | `f06d2ac80b7e84d058c501daff5832e5d4a5a63e6db46d6379a9cb717460b59d` |
| `/tmp/byok-official-migration-typecheck.log` | `e49652d3981768dabfc26ca8381fc7323192d7099f2f2e22952aabe26767abc9` |
| `/tmp/byok-official-migration-test.log` | `59b33cf24323639cccad0419d5ad21fa41a579831ce2c88fca5f660f3fe96d89` |
| `/tmp/byok-official-migration-api.log` | `9b8f2b5181f563105bd2efe1218023535d4126196fe554c12f332dc5b77ecbe5` |
| `/tmp/byok-official-migration-version.log` | `14d3addc3bf5d6ff4e564420e9a5e1720d52051f2b928e381f6f36cda7974a14` |

The upstream PR question is pending. No external upstream submission, fork edit, publication, merge or deployment has occurred. SDK PR #228 is already pushed at `67a4709c`; its own hosted checks are independent. The local Host SummaryJob scaffold stays uncommitted and unverified behind this prerequisite.
