# #519 Hermes Agent as a byok MCP client (external Bot beta): Hermes deltas

Baseline: byok-sdk `origin/main@5b988a6e` (2026-10-19). Upstream OAR `main@5296675b` (0.68.1). herdr 0.9.3. Local Hermes Agent `354ad3d4` (2026-10-18, `v0.22.2+1687.g354ad3d`).

Status: plan only. It does not authorize implementation, release, issue edits or downstream changes.

**Main document:** the shared byok MCP server design lives in #536, `docs/plans/2026-10-19-byok-mcp-server-external-bot-beta.md` (branch `claude/plan-514-grok-adapter`). Grok Bot is its first client. This document covers only what is different when Hermes is the client. Tool names, the per-Bot key and quota rules come from #536 "§ Tool catalogue" and "§ Auth". This document does not fix them.

## Ruling followed

Aimpact, 2026-10-19 about 14:00 HKT. It replaces every earlier Grok and Hermes instruction:

- The external Bot beta line is one **byok MCP server**. External Bots (Grok Bot, Hermes) connect to it as **MCP clients**.
- The server exposes existing byok Bot infrastructure as tools: dispatch work to coding agents (Pi, Codex, Claude, through OAR or herdr), memory, routine, outcome and ledger.
- No separate stack. Grok and Hermes are not `RuntimeAdapter`s as the main form.
- Auth and quota are per Bot, with keys.
- Recommended default, still to confirm: the external Bot keeps its own conversation memory; byok keeps tasks and artifacts.
- The Bot mode PRD does not change. This branch never changed it. `git diff --stat origin/main...HEAD` lists only this plan file.

Superseded: plan v1 (`ab704346`, a `HermesAdapter` runtime) and plan v2 (`af9955c4`, Hermes as an external member of Bot mode). The file was renamed from `2026-10-19-519-hermes-adapter-plan.md`.

## Conclusion

1. Hermes connects to the #536 server as an ordinary MCP client through its profile `mcp_servers` config. Hermes needs no SDK adapter, no ACP, no `shared/acp` vendoring and no protocol change.
2. One dedicated Hermes profile maps to one byok Bot key. The key gives the Bot identity and the quota.
3. Hermes must not do the coding itself. The Bot profile turns off Hermes's own coding paths (`terminal`, `file`, `code_execution`, `delegation` and others). Then coding work can reach coding agents only through the byok tools.
4. Hermes MCP tool calls time out after 300 s by default, and Hermes does not process MCP progress notifications. So dispatch must be asynchronous: submit returns a task id at once, and a bounded wait or status tool reads the result. v1 has no push back into the Hermes conversation.
5. Process ownership: the Hermes gateway belongs to the user. byok never runs `hermes` commands that can start a gateway. Coding-agent processes belong to the byok host and are never children of a process that Hermes started.

## 1. Inventory (Hermes side)

The #536 main document owns the inventory of byok MCP code (reserved helpers, `mcpToolsets`, `packages/client/src/mcp-server`, `@byok-sdk/server` task API) and of OAR (`oar mcp`, runtimes). This section lists only Hermes facts. All of them come from reading the source; only `--help` and `--version` were run.

### 1.1 OAR and Hermes

OAR has no Hermes runtime (verified on upstream `main@5296675b`: runtime directories, `docs/runtimes/`, README, full-text search, issues and PRs). Under this ruling that fact only confirms that Hermes is a client. Hermes is not a worker. herdr can start a `hermes` kind (`herdr agent start --help`), but the dispatch target list stays Pi, Codex and Claude (plus Grok CLI from #536).

### 1.2 Hermes MCP client

| Fact | Evidence |
| --- | --- |
| The MCP client reads `mcp_servers` from the profile's `config.yaml`. Each profile has its own config. | `tools/mcp_tool.py:2-3`; `hermes_cli/mcp_config.py:210-214`; `toolsets.py:341-343` |
| stdio form: `command`, `args`, `env`, `cwd`. HTTP form: `url`, `headers`, `ssl_verify`. The default is Streamable HTTP; `transport: sse` selects SSE. | `tools/mcp_tool_transport.py:117,127,133,362,370,605-608` |
| Other keys: `connect_timeout`, `auth`, `oauth`, `keepalive_interval`, `sampling`, `elicitation`, `tools.include` / `tools.exclude` (globs). | `tools/mcp_tool_transport.py:413`; `tools/mcp_tool_server_run.py:68,263-276`; `tools/mcp_tool_registration.py:227-228` |
| Tools appear as `mcp__<server>__<tool>`, clamped to 64 characters with a hash suffix. Each server is toolset `mcp-<server>`. | `tools/mcp_tool_schema.py:153-175`; `tools/mcp_tool_registration.py:135,334` |
| Tool-call timeout: `mcp_servers.<name>.timeout`, then `timeouts.mcp.tool_call`, then 300 s. Platform clamps apply [UNVERIFIED: the maximum]. | `tools/mcp_tool_common.py:41-57` |
| No MCP progress or async-task handling in the call path. | (verified: grep of `tools/mcp_tool_handlers.py`) |

### 1.3 Hermes's own coding paths (must be off for a byok Bot)

| Path | Fact | Evidence |
| --- | --- | --- |
| Skills + terminal | `skills/autonomous-ai-agents/{claude-code,codex,opencode}` teach the model to run those CLIs through `terminal` | `skills/autonomous-ai-agents/claude-code/SKILL.md:1-50` |
| `delegate_task` | Hermes subagents; background mode; an ACP client override that speaks to GitHub Copilot CLI | `tools/delegate_tool.py:216,490,516`; `agent/copilot_acp_client.py:290-375` |
| Kanban | Workers are `hermes -p <profile> chat -q` subprocesses | `hermes_cli/kanban_db_dispatch.py:~2803` |
| `codex-runtime` | Codex as Hermes's own model runtime. Not dispatch | `hermes_cli/codex_runtime_switch.py:15-27` |
| Core toolset | The default platform bundles include `terminal`, `process_manage`, `read_file`, `write_file`, `patch`, `search_files`, `execute_code`, `delegate_task`, `cronjob_manage` | `toolsets.py:11-47` |
| Restriction keys | Allow-list `platform_toolsets.<platform>`; deny-list `agent.disabled_toolsets`. An invalid name resolves to zero tools. The deny-list can also remove shared tools. | `cli-config.yaml.example:1405-1423`; `hermes_cli/config.py:1396-1408,3257`; `toolsets.py:~105` |

### 1.4 Hermes surfaces that could carry a result back

| Surface | Fit | Evidence |
| --- | --- | --- |
| Model polls a byok status tool on a later turn | Works with any MCP client. v1 choice | — |
| `terminal(background, notify_on_complete)` | Needs `terminal`, which §4 turns off | `tools/terminal_tool_background.py:15-22,106-120` |
| A2A inbound (`message/send` into the live session, push secrets) | byok would need a Hermes credential and an A2A sender | `plugins/platforms/a2a/plugin.yaml`, `README.md` |
| `hermes mcp serve` `messages_send` | Whether it starts an agent turn is [UNVERIFIED] | `mcp_serve.py:601-635` |
| `hermes webhook subscribe` | Webhook toolset is restricted; reply delivery is [UNVERIFIED] | `toolsets.py:~225` |

### 1.5 Gateway and memory facts (from plan v1/v2, unchanged)

- `hermes acp` and `hermes chat -q` start a **detached** `gateway run --idle-exit` daemon on first use. It escapes the caller's process tree and lives up to 600 s after it goes idle (`hermes_cli/gateway_client.py:215`; `gateway_runtime_start.py:31-71`; `gateway/run_idle_exit.py:1-20`).
- The gateway runs all tools and MCP servers for its profile. A stdio MCP server that Hermes starts is a child of that gateway. It stops when the gateway stops, restarts or idle-exits [UNVERIFIED for idle exit with an open MCP session].
- Hermes memory is per profile: `memories/MEMORY.md` (2,200 characters), `USER.md` (1,375 characters), and an optional external provider (`tools/memory_tool.py:2,40`; `config_defaults.py:1325-1343`).
- Hermes cron is per profile: `<profile>/cron/jobs.json`, run by the gateway every 60 s. `cronjob_manage` is in the core toolset (`cron/jobs.py:2,79-83`).

## 2. Delta table: Hermes versus Grok Bot as a client

| Area | Shared (#536) | Grok Bot (first client, #536) | Hermes (this document) |
| --- | --- | --- | --- |
| Server, tools, schemas | One byok MCP server, one tool catalogue | Same | Same. No Hermes-only tool |
| Transport | Defined in #536 | Remote HTTPS (Grok Bot runs in xAI's cloud) | Local: stdio or loopback Streamable HTTP (§3) |
| Auth and quota | Per-Bot key, per-Bot quota | Key entered as the Bot's own credential in the Grok Bot UI | Key in the Hermes profile `.env`, read by `mcp_servers` (§3.3) |
| Identity | One key = one byok Bot | One Grok Bot | One Hermes profile (§3.2) |
| Conversation memory | External Bot owns it (default, to confirm) | xAI side | Hermes profile memory (§5) |
| Tasks and artifacts | byok owns them | Same | Same |
| Result delivery | Async task id + status/wait (#536) | Long polling; webhook wake later | Polling within Hermes's 300 s tool timeout; push deferred (§4.2) |
| Who does the coding | Coding agents behind byok | Grok Bot has its own cloud computer; #536 decides limits | Hermes coding toolsets off (§4.1) |
| Process | byok host owns coding agents | Remote client, no local process | User-owned Hermes gateway; byok never starts it (§6) |
| Data leaving the device | #536 disclosure rules | xAI/Cursor cloud | Hermes `state.db`, Hermes memory provider, Hermes messaging platforms (§5) |

## 3. Connection

### 3.1 Transport

Hermes supports both forms. The choice depends on what #536 ships first.

- **Loopback Streamable HTTP (recommended when #536 has it).** The byok host owns the server process. A Hermes restart or idle exit does not touch byok state or running coding tasks. The Hermes config is a `url` plus an `Authorization` header.
- **stdio.** Hermes's gateway starts the byok server entry as a child process. This is allowed only if that process is a thin client to the byok host (for example over the daemon's authenticated control socket) and holds no task state. Coding agents must never be its children. Otherwise a Hermes gateway restart would kill coding work.

Profile template (field names follow §1.2; the server entry, URL and key name come from #536):

```yaml
# ~/.hermes/profiles/<bot>/config.yaml (written by the user, never by byok)
mcp_servers:
  byok:
    url: http://127.0.0.1:<port>/mcp          # loopback form
    headers:
      Authorization: "Bearer ${BYOK_BOT_KEY}"  # [UNVERIFIED: env interpolation in headers]
    timeout: 120
platform_toolsets:
  <platform>: [mcp-byok, web, vision, todo, clarify]   # allow-list, see §4.1
```

### 3.2 Identity

- One dedicated Hermes profile per byok Bot. The user creates it (`hermes profile create <name>`). byok does not write into `~/.hermes`.
- One byok Bot key per profile. Two profiles must not share a key, because quota and the task ledger are keyed by Bot.
- Hermes's own Bot Mode (rooms, `message_agent`, peers) stays inside Hermes. Several Hermes Bots that each call byok use their own keys.

### 3.3 Key custody

- The per-Bot key lives in the profile's `.env`, which Hermes already uses for secrets (`environment-variables.md:9`). Hermes, not byok, holds it at rest.
- With `terminal` and `code_execution` off (§4.1), the model has no tool that can print the environment. With them on, the model could read the key. That is one more reason for §4.1.
- byok BYOK provider keys never go to Hermes. Hermes provider keys never go to byok. Coding agents use their own byok device lanes.

## 4. Behavior deltas

### 4.1 Hermes must not code

The ruling says coding agents do the work. A Hermes profile with default toolsets can run `claude -p` through `terminal`, patch files, or delegate. The byok Bot profile uses an allow-list:

- Keep: `mcp-byok`, chat tools (`web`, `vision`, `todo`, `clarify`, `memory`).
- Remove: `terminal` (`terminal`, `process_manage`), `file`, `code_execution`, `delegation`, `browser`, `computer_use`, `kanban`, `cronjob` (see §4.4), `a2a`.
- The allow-list is safer than `agent.disabled_toolsets`, which can remove shared tools by accident. A typo gives zero tools, so the setup check must list the resolved tools.

byok cannot enforce this. Hermes is the user's program. The #536 server can only see that calls arrive with the right key. Q3 asks whether byok should refuse a Bot when the user does not confirm this setup.

### 4.2 Long-running work and results

- `submit` must return within seconds with a task id. A synchronous `run` (as in `oar mcp run`) would hit Hermes's 300 s timeout for real coding work.
- A wait tool must cap its wait below the Hermes timeout. With `timeout: 120` in §3.1, a cap of 100 s leaves room.
- v1 delivery: the model calls status or wait when the user asks, or at the start of its next turn. The task id stays in the Hermes conversation.
- Push into the Hermes conversation (A2A inbound, `hermes mcp serve`, webhook) is deferred. Each needs byok to hold a Hermes credential and to call into Hermes, which is the opposite direction (Q4).

### 4.3 Idempotency and retries

- Hermes may retry a tool call after a transport error, and the model may repeat a call [UNVERIFIED: Hermes MCP client retry policy]. A repeated `submit` must not start a second coding task.
- #536 owns the idempotency rule. The Hermes-specific need: the key must be stable across a Hermes retry of the same call. A model-chosen key is weak, because the model may pick a new one. S0 measures what Hermes actually repeats.
- Cancel is an explicit tool call. Closing the Hermes session or stopping the gateway does not cancel byok tasks.

### 4.4 Routine versus Hermes cron

- Scheduled coding work uses byok routine tools. byok then owns the schedule, the quota and the ledger.
- Hermes cron (`cronjob_manage`) would create a second scheduler that byok cannot see or count. The Bot profile removes `cronjob`. Hermes reminders for chat only are a user choice outside this beta (Q5).

### 4.5 Outcome and ledger

MCP tool inputs are structured and the server validates them. So Hermes can use the #536 outcome and ledger tools in full. This removes the v2 limit ("text only, no actions"), which came from Hermes's HTTP API, not from MCP.

## 5. Memory boundary

Recommended default (to confirm, Q1):

- Hermes keeps the conversation memory: `MEMORY.md`, `USER.md` and any Hermes memory provider in that profile.
- byok keeps tasks, artifacts, the ledger and any byok memory exposed by #536 tools.
- Hermes stores references (task ids, artifact ids, short summaries), not artifact bodies. Hermes memory is small anyway (2,200 and 1,375 characters).
- Tool descriptions in #536 should say which memory each tool writes, so the model does not mix the two.

Data flow to disclose: task summaries and artifacts that Hermes reads through MCP enter Hermes `state.db`, Hermes memory and possibly an external Hermes memory provider or a Hermes messaging platform. byok cannot track them after the tool returns.

## 6. Gateway ownership and process risk

- The Hermes gateway is the user's: an installed service, Desktop, a manual run, or an idle-exit daemon. byok never runs `hermes acp`, `hermes chat`, `hermes -z`, `gateway run|ensure|start` or any command that opens a session. A byok doctor check may run `hermes --version` only.
- If the user tests the setup with `hermes chat -q`, that command starts an idle-exit gateway. That is Hermes behavior on the user's machine. It is not a byok process and it holds no byok task.
- In the stdio form the byok server process is a gateway child. In the loopback form it is not. Either way, coding-agent processes are byok host children (OAR or herdr), so a gateway restart cannot kill them.
- herdr may show coding agents in panes. Hermes never drives herdr directly. Only the byok server dispatches.

## 7. S0 (Hermes client evidence gate)

S0 runs on a scratch profile that S0 creates and deletes. It never touches the user's default profile. It needs a #536 server build or a fake MCP server with the same tool shapes.

1. Hermes connects over stdio and over loopback HTTP. Tools show as `mcp__byok__*`.
2. The `${VAR}` form works in `headers` and `env`, or S0 records the supported form.
3. The allow-list in §4.1 leaves only the intended tools (`hermes tools` output), and the model has no way to run a coding CLI.
4. A wait call near the configured timeout: Hermes keeps the session and reports a timeout, not a crash.
5. Retry behavior: a forced transport error during `submit` shows whether Hermes re-sends the same call and with the same arguments.
6. Gateway restart and idle exit during a running coding task: the task continues; the stdio server (if used) restarts cleanly.
7. Process audit: during a full cycle byok starts no `hermes` process and no new `gateway run --idle-exit` appears.
8. Hermes approval prompts for MCP tool calls: whether they appear, and on which platforms.
9. Memory: after three tasks, Hermes `MEMORY.md` holds references only [behavioral; record, not a hard gate].

One paid model run needs Aimpact approval. If 3, 5 or 7 fails, stop and report.

## 8. Open questions (Hermes-specific)

Shared questions (key format, quota numbers, tool catalogue, transport, idempotency rule, the memory default) are in #536. These are the Hermes deltas:

| # | Question | Recommended answer | Reason |
| --- | --- | --- | --- |
| Q1 | Confirm the memory split for Hermes: Hermes keeps conversation memory, byok keeps tasks and artifacts, Hermes stores references only? | Yes | Matches the ruling's default; Hermes memory is small |
| Q2 | Transport for Hermes: loopback HTTP first, stdio only as a thin client? | Yes | A Hermes restart must not kill byok state or coding work |
| Q3 | byok cannot enforce "Hermes must not code". Require the user to confirm the §4.1 toolset setup before the Bot key is issued? | Yes, with a setup check that shows the resolved tool list | The ruling assigns coding to coding agents |
| Q4 | Push results into the Hermes conversation (A2A or `hermes mcp serve`) in v1? | No. Polling in v1; push after S0 item 6 and a security review | Push needs byok to hold a Hermes credential |
| Q5 | Hermes cron in the Bot profile: off? | Off. Scheduled work uses byok routines | One scheduler, one quota |
| Q6 | Is Hermes in the first beta cohort with Grok Bot, or second? | Second, after the Grok Bot client passes #536 S0 | Grok Bot is the declared first client |
| Q7 | Platforms: macOS first; Windows when Hermes's own gateway passes S0 there? | Yes | The client side is Hermes's platform risk |
| Q8 | #519 still asks for a `HermesAdapter` runtime. Retitle it to "Hermes as a byok MCP client (external Bot beta)"? | The issue owner retitles after this plan is accepted | This PR does not edit issues |

## 9. Slices (Hermes only; after the #536 server slices)

- **H0. S0 evidence** (§7). No product code. Probe in `/tmp`, record in `tasks/runs/`, note in `docs/notes/`.
- **H1. Client setup document.** The profile template, the toolset allow-list, key custody and the data-flow disclosure, as a docs page next to the #536 server docs. No code.
- **H2. Setup check.** If #536 adds a client self-check tool (for example "whoami" with the resolved Bot and quota), document the Hermes expected output. Otherwise none.
- **H3. Live acceptance.** One Hermes profile dispatches a coding task to each supported coding agent, waits, reads the artifact and cancels one task. Paid runs need approval.

No slice here changes SDK packages, the protocol or the vendored OAR fork. Those changes, if any, belong to #536.

## 10. Risks

- Hermes is fast-moving (a breaking API auth change in July 2026, `api-server.md:885-893`). S0 and the version in the setup doc are the guards.
- The user can turn `terminal` back on at any time. Then Hermes can code by itself and can read the Bot key. byok cannot detect this.
- A model that does not poll leaves finished tasks unread. The tool descriptions and the Hermes setup page must say when to call status.
- Content read through MCP can leave the device through Hermes memory providers or platforms.
- #536 is a draft. A change to its transport, auth or tool shapes changes §3 and §7.
