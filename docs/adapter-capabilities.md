# Adapter capability qualification

This matrix describes BYOK's exposed adapter contract, not everything an
upstream CLI might support. The production authority remains the immutable
`RuntimeAdapter.descriptor.capabilities` snapshot in `@byok-sdk/client`.
This document and the conformance expectations are evidence of that contract;
they are not a second runtime-selection registry.

## Capability matrix

Generated from each adapter's capability constant
(`packages/client/src/adapters/<id>/<id>-capabilities.ts`) by
`bun run docs:capability-matrix`; do not edit the table by hand. The same values
are each adapter's `descriptor.capabilities`, and the daemon reports them per
runtime in `conn.hello` (`runtimes[].capabilities`, `harnesses[].capabilities`)
and in presence (`runtimes[].capabilities`), so a Host can read them before
dispatch. A runtime a daemon did not report, or a field an older daemon omits,
is unknown, not `no`.

`yes` for an isolation row is a guarantee the
[runtime contract suite](runtime-contract.md) checks: it refuses to skip a case
the descriptor declares. `no` means the SDK makes no such guarantee; the
[isolation section](#user-level-configuration-and-session-isolation) says what
the runtime does instead.

<!-- generated:capability-matrix:start -->
| Capability | Wire field | agy | Claude | Codex | dsh | Grok | Hermes | OpenCode (unqualified) | Pi | Pi (`durableLane`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qualified version (PR CI) | — | `1.5.1` | `2.1.312` | `0.160.0` | `0.2.2-rc.1` | `1.0.52` | `0.22.2+2364.g0b10b9f` | `unqualified` | `1.5.0` | `1.5.0` |
| Resume a known native session | `resume` | yes | yes | yes | yes | yes | no | yes | yes | no |
| Redirect the active turn | `steer` | yes | no | yes | yes | no | no | no | yes | no |
| Display-only message draft | `messageDraft` | no | yes | yes | no | yes | yes | no | yes | yes |
| Task-scoped MCP toolsets | `mcpToolsets` | yes | yes | yes | yes | yes | yes | no | yes | yes |
| Interactive approval channel | `approvalInteractive` | no | no | no | no | no | no | no | no | no |
| Tool authorization `auto` | `toolAuthorizationAuto` | no | yes | no | no | no | no | no | yes | yes |
| Prepared lane | `preparedLane` | no | no | no | no | no | no | no | yes | no |
| Durable worker lane | `durableLane` | no | no | no | no | no | no | no | no | yes |
| Keeps user-level instructions out | `isolation.userInstructions` | yes | yes | no | yes | no | yes | no | yes | no |
| Keeps the user output style out | `isolation.userOutputStyle` | yes (no source) | yes | no | yes | no | yes | no | no | no |
| Keeps user-level memory out | `isolation.userMemory` | no | yes | no | yes (no source) | no | yes | no | no | no |
| Keeps user skills out | `isolation.userSkills` | yes | no | no | yes | no | yes | no | no | no |
| Keeps user hook context out | `isolation.userHookContext` | yes | no | no | no | no | yes | no | no | no |
| Keeps user MCP servers out | `isolation.userMcpServers` | yes | yes | yes | yes | yes | yes | no | no | no |
| Turns off the transcript store | `isolation.sessionPersistence` | no | yes | no | no | no | no | no | no | no |
<!-- generated:capability-matrix:end -->

## OpenCode implementation and qualification (#1538)

`OpenCodeAdapter` is an opt-in custom harness (`harnessId: 'opencode'`). Its
platform list is empty until native OS/line onboarding canaries qualify it;
replay tests do not advertise a platform. The compatibility floors are v1
1.18.35 and v2 2.0.26. No default qualified-version policy is installed yet.
A Host can supply a version policy; unrecognized, below-floor and prerelease
tokens still fail the executable compatibility gate.

Native qualification results and the distinction between native CLI
availability and adapter acceptance are recorded in the [PR 3 canary evidence](researches/2026-11-08-opencode-native-qualification.md).
An installed CLI, matching model readback or passing replay suite alone does
not enable onboarding. Every advertised OS/line combination needs completion,
resume and cwd refusal, permission refusal, cancellation and disposal evidence,
including no surviving `serve --service` process. A pre-output rate-limit
fallback that cannot be provoked honestly stays covered by replay only.

The Host supplies `runtimes.opencode.models`, an ordered list of native model
ids, and optionally `executable`. There is no SDK model default, price check,
model listing, automatic installation, upgrade or cross-major migration.
The adapter selects the first id, applies it explicitly through ACP and refuses
an absent or differing native readback before prompting. On an OAR-classified
rate limit before text, reasoning or tool output, it retries once with the next
candidate after reaping the first process tree, resuming the same admitted native
session and verifying its model readback. It never creates a replacement
session; an unsupported resume or model switch preserves the rate-limit failure.
A non-terminal `error` diagnostic event contains a
JSON switch record with `event: "model_switch"`, `from`, `to` and
`reason: "rate_limited"`. A second rate limit or any preceding output prevents
another switch. Text-classified failure categories remain `unknown` in terminal
failure reporting, as for the other ACP adapters.

OpenCode runs in the device user's environment and owns its native session
store. The SDK does not read credentials, filter or rewrite user configuration,
provide a home, or proxy model traffic. All isolation fields are false.
A later turn resumes its native session in a new owned process; OAR refuses
resume if the original cwd is different or cannot be proved. The SDK owns no
persistent OpenCode transcript directory, so no SDK retention store is created.

Steering and interactive permissions are unsupported on both lines. The ACP
boundary cancels permission requests. V1 retains OAR's session-local appended
persona overlay and cleanup; v2 refuses Agent-memory readers before execution
because that appended instruction channel is unavailable. Task-scoped Host MCP
toolsets are rejected before launch until both lines pass qualification. Native
user MCP remains inherited. V2 `execute` calls remain opaque without a proven
native tool identity; the SDK never derives MCP names from code. Child call IDs
carry the native child session id to avoid merging their calls with root calls.
Child-session text is excluded from root answer progress. The SDK's flat event
schema has no parent-graph field; no spawning-tool edge is invented. Usage fields
are emitted only when OAR supplies native counters.

Install the chosen line as an operator action. OpenCode v1 uses `opencode-ai`
on npm and `https://opencode.ai/install`; v2 uses `@opencode/cli` and
`https://opencode.ai/v2/install`. The installer locations collide at
`~/.opencode/bin/opencode`; choose and retain one line. Native Windows npm
command shims use the existing shell-free invocation resolver and owned job
lifecycle. Neither a Linux nor WSL run qualifies native Windows.
Current [upstream installation guidance](https://opencode.ai/docs/) recommends
a standalone v2 Windows CLI binary and does not support Windows package managers.
Retain the chosen line; do not overwrite a v1 installation to perform a v2 canary.

## Qualification notes

The [capability matrix](#capability-matrix) is the only comparison of what each
adapter declares. These notes are evidence of how the bundled adapters meet
those declarations, and of behavior the matrix does not cover; they are not a
second registry.

- Resume uses each runtime's exact native identity: Claude `--resume`, Codex
  `thread/resume`, Grok ACP `session/resume`, dsh `agents.resume` through the OAR
  bridge. A `followUp` after an idle turn stays in the same native session or
  thread on Claude, Codex, Grok, Hermes and Pi. agy and dsh refuse it and a later
  turn resumes in a new process; Pi's durable lane refuses it too.
- Codex steering targets the exact active `expectedTurnId`. An adapter without
  `steer` returns a typed rejection.
- Message drafts come from Claude's `--include-partial-messages` text deltas,
  Codex `item/agentMessage/delta`, Grok ACP `text_delta` and Pi `text_delta`
  progress.
- Tool authorization `auto`: Claude gates through the SDK `PreToolUse`
  callback, confirmed by `hooks_applied`; Pi gates on the ordinary RPC lane
  with its native subagents, on the prepared lane and on the durable lane.
  Every other case, Grok's partial hosted-terminal coverage included, is
  declined before claim.
- No bundled adapter offers native session fork or rollback (the SDK `Session`
  has no such operation), the legacy boolean interactive approval, native
  approval or structured-question replies under default construction, or
  recovery of pending native interactions after a process restart. Browser or
  mobile reconnect is the Host's, not native session resume.
- Local native interaction opt-in: Claude relays structured AskUserQuestion
  only and passes other `can_use_tool` requests through as allow; Codex relays
  structured question IDs only, keeps `approvalPolicy: never` and refuses
  approval requests; Grok answers every permission request `cancelled`; dsh has
  no client for them, see the dsh section; Hermes refuses every one with
  `reject_once`; Pi has none.
- MCP identity on tool events (`tool_use.mcp`, `tool_result.mcp`): Claude sets
  it for task toolset servers from its own `mcp_status` answer; Codex from the
  native `mcpToolCall` `server` and `tool`, for every server it runs, SDK
  helpers included; Pi by exact observed name, on the ordinary, prepared and
  durable lanes. Grok does not set it: ACP `tool_call` defines no MCP server
  field, and live Grok evidence is pending (#633).
- Trajectory evidence: only ordinary Pi declares `event-stream`, and Pi with
  `durableLane: true` does not; Claude and Codex records are `unknown`.
- Process tree (POSIX): disposal ends a runtime's tool processes in process
  groups of their own after the root was killed from outside, if one of the
  once-a-second observations saw them while the root ran
  ([#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269)).

By default Claude and Codex run YOLO
([ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md)): Claude with
`--dangerously-skip-permissions`, Codex with `approvalPolicy: never`. Native
interaction opt-in relays questions only: Claude uses
`--permission-prompt-tool stdio --permission-mode acceptEdits` and passes every
non-question request through as allow; Codex keeps `approvalPolicy: never`.
Tool permission is solely the task's `auto | all` decision.

Tool authorization `all` needs no adapter support: the daemon reminds from the
normalized `tool_use` stream for every runtime. Local task rules share the same
classifier in both modes: Always Ask upgrades a call to approval (`auto`) or a
reminder (`all`); Allow without Asking suppresses both, except for the
non-overridable credential/login-persistence sensitive-path floor. The resolver
accepts either a mode or `{ mode, rules }`, validates/copies/freezes it before
claim and re-resolves it on a resume offer. Pi (ordinary RPC with native
children, prepared and durable) and Claude use their existing gates; Codex,
Grok, Hermes and dsh still decline `auto` before claim. Rules and audit metadata remain local; the
server wire protocol, Pi launch v8 and digest format are unchanged. No reviewer
model, natural-language matching, deny rule or new dependency is introduced.
The shared matcher has bounded wildcard syntax and identical Node/Bun results;
shell control/substitution syntax cannot activate allow. The sensitive-path
floor resolves home/nearest existing parents, recognizes darwin aliases and
folds case on darwin/win32. Suppressed high-risk calls retain local audit codes,
including in `all`; invalid-policy details stay out of wire decline reasons.
See the spec's
[Tool authorization](spec.md#tool-authorization-auto-and-all-1061) section for
the classifier and the honest limits (tool gate, not file scope or sandbox).

Pi is intentionally outside this qualification change. Existing Pi behavior
and its existing tests are unchanged; these notes do not downgrade its
already implemented capabilities or certify them without evidence. Custom
adapters must qualify their own descriptor and behavior. Sharing an upstream
runtime name or using a custom harness does not inherit another adapter's pass.
Trajectory evidence has its own Pi evidence; see
[Trajectory evidence](#trajectory-evidence).

## User-level configuration and session isolation

An Agent home sets the execution's working directory and projected persona; it
is not a promise that the runtime reads only that directory. The standard
[environment builder](../packages/client/src/runtime/environment.ts) gives it the
user's login-shell environment except `CLAUDECODE` and `BYOK_*` (#1095). Paths such as `HOME`,
`XDG_*`, `GROK_HOME` and `CODEX_HOME` are not reset by that builder. Task-scoped
MCP configuration, a fresh native session, folder trust and filesystem permission
modes address different concerns; none alone establishes persona isolation.

The sections below name, per runtime, the user-level instruction sources it
loads, whether the user's own MCP servers reach a task, the runtime's own
memory, and the per-process switch the CLI accepts, at the version each probe
used. The isolation rows of the [capability matrix](#capability-matrix) say
which of these the SDK keeps out, as checked by the runtime contract suite. The
[#634 evidence note](researches/2026-10-22-634-runtime-user-config.md) and the
[#871/#873 evidence note](researches/2026-10-24-871-873-claude-agent-user-context.md)
give the source lines, help output and probes. The SDK option is an adapter option: it applies
to every session that the adapter starts. A choice per task would need a new
wire field. The default is unchanged, and the option is not an isolation
guarantee.

### Claude: user-level configuration

The [Claude adapter](../packages/client/src/adapters/claude/claude-adapter.ts)
adds task MCP servers with `--mcp-config`. By default it keeps the user's
settings, deny rules, hooks, MCP servers, instruction files and auto memory. The evidence version is Claude Code 2.1.302;
the adapter pins no Claude version. Claude's
[Agent SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
page lists what each setting source loads:

- `user`: `~/.claude/settings.json`, `~/.claude/CLAUDE.md`,
  `~/.claude/rules/*.md`, and the user skills, commands and subagents.
- `project`: `<cwd>/.claude/settings.json` and its hooks, and `CLAUDE.md` and
  `.claude/rules/*.md` in the cwd and in every parent directory.
- `local`: `CLAUDE.local.md` in the cwd and every parent directory, and
  `<cwd>/.claude/settings.local.json`.
- Always: managed policy, `~/.claude.json`, and auto memory unless
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set. A user `settings.json` `env`
  block wins over that process variable (probed).

Claude's `--setting-sources` flag selects these sources. The SDK has no option
for it, because a launch without the `user` source keeps the user instructions
for the usual Host layout and removes guardrails:

- The 2.1.302 memory loader looks for project files in every parent directory
  of the cwd. For an Agent home under `$HOME`, it then loads `~/CLAUDE.md`,
  `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` as project files. A local
  probe against a fake endpoint confirmed this.
- The launch drops the user's permission rules and hooks. Under the default
  `--dangerously-skip-permissions` these are the remaining guardrails.
- It drops the `env` block and `apiKeyHelper` of the user settings. If the
  provider login or `ANTHROPIC_BASE_URL` lives there, Claude cannot reach the
  provider.
- Managed policy and auto memory still load.

Claude's `claudeMdExcludes` setting takes glob patterns that match absolute
file paths, at any settings layer. In the local probe, `--settings` with
patterns for `~/.claude/CLAUDE.md` and `~/.claude/rules/**` removed those two
files and kept the user settings. `~/CLAUDE.md` still loaded, as a project
file. To remove every instruction file above the Agent home, the patterns
must name each parent directory. The paths also depend on `CLAUDE_CONFIG_DIR`
and on symlinks.

#### `agentUserContext`

`ClaudeAdapterOptions.agentUserContext: 'excluded'` gives an Agent task (a run
whose manifest has an `agentRef`, as every `task.offer` does) only SDK, Host
and Agent-home inputs. A run without an `agentRef` is unchanged: a parent
`CLAUDE.md` of a workspace is a real project instruction.
The default, `'inherit'`, sets nothing. The anchor is the sealed
`lease.canonicalHome`, never the cwd, so a memory reader in
`<home>/.byok/runs/<taskId>/` still loads the home's files through Claude's
parent walk. Under `excluded` an Agent task starts with:

- `--strict-mcp-config`, also when the task has no servers (then without
  `--mcp-config`). The task toolset servers and the SDK's own servers stay,
  because they are in the task's `--mcp-config`. The servers of
  `~/.claude.json` do not load (probed). Project `.mcp.json` servers, plugin
  servers and claude.ai connectors do not load either (inferred from the
  binary and its help text; not probed). With an enterprise
  `managed-mcp.json`, Claude exits at startup, as it already does for every
  launch with `--mcp-config`; the start then fails as an early exit.
- A `--settings` file, `claude-settings.json` (mode 0600) in the execution's
  SDK scratch directory, removed with it. Its `claudeMdExcludes` names
  `CLAUDE.md` and `rules/**` of the config directory (`CLAUDE_CONFIG_DIR`, else
  `.claude` in `HOME`, or in `USERPROFILE` on Windows) unless that directory,
  or its real path, lies inside the Agent home. It also names `CLAUDE.md`, `CLAUDE.local.md`,
  `.claude/CLAUDE.md` and `.claude/rules/**` of every directory strictly above
  the Agent home, up to but not including the filesystem root. Everything at
  and below the Agent home stays. Claude turns `\` into `/` before it
  matches, so the patterns use `/` and cannot escape glob syntax. In the
  directory part of a `rules/**` pattern, each of `( ) [ ] { } * ? ! @ + | ^ $`
  becomes `?`.
- In the same file, `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` set to `1`. The flag
  layer outranks a user `settings.json` `env` block. The process variable and
  `autoMemoryEnabled: false` do not (probed).
- In the same file, `outputStyle` set to `default`. It outranks a user
  `outputStyle`, so neither the style file's text nor the system-prompt
  section that refers to an output style reaches the model (probed on
  2.1.319, #1564).
- `--setting-sources` untouched. The user's settings, deny rules, hooks,
  `apiKeyHelper`, model and env still apply (probed for deny rules, a hook,
  model and env).

The start fails as a non-retryable `authority` failure, with a reason that
names no path, when the Agent manifest has no sealed absolute, normalized
`lease.canonicalHome`, when its cwd is not the home or inside it, or when
`CLAUDE_CONFIG_DIR` is set but not absolute.

The option affects new sessions only. In the probe, a session started without
it and resumed with it still carried the user instruction files and the auto
memory in its first history message. A Host that turns the option on should
start fresh Agent sessions (drop `sessionRef`).

Under `excluded` these still load and can reach the model (probed on 2.1.319,
#1564):

- Output of the user's hooks that add context, such as SessionStart and
  UserPromptSubmit. Hooks merge across setting layers, so the flag layer
  cannot remove one event's hooks, and `allowManagedHooksOnly` takes effect
  only in managed policy. Dropping the `user` setting source also drops the
  guard hooks, such as PreToolUse, and the deny rules (see above);
  `disableAllHooks`, `--bare` and `--safe-mode` drop every hook (from the
  help text; not probed).
- The user's skills: their names, and depending on the frontmatter their
  descriptions, appear in the skill listing.
- The user's commands and subagents, installed plugins' skills and hooks, and
  managed policy, including a managed `CLAUDE.md`, which cannot be excluded.

The `isolation.userContext` capability bit does not yet describe these
sources; splitting it is tracked separately.

On Windows the adapter writes the same patterns, and fixture tests cover a
win32 home. No Claude on Windows was probed: drive-letter case, `\\?\` paths and
junctions are unverified, so a Windows Host should check the result with its
own installation.

`createDaemon` builds the Claude adapter without options. A Host sets the
option on its own `ClaudeAdapter` through `createDaemonWithAdapters`.

### Codex: user-level configuration

A custom provider selects model routing, not all Codex network destinations.
Even with plugins disabled, eligible ChatGPT authentication can trigger a
separate authenticated cloud-config request. See [custom-provider background
services and evidence limits](researches/2026-10-28-codex-custom-provider-background-services.md).

The [Codex adapter](../packages/client/src/adapters/codex/codex-adapter.ts)
starts the user's app server with the supplied environment. Native config remains
in effect except for explicit adapter overrides such as sandbox and approval
policy; `sandboxMode: 'inherit'` leaves even that sandbox choice to native config.
Upstream documents user `config.toml` and global `AGENTS.override.md` / `AGENTS.md`
under `CODEX_HOME` (normally `~/.codex`), with project instruction discovery added
for the working directory. See [configuration](https://developers.openai.com/codex/config-basic)
and [instruction discovery](https://developers.openai.com/codex/guides/agents-md).

The Codex 0.160.0 app server always reads `$CODEX_HOME/AGENTS.override.md`,
else `$CODEX_HOME/AGENTS.md`. No configuration key, flag or environment
variable turns that file off. `project_doc_max_bytes = 0` stops only the
project files. The `config`, `base_instructions` and `developer_instructions`
fields of `thread/start` and `thread/resume` do not remove the user file, and a
per-thread MCP override does not either. `CODEX_HOME` also holds `auth.json`
and the sessions, so moving it moves the login. The SDK has no Codex option
for user instructions. Keeping the user file out means moving `CODEX_HOME`,
and the login moves with it. A ChatGPT login refresh writes the new token back
to `auth.json` and the old refresh token stops working, so a copied login does
not survive its first refresh. The SDK therefore does not move `CODEX_HOME`. A
Host that needs isolation checks `isolation.userContext`, which is `false` for
Codex.

#### `agentUserMcpServers` (Codex)

`CodexAdapterOptions.agentUserMcpServers: 'excluded'` gives an Agent task (a
run whose manifest has an `agentRef`, as every `task.offer` does) only the
task's and the SDK's MCP servers. It changes MCP servers only; the user's
`AGENTS.md` still loads. A run without an `agentRef`, and the default
`'inherit'`, are unchanged. The adapter works on the session's own
app server, through two caller-owned steps of the
[vendored session](../packages/client/vendor/oar/45488e7/PROVENANCE.md):

- Before the thread opens, `config/read` for the task cwd lists the servers of
  the user and project `config.toml` layers. Each one that is not a task
  server gets `enabled = false` in the `thread/start` or `thread/resume`
  `config`, and the same `config` sets `features.apps = false` and
  `features.plugins = false`. A user server with the name of a task or SDK
  server refuses the start, because Codex would merge the user's `env`, `cwd`
  and tool filters into the task server.
- After the open, `mcpServerStatus/list` with the thread id reads the
  thread's servers back. Any server outside the task that is not `disabled`
  refuses the start. A plugin server is named with its plugin id, and is
  refused even when it has the name of a task server.

Codex keeps no MCP servers per thread, so a resume carries the same `config`:
the option also covers resumed threads. On a resume, Codex may start a queued
turn before the read-back. That turn already runs with the overrides, and a
failed read-back stops the app server.

`features.plugins = false` turns off the thread's plugins altogether, with
their skills and commands, not only their MCP servers. Plugin servers are not
in `config/read`'s `mcp_servers`, so the feature switch is the only per-thread
way to remove them.

Probed on Codex 0.160.0 and 0.164.0 in a synthetic `CODEX_HOME` with the
network denied: a user stdio server, a dotted name and a trusted project
server read back as `disabled`, a plugin server disappeared with either
`features.plugins = false` or `plugins."<id>".enabled = false`, and the
user's `model` and `sandbox_mode` still applied. The same overrides as launch
`-c` arguments did not disable the servers, and a quoted dotted key stopped the
app server, so the adapter does not use them. Connectors need a ChatGPT login
and were not probed: that `features.apps = false` removes them is inferred. If
Codex still starts its connector server (`codex_apps`), the read-back refuses
the start.

The start fails as a non-retryable `authority` failure, class `unknown`. The
reason names servers and plugin ids, never paths:

- `codex Agent user MCP server exclusion refused: user MCP servers share a name with task servers: <names>`
- `codex Agent thread still runs MCP servers outside the task: <names>`
- `codex Agent user MCP server exclusion refused: config/read returned no readable configuration`
- `codex Agent user MCP server exclusion refused: mcpServerStatus/list returned a reply it cannot read`
  (also for a cursor that does not end within 64 pages)

A failed `config/read` or `mcpServerStatus/list` request fails the open as any
other app-server error does.

`createDaemon` does not set the option. A Host sets it on its own
`CodexAdapter` through `createDaemonWithAdapters`.

### Grok: user-level configuration

ACP `terminal: false` does not hide Grok 1.0.52's native terminal tool. The SDK
does not provide a hidden-terminal mode; see the [qualified observation and
limits](researches/2026-10-28-grok-terminal-capability-boundary.md).

The [vendored launch profile](../packages/client/vendor/oar/45488e7/runtimes/grok/session.ts)
uses `agent --always-approve --no-leader stdio`; the adapter forwards the task
environment. `grok agent` 1.0.52 has no flag for rule loading or folder trust.
Grok's [Project rules guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md)
loads these home sources wherever Grok starts:

- `$GROK_HOME/AGENTS.md` and `$GROK_HOME/rules/` (normally under `~/.grok/`).
- `~/.claude/CLAUDE.md` and `~/.claude/rules/`, under the
  `compat.claude.agents` and `compat.claude.rules` cells.
- `~/.cursor/AGENTS.md` and `~/.cursor/rules/`, under the
  `compat.cursor.agents` and `compat.cursor.rules` cells.
- Each `[paths] extra_rule_dirs` entry, also without folder trust.

Project `AGENTS.md` loading requires folder trust. In a trusted folder, the
`agents` and `rules` cells also cover the project `.claude/CLAUDE*.md`,
`.claude/rules/` and `.cursor/rules/`, and a top-level project `CLAUDE.md`
stays recognized (from the guide; not probed).

`GrokAdapterOptions.compatInstructions: 'disabled'` sets
`GROK_CLAUDE_AGENTS_ENABLED`, `GROK_CLAUDE_RULES_ENABLED`,
`GROK_CURSOR_AGENTS_ENABLED` and `GROK_CURSOR_RULES_ENABLED` to `0` on the
Grok agent process. Commands that Grok asks the client to run do not get
them. Children that Grok starts itself, such as stdio MCP servers and hooks,
may inherit them. The
[configuration guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md)
puts an environment variable before `config.toml`, so the user's own
`compat` settings do not turn these cells on again (from the guide; not
probed). The default, `'inherit'`, sets nothing. With `'disabled'`, these
stay:

- `$GROK_HOME/AGENTS.md`, `$GROK_HOME/rules/` and `extra_rule_dirs`. No
  environment variable controls them, and the `GROK_CONFIG` overlay cannot set
  `paths` or `compat`.
- The Claude and Cursor `skills`, `hooks` and `mcps` cells, with their
  configured values.

Keeping these out means moving `GROK_HOME`, which also moves `auth.json` and
the sessions; the adapter does not do it, so Grok declares
`isolation.userContext: false`. A Host that needs isolation checks that bit. With the four variables, `grok inspect --json` 1.0.52 lists the
four Claude and Cursor files as `disabled`; without them, as `enabled`. The
probe ran in a synthetic home with the network denied. `inspect` reports
discovery, not prompt text. No live Grok session shows what the model sees.

#### `agentUserMcpServers` (Grok)

`GrokAdapterOptions.agentUserMcpServers: 'excluded'` applies to Agent tasks
(runs whose manifest has an `agentRef`, as every `task.offer` does); a run
without an `agentRef`, and the default `'inherit'`, are unchanged. Grok has no per-process switch for the servers of
`~/.grok/config.toml`, a project `.grok/config.toml` or `.mcp.json`, or
plugins, and `GROK_CONFIG` cannot set `disabled_mcp_servers`. So the adapter
turns off what it can and refuses the start when anything else is on:

- It sets `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED` and
  `GROK_MANAGED_MCPS_ENABLED` to `0` on the Grok agent process.
- Before the agent starts, it runs `grok inspect --json` with the agent's
  command, task cwd and environment, through the same `spawnFn`. The start
  fails if inspect lists an MCP server that is not `disabled`, or an enabled
  plugin that provides MCP servers, or if inspect fails, times out (5 s),
  prints more than 16 MiB or prints output the adapter cannot read.

A user who keeps all their servers in `~/.claude.json` or `~/.cursor/mcp.json`
can run Agent tasks; any enabled server in a Grok-native source stops them.
The Host reads which ones from the failure reason. Two sources are not
detected:

- A server turned on while the session runs: a project `.grok/config.toml`
  hot-reload, `/mcps` or `grok mcp enable`.
- Managed MCP that an administrator pins on: `managed_mcps.enabled` is a
  `pin` key, and offline inspect does not show managed servers.

`inspect` reports discovery. It over-reports in two places, which refuses
more, never less: a server in `disabled_mcp_servers` is listed without a
`disabled` mark, and a project `.mcp.json` in an untrusted folder is listed.
A plugin shows only how many servers it provides, so the reason names the
plugin. Inspect also extracts its user guide into `$GROK_HOME/docs/`, as
every Grok start does.

Probed on Grok 1.0.52 and 1.0.62 in a synthetic home with the network denied:
with the variables, `grok inspect --json` lists the `~/.claude.json` and
`~/.cursor/mcp.json` servers as `disabled`, and the `~/.grok/config.toml`,
project `.grok/config.toml` and `.mcp.json` servers and the plugin as before.

The start fails as a non-retryable `authority` failure, class `unknown`. The
reason names servers with their inspect source type, and plugins, never
paths:

- `grok Agent user MCP server exclusion refused: Grok still loads MCP servers outside the task: <name (source)>; enabled plugins provide MCP servers: <plugins>`
- `grok Agent user MCP server exclusion refused: grok inspect failed`

### Pi: user-level configuration

The ordinary [Pi RPC host](../packages/client/src/bin/pi-rpc-host.ts) deliberately
loads the user's extensions and skills beside SDK extensions. Its task MCP launch
file does not disable the normal resource loader or all ambient context sources.
Credential custody and environment filtering also do not establish prompt
isolation: the allowlisted environment retains home/config discovery paths.

Pi 1.5.0 reads its agent directory, `$PI_CODING_AGENT_DIR` or else
`~/.pi/agent`. From it, Pi loads a context file (`AGENTS.override.md`,
`AGENTS.md` or `CLAUDE.md`), `SYSTEM.md`, `APPEND_SYSTEM.md`, extensions,
prompts, themes and skills. It also loads skills from `~/.agents/skills`. The
context walk goes from the cwd up to the filesystem root and does not stop at
the git root. So an `AGENTS.md` or `CLAUDE.md` in `~` loads for an Agent home
below `~`. The SDK host accepts no Pi resource flag. The agent directory also
holds `auth.json`, `models.json` and the sessions. The SDK has an ordinary-Pi
option for user instructions: Agent tasks accept
`PiAdapterOptions.agentUserContext: 'excluded'` (see
[Pi explicitly authorized resources](#pi-explicitly-authorized-resources)).
`agentUserContext: 'excluded'` excludes user-level resources and the instruction
files of every directory above the Agent home. Instruction files in the Agent
home (`lease.canonicalHome`) itself and its subdirectories load as usual, the
same rule as Claude.

The host bundles pi-web-access and rpiv-todo as replaceable extensions. When
another loaded extension registers one of their tool, command or flag names,
for example the user's own install of either package, Pi leaves the bundled
one out instead of failing the launch on the name conflict, and the host writes
a line to stderr naming it.

`excluded` keeps the model selection of the user's global Pi settings
(`defaultProvider`, `defaultModel`, `defaultThinkingLevel`; project settings are
not read). A new session without an explicit model must start on exactly that
default, which must name a model with configured auth. Otherwise the host exits
before any provider request, instead of taking whichever provider has a key. A
resumed session keeps the model its transcript recorded, and refuses to start
when that model is no longer available.

The [prepared Pi session](../packages/client/src/adapters/pi/prepared-session.ts)
is different: it uses in-memory settings and disables discovered extensions,
skills, prompt templates, themes and context files, supplying the sealed system
prompt and SDK extension explicitly. This is an existing prepared-execution
contract, not a toggle on ordinary Pi. The Host must put the intended Agent-home
persona into the prepared input; the disabled context loader does not load
`AGENTS.md` on the Host's behalf. Provider/auth/model resources and the durable Pi
lane have separate contracts; this does not certify an OS-level sandbox.

### Hermes: user-level configuration

The [Hermes adapter](../packages/client/src/adapters/hermes/hermes-adapter.ts)
removes ambient `HERMES_*` variables and supplies a fresh execution-specific
`HERMES_HOME`. Its [profile builder](../packages/client/src/adapters/hermes/hermes-home.ts)
writes SDK-owned configuration with Hermes memory and user-profile loading
disabled, carrying only designated model metadata caches. This isolates that
Hermes profile from the normal user home. It does not promise that arbitrary
runtime tools, project files or the rest of the process environment are isolated.

Hermes 0.22.2+2364.g0b10b9f reads `SOUL.md` from `HERMES_HOME`, so it seeds
its own default text in the fresh home. It reads `MEMORY.md` and `USER.md` only
when they are enabled. Project context comes from the cwd and the git-root
chain; Hermes has no user-level context file. Skills come from trusted project
directories, `HERMES_HOME/skills` and configured skill directories, which the
SDK profile does not set. No user-level instruction source reaches the
session, so Hermes needs no option.

### dsh: user-level configuration

The [dsh adapter](../packages/client/src/adapters/dsh/dsh-adapter.ts) runs
every session in the Host's `home` as `DSH_HOME` and refuses `~/.dsh` and
anything below it. It drops ambient `DSH_*` variables and sets `DSH_HOME`,
`DSH_AGENTS_HOME` (an empty `byok-agents-home` directory in that root),
`DSH_PERMISSION_MODE` and `DSH_TELEMETRY_MODE=DISABLED` itself.

dsh 0.2.2-rc.1 reads user context from `$DSH_HOME/AGENTS.md`,
`$DSH_HOME/skills` and `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`),
and user MCP servers from the profile and home `cordis.patch.yml` files under
`DSH_HOME`. With the SDK root none of the user's own copies apply, so dsh needs
no option. Project context still loads: the workspace `AGENTS.md`/`CLAUDE.md`
(and `.local` overrides) and the project `.agents/skills`. The runtime contract
suite checks this with markers in `~/.dsh` and `~/.agents`. A positive control
shows that a skill in the adapter's own `DSH_AGENTS_HOME` does reach the model.

### agy: user-level configuration

The [agy adapter](../packages/client/src/adapters/antigravity/agy-adapter.ts)
points `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `GEMINI_HOME` into the
Host's `home` and refuses the user's home and anything below `~/.gemini`. It
drops ambient `GEMINI_*`, `GOOGLE_*`, `AGY_*` and `ANTIGRAVITY_*` variables and
the `XDG_*` directory variables, because agy reads and removes
`antigravity/credential-user-scope` in the user config directory.
`DBUS_SESSION_BUS_ADDRESS` names a socket in the owned home that does not exist:
agy looks for the session bus, and an address that cannot connect fails as on a
host with no bus, without starting `dbus-launch`.

Those directories also apply to every tool agy runs. agy and its tools cannot see
the user's git identity or global git config, and on Linux they cannot reach the
system keyring, because the session bus is unconnectable. git and `gh` read their
config from the owned home; system-level git config, such as a system credential
helper, is still read on every OS. On Windows, Credential Manager stays reachable,
and a system-configured git credential helper can use it. On macOS, the SDK does
not isolate the keychain, and whether agy reads it was not checked.
`systemctl --user` stops working without
`XDG_RUNTIME_DIR`. Container sockets are not cut off: rootless podman can fall
back to `/run/user/<uid>`, and a rootful `/var/run/docker.sock` stays reachable
for a user in the docker group. On Windows, npm and similar tools read
`%APPDATA%` from the owned home. A Host that needs a git identity passes
`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
`GIT_COMMITTER_EMAIL` through `runtimeEnvironment`.

agy reads user context and MCP
servers from `.gemini` below that home, so the user's own copies never apply and
agy needs no option. Project context still loads: agy reads `AGENTS.md`,
`GEMINI.md` and `.agents/AGENTS.md` from the workspace, and it walks up to a
`.git` root. The runtime contract suite checks this with markers in the ambient
home, and a positive control shows that files in the adapter's own home reach
the model. agy always keeps conversations in that home, because resume needs
them; the `agy-session-store` retention class expires them. A daemon cleans up
sessions for one agy home only.

### Agent task session records

An Agent task runs in the Agent home, but a runtime may save the session
record elsewhere. Deleting the Agent home does not remove such a record. The
SDK does not delete runtime records itself: their paths follow each runtime's
own rules. Whether the SDK can turn a runtime's record off is the
`isolation.sessionPersistence` row of the [capability matrix](#capability-matrix);
for Claude it is `agentSessionPersistence: 'disabled'`, below.

| Runtime | Where an Agent task's session record goes |
| --- | --- |
| Claude | `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/<session>.jsonl`, outside the Agent home |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. The adapter does not set `CODEX_HOME`, so normally under `~/.codex` |
| Grok | `$GROK_HOME/sessions/<encoded cwd>/<session id>/`, and the `sessions/session_search.sqlite` index. The adapter does not set `GROK_HOME`, so normally under `~/.grok` |
| Pi, ordinary, Pi login | The settings `sessionDir`, else `<agent dir>/sessions/--<encoded cwd>--/<time>_<id>.jsonl`. The agent directory is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` |
| Pi, ordinary, Keys profile | `DaemonConfig.piByokLauncher.sessionDir/<time>_<id>.jsonl`, one folder for every execution, which the Host chooses |
| Pi, prepared | None: the session is in memory |
| Pi, durable | `durable-<taskId>.sqlite` replica in the daemon store, disjoint from the Agent home, removed after its retention TTL; the lane recovers from it |
| Hermes | `state.db` and `sessions/` in the execution's profile, `<home>/profiles/byok-<id>/`, removed when the execution closes, or by the 15-minute sweep after a crash |
| dsh | `<home>/sessions/<encoded cwd>/<session id>/` in the Host's dsh root, kept so that `agents.resume` works; the adapter never removes it |

What the upstream runtimes offer that the SDK does not use:

- Codex: the 0.164.0 app-server schema has `ephemeral` on `thread/start` (a
  thread that "should not be materialized on disk"), and `codex exec --help`
  lists `--ephemeral`. The [launch](../packages/client/vendor/oar/45488e7/runtimes/codex/open.ts)
  does not send it. Inferred: 0.160.0 has the field, and an ephemeral thread
  leaves the other `CODEX_HOME` files alone.
- Grok: `grok` 1.0.62 has no persistence flag, and the `session/new` `_meta`
  keys of its agent-mode guide have none. From the 1.0.62 guide and local
  folders; not probed with an SDK session or on 1.0.52.
- Pi: Pi 1.5.0 has `SessionManager.inMemory` and the CLI flag `--no-session`
  ("Don't save session (ephemeral)"). The SDK
  [host](../packages/client/src/bin/pi-session-runtime.ts) opens a saved session
  and accepts no such flag.

#### `agentSessionPersistence`

`ClaudeAdapterOptions.agentSessionPersistence: 'disabled'` starts an Agent
task (a run whose manifest has an `agentRef`, as every `task.offer` does) with
`--no-session-persistence`. Claude 2.1.302
describes the flag as "sessions will not be saved to disk and cannot be
resumed", and it works only with `--print`, which the adapter always uses.
The adapter starts one Claude process per task, so the flag also covers every
follow-up of the task. The default, `'enabled'`, sets nothing, and other tasks
are unchanged.

Such a session cannot be resumed. An Agent task that carries a
`sessionRef` (a resume, an Agent handoff or a memory-reader resume) fails
before Claude starts, writes no file and runs no fresh session in its place.
The failure is a non-retryable `authority` failure with the reason `claude
Agent session persistence is disabled, so the task cannot resume a session`.
The daemon still records the session handoff of such a task, so a later offer
with that `sessionRef` reaches the adapter and fails there. The descriptor
keeps `resume: true`, because ordinary tasks can still resume.

Auto memory also writes under `projects/<encoded cwd>/memory/`. This option
does not turn it off; `agentUserContext: 'excluded'` does, and the two
options apply together.

An offline probe of Claude 2.1.302 started `-p --input-format stream-json
--output-format stream-json --verbose` with a temporary `HOME` and
`CLAUDE_CONFIG_DIR`, an invalid `ANTHROPIC_API_KEY` and the network denied by
`sandbox-exec`. No request left the machine; Claude retried the API until the
probe killed it.

- Without the flag, `system/init` carried a `session_id`, and
  `projects/<encoded cwd>/<session>.jsonl` held the user message, the
  attachments and the API request bodies.
- With the flag, `system/init` still carried a `session_id`. Under
  `projects/` there was only an empty `<encoded cwd>/memory/` directory.
- With the flag and auto memory off (the `env` setting that
  `agentUserContext: 'excluded'` writes), there was no `projects/` directory.
- In every run, Claude also wrote `.claude.json` and its backup,
  `sessions/<pid>.json` (the process's cwd and session id) and a failed
  telemetry event under `telemetry/`, none with the instruction text. The
  probe killed the process, so whether a clean exit removes
  `sessions/<pid>.json` is not shown. No tool ran, so `file-history/` and
  `shell-snapshots/` stayed untested.

Fixture tests prove the launch flag, the follow-up on the same process and
the refusal.

As with `agentUserContext`, `createDaemon` builds the Claude adapter without
options. A Host sets this option on its own `ClaudeAdapter` through
`createDaemonWithAdapters`.

### Evidence and remaining qualification

Existing offline evidence includes `environment.test.ts` (environment inheritance),
`claude-adapter.test.ts` (additive MCP launch; under `agentUserContext:
'excluded'`, the strict MCP flag, the settings file and the refusals),
`claude-agent-user-context.test.ts` (exclude patterns for POSIX and win32
homes, a reader cwd, `CLAUDE_CONFIG_DIR`, glob syntax in a parent),
`grok-adapter.test.ts` (the
four variables reach the agent process only with
`compatInstructions: 'disabled'`, and never a hosted terminal command),
`pi-rpc-host.test.ts` (user resources beside SDK extensions),
`pi-prepared-tools.test.ts` (frozen tool surface), and
`hermes-home.test.ts` (profile contents). The
[evidence note](researches/2026-10-22-634-runtime-user-config.md) records the
pinned-version sources, the Claude loader reading, a local Claude probe
against a fake endpoint, and the `grok inspect` probe. The
[#871/#873 evidence note](researches/2026-10-24-871-873-claude-agent-user-context.md)
records a probe of Claude 2.1.302 with the `agentUserContext` flags in a
synthetic home: user markers and auto memory absent, Agent-home files present,
the user MCP server gone, and the deny rule and hook still in effect. These fixtures check
launch arguments and environment. They do not
prove an installed CLI's entire prompt contains no user rules. No provider
ran, and no global configuration changed.

For an “Agent home only” guarantee, qualify the exact runtime version with
synthetic user-rule and Agent-home markers in a live session, show user
markers absent while the persona remains present, and cover resume behavior
and credential discovery. Until then, Hosts requiring that guarantee must
treat the Claude, Codex, Grok and Pi lanes as unqualified, with or without the
Grok option. [Issue #634](https://github.com/Ancienttwo/byok-sdk/issues/634)
tracks that remaining work; adding persona text alone does not establish isolation.

## Grok

`GrokAdapter` runs Grok Build over ACP: `grok agent --always-approve
--no-leader stdio`, through the vendored OAR Grok profile
(`packages/client/vendor/oar/45488e7`). The ACP stack is a private entry that
loads at session start, so `@byok-sdk/client/adapters` carries no ACP
dependency.

- Identity: the descriptor id is `grok`. It is not a frozen wire runtime id,
  so a task selects it with the custom-harness identity (`harnessId: 'grok'`,
  server capability `custom-harness`). It takes no dispatch selection. The
  model is the `model` adapter option (`session/set_model`).
- Ownership: the SDK spawns, adopts and reaps the agent process and every
  `terminal/create` command Grok asks the client to run. Each gets the explicit
  task environment. The retained records have the same 16 MiB default budget
  as Codex.
- Permissions: Grok runs in its own approve-all mode. A permission request
  that still reaches the client (a user's own shell `ask` rule or `ask` hook)
  is answered `cancelled` and recorded. Grok 1.0.52 then ends the turn as
  cancelled and calls no model, so the task fails as semantic and
  non-retryable unless the SDK asked for the cancel. A `reject_once` answer
  ends the turn the same way. The SDK adds no second permission layer.
- MCP toolsets: task stdio servers go in the ACP `mcpServers` of
  `session/new` and `session/resume`.
- Closing reply: Grok streams text. The adapter emits one `progress` event per
  text run; a tool call or the turn end closes a run. The daemon publishes the
  last run as the closing reply when Grok does not call `send_agent_message`.
  Sub-agent sessions produce no events for the parent.
- Tool input: `tool_use.input` is the native `rawInput` object of the opening
  `tool_call` frame. When that is not an object, `input` is left out.
- Resume: ACP `session/resume` with the exact id. Its answer carries no id, so
  the resumed identity is the requested one by construction; the conformance
  identity-drift case does not apply. A missing session fails closed.
- Interrupt: `session/cancel`, then a wait for the cancelled prompt answer,
  bounded by `interruptTimeoutMs` (default 1000 ms). OAR still kills the
  process when Grok answers nothing for 10 s.
- Detection: `grok --version` (advisory when it is not the qualified 1.0.52,
  the newest OAR live evidence), `grok agent stdio --help` (else
  `refused: acp_unavailable`), and a login signal: `$GROK_HOME/auth.json`
  (default `~/.grok/auth.json`) exists, or `XAI_API_KEY` is set. The file is
  never read and no session opens.
- Agent memory: the daemon puts the memory guidance, including the
  memory-reader read-only rule, into the prompt text, so Grok receives it with
  each instruction. Grok's native project instruction discovery requires folder
  trust; canonical Agent-home cwd alone does not establish that trust. For a
  fresh strict-Agent session, the adapter reads only `AGENTS.md` from the sealed
  lease's canonical home and appends it through `session/new._meta.rules`.
  The file must be a stable regular UTF-8 file, at most 64 KiB; symlinks and
  unsafe reads fail with a non-retryable authority error. Missing/empty files
  add no rules. Reader sessions keep their sealed run cwd; ancestor and run
  directory instruction files are not scanned by this SDK injection. A fresh
  reader runs in `<home>/.byok/runs/<taskId>` and gets the home `AGENTS.md`.
  A resumed reader runs again in the run directory its handoff recorded,
  which must be a direct child of `<home>/.byok/runs/`.
  Persona-bearing Agent resume is refused with `grok Agent persona resume is
  not qualified`: append-only rules cannot safely be reapplied on resume.
  Ordinary non-Agent resume and Agent resume with no persona are unchanged.
  `grok-reader-persona.test.ts` runs these reader cases through the real
  `TaskRunner` and Agent home against the fake ACP agent.
  The adapter does not grant folder trust, change trust configuration, load
  hooks/skills, or replace Grok's built-in prompt. Synthetic ACP fixtures verify
  routing and unchanged launch policy, not model adherence or runtime trust
  semantics. Live persona and unchanged MCP/hooks trust acceptance remain
  pending (#628); no new Grok version is qualified by this change.
- Platforms: macOS and Linux. The descriptor declares
  `platforms: ['darwin', 'linux']`, so detection on Windows is refused with
  `platform_unsupported` and runs no probe, and a daemon dispatches no Grok
  task there. Windows has fixture evidence only. The `adapter-lifecycle-smoke`
  Windows leg runs `grok-windows-contract.test.ts`, which drives the adapter
  directly against the fake ACP agent behind a compiled launcher: one turn, a
  hosted terminal command with the task environment, `session/cancel`, and the
  end of the agent tree and of a hung terminal tree on close. Before Windows
  can join the descriptor, a live Windows run must show detection and the
  login signal with the real `grok.exe`; an ACP session with model selection,
  `_meta.rules` and resume; the shell lines that the real Grok sends, which run
  under `cmd.exe` (the fixture sends only a Node command line); and the end of
  the real agent's own child processes.

The fixture suite proves the adapter contract against a fake ACP agent. It is
not live certification. No live Grok run is part of CI.

## Hermes adapter (custom harness)

`HermesAdapter` (id `hermes`, #519) is outside the shared conformance runner,
which assumes native resume. It runs on the custom-harness path
(`harnessId: 'hermes'`). Its declared capabilities are in the
[capability matrix](#capability-matrix). How it meets them: it does not resume,
because each execution has a fresh Hermes profile and `prepare()` rejects
`sessionRef`; steering returns a typed `SteerUnsupportedError`; a new
instruction after an idle turn stays in the same ACP session; task MCP toolsets
go to ACP `session/new.mcpServers` stdio entries; and each
`agent_message_chunk` is one draft `progress`. It sets no MCP identity on tool
events, because the ACP title is the Hermes registry name, not an authoritative
identity. It omits the legacy boolean approval and native interactions, and
declares no trajectory evidence.

Hermes runs edits in ACP mode `dont_ask` and commands under `--yolo`. A
permission request that still arrives (Hermes's guard on sensitive paths and
agent instruction files) is refused with its `reject_once` option. The tool
fails and the model sees the refusal. The adapter owns the Hermes gateway
process tree and checks the gateway identity before and after the viewer
attaches.

Hermes declares no `toolAuthorizationAuto`, so nothing asks before a tool runs;
an `all`-mode Task gets a reminder after the call starts. Hermes's ACP
`tool_call` has no tool name, and its own tools send no `rawInput`. The
[projection](../packages/client/src/adapters/hermes/projection.ts) takes the
name from the title, the path from `locations`, and a shell command from the
`$ ` content line. These are Hermes display conventions, so a Hermes upgrade
must check them again. The classifier has three limits on Hermes:

- A call with several `locations` is classified on the first one.
- A V4A `patch` (`mode: 'patch'`) names no path until its result, so a V4A
  write outside the workspace raises no reminder.
- Stdin written to a running `process` and shell commands run from
  `execute_code` are never seen as commands, so `all`-mode reminders miss them.

Platform notes:

- POSIX: the adapter asks the gateway `identify` over the Unix socket
  `<profile>/gateway.sock` (or the path in `gateway.sock.path`). The gateway
  pid must be the pid the adapter spawned.
- Windows: the adapter uses the named pipe
  `\\.\pipe\hermes-gateway-<hash>` that Hermes derives from the profile
  home (`windows_pipe_name` in Hermes `gateway/control_socket.py`). A
  console-script `hermes.exe` and the custody launcher start Hermes's Python as
  a child. So a gateway pid at most four parent links below the spawned pid is
  owned. The adapter reads the process table once per start with PowerShell
  CIM (about 0.4 s warm, 3.5 s cold on `windows-latest`). Hermes gives the pipe
  a DACL for the current user only. The adapter dials the pipe through
  kernel32 at the identification level (Node's `net` client would allow the
  server to impersonate the daemon), takes the server pid from the kernel and
  sends `identify` only to a server it owns. It stops a foreign gateway only
  when that pid runs below the viewer the adapter started. The profiles
  directory, and a root the adapter creates, get a DACL for the current user,
  SYSTEM and Administrators. A root that already exists keeps its ACL, so do
  not put it where other users can write.
- Windows custody: the launcher cannot replace itself, so it starts Hermes as
  a child and stays alive until Hermes exits (see the client README).
- Windows executable: give `resolveBin` the `hermes.exe` that Hermes's
  installer publishes (`<Hermes home>\bin\hermes.exe`, a console-script
  launcher). Node does not start a `hermes.cmd` shim without a shell.
- Windows root: the user's Hermes home there is `%LOCALAPPDATA%\hermes`, so
  the adapter refuses that path and anything below it as `home`, as it
  refuses `~/.hermes`.

Evidence: `hermes-adapter.test.ts` and `hermes-custody.test.ts` (synthetic
`fake-hermes.mjs`, offline), `hermes-gateway-control.test.ts` (pipe name
against Hermes's own hash, ownership walk), and the
[S0 note](researches/2026-10-20-519-hermes-acp-s0.md), which records one real Hermes
`0.22.2+2364.g0b10b9f` turn with a fake model endpoint on macOS. On Windows
the fake suites run behind a compiled `hermes.exe` that starts Node as a child,
the same process shape as a venv console script; the
[Windows note](researches/2026-10-22-608-hermes-windows.md) records the runs.
`hermes-real.test.ts` runs the adapter against the real qualified Hermes on
`windows-latest` (CI job `hermes-real-windows`), with a fake model endpoint
and the custody launcher: `detect()`, `prepare()`, one turn through the owned
gateway to `turn_end`, the pipe client against the real Hermes pipe server,
and the key only in the Hermes child; the
[real-run note](researches/2026-10-26-608-hermes-windows-real.md) records it. No
live-provider run or Linux run is part of this evidence.
The descriptor declares `platforms: ['darwin', 'linux', 'win32']`.

## dsh adapter (custom harness)

`DshAdapter` (id `dsh`, #1258) runs DeepSeek Harness (`@deepseek-ai/dsh`, a
developer preview) through the vendored OAR dsh runtime. Each session runs one
`dsh --profile acp` process with the ACP protocol plugin off and OAR's private
bridge plugin on, and talks JSON lines over stdio. No ACP message is exchanged
and `@agentclientprotocol/sdk` does not load. It runs on the custom-harness path (`harnessId: 'dsh'`). It takes no dispatch selection.
`createDaemon` and `createRuntimeAdapters` build it when `runtimeAllowlist` lists
`dsh`, from the required `runtimes.dsh` (`home`, `model`, and optional `sandbox`
and `versionPolicy`). The other options stay on the `DshAdapter` constructor.

- Model: the required `model` option names `provider`, `model`, `keyEnv` and,
  for `custom`, `baseUrl`. The adapter writes the provider route, `keyEnv` and
  `baseUrl` into a per-execution `--patch` overlay (mode 0600, in the execution
  scratch directory), beside OAR's bridge overlay. The model travels as the
  session's selection, not in the patch. `deepseek` uses the DeepSeek API route; `custom` is a hand-declared OpenAI-compatible
  route; any other provider id is a dsh pi-ai catalog route. The key itself is
  only in the environment, under `keyEnv`; `baseUrl` refuses credentials and a
  query string. `keyEnv` must contain `KEY`,
  `TOKEN`, `SECRET` or `PASSWORD`, which dsh strips from tool processes. It
  must not start with `BYOK_` (the runtime environment drops those) or `DSH_`,
  and it must not be `DEEPSEEK_API_KEY`, which dsh `web_search` also reads.
- Start: dsh validates the selected route when the session opens. The first
  request must then report that route and model; any other value fails closed
  as `authority`.
- Working directory: the process starts in the execution scratch directory,
  so dsh never loads a workspace `.env`. The workspace, realpath-resolved, is
  the session `cwd`. `TMPDIR` is the execution scratch too.
- Host toolsets: dsh takes stdio `command` and `args` only. An entry with
  `type: 'http'`, non-empty `env` or `headers`, or a name outside
  `[A-Za-z0-9_-]{1,32}` is refused before dsh starts, without a retry. A Host
  that configures env for its own server cannot run it under dsh. Do not put a
  token in `args` instead: dsh persistence of MCP entries is unaudited. Entries
  are sent again on every resume.
- Permissions: `sandbox` selects `DSH_PERMISSION_MODE`. The default,
  `danger-full-access`, pairs with dsh approval `never`. `workspace-write` and
  `read-only` keep dsh's OS sandbox (seatbelt on macOS, bwrap or landlock on
  Linux). The bridge has no approval channel, so nothing waits on a human: a
  command the sandbox blocks fails with the OS error, and dsh refuses every
  escalation (`sandbox_permissions`) and returns it to the model as a tool
  error. The turn goes on either way. `auto` is declined before claim.
- Events: the adapter reads each native committed assistant message, so each
  `progress` is one message, the descriptor sets
  `progressMessageBoundary: 'event'` and declares no message draft.
  `tool_use.input` is the object parsed from dsh's complete native `arguments`
  string, never a display text, so tool authorization sees the whole input.
  Arguments that are not a JSON object fail the session as `authority`.
  `tool_result.output` carries the content blocks under `content`. `usage`
  carries the root and subagent billed tokens observed before the root turn
  ends, summed from OAR's per-session cumulative totals. Context occupancy
  stays root-only (`contextTokens`, `contextWindow`,
  `contextSource: 'provider'`).
- Turn end: an Attempt is one prompt on one process. dsh's subagents and
  background jobs outlive the turn, and when one finishes dsh opens a root turn
  with no prompt. So on the root turn end the session projects nothing more,
  closes dsh and disposes the owned process tree, and only then reports
  `turn_end` (`dsh.turnEnd`). Work started with `subagent` or `bash` with
  `run_in_background: true` stops there and its
  unfinished work is lost. This is not a failure: the model's own reply says it
  started them. `followUp` is refused; a later turn resumes in a new process
  (`dsh.resume`). After a resume dsh restarts neither: `list_agents` shows the
  subagent `[inactive]`, `job_list` is empty, and the model gets no notice. One
  narrow window remains: a background child that finishes between the root turn
  end and dsh handling the dispose can still start the unprompted turn, and that
  turn's tokens and tool calls reach no `usage` or `tool_use`.
- Failures: a failed turn's class comes from dsh's native code or status. A
  rate limit is a retryable `semantic` failure; the others are non-retryable.
  A resume of an unknown session or from another workspace is a typed refusal,
  reported as `authority`. A dsh process that ends on its own, before or after
  answering, is `runtime_exited`.
- Steering, interrupt and close: `steer` reaches the running turn's next model
  request (`dsh.steer`). An interrupt reads the process table, sends the native
  cancel and waits for the turn end, bounded by `interruptTimeoutMs`. `close()`
  asks dsh to dispose its sessions and flush its log, then disposes the owned
  process tree.
- Process tree: dsh runs each shell tool in its own process group. Closing
  the session reaps them (`dsh.close`). When the dsh root is killed from
  outside (SIGKILL, OOM), disposal ends the tool processes the owned process
  tree observed while the root ran (`dsh.sigkill`,
  [#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269)); a tool started
  within one second of that kill is not seen.
- Detection: `dsh --version` (advisory when it is not the qualified
  `0.2.2-rc.1`), then `dsh --profile acp --help`, which also writes the acp
  profile into a new root (else `refused: acp_unavailable`). `authPresent`
  means the `keyEnv` variable is set; the key is not checked.
- Egress: the DeepSeek route sends `GET https://api.deepseek.com/models` when
  dsh boots with a key. That call is free, but it is traffic. The contract
  suite's custom route has no declared host.
- Platforms: macOS and Linux. dsh ships no win32 build of its native addon.

Evidence: `dsh-adapter.test.ts` (synthetic `fake-dsh.mjs`, offline) and the
[runtime contract suite](runtime-contract.md) against the real qualified dsh.
Locally on macOS with dsh 0.2.2-rc.1, every case passes, `dsh.close`
included; `dsh.sigkill` runs in CI. The design and probes are in
[the dsh adapter plan](researches/2026-11-01-dsh-adapter.md) and
[the bridge probe](researches/2026-11-06-oar-0.91.0-dsh-bridge.md).

## agy adapter (custom harness)

`AgyAdapter` (id `agy`, #1469) runs the Antigravity CLI over its native ACP:
one `agy acp --dangerously-skip-permissions --process-per-session
--disable-telemetry` process per Attempt, driven by the vendored OAR Antigravity
profile, which loads lazily through the private `#byok-acp-runtime` entry. It
runs on the custom-harness path (`harnessId: 'agy'`). It takes no dispatch
selection. `createDaemon` and `createRuntimeAdapters` build it when
`runtimeAllowlist` lists `agy`, from the required `runtimes.agy` (`home`, and
optional `model` and `versionPolicy`). The other options stay on the
`AgyAdapter` constructor.

- Credential: put a Gemini API key in the runtime environment as
  `GEMINI_API_KEY`. `detect()` reports `authPresent` from it, without checking
  it against the provider, and a task without it fails as non-retryable
  authority. Only a Gemini API key is supported, never a Google account login.
  agy passes its whole environment to `run_command` and stdio MCP children, so
  the key stays in the daemon process. Each agy process gets its own proxy on an
  ephemeral `127.0.0.1` port, started before agy and closed when agy exits. agy
  holds that address and a random per-session token as its `GEMINI_API_KEY`. The
  proxy refuses a request without the token, replaces the token with the real
  key, and forwards to `https://generativelanguage.googleapis.com`, whatever the
  request names. It stores and logs neither the key nor any body. A proxy that
  cannot start fails the task before agy starts, and that failure is retryable.
  `agy.keyIsolation` proves the key reaches the provider and neither a tool nor
  a stdio MCP server.
- Residual risk: during a session, commands and MCP servers agy starts can read
  the token and spend the user's quota through the proxy, on any path of the
  Gemini API, but they cannot take the key.
- Network proxy: the daemon's connection to Gemini honors `HTTP_PROXY`,
  `HTTPS_PROXY` and `NO_PROXY` from the runtime environment only, never the
  daemon's own environment. Only `http` and `https` proxy URLs work: `ALL_PROXY`
  is ignored, and a SOCKS URL means a direct connection. A malformed proxy URL
  fails the start, and no proxy URL appears in an error, because it may carry a
  password. agy itself never sends its loopback requests into a configured proxy.
- Login state: with no stored login, the measured model request carries only
  the API key, in `x-goog-api-key`, and no `Authorization` header. Whether agy
  switches to a stored Google login when one exists is not verified, and the
  APPDATA redirection does not affect Windows Credential Manager. Whether agy
  reads the macOS keychain was not checked, and the SDK does not isolate it.
- Host toolsets: agy rejects Host toolset entries carrying `env` or `headers`;
  a Host that configures env for its own server cannot run it under agy. agy
  persists session MCP entries in its conversation database; upstream found env
  and header values there in plain text after close (botiverse/oar#392). Treat
  `args` the same way: do not put tokens in `args`.
- Instructions: a writer runs in the Agent home, where agy reads `AGENTS.md`
  itself, so nothing is appended. A `memory-reader` runs in
  `.byok/runs/<task>`, which agy does not read from, so the persona is
  appended, on every open because agy replaces its append on resume. If the home
  has `.git`, agy walks up to it and that reader sees the persona twice; agy has
  no root-marker option.
- Tools: MCP tools are `mcp_<server>_<tool>`, verbatim. `run_command`,
  `read_file`, `write_file` and `edit_file` spell their inputs `CommandLine` and
  `Path`, so the projection adds `command` and `path` for tool authorization.
  `tool_use.input` is otherwise the structured raw input of the opening frame,
  never OAR's capped text; a call without one has no input.
- Turn end: an Attempt is one prompt on one process. Subagents and schedules
  run in the background and report no ACP frame, so on `end_turn` the session
  closes agy and disposes the owned process tree before it reports `turn_end`.
  That includes a `run_command` with `IsDaemon`, which leaves the process group
  (`agy.turnEnd`). `followUp` is refused; a later turn resumes in a new process,
  and no wait is needed. Schedules die with the worker: none survived a kill,
  and on resume agy tells the model its background tasks were stopped. What a
  subagent did before the kill reaches no reminder and no audit.
- Permissions: agy still asks for a file outside its workspace, and a
  `cancelled` answer ends the turn as a success, so the adapter answers with an
  explicit option. A writer gets `allow_once`. A `memory-reader` gets
  `allow_once` for reads, `reject_once` for a write below the home outside its
  run directory, and `allow_once` otherwise. `--add-dir` is not used, because it
  would also allow those writes. agy ends the turn after `reject_once`, so that
  Attempt fails as non-retryable `semantic`. `run_command` is never asked.
  `auto` is declined before claim.
- Detection: `agy --version` must be at least 1.5.0, the first with native ACP
  (an older CLI answers `acp` with its help, else `refused: acp_unavailable`),
  and warns when it is not the qualified `1.5.1`. `authPresent` is not reported,
  because the credential is not in agy.
- Failures: a failed turn takes its class from the vendored OAR outcome, and a
  class taken from error text stays `unknown`. Resume needs `session/list` to
  confirm the saved cwd, else it fails as `authority`.
- Steering redirects the active turn through native ACP. agy reports no usage events.
- Egress: `--disable-telemetry` stops agy's calls to `play.googleapis.com`, and
  `AGY_CLI_DISABLE_AUTO_UPDATE=1` is always set.
- Platforms: macOS, Linux and Windows.

Evidence: the `AgyAdapter` cases in `grok-adapter.test.ts` (synthetic
`fake-acp-agent.mjs`, offline) and the [runtime contract suite](runtime-contract.md)
against the real qualified agy, including a Windows leg.

## Selection and platforms

A Host reads the adapter list, not a table of its own. `taskRuntimeTarget(descriptor)`
from `@byok-sdk/client/adapters` returns `{ runtime }` for a frozen wire runtime
id (`RUNTIME_IDS` in `@byok-sdk/protocol/constants`) and `{ harnessId }` for any
other id. `descriptor.platforms` lists the supported `process.platform` values:
Claude, Codex, Pi, Hermes and agy declare macOS, Linux and Windows; Grok, dsh
and durable Pi declare macOS and Linux. A descriptor without `platforms` has no platform
restriction. `observeRuntimeDetection` refuses an unsupported platform with
`platform_unsupported` before `detect()` runs, and `projectRuntimeObservation`
gives the same fields the daemon emits in its `runtimes-detected` event. Both
are in the transport-free `./adapters` entry. A refused adapter is not
advertised in `conn.hello`, so the cloud rejects a submit for that harness
before an offer exists. An explicit offer that does reach the daemon is
declined with a `platform_unsupported:` reason and `retryable: true`.
`@byok-sdk/client/testing` exports `fakeRuntimeAdapter(id, behavior)`, whose
descriptor is the real adapter's default descriptor.

On Windows, Claude and Codex find their command as cmd.exe does: PATH order,
then PATHEXT order (#763). They never search the current directory: a command
that is not on PATH gives `not-found`, and the spawn does not search either. A
native `.exe` or `.com` runs directly. npm installs both CLIs as `.cmd` shims,
and Windows cannot start a `.cmd` without cmd.exe. The adapters do not use a
shell, so cmd.exe never interprets a task argument. For an npm shim (cmd-shim
4.1.0 or later, npm 8 or later) of a `#!/usr/bin/env node` bin with no extra
node arguments, the adapter runs the shim's JavaScript entry with the node that
the shim selects: `node.exe` next to the shim, else `node` on PATH.
`BYOK_CLAUDE_BIN` and `BYOK_CODEX_BIN` can name a full `.cmd` path. Older npm
shims, pnpm and yarn shims, shims with node arguments, `#!/bin/sh` shims and
any other `.cmd` or `.bat` are refused as `not-executable`. A refusal names no
local path. Detection and launch use the same resolution. Evidence:
`adapter-task-smoke.mjs` installs fixture packages with the real npm on each
OS. It detects both runtimes through PATH and through the override variable,
and it runs and cancels their tasks through the shims.

## What the qualification suite proves

`packages/client/src/__tests__/adapter-capability-conformance.test.ts` runs the
same assertions for the actual Claude, Codex and Grok adapters. Its test-only runner
lives in `fixtures/adapter-capability-conformance.ts`; it uses the established
prepared-operation path and existing synthetic CLI fixtures. It adds no
production transport, provider dependency, or package dependency cycle.

The shared default-construction assertions require:

- Immutable descriptor facts matching the adapter's behavior.
- Resume through the native operation, with the exact original session ID.
  Claude must emit the real `--resume` argument; Codex must emit
  `thread/resume` and must not silently use `thread/start`.
- Rejection of missing native sessions and mismatched returned identities.
- A separate idle follow-up that retains the native session identity.
- Positive steering evidence using the active Codex turn ID, or Claude's
  typed `SteerUnsupportedError`. Queuing a later turn is not steering.
- No advertised or callable SDK fork/rollback operation.
- Rejection of `confirm` before binary resolution or subprocess invocation.
- Explicit failure of both legacy approve and reject requests when the
  adapter cannot support the interactive product lane.
- Idempotent disposal while a synthetic turn is still active.

The fixtures use an isolated temporary HOME and an explicit environment.
They do not call a model provider or use a real login. A passing fixture
test establishes adapter-contract regression coverage, not live vendor
certification. Codex's existing version admission and the adapter-specific
fixture suites remain necessary evidence; this runner does not replace them.

From the repository root, after the normal frozen dependency install and build:

```sh
cd packages/client
bun run test src/__tests__/adapter-capability-conformance.test.ts
```

The root-required build, typecheck, test, API-surface and version-authority
checks remain release gates. Running only the command above is not a full
repository pass.

## Opt-in native interaction evidence

Constructing a Claude or Codex adapter with `nativeInteractions.onRequest`
enables a local Host callback and `Session.interactions`. The callback receives
its response channel directly, including a request arriving before session startup
returns; a Host must not wait for startup to finish before answering that request.
Neither the remote
boolean approval protocol nor a browser/mobile transport is added. Hosts use
the callback's exact request ID and channel to submit typed answers, and may
read a pending snapshot in that same live process. Restarted/resumed processes
receive a new generation and cannot answer the old process's requests.

- Claude uses the official stdio initialize/can_use_tool protocol for
  AskUserQuestion; other requests are allowed at once without a Host prompt. It
  never emits persistent permission updates. Questions preserve exact question text,
  selected labels, multiple selections and free text. Unknown native controls,
  reused IDs and malformed requests dispose the process.
- Codex 0.160.0 keeps `approvalPolicy: never`; command/file approval requests
  are refused as unsupported. Questions preserve native
  question IDs and answer arrays. Exact active-turn and resume-thread checks
  precede Host callbacks. Permissions profiles, dynamic tools and MCP
  elicitation remain unsupported.
- Native response writes have bounded acknowledged transport ownership.
  Duplicate equal answers join one result; conflicts/late answers cannot send
  another response. Native cancellation, timeouts, interrupts and process exit
  invalidate requests without converting them to steer text.

`structuredQuestions` describes the installed bridge capability. A task must
also expose the provider's question tool; the user's own agent configuration
can remove it. Native interactions never prompt for tool permission; that is
the task's `auto | all` decision.

The enabled-mode suites are `native-interactions.test.ts`,
`claude-native-interactions.test.ts`, `codex-native-interactions.test.ts`, and
`codex-native-write.test.ts`, with existing control/transport and OAR tests.
All are offline fixtures, not live-provider or desktop certification. Exact
inspected source revisions and hashes are in
[the native protocol inventory](researches/2026-10-06-native-interaction-sources.json).

## Native interaction qualification gate

The SDK interaction lifecycle may be tested independently of a provider
adapter. That does not qualify a provider wire mapping. Before an adapter can
advertise native approval or structured-question support, it needs verified
request and response schemas, exact native ID preservation, an explicit
supported decision set, and adapter tests showing a response reaches its
original native request. Unsupported request kinds must remain unsupported.

Qualification must also exercise cancellation, timeout, duplicate/late
responses, a closed or replaced session, and recovery of pending prompts
within a live session. A new process lifetime needs a new local generation
even if it resumes the same native session ID. A stored prompt or an old
browser form cannot authorize a reply in the replacement process.

Cross-process pending-interaction recovery and remote Host delivery are not
implemented by this matrix. Pending prompt display is not replay authority.
An approval answer is not a steer message. Follow-up text is not a structured
answer. Never substitute one operation to make an unsupported feature appear
to succeed.

## Trajectory evidence

`RuntimeAdapterDescriptor.trajectoryEvidence: 'event-stream'` declares
`Session.events` as the evidence source of the daemon's local execution record
(#553). The declaration states these facts:

- Every `tool_use` and `tool_result` carries its `toolCallId`.
- `turn_end` means that the runtime completed.
- `Session.evidence()` counts runtime output that the session could not turn
  into events: undecoded frames, unmapped frames, and tool results that the
  adapter made itself. The counts cover the whole session up to `close()`.
  The Session must implement `evidence()`, and returns zero counts when
  nothing was dropped.

An adapter without the declaration gets `unknown` records
(`source_not_declared`). A declaring adapter whose started Session has no
`evidence()` gets `unknown` records (`evidence_missing`); the task runs and
ends as usual. A declaration names the collection surface. It does
not prove that each run is complete. The record never changes the terminal or
a retry decision. Downstream read paths and display text are in section 7 of
the [downstream diagnostics guide](agent-diagnostics-integration.md).

- Pi: `PiAdapter` declares `event-stream`. With `durableLane: true` it does not
  declare it, because T0 did not verify the durable worker's own frames and
  respawn path. `PiSession.evidence()` counts stdout lines that are not a JSON
  object, an unterminated last line, and unmapped frame types. It reports no
  synthetic results. The evidence is the
  [Octop T0 note](researches/2026-10-20-octop-t0-pi-trajectory.md) and
  `pi-execution-record.test.ts`. T0 read the emit path of the pinned Pi 1.3.0,
  ran its core with a synthetic model stream, and replayed synthetic RPC
  records. No live Pi run or provider call is part of this evidence. A killed
  Pi process has no pairing guarantee. A run that a kill cuts short is
  `partial`.
- Claude and Codex: not declared. Slice T2 of #553 would add their counts.
  The owner decides on T2 after Pi verification.
- Custom adapters: declare only with your own evidence for the facts above.
  Treat the runtime's routine bookkeeping frames as expected, not unmapped.
  If you do not, every normal run is `partial`. A shared runtime name does not
  inherit the Pi declaration.

## Wrapping a Session

A Host that wraps an adapter or its `Session` (admission, ownership, audit,
metering) keeps the adapter's descriptor, so the wrapped Session must carry
every member that descriptor declares. The daemon binds those members once,
when `start()` returns, and never falls back to "no capability":

- `progressMessageBoundary: 'session'` (Claude) requires
  `Session.progressStartsMessage()`. Without it the daemon closes the session
  and fails the task at start with `runtime_session_incomplete`
  (`task.fail`, non-retryable, failure class `unknown`).
- `trajectoryEvidence: 'event-stream'` (Pi RPC lanes) requires
  `Session.evidence()`. Without it the task runs as usual, and its execution
  record is `unknown` (`evidence_missing`).

A wrapper also yields the inner event objects unchanged, because
`progressStartsMessage(event)` recognizes the objects its own `events`
yielded, and reads `sessionRef` from the live inner session rather than a
copy taken at start.

## Local admission declarations

Three adapter declarations are local facts the daemon reads instead of the
runtime id. None of them reaches the wire, and a custom adapter that shares a
built-in runtime name does not inherit them.

- `RuntimeAdapterDescriptor.fileScope: { lanes }`: the lanes on which the
  adapter enforces an explicit `ToolAuthorizationPolicy.fileScope` (#1061).
  A scoped offer on any other lane, or on an adapter without the declaration,
  declines before claim with `file_scope_unsupported`. Platforms other than
  darwin, linux and win32 still decline; the durable lane itself runs only on
  darwin/linux. Writer and memory-reader offers are admitted
  alike; a reader's grant makes the home read-only and adds its run directory
  as a writable `run` root. `PiAdapter`
  declares `['rpc', 'prepared']`, and `['durable']` with `durableLane: true`.
- `RuntimeAdapterDescriptor.providerProfileBinding: true`: the adapter runs an
  exact `byok-profile` dispatch selection. The daemon advertises
  `provider-profile-binding` only when such an adapter also opts into dispatch
  selection and the BYOK launcher is configured. `PiAdapter` declares it.
- `RuntimeAdapter.projectMcpEnvironment(env)`: the environment the adapter's
  task-scoped MCP servers receive. The admission-time MCP probes and helper
  preflights use the same value. Without it, MCP servers receive the task's
  runtime environment unchanged. `PiAdapter` keeps its directory selectors,
  `BYOK_PI_*` names and provider credentials out.

## References and ownership

- Source contract: `packages/client/src/types.ts`.
- Adapter evidence: `claude-adapter.test.ts` and `codex-adapter.test.ts`.
- MCP identity on tool events: `docs/protocol.md` §11.7 gives the source per
  adapter. Evidence: `mcp-event-identity.test.ts`,
  `claude-mcp-identity.test.ts` and `codex-events.test.ts`.
- Host recovery boundary: Host reconnect next step (`docs/researches/2026-10-06-host-reconnect-boundary.md`, untracked since #390).
- Architecture: [SDK architecture](architecture/sdk-architecture.md), especially
  the adapter and embedded server boundaries.
- Design reference: [T3 pinned revision](https://github.com/pingdotgg/t3code/tree/3e6b45028ceec5820dacb37dc3852470ebdc9411).
  The extraction adopts capability honesty and explicit lifecycle boundaries;
  it does not import a second agent runtime, WebSocket transport, or computer
  control surface.

### Pi explicitly authorized resources

Pi ordinary RPC Agent operations accept `agentSkillPaths` and `agentExtensionPaths`
(default `[]`), independently of `agentUserContext` and `auto | all` tool
authorization. Supply absolute local paths; no package download selectors or implicit user-directory discovery are added by these options.
For example, a Host can exclude personal context while loading one task skill:

```ts
new PiAdapter({
  agentUserContext: 'excluded',
  agentSkillPaths: ['/approved/skills/research/SKILL.md'],
  agentExtensionPaths: ['/approved/extensions/research.ts'],
});
```

The Host authorizes the extension as executable code, including resources it
registers. This is not a sandbox. Default/inherit behavior and non-Agent operations
are unchanged. Explicit resource loading requires the ordinary RPC lane; prepared
and durable lanes reject it. Resource selection remains adapter scoped, so
different task resources require separately configured adapters.

Explicit skill paths must exist and be readable. Pi remains the authority for
skill parsing and its advisory diagnostics: a readable path that yields no valid
skill is not promoted to a fatal error by the SDK.
