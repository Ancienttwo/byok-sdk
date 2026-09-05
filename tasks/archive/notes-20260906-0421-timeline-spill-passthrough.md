> **Archived**: 2026-09-06 04:21
> **Related Plan**: plans/archive/plan-20260906-0412-timeline-spill-passthrough.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260906-0421
> **Archive Projection V1**: `plans/plan-20260906-0412-timeline-spill-passthrough.md` => `plans/archive/plan-20260906-0412-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/notes/20260906-0412-timeline-spill-passthrough.notes.md` => `tasks/archive/notes-20260906-0421-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/contracts/20260906-0412-timeline-spill-passthrough.contract.md` => `tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md`
> **Archive Projection V1**: `tasks/reviews/20260906-0412-timeline-spill-passthrough.review.md` => `tasks/archive/review-20260906-0421-timeline-spill-passthrough.md`

# Implementation Notes: timeline-spill-passthrough

> **Status**: Active
> **Plan**: plans/archive/plan-20260906-0412-timeline-spill-passthrough.md
> **Contract**: tasks/archive/contract-20260906-0421-timeline-spill-passthrough.md
> **Review**: tasks/archive/review-20260906-0421-timeline-spill-passthrough.md
> **Last Updated**: 2026-09-06 04:18
> **Lifecycle**: notes

## Design Decisions

- Two descriptors, not one: a tool item merges one `tool_use` and one
  `tool_result`, so `inputSpill` and `outputSpill` stay separate; a single
  `spill` field would be ambiguous when both sides spilled.
- Presence is copied, never inferred: the spreads are guarded by
  `Object.hasOwn(<event>, 'spill')`, mirroring the existing `input` / `output`
  guards, so a key is absent rather than `undefined` when the source event
  carried no spill. No consumer may derive truncation from the
  `{ preview: { head, tail } }` shape.

## Per-File Changes

| File | Change |
|------|--------|
| `packages/ui-runtime/src/types.ts` | `import type { AgentEventSpill } from '@byok-sdk/protocol'`; `ToolTimelineItem` gains `readonly inputSpill?: AgentEventSpill` and `readonly outputSpill?: AgentEventSpill`, each with a one-line doc comment pointing at `docs/protocol.md` §11.6. |
| `packages/ui-runtime/src/timeline.ts` | `toolItem` (paired fold) spreads `inputSpill` / `outputSpill` from the `tool_use` / `tool_result` observations behind `Object.hasOwn(..., 'spill')`; `unpairedTool` spreads the same two behind its existing `observation.type` guards. Both items stay `Object.freeze`d. |
| `packages/ui-runtime/src/__tests__/timeline.test.ts` | Three cases: paired use+result where both events spilled (blob form on the input, `unstoredReason` form on the output) asserts both fields deep-equal the sources; unpaired `tool_result` with `spill` asserts `outputSpill` only and `Object.hasOwn(item, 'inputSpill') === false`; a paired item without spill asserts neither key is own. |
| `api-surface/ui-runtime.d.ts` | Regenerated with `node scripts/api-surface/check-api-surface.mjs --update --package ui-runtime`; 5 added lines, 0 removed. |
| `CHANGELOG.md` | Unreleased bullet for `@byok-sdk/ui-runtime`. |
| `tasks/todos.md` | Deleted the delivered "Timeline 消费者透出 spill" row; the `bin/audit-log.ts` row stays. |

## Verification

```
bun run --filter @byok-sdk/ui-runtime typecheck -> exit 0
bun run --filter @byok-sdk/ui-runtime build     -> exit 0
bun run --filter @byok-sdk/ui-runtime test      -> exit 0   (3 files, 20 tests passed)
bun run typecheck                               -> exit 0
bun run check:api-surface                       -> exit 0   (9 package golden(s) match)
git diff --check                                -> exit 0
```

Golden diff: `git diff api-surface/ui-runtime.d.ts | grep -c '^-[^-]'` = 0, `'^+[^+]'` = 5.

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
