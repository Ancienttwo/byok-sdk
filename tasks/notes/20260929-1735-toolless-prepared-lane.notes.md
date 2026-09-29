# Implementation Notes: toolless-prepared-lane

> **Status**: Active
> **Plan**: plans/plan-20260929-1735-toolless-prepared-lane.md
> **Contract**: tasks/contracts/20260929-1735-toolless-prepared-lane.contract.md
> **Review**: tasks/reviews/20260929-1735-toolless-prepared-lane.review.md
> **Last Updated**: 2026-09-29T17:50:00+0800
> **Lifecycle**: notes

## Design Decisions

- The launch attestation stays bound for a tool-less record; G3 (`preparation_launch_attestation_mismatch` for launcher-wrapped claude/codex) is unchanged.
- The offer omits `requiredToolsets`; `RequiredToolsetsSchema` (`.min(1)`) is not relaxed.
- G6: admission builds `toolsetDefinitionRevisions` from the toolsets the record names (the list the producer uses), not every configured toolset.

## Pre-fix evidence (unfixed code, base ede2db31)

Command (in `packages/client`): `npx vitest run src/__tests__/prepared-offer-lane.test.ts -t "<title>"`

- Tool-less repro (`toollessRecord()`, offer omits `requiredToolsets`): 1 failed | 57 skipped.
  `preparation_launch_attestation_mismatch: this task proved no trusted MCP launch boundary, and a preparation is counted under one` (G2 is the first gate).
- G6 regression (`binds only the toolsets the record names ...`, registry {team, unrelated}, record names team): 1 failed | 58 skipped.
  `preparation_tool_binding_digest_mismatch: the launch directory, toolset definition revisions, server argv or implementation identities this task resolved are not the ones the named preparation bound`. G6 reproduces and is a bug, not intended behavior.

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
