# Claude Agent tasks without the user's MCP servers, instruction files and auto memory (#871, #873)

## Scope

`ClaudeAdapterOptions.agentUserContext: 'excluded'` gives an Agent task
(`task.offer_for_agent`) only SDK, Host and Agent-home inputs. The
[adapter capability page](../adapter-capabilities.md#agentusercontext) states
the contract. This note records the evidence behind it.

- Claude Code **2.1.302**, the native darwin-arm64 binary, SHA-256
  `5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37`,
  BUILD_TIME `2026-10-16T15:52:41Z`, GIT_SHA
  `2ef144e6f98c1c99d082b735e4b38f50e3391e55`. It is the build that the
  [#634 note](2026-10-22-634-runtime-user-config.md) read. The adapter pins no
  Claude version.
- Docs read on 2026-10-24: the
  [CLI reference](https://code.claude.com/docs/en/cli-reference) and
  [Managed MCP](https://code.claude.com/docs/en/managed-mcp).

## Probe

The probe used the #634 method with adapter-shaped launches:
`-p --input-format stream-json --output-format stream-json --verbose
--dangerously-skip-permissions --mcp-config <file>`, with the first turn on
stdin.

- Network: a fake Messages endpoint on `127.0.0.1` with a dummy key. The
  proxies pointed at a dead port. `sandbox-exec` denied outbound connections
  except localhost, and denied the real `~/.claude`, `~/.claude.json` and the
  keychain. A `security` shim refused every keychain lookup.
- No provider call, no paid call and no global configuration edit.
- Synthetic home: `HOME` and `CLAUDE_CONFIG_DIR=$HOME/.claude`. The Agent home
  was `$HOME/app/agents/a1`, and the reader cwd `<home>/.byok/runs/t1`.
- Markers: `~/CLAUDE.md`, `~/CLAUDE.local.md`, `~/AGENTS.md`,
  `<config>/CLAUDE.md`, `<config>/rules/user-rule.md`, `~/app/CLAUDE.md`,
  `~/app/.claude/rules/mid-rule.md`, `<home>/CLAUDE.md`,
  `<home>/.claude/CLAUDE.md`, `<home>/.claude/rules/agent-rule.md`, and an
  auto-memory `MEMORY.md`.
- A user MCP server `user_notes` in `<config>/.claude.json` and
  `~/.claude.json`.
- User `settings.json`: `model`, an `env` header,
  `permissions.deny: ["WebFetch", "mcp__task_b"]`, and a `UserPromptSubmit`
  hook that appends to a log.
- Task `--mcp-config`: `task_a`, `task_b` and the SDK-reserved
  `byokagentmemory`, each a real stdio MCP server.

Every launch exited 0 with `result: success`. "Excluded" below is
`--strict-mcp-config` plus `--settings` with `claudeMdExcludes` and
`env.CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

| Launch | MCP servers in `system/init` | User and parent instruction files | Agent-home files | Auto memory | Deny rule | Hook | User `model` and `env` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default | user_notes, task_a, task_b, byokagentmemory | loaded | loaded | loaded | applied | ran | applied |
| `--setting-sources project,local` | task_a, task_b, byokagentmemory | loaded (as project files) | loaded | loaded | **not applied** | **did not run** | **dropped** |
| `--strict-mcp-config` | task_a, task_b, byokagentmemory | loaded | loaded | loaded | applied | ran | applied |
| Strict, no `--mcp-config` | none | loaded | loaded | loaded | applied | ran | applied |
| Excluded | task_a, task_b, byokagentmemory | **absent** | loaded | **absent** | applied | ran | applied |
| Excluded, reader cwd | task_a, task_b, byokagentmemory | absent | loaded (parent walk) | absent | applied | ran | applied |
| Excluded, settings as a 0600 file | task_a, task_b, byokagentmemory | absent | loaded | absent | applied | ran | applied |
| Excluded, `CLAUDE_CONFIG_DIR` through a symlink, patterns on the link path | as above | absent | loaded | absent | applied | ran | applied |

- "Deny rule applied" means `WebFetch` and `mcp__task_b` were absent from
  `system/init.tools` and from the request's `tools`.
- `~/AGENTS.md` never loaded. The 2.1.302 walk reads `CLAUDE.md`,
  `CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/`.
- The probe used neither `mcp_status` nor a tool call. `system/init` and the
  request's `tools` array show what the session has; `mcp_status` reads the
  same server list.
- The patterns that `claudeAgentUserContextSettings` builds for the probe's
  home equal the probed set (44 patterns; the probe listed two duplicates).

### Auto memory

A second run also set `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0"` in the user
`settings.json`.

| How it is turned off | Auto memory in the request |
| --- | --- |
| Process variable `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | loaded (the user `env` overrides it) |
| `--settings {autoMemoryEnabled: false}` | loaded (`0` means "forced on" and beats the setting) |
| `--settings {env: {CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"}}` | absent |

Only the flag-layer `env` holds, because the flag layer sits above the user
layer. Managed settings stay above the flag layer; that is admin authority.

### Resume

A session started without the switches and resumed with them still carried
every user marker and the auto-memory text in its first history message. The
new turn added no instruction text, and the MCP list was strict. The switch
therefore cleans new sessions only.

### Glob characters in a parent directory

- Literal file patterns (`<dir>/CLAUDE.md`) matched at any path: picomatch
  compares the exact string first.
- `<dir>/.claude/rules/**` stopped matching when `<dir>` contained `(` or
  `)`; the rule file under `Program Files (x86)` leaked. Space, `@`, `+` and
  `!` were fine.
- Claude rewrites `\` to `/` in both pattern and path, so backslash escaping
  is impossible.
- Replacing each of `( ) [ ] { } * ? ! @ + | ^ $` with `?` in the directory
  part of the rules pattern excluded the rules for `paren (x86)`, `brk [1]`,
  `brace {a,b}`, `star*q?`, a plain path, `张三` and `张三 (x86)`, and kept the
  Agent-home files. `?` can match a sibling directory with a name of the same
  length, which is never on the walk.

## Binary reading (inferred unless the probe shows it)

- Help text: "`--strict-mcp-config` Only use MCP servers from --mcp-config,
  ignoring all other MCP configurations". The `--restricted` help says it
  ignores the settings files and to "add --strict-mcp-config to skip MCP
  servers too", so MCP and settings layers are separate switches.
- claude.ai connectors: the connector-status code maps the strict switch to
  the state "restricted", with the text that connectors "are not loaded"
  when "MCP servers are restricted to explicitly passed config". Not probed: a
  probe needs a real claude.ai login.
- Project `.mcp.json` and plugin MCP servers: inferred from "ignoring all
  other MCP configurations". Plugin hooks and skills are not MCP and stay.
- With an enterprise `managed-mcp.json`, Claude exits at startup for
  `--mcp-config` and for `--strict-mcp-config` alike (docs and binary text).
  The adapter adds no code for it: a launch with task servers already exits
  there today.
- Exclude matching uses picomatch with `{dot: true}` against the path with
  `\` turned into `/`. It applies to user, project and local files only; a
  managed `CLAUDE.md` cannot be excluded. An absolute pattern whose static
  prefix is a symlink also matches its real path. `claudeMdExcludes` is
  honored from the `--settings` layer.
- Windows runs the same `\` to `/` normalization. Drive-letter case, `\\?\`
  paths and junctions were not probed: there is no Windows Claude here.

## Correction to the #634 note

`--setting-sources project,local` also dropped the user-scope MCP server that
`~/.claude.json` defines. The #634 note says `~/.claude.json` is read
regardless. The file is read, but its user-scope `mcpServers` follow the
`user` source.

## Residual risks

- Windows: the patterns are covered by fixture tests only, not by a Claude on
  win32.
- claude.ai connectors and plugin MCP servers: dropped according to the binary
  text, not probed.
- A resumed session keeps the old instructions in its history.
- The probe shows the request that Claude builds, not model behavior.
- Still loaded from the user: skills, commands, subagents and output styles
  from the config directory; installed plugins' skills and hooks; managed
  policy files.
- A later Claude version can change any of this.
