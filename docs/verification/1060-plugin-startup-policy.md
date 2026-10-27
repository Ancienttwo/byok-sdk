# #1060 Plugin exclusion at Codex startup

## P1 — Boundary

`CodexAdapter.start` owns the process launch policy. `codexSession` passes
`launchArgs` to `startAppServerClient`, which puts them in the app-server argv
before `--listen stdio://`. The existing Agent exclusion helper owns effective
MCP configuration validation and thread status read-back.

## P2 — Timing

Previously, `agentUserMcpServers: excluded` plus an Agent manifest disabled
plugins only after spawn/initialize/config-read, in `thread/start` or
`thread/resume`. Codex 0.164.0 can run plugin startup sync before those requests.
The same existing condition now supplies `-c features.plugins=false` at spawn.
Both fresh and resumed sessions use this path; memory-reader root markers are
composed with the override. No provider detection is involved.

## P3 — Constraints

Default/inherit and non-Agent tasks keep their previous launch behavior.
Thread exclusion, collision refusal, MCP status verification and startup
failure disposal are unchanged. Imports and beforeOpen logic are unchanged.
The launch override disables plugins, not just plugin network requests. It does
not change `chatgpt_base_url`, auth, or model routing, and does not establish
network isolation. The added argv is constant-size; at 10x concurrency the
existing per-session app-server process cost remains the scaling boundary.

## Parent verification commands

Implementation agent did not run build, typecheck, tests or real Codex probes.
Run from the integrated checkout. Build is required before package tests.

```sh
bun run build
cd packages/client
bun run test -- src/__tests__/codex-plugin-startup-policy.test.ts -t fresh
bun run test -- src/__tests__/codex-plugin-startup-policy.test.ts -t resume
bun run test -- src/__tests__/codex-agent-user-mcp-servers.test.ts src/__tests__/codex-adapter.test.ts
```

Each fresh/resume group covers excluded writer/reader, omitted/default,
explicit inherit, excluded non-Agent, and an active-plugin read-back refusal.
The new tests observe actual spawn argv before any fixture RPC. They are timing
regressions, not evidence of real Codex network behavior. No existing test
assertion was changed. Parent owns the required root checks and independent
review of the implementation plus new assertions.

## Existing real Codex loopback probe: minimal entry

Source:
`/Users/chris/Projects/byok-sdk/_ops/issue-lanes/1060-probes/byok-1060-plugins-disabled.mjs`.
It creates synthetic HOME/CODEX_HOME and a fake API key, scrubs ambient env,
serves model responses on loopback, and records requests rejected by its proxy.
Its two tool-grant assertions depend on the frozen #1058 changes: run after
parent integrates those changes. Do not run the ordinary authenticated real
app-server probe as a substitute.

The research probe pre-disables plugins in config.toml and imports the #1058
worktree. To test this fix, make a disposable copy against the integrated
checkout and remove that pre-disable; otherwise the result masks the bug:

```sh
python3 - <<'PY'
from pathlib import Path
source = Path('/Users/chris/Projects/byok-sdk/_ops/issue-lanes/1060-probes/byok-1060-plugins-disabled.mjs').read_text()
old = '/Users/chris/Projects/byok-sdk-worktrees/1058-reserved-mcp-grants'
assert source.count(old) == 3
source = source.replace(old, str(Path.cwd()))
pre_disable = r'[features]\nplugins = false\n'
assert source.count(pre_disable) == 1
source = source.replace(pre_disable, '')
Path('/tmp/byok-1060-startup-policy.mjs').write_text(source)
PY
BYOK_CODEX_LOOPBACK=1 BYOK_CODEX_BIN=/absolute/path/to/codex bun /tmp/byok-1060-startup-policy.mjs
```

Use a known local Codex 0.164.0 binary; inspect the reported runtimeVersion,
tool cases and blockedConnections. This existing probe covers fresh sessions;
resume timing is covered by the independent regression suite above, not claimed
as real-runtime resume evidence. A zero blockedConnections count applies only
to the observed fixture and proxy traffic. It does not prove all networking is
blocked or all ChatGPT background services are disabled. Keep the synthetic
credential and loopback boundaries intact. Remove the disposable copy after
collecting evidence.

## Parent checks on 8398dbf14

- Root build, root typecheck and version-authority: exit 0.
- Three focused files (`codex-plugin-startup-policy`, `codex-agent-user-mcp-servers`, `codex-adapter`): 88 passed, exit 0. Existing assertions were not changed.
- API surface initially differed only in the option JSDoc above. Regenerated the client declaration golden alone; the full API gate then passed without changing budgets.
- Real Codex 0.164.0 fresh-session loopback used the existing synthetic-home probe with the preconfigured plugins=false removed and only its host-server case retained. The local provider received two requests; the unapproved Host tool was advertised but never executed, and Codex returned approval-never refusal. The rejecting proxy recorded no external connection attempts in this fixture. No paid call or real credential was used.
- This standalone case does not cover SDK helper grants (PR #1066), real-runtime resume, other Codex versions or all background services. Fresh/resume timing and unchanged default/non-Agent behavior are covered by the focused regression suite; full issue #1060 remains broader than this patch.

Logs: `/tmp/byok-1060-build.log`, `byok-1060-typecheck.log`, `byok-1060-tests.log`, `byok-1060-api-final.log`, `byok-1060-version.log`, `byok-1060-real-startup.log`. Final integrated-head CI remains required.
