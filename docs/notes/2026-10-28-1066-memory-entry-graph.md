# #1066 memory entry graph contract alignment

Base: `7037f57c2cde6e460e7bbd329b92a220ef954bb3`.
Parent evidence: `/tmp/byok-final-composite-test.log`,
`agent-memory-entry-constraints.test.ts:101`: actual 20 modules versus expected
19; the sole additional path is `sdk-reserved-mcp.ts`.

## Boundary trace and decision

`agent-memory/index.ts` exports the memory MCP server and its two tool names
from `bin/agent-memory-mcp-server.ts`. That module now imports the canonical
`memory_recall` / `memory_save` constants from `sdk-reserved-mcp.ts` and uses
them in both tool definitions and dispatch. Codex's reserved MCP grant helper
independently imports the fixed tool table from the same authority; the name
module does not import that adapter back into the memory entry.

The entire shared module has no imports or dynamic loads. It contains string
constants, locally allocated frozen name tables and a pure membership function.
There is no I/O, process spawn, external-state mutation, credential access,
daemon composition or transport dependency. Existing memory tool values and
entry exports are unchanged. This is canonical-name reuse within the embedded
memory boundary, not an implementation defect to mask by relaxing its guard.

The test therefore adds only `sdk-reserved-mcp.ts` to its sorted exact module
list, with the reason beside that assertion. Graph walking and equality remain
unchanged; all forbidden-module/symbol, credential, public-export, projection
and platform assertions remain unchanged. No arbitrary-module allowance or
external dependency exception is added. No production file changes.

## Verification handoff

Only static tracing and `git diff --check` performed here; no build, typecheck
or tests run. Parent/p3 owns cherry-pick into #1066 and final composite checks.
Targeted command after the parent build, from `packages/client`:

```sh
bun run test -- src/__tests__/agent-memory-entry-constraints.test.ts
```

The source review does not substitute for that test or built-entry/API checks.
Other failures in the supplied composite log are outside this exact slice.
