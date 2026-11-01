# Minimal guardrails (ADR-037): real-agent acceptance

Date: 2026-10-08. Owner-approved acceptance run.
Source: `main` at `77385cec`, clean tree, `bun run build` exit 0.
Scope: the merged daemon path against the real local agents on this Mac.
This note records evidence only. It changes no product code.

## Result

Claude, Codex and Pi pass the launch, environment, MCP, workspace and
terminal checks. The descendant-cleanup check fails for Claude and Pi:
a background `nohup sleep` that the agent starts outlives the task and
the daemon stop. Codex does not exercise the SDK sweep, because Codex
itself removes the background job when its shell command ends.

## Environment

| Item | Value |
| --- | --- |
| OS user | uid 501, macOS (Darwin 25.5.0), not root |
| Node | v26.10.0 (`/opt/homebrew/bin/node`) |
| Claude Code | `2.1.291 (Claude Code)` at `~/.bun/bin/claude` |
| Codex CLI | `codex-cli 0.161.0` at `~/.local/bin/codex`. The SDK qualifies 0.160.0. |
| Pi | Bundled `@earendil-works/pi-coding-agent` 1.0.4, launched through `packages/client/dist/bin/byok-pi-rpc.js`. The user `pi` CLI 1.0.0 is not used. |
| Pi credential | Ordinary Pi lane. Pi reads the user agentDir `~/.pi/agent`. The default provider is `magpie`, a loopback proxy at `127.0.0.1:3425`. The model is `antigravity/gemini-3.8-flash`. No secret was read or printed. |
| `setsid` | Not present on macOS. The task uses `nohup sleep N >/dev/null 2>&1 &`. |

## Method

The driver and shims are outside the repo, in `/tmp/byok-accept/`.

- `driver.mjs <runtime> [task|inherit-start]` starts a real
  `@byok-sdk/server` (`createByokServer`) on loopback. It pairs and starts a
  daemon from `packages/client/dist`. It dispatches one task with
  `requiredToolsets: ['accept']`.
- The `accept` toolset is the repo fixture
  `packages/client/src/__tests__/fixtures/toolset-echo-mcp.mjs`. It writes
  an audit line for each MCP request. It returns `byok-echo:<text>`.
- `workspaceRoot` is a fresh `/tmp/byok-accept/<runtime>-task-*/workspace`.
  The task cwd is `<workspaceRoot>/<taskId>`. `HOME` is the real home, so
  the agents use their real login and config.
- Claude and Codex: `createDaemon(config)`, the bundled adapter path.
  `BYOK_CLAUDE_BIN` / `BYOK_CODEX_BIN` point to a shell shim. The shim
  records argv and the names (never the values) of `CLAUDECODE` and
  `BYOK_*` variables, then `exec`s the real binary. The pid does not change.
- Pi: `createDaemonWithAdapters(config, [new PiAdapter({ byokLauncher:
  undefined, spawnFn })])`. This is the same construction as `createDaemon`
  (`create-daemon.ts:1194`). The added `spawnFn` records argv and env names,
  then calls `node:child_process.spawn`. `BYOK_PI_BIN` is not set, so the
  bundled Pi entry is used.
- The daemon process has `CLAUDECODE=1`, `BYOK_ACCEPT_STRIP_PROBE=1` and
  `BYOK_TEST_DEVICE_CREDENTIAL_STORE=1`. These probe the strip rule.
- Each runtime uses its own sleep length (Claude 301, Codex 302, Pi 303),
  so `ps` attributes each process without doubt. A 200 ms sampler reads
  `ps -axo pid=,ppid=,pgid=,command=`. macOS `ps` has no `sid` keyword, so
  the driver reads the session id with `os.getsid`.
- Task bound: 180 s. The driver kills only its own numbered sleep, and
  only after it records the result.

Instruction (per runtime):

```text
Do exactly these steps and nothing else. 1) Call the MCP tool named echo
(from the accept toolset) with text ACCEPT-<runtime>. 2) Create a file
named accept.txt in the current working directory that contains exactly
the text the echo tool returned. 3) Run this exact shell command:
nohup sleep <N> >/dev/null 2>&1 & 4) Reply with the word done.
```

Commands:

```sh
bun run build
node /tmp/byok-accept/driver.mjs claude task
node /tmp/byok-accept/driver.mjs codex task
node /tmp/byok-accept/driver.mjs pi task
node /tmp/byok-accept/driver.mjs codex inherit-start
```

## Per-runtime checks

### Claude (task `017d7432-5c35-49c1-b1e7-71f894aaa669`)

| Check | Status | Observed |
| --- | --- | --- |
| Detection | PASS | `available`, version `2.1.291 (Claude Code)`, `authPresent: true` |
| Launch argv | PASS | `-p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --mcp-config <tmp>/byok-mcp-*/mcp-config.json`. No `--strict-mcp-config`. |
| Launch cwd | PASS | `/private/tmp/byok-accept/claude-task-na1mVp/workspace/<taskId>` |
| Child env | PASS | Task launch: `FLAGGED_ENV_NAMES []`. No `CLAUDECODE`, no `BYOK_*`. |
| MCP tools/call | PASS | Event `tool_use mcp__echo__echo {"text":"ACCEPT-claude"}`. `tool_result` text `byok-echo:ACCEPT-claude`. Audit: `initialize`, `tools/list`, one `tools/call`. |
| User config inherited | PASS | Claude loaded the tool through its own deferred `ToolSearch`. This is user-level Claude behaviour. |
| `accept.txt` | PASS | `byok-echo:ACCEPT-claude` |
| Terminal state | PASS | Server `Complete`, `claimedRuntime: claude`, summary `done` |
| MCP config temp dir removed | PASS | `byok-mcp-ETJCph` absent after the run |
| Background sleep gone | **FAIL** | Root pid 86333, pgid 86333. Sleep pid 87791: ppid 1, pgid 87780, sid 87780 at first sight (during the task). Alive after terminal and quiescence (`activeTaskCount 0`). Alive after `daemon.stop()`. The driver killed it. |

### Codex (task `6d6f432a-bb76-4310-bd2b-6d0bcbfa7b05`)

| Check | Status | Observed |
| --- | --- | --- |
| Detection | PASS | `{"kind":"available","version":"codex-cli 0.161.0","authPresent":true,"advisory":{"reason":"runtime_version_unqualified","qualifiedVersion":"0.160.0"}}`. No refusal. |
| Logged warning | PASS | `[byok/client] codex codex-cli 0.161.0 is not the qualified 0.160.0; continuing` |
| Launch argv | PASS | `app-server -c sandbox_mode="danger-full-access" --listen stdio://`. No `mcp_servers.*` override in argv. |
| Approval and sandbox (Codex readback) | PASS | Rollout `turn_context`: `approval_policy: never`, `sandbox_policy: {"type":"danger-full-access"}`, `originator: oar`, `cli_version: 0.161.0` |
| MCP via thread config | PASS | The echo server spawned in the task cwd with no argv entry. Event `mcp_tool_call echo/echo {"text":"ACCEPT-codex"}`. Result `byok-echo:ACCEPT-codex`, status `completed`. |
| Child env | PASS | Task launch: `FLAGGED_ENV_NAMES []` |
| `accept.txt` | PASS | `byok-echo:ACCEPT-codex` |
| Terminal state | PASS | Server `Complete`, `claimedRuntime: codex` |
| Background sleep gone | PASS (SDK sweep not exercised) | Codex ran `/bin/zsh -lc 'nohup sleep 302 >/dev/null 2>&1 &'` with exit 0. The sampler never saw `sleep 302`. Codex removes the job when the command ends `[inferred]`. This run does not test the SDK sweep. |

### Codex with `DaemonConfig.codexSandbox: 'inherit'`

| Check | Status | Observed |
| --- | --- | --- |
| Launch argv | PASS | `app-server --listen stdio://`. No `sandbox_mode` override. |
| Child env | PASS | `FLAGGED_ENV_NAMES []` |
| Abort | PASS | Cancel after `started`. Terminal `Cancelled`. `daemon.stop()` clean. |
| Effective sandbox | Not distinguishable | The user `~/.codex/config.toml` also sets `sandbox_mode = "danger-full-access"`. Only argv absence is evidence. |

### Pi (task `305b27db-7c17-4158-86b7-80f6c7282296`)

| Check | Status | Observed |
| --- | --- | --- |
| Detection | PASS | `available`, version `1.0.4`, `authPresent: true` |
| Launch argv | PASS | `node packages/client/dist/bin/byok-pi-rpc.js --config-digest=<sha256> --config <tmp>/byok-pi-mcp-*/rpc-launch.json --mode rpc`. No `--no-skills`, no `--no-extensions`. `detached: true`. |
| Launch cwd | PASS | `/private/tmp/byok-accept/pi-task-KnLpVp/workspace/<taskId>` |
| Host config | PASS | Keys `format, version, cwd, mcp`. `mcp` holds `mcpServers.echo`, the daemon `tools/list` observation, `launchCwd` and `mcpEnv` (77 names, no `CLAUDECODE`, no `BYOK_*`). |
| Child env | PASS | Spawn env: `FLAGGED_ENV_NAMES []` |
| User agentDir inherited | PASS | Pi session file: `model_change provider=magpie modelId=antigravity/gemini-3.8-flash`, thinking `high`. These are the user `settings.json` defaults. |
| D5 `tools/list` probe | PASS | Audit shows a daemon probe (spawn in `/private/tmp/byok-accept`, `tools/list`), then the Pi child spawn in the task cwd. |
| MCP tools/call | PASS | Event `tool_use mcp__echo__echo {"text":"ACCEPT-pi"}`. Result `byok-echo:ACCEPT-pi`, details `toolsetId: accept`. |
| `accept.txt` | PASS | `byok-echo:ACCEPT-pi` |
| Terminal state | PASS | Server `Complete`, `claimedRuntime: pi` |
| MCP config temp dir removed | PASS | `byok-pi-mcp-j2hzSm` absent after the run |
| Background sleep gone | **FAIL** | Sleep pid 4731: ppid 1, pgid 4730, sid 4730 at first sight. Alive after terminal and quiescence. Alive after `daemon.stop()`. The driver killed it. |

## Defect: orphaned background jobs outlive the task (POSIX)

Observed: Claude and Pi run each shell command in a session of its own. The
shell (pid 87780 for Claude, 4730 for Pi) exits as soon as `&` returns. The
sleep becomes an orphan: ppid 1, pgid and sid equal to the dead shell pid.
This happens seconds before the turn ends.

Cause: the disposal path finds descendants only through the live tree.
`rememberDescendants` reads `descendantsOf(readProcessTable(), pid)` just
before the SIGTERM (`packages/client/src/adapters/process-tree.ts:247-249`,
called at `:432` and `:537`). The orphan is no longer below the root, so it is not
in that set. The group kill reaches only the root group (`:538`, `:546`).
`killEntries` signals a remembered group only when its remembered member is
still live with the same start time
(`packages/client/vendor/oar/0be506f/shared/executable/process-tree.ts:117-129`).
The dead shell is not live, so its group 87780/4730 is never signalled.
The doc comment states this residual for Windows only
(`process-tree.ts:461-463`). It does not state it for POSIX.

Proposed fix (not applied):

1. Smallest: state the POSIX residual in the `disposeOwnedProcessTree` doc
   comment and in ADR-037 "Keep". A job that detaches and whose parent
   exits before disposal is out of reach of the tree walk.
2. Mechanism: give each runtime child a unique per-launch marker variable
   (not `BYOK_*`, so the strip rule keeps it). At disposal, after the group
   kill, scan same-uid processes for the marker and SIGKILL matches whose
   start time is after the root start. Linux reads `/proc/<pid>/environ`.
   macOS reads the environment with `ps -E` or `sysctl KERN_PROCARGS2`. A
   process that scrubs its environment still escapes. Linux can add a
   cgroup or a child subreaper as a stronger backstop.

Periodic snapshots of the tree do not fix this case. The shell lives for
milliseconds, and `killEntries` skips a dead group leader.

## Other observations

- Detection probes get the full daemon environment, `CLAUDECODE` and
  `BYOK_*` included. The shim log shows them on `--version`,
  `auth status --json`, `app-server --help` and `login status`. Task
  launches are clean. Sources: `packages/client/src/adapters/detect-outcome.ts:28`,
  `packages/client/src/adapters/claude/claude-adapter.ts:434`,
  `packages/client/src/adapters/codex/codex-adapter.ts:99`, `:108`. Each
  call omits `env`. Risk is low: the probe runs the same user binary. It
  is a gap against the ADR-037 `BYOK_*` deny if a host puts a secret in a
  `BYOK_*` variable.
- The Codex advisory is not in the `runtimes-detected` event or in
  `RuntimeInfo`. Only the `console.warn` line carries it
  (`packages/client/src/daemon/create-daemon.ts:999-1000`).
- First inherit attempt: the driver cancelled the task while it was still
  `Offered` on the server. The daemon then claimed it. The claim was
  rejected (`inbound_rejected`, terminal quarantine). The runtime reported
  `runtime-disposal-failed` (`startup runtime ownership remains
  quarantined`). `daemon.stop()` rejected with `RuntimeDisposalFailure`.
  The Codex app-server (pid 6000) was gone after the driver exited. The
  retry, with cancel after `started`, was clean. The cancel-before-claim
  race needs its own investigation `[unverified root cause]`.
- The Pi `rpc-launch.json` holds the full inherited environment in
  `mcp.mcpEnv`, provider key values included. This follows ADR-037 D2/D3.
  The SDK removed the file after the task.

## Cleanup

- After each run: `ps -axo pid,ppid,pgid,command | grep -E "sleep 30[0-9]$|byok-accept|byok-pi-rpc|driver.mjs"` printed nothing. No daemon, agent or
  sleep from this run remains.
- The driver killed the two surviving sleeps (pids 87791 and 4731) after
  it recorded them.
- The repo has no change except this note.
- The real agents wrote their usual session files under `~/.claude`,
  `~/.codex/sessions` and `~/.pi/agent/sessions`. These are normal agent
  side effects.
- Evidence stays in `/tmp/byok-accept/*/result.json` and `launch.log`.
  The Pi launch log was redacted: env values were removed, names kept.

## Residual gaps

- Codex: the SDK sweep is not exercised by this task shape. A job that
  escapes Codex's own cleanup (for example a new session from Python
  `start_new_session=True`) would very probably hit the same defect
  `[inferred]`.
- `codexSandbox: 'inherit'` is proven by argv only. The user config has the
  same sandbox value, so the effective policy does not differ.
- Pi used the ordinary agentDir lane. The BYOK keys-profile lane was not
  run.
- Cancellation of a running tool (a foreground descendant at SIGTERM time)
  was not run in this acceptance.

## Follow-up

Branch `fix/acceptance-followups` (one PR) handles the findings above.

- Orphaned background jobs (POSIX): documented, no new mechanism (owner
  ruling). The limit is now stated in the `disposeOwnedProcessTree` doc
  comment, `docs/spec.md`, `docs/security.md`, ADR-037 Keep, the CHANGELOG
  process-tree entry and `2026-10-08-oar-0.37.0-upgrade.md`. Descendants that
  are still below the root at the read are reached, also when they left the
  process group. A process whose parent exited before the read is not.
- Detection probes: `--version`, Claude `auth status`, Codex
  `app-server --help` and `login status` now get `buildRuntimeEnv` output, so
  no `CLAUDECODE` and no `BYOK_*`.
- Cancel during runtime start: root cause found and fixed. The cancel arrived
  after the claim, while Codex `start()` was still opening its session.
  `startOwnedRuntime` rejected at once, and its disposal retry refused until
  `start()` settled. Codex does not read the abort signal and needs about
  4 s to open a session. The first disposal attempt failed at once, and
  `daemon.stop()` made one more attempt while the start was still open. The
  `inbound_rejected` line was the server refusing a late outbound envelope
  for the already-cancelled task `[inferred]`. It does not touch runtime
  disposal, so it was not the cause. While the aborted start still runs,
  the daemon now defers disposal without a failure report. Shutdown waits up
  to 5 s after the abort for the start to settle, then closes the late
  session. The race exists since `55ce43cb` (2026-09-07), before the
  minimal-guardrails work.
- Pi `rpc-launch.json`: the directory is 0700 (mkdtemp) and the file is
  created 0600 with an exclusive create, then removed on every start failure
  and on close. The redundant `mcp-config.json` copy is gone. `mcpEnv` is the
  `projectPiMcpEnvironment` projection, so it holds no provider credential
  name from the shared deny list. Other inherited values stay, because the
  MCP servers get the full inherited environment (ADR-037 D2/D3).
