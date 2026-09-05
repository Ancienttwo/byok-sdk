# Implementation Notes: audit-log-spill-size

> **Status**: Active
> **Plan**: plans/plan-20260906-0433-audit-log-spill-size.md
> **Contract**: tasks/contracts/20260906-0433-audit-log-spill-size.contract.md
> **Review**: tasks/reviews/20260906-0433-audit-log-spill-size.review.md
> **Last Updated**: 2026-09-06 04:40
> **Lifecycle**: notes

## Design Decisions

- Write side (`packages/client/src/bin/audit-log.ts`, `redactAgentEvent`): when a
  `tool_use`/`tool_result` carries `spill`, the record is
  `{ type, tool, inputSize: spill.totalBytes, inputSpilled: true }` (symmetric
  `outputSize`/`outputSpilled`). The spill locator (`blob`, `blobId`,
  `contentHash`) and `unstoredReason` are never written — only the pre-spill
  size and a boolean. Unspilled events keep the `valueByteSize` branch verbatim.
- `placeholderFor(size, spilled?)` gained an optional second parameter rendering
  `[redacted: N bytes, spilled]` (and `[redacted, spilled]` when size is
  undefined); the unspilled strings are unchanged.
- Read side (`reconstructAgentEvent`) feeds `bool(r.inputSpilled, false)` /
  `bool(r.outputSpilled, false)` — the module's existing coercion helper, no new
  one needed — into `placeholderFor`, so a legacy line with no flag reconstructs
  exactly as before.
- Tests (`packages/client/src/__tests__/bin-audit-log.test.ts`, +3 cases in the
  "finding P1 #3" describe): blob-form spill, `unstoredReason`-form spill, and
  an unspilled control. The blob case asserts the raw JSONL line contains
  neither the locator, `contentHash`, the substring `spill`, nor the preview
  bytes; the taskIds are `task-big-output` / `task-unstored` precisely so the
  `not.toContain('spill')` assertion is not satisfied by the taskId itself.
- Docs: CHANGELOG Unreleased gained one `@byok-sdk/client` bullet; the
  `bin/audit-log.ts` spill-size row was removed from `tasks/todos.md`.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Verification (verbatim exit lines, 2026-09-06)

```
$ bun run --filter @byok-sdk/client typecheck
@byok-sdk/client typecheck: Exited with code 0

$ bun run --filter @byok-sdk/client build
@byok-sdk/client build: ESM ⚡️ Build success in 812ms
@byok-sdk/client build: {"adapterEntryBytes":150063,"packageRoot":"/Users/kito/Projects/byok-sdk-wt-audit-log-spill-size/packages/client/","status":"passed"}
@byok-sdk/client build: {"agentMemoryEntryBytes":39086,"agentMemoryEntryCeiling":49152,"rootEntryBytes":951981,"status":"passed"}
@byok-sdk/client build: Exited with code 0

$ bun run --filter @byok-sdk/client test -- bin-audit-log
@byok-sdk/client test:  Test Files  1 passed (1)
@byok-sdk/client test:       Tests  32 passed (32)
@byok-sdk/client test: Exited with code 0

$ bun run --filter @byok-sdk/client test
@byok-sdk/client test:  Test Files  169 passed | 2 skipped (171)
@byok-sdk/client test:       Tests  1673 passed | 11 skipped (1684)
@byok-sdk/client test: Exited with code 0

$ bun run check:api-surface
$ node scripts/api-surface/check-api-surface.mjs
api-surface: 9 package golden(s) match the built declarations
EXIT=0

$ git diff --check
EXIT=0
```

No `client` api-surface drift, so no golden regeneration was needed.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
