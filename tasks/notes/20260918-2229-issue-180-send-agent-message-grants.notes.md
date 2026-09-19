# Implementation Notes: issue-180-send-agent-message-grants

> **Status**: Active
> **Plan**: plans/plan-20260918-2229-issue-180-send-agent-message-grants.md
> **Contract**: tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md
> **Review**: tasks/reviews/20260918-2229-issue-180-send-agent-message-grants.review.md
> **Last Updated**: 2026-09-18 23:10
> **Lifecycle**: notes

## Design Decisions

- Claude consumes the whole reserved table (`resolveReservedMcpToolGrants(input.mcpServers)`) instead of the memory-only slice, matching codex's unfiltered call; the memory-only filter predates the table gaining the message server.
- Pi's grant surface is the `--tools` registry allowlist (the fork's `_refreshToolRegistry` filters extension-registered tools through the same `allowedToolNames` set as builtins), so the reserved bare name rides whatever allowlist the mapper emits; `auto` without `allowTools` emits none by design (undefined allowlist admits extension tools; emitting a reserved-only list would cage pi's native defaults). `readonly` + `allowTools: []` + message server emits `--tools send_agent_message` rather than `--no-tools`, keeping the lane explicit instead of relying on pi's new-registry-name activation bookkeeping.
- `resolvePiNativeToolSelection` deliberately does NOT thread reserved grants: it resolves the native set a prepared session binds; reserved tools register via the extension, never as natives.
- `bin/pi-rpc-host.ts` drift gate re-derives the expected flags from `mapPermissionPolicyToPiArgs(config.policy, resolveReservedMcpToolGrants(config.mcp.mcpServers))` — same table, same config the child holds — so the gate stays a projection-equality test after the adapter began folding reserved grants in. Verified against the real child: flags omitting `send_agent_message` are refused; the exact projection starts RPC through the live session_start observe.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Pi: grant via `--tools` bare name vs a new reserved-only flag | bare name in the allowlist | pi has no permission-pre-grant surface; the allowlist IS the registry filter the fork applies to extension tools |
| Pi: emit `--no-tools` for readonly+empty allowTools with message server | `--tools send_agent_message` | explicit lane admission beats depending on pi's new-registry-name activation path |
| Host drift gate: accept adapter flags unverified vs re-derive from config | re-derive | policy alone no longer reproduces the projection; unverified acceptance would dissolve the gate |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix failure artifact: `tasks/runs/20260918-2229-issue-180-prefix-failure.txt`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Report-only observation (kept here, not fixed — outside this task's surface): pi readonly `--tools` base list (`read,grep,find,ls,subagent,todo`) does not name QUALIFIED host-toolset tools (e.g. `mcp__docs__search_docs`) that the extension registers, so under readonly a projected host toolset's qualified names may be dropped by the registry filter unless operators list them in `allowTools`. Deserves its own issue if confirmed.
