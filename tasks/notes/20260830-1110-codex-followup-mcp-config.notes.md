# Implementation Notes: codex-followup-mcp-config

> **Status**: Active
> **Plan**: plans/plan-20260830-1110-codex-followup-mcp-config.md
> **Contract**: tasks/contracts/20260830-1110-codex-followup-mcp-config.contract.md
> **Review**: tasks/reviews/20260830-1110-codex-followup-mcp-config.review.md
> **Last Updated**: 2026-08-30 11:20
> **Lifecycle**: notes

## Design Decisions

- **The first turn's argv is stored, not recomputed.** `startPrepared` computes `codexMcpConfigArgs(startInput.mcpServers, preparedGrants)` once, uses it for the start turn, and hands the same array to `CodexSession` as `mcpConfigArgs`. `followUp` appends it verbatim after the freshly re-mapped `mapping.args`. `preparedGrants` was probed at admission and `startInput.mcpServers` is that operation's sealed authority, so any second computation could only widen or drift — a follow-up therefore cannot change this session's MCP authority.
- **Policy is still re-mapped per turn; MCP config is not.** They are different kinds of input: the policy belongs to the offer of THIS turn (and `followUp` already fails closed on a policy it cannot express), while the MCP servers and grants belong to the session's frozen admission. Mixing them — re-deriving MCP config from a follow-up payload — would be the widen path this adapter exists to prevent.
- **No behavior change when there are no MCP servers.** `codexMcpConfigArgs` returns `[]` for an empty/absent server map, so the stored array is empty and a resume argv is byte-for-byte what it was before this fix. Covered by an explicit test.

## Deviations From Plan Or Spec

- The live smoke's granted run now runs WITHOUT `--ephemeral` (that flag persists no session file, so there is nothing to resume) and its resume turn reuses the first turn's audit file, so the two turns carry byte-identical `mcp_servers.*` overrides and the resume is measured by the `tools/call` it adds. The ungranted run is unchanged.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Store the first turn's computed argv on the session | **Selected** | Byte-identical replay, single authority, no re-probe, cannot widen. |
| Recompute in `followUp` from stored servers + grants | Rejected | A second computation site that must be kept in step with the first; no benefit, and it invites deriving from follow-up input later. |
| Carry MCP servers on the follow-up payload | Rejected | Makes a follow-up able to change the session's MCP authority — the exact failure mode the admission probe exists to prevent. |

## Open Questions

- None.

## Verification

### Resume argv now emitted

For a session started with the reserved message server (fake-codex unit test, `packages/client/src/__tests__/codex-adapter.test.ts`):

```
exec resume fake-thread-1 --json --skip-git-repo-check
  -c sandbox_mode=workspace-write
  -c approval_policy=never
  --ignore-user-config
  -c mcp_servers.byokagentmessage.command="/opt/byok-agent-message-mcp"
  -c mcp_servers.byokagentmessage.args=["--stdio"]
  -c mcp_servers.byokagentmessage.env.BYOK_AGENT_MESSAGE_CONTEXT="sealed-context"
  -c mcp_servers.byokagentmessage.enabled_tools=["send_agent_message"]
  -c mcp_servers.byokagentmessage.tools.send_agent_message.approval_mode="approve"
  "follow up"
```

The MCP slice is asserted byte-identical to the first turn's. A session started with no MCP servers resumes with no `mcp_servers.*` and no `--ignore-user-config` at all (separate test).

### Falsifier (fix reverted, fixture refuses the ungranted resume)

`fake-codex.mjs` gained `FAKE_CODEX_MCP_TOOL_CALL=<server>/<tool>`: every turn "calls" that tool and fails with codex's own refusal shape unless THAT turn's argv carries `--ignore-user-config`, the server `command`, an `enabled_tools` allowlist naming the tool, and its per-tool `approval_mode="approve"`. With `followUp`'s `...this.mcpConfigArgs` removed:

```
 FAIL  src/__tests__/codex-adapter.test.ts > CodexAdapter against the fake-codex fixture > replays the first turn's exact MCP config argv on a resumed turn, so the MCP tool still resolves
RuntimeExecutionFailure: codex reported terminal task failure
 ❯ CodexProcessRunner.onEvent src/adapters/codex/codex-adapter.ts:612:37
 Test Files  1 failed (1)
      Tests  1 failed | 33 skipped (34)
```

### Required checks

```
$ bun run build
@byok-sdk/client build: ESM ⚡️ Build success in 809ms
@byok-sdk/client build: {"adapterEntryBytes":132442,"packageRoot":"…/packages/client/","status":"passed"}
@byok-sdk/client build: {"agentMemoryEntryBytes":39006,"agentMemoryEntryCeiling":49152,"rootEntryBytes":855968,"status":"passed"}
byok-sdk build: Exited with code 0
BUILD_EXIT=0

$ bun run typecheck
@byok-sdk/server:typecheck                           | Done in 483ms
@byok-sdk/testkit:typecheck                          | Done in 110ms
@byok-sdk/ui-runtime:typecheck                       | Done in 118ms
byok-sdk:typecheck                                   | Done in 112ms
TYPECHECK_EXIT=0

$ bun run test
@byok-sdk/client:test                           |  Test Files  159 passed | 2 skipped (161)
@byok-sdk/client:test                           |       Tests  1544 passed | 11 skipped (1555)
TEST_EXIT=0
```

### Live smoke (real codex-cli 0.149.0, three runs: ungranted / granted / resumed)

```
$ bun run --filter '@byok-sdk/client' smoke:codex-toolset-permission
@byok-sdk/client smoke:codex-toolset-permission: [codex-toolset-permission] codex called the projected toolset tool only with its per-tool grant, on the first turn and on a resume, global approval still never
@byok-sdk/client smoke:codex-toolset-permission: Exited with code 0
SMOKE_EXIT=0
```
