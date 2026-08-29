# Implementation Notes: readonly-toolset-mcp-grant

> **Status**: Active
> **Plan**: plans/plan-20260830-0302-readonly-toolset-mcp-grant.md
> **Contract**: tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md
> **Review**: tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md
> **Last Updated**: 2026-08-30 03:03
> **Lifecycle**: notes

## Design Decisions

- **The tool names come from a new `tools/list` observation, not from the registry.** The plan assumed `McpToolsetRegistry` already performed `tools/list` for readiness. It does not: it validates `command`/`args`, and its lifecycle states (`installed`/`ready`/`degraded`/…) are *host-reported* observations (`McpToolsetRegistry.report`), never derived by the SDK. The only existing handshake was `preflightAgentMessageMcp`, for the reserved message helper. So `daemon/mcp-tools-probe.ts` generalizes that handshake, `TaskRunner` runs it for every projected toolset server before `adapter.prepare()`, and the result travels as a new `mcpToolsetTools` field on both `RuntimeAdapterPrepareInput` and `RuntimeOperationStartInput`. `preflightAgentMessageMcp` now sits on top of the shared prober (label `helper`, so its error text is unchanged) instead of carrying a second copy.
- **A separate start-input field, not an extra key on `McpStdioServerConfig`.** That type is also the host-facing `DaemonConfig.mcpToolsets` shape (which rejects any key but `command`/`args`) and it is written verbatim into claude's generated `--mcp-config`. Keeping the observation beside the servers keeps configuration non-authoritative over grants and keeps the generated config file exactly what the CLI understands.
- **A projected server that cannot be observed is declined pre-claim, retryably.** Without names there is no grant, and without a grant the toolset is uncallable on both runtimes — so this is an inexpressible policy, not a smaller one. Retryable because a server that cannot start right now may start later, matching the workspace-busy declines beside it.
- **Claude grants under `readonly` AND `auto`; `confirm`/`plan` deliberately do not.** Live-probed against 2.1.251: `acceptEdits` auto-denies `mcp__saleskoprobe__echo` exactly like `default` does (`permission_denials` populated), so `auto` needed the same fix or it would have kept a silent, differently-shaped version of the same defect. `confirm` must not pre-grant — its `--permission-prompt-tool` channel is the human decision the caller asked for. `plan` must not pre-grant — this SDK cannot know whether an opaque host toolset tool mutates, and plan mode's contract is that the mutating call never runs.
- **One codex mechanism, generalized, not a second one.** `probeCodexReservedAgentMessageApproval` (commit `9110878`) split into `requireCodexPerToolApprovalSupport` (the ≥ 0.149 version gate, once per prepare) and `probeCodexMcpToolApproval` (the `codex mcp get … --json` read-back, once per server), driven for the reserved helper and every projected toolset server alike. `codexMcpConfigArgs` composes `enabled_tools` + per-tool `approval_mode="approve"` through one helper for both.
- **Tool names are validated before they can become argv.** `mcp-tools-probe.ts` rejects any reported name outside `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`. A comma would forge extra `--allowedTools` entries; a dot or quote would forge a different `-c mcp_servers.….tools.<tool>.…` key.
- **Both adapters re-check at `start()`.** The grant is frozen at admission, so `startPrepared` recomputes it from the start input and fails closed on any difference, mirroring the existing model-selection re-check.

## Deviations From Plan Or Spec

- Plan/brief said the registry "already performs `tools/list`". It does not — see the first design decision. The `Data Flow` line still holds end to end; only the producer is new code rather than an existing observation.
- `APPROVAL_MCP_SERVER_NAME` moved from `adapters/claude/claude-adapter.ts` to `sdk-reserved-mcp.ts` (re-exported from its original path, so the public surface is unchanged) so `RESERVED_MCP_SERVER_NAMES` is one list read by both the registry's host-config rejection and the adapters' "never treat a reserved server as a projected one" rule.
- `packages/client/README.md` also drops a stale sentence claiming toolset offers for Codex are declined; both `CodexAdapter` and `PiAdapter` have declared `mcpToolsets: true` since before this task.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Per-tool grant from an observed `tools/list` | **Selected** | Exact; no widening; reuses `9110878`'s mechanism on codex. Costs one extra short-lived MCP child per projected server per task. |
| Server-scoped wildcard (`--allowedTools mcp__<server>`, codex `default_tools_approval_mode`) | Rejected | The claude form was never verified; codex's `default_tools_approval_mode="auto"` was live-verified INEFFECTIVE under `approval_policy=never` on 0.149.0 (downstream Gate 0). Both would silently grant tools a server adds later. |
| Make the observation an optional dep with no default | Rejected | A host that forgot to wire it would silently project toolsets the model can list and never call — the exact defect being fixed. It defaults to the real prober; only tests inject a stub. |
| Grant under `confirm`/`plan` too, for uniformity | Rejected | Would bypass confirm's human decision, and would let plan mode execute an opaque MCP tool. Documented in `adapters/claude/permission-mapping.ts`. |

## Open Questions

- None.

## Verification

### Falsifier (run BEFORE touching adapter code, per the contract)

Real CLIs, real one-tool stdio echo server, `mkdtemp` cwd, nothing near `~/.salesko`/`~/.codex`/`~/.claude`.

```
codex-cli 0.149.0, non-reserved server "saleskoprobe":
  codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check
    -c sandbox_mode=read-only -c approval_policy=never
    -c mcp_servers.saleskoprobe.command=… -c mcp_servers.saleskoprobe.args=[…]
    -c mcp_servers.saleskoprobe.enabled_tools=["echo"]
    -c mcp_servers.saleskoprobe.tools.echo.approval_mode="approve"
  EXIT=0; audit: spawn, initialize, tools/list, tools/call{"text":"gate"}
  item.completed mcp_tool_call status "completed" -> "gate0-echo:gate"

claude 2.1.251, readonly argv + one flag:
  -p --input-format stream-json --output-format stream-json --verbose
  --permission-mode default --tools "" --mcp-config … --strict-mcp-config
  --allowedTools mcp__saleskoprobe__echo
  EXIT=0; system.init tools: ["mcp__saleskoprobe__echo"] (no built-ins)
  permission_denials: []; result "gate0-echo:gate"; audit reached tools/call

claude 2.1.251, SAME config under --permission-mode acceptEdits, NO grant:
  permission_denials: [{tool_name:"mcp__saleskoprobe__echo",…}]
  audit: spawn, initialize, tools/list -- no tools/call
  -> `auto` was broken the same way `readonly` was; both take the grant.
```

Both falsifier directions hold: neither runtime ignores the grant, and neither
runtime permits the call without it.

### Live smokes (real CLIs, both directions, added by this task)

```
$ node scripts/claude-toolset-permission-smoke.mjs
[claude-toolset-permission] claude called the projected toolset tool only with --allowedTools, built-ins still empty

$ node scripts/codex-toolset-permission-smoke.mjs
[codex-toolset-permission] codex called the projected toolset tool only with its per-tool grant, global approval still never
```

### Contract commands (this worktree)

```
$ bun run build
BUILD_EXIT=0

$ bun run typecheck
TYPECHECK_EXIT=0        (15 packages, all Done)

$ bun run test
@byok-sdk/client:test   Test Files  155 passed | 2 skipped (157)
@byok-sdk/client:test        Tests  1481 passed | 11 skipped (1492)
@byok-sdk/cloud:test         Tests  226 passed (226)
@byok-sdk/cloud-dataplane:test  1 failed (worker-packaging wrangler dry-run,
                                Test timed out in 5000ms on a cold first
                                wrangler invocation; passes on re-run:
                                "Test Files 1 passed / Tests 6 passed")
```

A second full `bun run test` pass hit two 30s timeouts in
`src/__tests__/skill-pack-install.test.ts` (`refuses a manifest declaring a
path that escapes the pack directory`, `refuses a lock that names a path
outside the pack directory`). Reproduced with this task's changes stashed
(`git stash push -- packages/client/src packages/client/scripts
packages/client/package.json`) — identical `Tests 2 failed | 35 passed` —
so they are pre-existing and load-dependent, not caused by this change.
Reported, not fixed.

### T2 — downstream acceptance oracle (salesko Gate 0)

Worktree `/Users/kito/Projects/salesko-new-wt-private-agent-salesko-read-tools`.
This build was overlaid into its `node_modules/@byok-sdk/client` (backup moved
to `client.gate0-backup`, `dist/` + `package.json` + `README.md` copied in);
`package.json`/`bun.lock` untouched, nothing committed, overlay restored
afterwards. `@byok-sdk/{core,protocol,cloud}` stayed at the published 0.10.1 —
this branch's train is 0.9.1-rc.2 because it is based on
`codex/packed-host-sdk-helper`, while `origin/main` is already at 0.10.2.

```
$ SALESKO_GATE0_LIVE=1 bun test ./apps/local-agent/src/salesko-read-tools-gate0.falsifier.ts
 9 pass
 0 fail
 75 expect() calls
Ran 9 tests across 1 file. [40.54s]

claude/codex live audit, both runtimes:
  spawn(daemon cwd) initialize tools/list        <- the new readiness probe
  spawn(canonical Agent home) initialize tools/list
  tools/call echo {"text":"gate0"}               <- previously never reached
  task summary: "gate0-echo:gate0"
```

Three consequences worth carrying into the release decision:

1. The daemon's readiness probe means a toolset MCP server is now started
   TWICE per task: once by the daemon (its own cwd, `tools/list` only) and
   once by the runtime (the task cwd). The downstream `F1a` control had
   asserted every start's cwd; it now asserts the runtime's start.
2. `CodexAdapter.prepare()` now execFile-probes the codex bin (`--version`,
   `codex mcp get`) for a toolset task too, so a test double that registers a
   non-codex binary as the codex bin is rejected pre-claim. The downstream
   fixture had to become a real fixture *bin*. This is the intended
   fail-closed gate, but it is a visible contract change for any host with a
   fake codex.
3. Version skew was ruled out as an explanation for the downstream result: the
   unpaid suite is 4 pass / 5 skip on the published 0.10.1 client and on this
   overlaid build alike; only the live `F4` tests separate them.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Live smokes: `packages/client/scripts/claude-toolset-permission-smoke.mjs`, `packages/client/scripts/codex-toolset-permission-smoke.mjs`
- Downstream acceptance oracle: `/Users/kito/Projects/salesko-new-wt-private-agent-salesko-read-tools/tasks/notes/20260830-0134-private-agent-salesko-read-tools.notes.md` (`## T0 Gate 0 results`)

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
