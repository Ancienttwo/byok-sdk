# Runtime user-level configuration (#634) and the Grok reader persona (#609)

## P1: boundary

The daemon starts each runtime as the Host user, with the Host environment
minus `CLAUDECODE` and `BYOK_*`. An Agent home sets the cwd and holds the
projected persona. The runtime can still read the user's own configuration.
This note records, for each adapter, what the pinned runtime reads and which
per-process switch exists. A switch counts only when the pinned CLI accepts it
as a flag or an environment variable.

| Adapter | Version used for this evidence | Where the version comes from |
| --- | --- | --- |
| Claude | Claude Code 2.1.302 | The adapter pins no version. 2.1.302 is the installed build and the newest live evidence in the adapter (`mcp-identity.ts`). |
| Codex | 0.160.0 | `QUALIFIED_CODEX_VERSION` |
| Grok | 1.0.52 (0920c8169e27) | `QUALIFIED_GROK_VERSION` |
| Pi | 1.3.0 | `packages/client/package.json` |
| Hermes | 0.22.2+2364.g0b10b9f | `QUALIFIED_HERMES_VERSION` |

No runtime session, model call, credential read or global configuration edit
was made for this note.

## P2: evidence

### Grok 1.0.52

- Binary: `grok-1.0.52` from the Grok updater cache, SHA-256
  `c2caa9895dd763297a75e8fb6077e175d9c5304c53903e52cff8891a1384bbb9`.
- `grok agent --help` and `grok agent stdio --help` are the same on 1.0.52
  and 1.0.62. `grok agent` has no flag for rule loading or folder trust.
  `--rules` and `--system-prompt-override` exist only on the interactive
  `grok` command, which the adapter does not run.
- The binary carries its user guide as plain text. These sections are
  byte-identical in 1.0.52 and 1.0.62: "Project Rules (AGENTS.md)",
  "Harness compatibility", the `compat` and `paths` tables of the
  configuration reference, and "Injecting config with `GROK_CONFIG`". The
  guide files that 1.0.62 extracts have these SHA-256 values:
  `12-project-rules.md` `5bc157f2…37f53`, `05-configuration.md`
  `e9a87f1c…84619`, `26-config-reference.md` `c1e0c4d2…40145`.
- The guide says that home rules load "regardless of where it starts":
  `$GROK_HOME/rules/` ("Always scanned"), `~/.claude/rules/`
  (`compat.claude.rules`), `~/.cursor/rules/` (`compat.cursor.rules`) and each
  `[paths] extra_rule_dirs` entry ("regardless of folder trust"). Project
  `AGENTS.md` loading "requires folder trust".
- The `compat` table names an environment variable for each cell, for example
  "`compat.claude.rules` … Also GROK_CLAUDE_RULES_ENABLED". The guide gives the
  order "env var > config.toml > default (on)".
- The `GROK_CONFIG` overlay accepts only `models`, `features`, a narrowed
  `toolset` and `shell_environment_policy`. It cannot set `paths` or `compat`.
- `paths.extra_rule_dirs` has no environment variable.

Probe: `grok inspect --json` lists the files that Grok discovers for a
directory. It reports discovery, not prompt text. It needs no login and makes
no model call. The probe ran in a synthetic home with the network denied:

```sh
cd "$P/home/agent"   # holds AGENTS.md; not a trusted folder
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  env -i PATH=/usr/bin:/bin HOME="$P/home" GROK_HOME="$P/home/.grok" \
  GROK_DISABLE_AUTOUPDATER=1 \
  GROK_CLAUDE_RULES_ENABLED=0 GROK_CLAUDE_AGENTS_ENABLED=0 \
  GROK_CURSOR_RULES_ENABLED=0 GROK_CURSOR_AGENTS_ENABLED=0 \
  grok-1.0.52 inspect --json
```

The second run is the same command with the four variables. `$P/home/.grok/config.toml`
lists one `extra_rule_dirs` entry. Each file holds one marker line.

| Synthetic file | Default run | Four variables set to `0` |
| --- | --- | --- |
| `$GROK_HOME/AGENTS.md` | listed, `global` | listed, `global` |
| `$GROK_HOME/rules/probe.md` | listed, `global` | listed, `global` |
| `~/.claude/CLAUDE.md` | listed, `claude`, `enabled` | listed, `claude`, `disabled` |
| `~/.claude/rules/probe.md` | listed, `claude`, `enabled` | listed, `claude`, `disabled` |
| `~/.cursor/AGENTS.md` | listed, `cursor`, `enabled` | listed, `cursor`, `disabled` |
| `~/.cursor/rules/probe.md` | listed, `cursor`, `enabled` | listed, `cursor`, `disabled` |
| `extra_rule_dirs` entry | listed, `global` | listed, `global` |
| `<cwd>/AGENTS.md` | not listed (`projectTrusted: false`) | not listed |

The four cells report `"source": "env"`. The values `0` and `false` gave the
same result. A skill under `~/.claude/skills/` stayed listed in all runs,
also with `GROK_CLAUDE_SKILLS_ENABLED=0`; the new option does not touch skills.

### Claude Code 2.1.302

- The package installs a native binary, not a readable `cli.js`.
- `claude --help`: "`--setting-sources <sources>` Comma-separated list of
  setting sources to load (user, project, local)."
- [Agent SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
  (read 2026-10-22). The "User" rows: `~/.claude/CLAUDE.md` and
  `~/.claude/rules/*.md` load when "`settingSources` includes `"user"`". The
  "user" source also loads the user `settings.json` and the user skills,
  commands and subagents. "Project rules" are "`<cwd>/.claude/rules/*.md` and
  `.claude/rules/*.md` in every parent directory". Managed policy settings and
  `~/.claude.json` "are read regardless". Auto memory loads at session start
  unless `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` or `autoMemoryEnabled: false`.
- [Memory](https://code.claude.com/docs/en/memory): "Project rules are
  skipped if you exclude `project` from `--setting-sources`." The
  `claudeMdExcludes` setting takes glob patterns that are "matched against
  absolute file paths", at any settings layer.
- From the binary (inferred, not run): the user `settings.json` also carries
  the user's permission rules, hooks, its `env` block and `apiKeyHelper`.
  These drop with the `user` source. OAuth, the keychain and
  `ANTHROPIC_API_KEY` in the process environment do not depend on it.
- Consequence for an Agent home under `$HOME`: `~` is a parent directory of
  the home. By the table above, `~/.claude/rules/*.md` can then load as
  project rules even without the `user` source. This was not run.
- Resume: a resumed session keeps the instruction text of its earlier launch
  in its history (inferred from the binary). The option gives a clean
  instruction set only to a fresh session.

### Codex 0.160.0

Source: openai/codex at tag `rust-v0.160.0`, paths under `codex-rs/`.

- `codex-home/src/instructions/mod.rs:43-79` reads
  `$CODEX_HOME/AGENTS.override.md`, else `$CODEX_HOME/AGENTS.md`.
- `app-server/src/message_processor.rs:355-357` always installs that
  provider. No configuration key gates it.
- `core/src/agents_md.rs:68-72` and `:133`: `project_doc_max_bytes = 0` stops
  only the project documents.
- `thread/start` and `thread/resume` take `config`, `base_instructions` and
  `developer_instructions`
  (`app-server-protocol/src/protocol/v2/thread.rs:100-106` and `:410-414`).
  None of them removes the user instructions.
- `CODEX_HOME` also holds `auth.json` (`login/src/auth/storage.rs:155`),
  `config.toml` and the sessions.
- Result: Codex 0.160.0 has no per-session switch for user instructions.

### Pi 1.3.0

Source: `packages/client/node_modules/@earendil-works/pi-coding-agent/dist/`.

- `config.js:476-497`: the agent directory is `$PI_CODING_AGENT_DIR`, else
  `~/.pi/agent`. `auth.json`, `models.json`, `settings.json` and the sessions
  are under it (`config.js:499-530`).
- `core/resource-loader.js:115-116,165-172`: the agent-directory context file
  (`AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md`) loads first.
- `core/resource-loader.js:177-199`: the walk goes from the cwd up to the
  filesystem root. It does not stop at the git root. So an `AGENTS.md` or
  `CLAUDE.md` in `~` loads for an Agent home below `~`.
- `core/resource-loader.js:947-963`: the agent-directory `SYSTEM.md` and
  `APPEND_SYSTEM.md`.
- `core/package-manager.js:2011-2016,2056-2066`: extensions, prompts, themes
  and skills from the agent directory, and skills from `~/.agents/skills`.
- `cli/args.js:320-329`: `--no-context-files` drops every `AGENTS.md` and
  `CLAUDE.md`, the Agent-home file too.
- The SDK host (`pi-rpc-host.ts:121-125`) refuses other flags and passes
  only `extensionFactories` to the resource loader (`pi-rpc-host.ts:168-178`).
- `core/resource-loader.d.ts:111-120`: `agentsFilesOverride` receives each
  context file with its path. A future host option could drop only the
  agent-directory file. That is an SDK API, not a CLI switch, and this change
  does not add it.

### Hermes 0.22.2+2364.g0b10b9f

Source: `git show 0b10b9f:<path>` in a local Hermes checkout.

- `agent/prompt_builder.py:1542,1561`: `SOUL.md` comes from `HERMES_HOME`.
  The SDK gives each execution a fresh `HERMES_HOME`, so Hermes seeds its own
  default text.
- `agent/agent_init.py:1334-1341`: `MEMORY.md` and `USER.md` load only when
  enabled. The SDK profile turns both off (`hermes-home.ts`).
- `agent/prompt_builder.py:1610-1661,1755-1772`: project context comes from
  the cwd and the git-root chain. No user-level context file exists.
- `agent/skill_utils.py:397-408`: skills come from trusted project
  directories, `HERMES_HOME/skills`, `skills.create_dir` and
  `skills.external_dirs`. The SDK profile sets none of these.
- Result: no user-level instruction source reaches the session.

### Grok memory-reader persona (#609)

`grok-reader-persona.test.ts` runs memory-reader Attempts through the real
`TaskRunner`, `AgentHomeManager` and `GrokAdapter`, with the fake ACP agent.

- A fresh reader opens `session/new` with cwd
  `<home>/.byok/runs/<taskId>` and the home `AGENTS.md` in `_meta.rules`.
  This passed before the change.
- A resumed reader runs in the run directory that its handoff recorded, which
  is named after the earlier task. Before the change, `grokAgentPersona`
  required the directory name to equal the new task id. So every resumed
  reader failed with "grok Agent persona cwd does not match its sealed lease",
  also when the home has no `AGENTS.md`. Both resume cases of the test failed
  with that reason.
- After the change, a resumed reader without a persona opens
  `session/resume` in its recorded run directory. A resumed reader with a
  persona is refused with "persona resume is not qualified", as for writers.
  A fresh reader still needs `runs/<taskId>`. A resumed reader still needs a
  direct child of `<home>/.byok/runs/`.

## P3: decision

- Add an option only where the pinned CLI has a per-process switch.
  - Grok: `compatInstructions: 'disabled'` sets the four compatibility
    variables in the agent process environment only. Hosted terminal
    commands keep the task environment.
  - Claude: `settingSources` passes `--setting-sources`. It is a direct
    pass-through of a documented flag, not an isolation claim.
- Codex, Pi and Hermes get documentation only.
- Each option is an adapter option and applies to every session that the
  adapter starts. A choice per task would need a new wire field. The
  defaults are unchanged.
- Not offered: relocating `GROK_HOME`, `CODEX_HOME` or `PI_CODING_AGENT_DIR`
  (each also moves the login and the sessions); Claude `--bare` (it never
  reads OAuth or the keychain); Claude `--restricted` (it removes Bash and
  refuses `bypassPermissions`); `claudeMdExcludes` (the adapter would have to
  compute absolute paths, which was not verified).

## Residual risks

- `grok inspect` shows discovery, not prompt contents. No live Grok run shows
  that the model sees no disabled file.
- No Claude session ran. The Claude evidence is the help text, the official
  docs, and binary reading marked as inferred. A credential-free Claude probe
  needs the owner's approval, because Claude can read and refresh the user's
  keychain login.
- `$GROK_HOME/AGENTS.md`, `$GROK_HOME/rules/` and `extra_rule_dirs` stay
  active for Grok. The `~/.claude` and `~/.cursor` named files and rules stay
  active under `compatInstructions: 'inherit'`.
