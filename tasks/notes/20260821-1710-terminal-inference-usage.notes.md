# Notes: terminal-inference-usage

> **Status**: Complete
> **Plan**: `plans/plan-20260821-1710-terminal-inference-usage.md`

## Runtime evidence

- Codex maps the real `turn.completed.usage` observation before `turn_end` and
  does not synthesize a total (`packages/client/src/adapters/codex/events.ts`).
- Claude maps its terminal `result.usage` before `turn_end` or terminal error;
  cache creation is intentionally not conflated with cached input
  (`packages/client/src/adapters/claude/events.ts`).
- Pi's current RPC message contract exposes neither token usage nor a terminal
  provider/model observation. It therefore omits `TerminalInferenceUsage`
  rather than fabricating a usage fact from runtime, release version, or
  device duration.

## Semantic pin

`TerminalInferenceUsage` is the last normalized usage observation seen before
the winning local terminal signal for one task run. It is not a cumulative
counter across events or retries, and it is not an accounting or billing fact.
The cloud first-terminal receipt is separately first-write-wins; its typed
projection preserves the exact winning terminal value.

## Verification evidence

- Protocol tests cover each terminal variant, legacy omission, exact codec
  roundtrip, all specified bounds/rejections, and the frozen-v1 golden.
- Client tests prove last-observed Codex/Claude semantics, Pi omission without
  a native usage event, and `create-daemon` composition of U4a's frozen
  `localAgentRelease.version`.
- Cloud tests prove every terminal projection and preserve the first terminal's
  usage through a later conflicting terminal.
- `bun run build`, `bun run typecheck`, and `bun run test` pass. After the
  repository-owned harness layout was materialized, strict workflow passed and
  `repo-harness run verify-contract --strict` reported `total=11 failed=0
  status=Fulfilled`.
