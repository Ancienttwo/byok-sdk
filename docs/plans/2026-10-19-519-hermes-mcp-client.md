# #519 Hermes Agent as a byok MCP client (external Bot beta): Hermes deltas

Baseline: byok-sdk `origin/main@5b988a6e` (2026-10-19). Main document #536 at `e3cb330a`. Upstream OAR `main@5296675b` (0.68.1). herdr 0.9.3. Local Hermes Agent `354ad3d4` (2026-10-18, `v0.22.2+1687.g354ad3d`).

Status: plan only. It does not authorize implementation, release, issue edits or downstream changes.

**Main document:** [#536](https://github.com/Ancienttwo/byok-sdk/pull/536), `docs/plans/2026-10-19-byok-mcp-server-external-bot-beta.md` (branch `claude/plan-514-grok-adapter`). Grok Bot is its first client. That document owns the architecture (§2), the tool catalogue (§3), auth (§4), quota, idempotency and cancellation (§5), client integration (§6), S0 (§7) and the shared open questions (§9). This document covers only what is different when Hermes is the client. It is slice B7 of #536 §8. Tool names below are the #536 drafts and follow any change there.

## Ruling followed

Aimpact, 2026-10-19 about 14:00 HKT. It replaces every earlier Grok and Hermes instruction:

- The external Bot beta line is one **byok MCP server**. External Bots (Grok Bot, Hermes) connect to it as **MCP clients**.
- The server exposes existing byok Bot infrastructure as tools: dispatch work to coding agents (Pi, Codex, Claude), memory, routine, outcome and ledger.
- No separate stack. Grok and Hermes are not `RuntimeAdapter`s as the main form.
- Auth and quota are per Bot, with keys.
- Recommended default, still to confirm: the external Bot keeps its own conversation memory; byok keeps tasks and artifacts (#536 §9 Q1).
- The Bot mode PRD does not change. This branch never changed it: `git diff --stat origin/main...HEAD` lists only this plan file.

Superseded: plan v1 (`ab704346`, a `HermesAdapter` runtime) and plan v2 (`af9955c4`, Hermes as an external member of Bot mode). The file was renamed from `2026-10-19-519-hermes-adapter-plan.md`.

## Conclusion

1. Hermes connects to the #536 server as an ordinary MCP client: one entry in the profile `mcp_servers`, loopback Streamable HTTP, `Authorization: Bearer <byok bot key>`. Hermes needs no SDK adapter, no ACP, no `shared/acp` vendoring and no protocol change.
2. One dedicated Hermes profile maps to one byok bot key. The key gives the Bot identity, scopes and quota (#536 §4).
3. Hermes must not code. The Bot profile turns off Hermes's own coding paths (`terminal`, `file`, `code_execution`, `delegation` and others). Then coding work can reach coding agents only through `byok_task_submit`.
4. Results are asynchronous. `byok_task_submit` returns at once, and `byok_task_status` waits at most 50 s (#536 §5), well inside Hermes's 300 s MCP timeout. Hermes needs no push (#536 §6).
5. Process ownership: the Hermes gateway belongs to the user. byok never runs `hermes` commands that open a session. The MCP server and the coding agents belong to the byok Host and device daemon, never to a process that Hermes started (#536 §2).

## 1. Inventory (Hermes side)

#536 §1 owns the inventory of byok MCP code (reserved helpers, `mcpToolsets`, `packages/client/src/mcp-server`, the `@byok-sdk/server` API) and of OAR and herdr. This section lists only Hermes facts. All of them come from reading the source; only `--help` and `--version` were run.

### 1.1 OAR and Hermes

OAR has no Hermes runtime (verified on upstream `main@5296675b`: runtime directories, `docs/runtimes/`, README, full-text search, issues and PRs). Under this ruling that fact only confirms that Hermes is a client, not a worker. herdr can start a `hermes` kind, but herdr is not on the beta execution path (#536 §9 Q8).

### 1.2 Hermes MCP client

| Fact | Evidence |
| --- | --- |
| The MCP client reads `mcp_servers` from the profile's `config.yaml`. Each profile has its own config. | `tools/mcp_tool.py:2-3`; `hermes_cli/mcp_config.py:210-214`; `toolsets.py:341-343` |
| stdio form: `command`, `args`, `env`, `cwd`. HTTP form: `url`, `headers`, `ssl_verify`. The default is Streamable HTTP; `transport: sse` selects SSE. | `tools/mcp_tool_transport.py:117,127,133,362,370,605-608` |
| Other keys: `connect_timeout`, `auth`, `oauth`, `keepalive_interval`, `sampling`, `elicitation`, `tools.include` / `tools.exclude` (globs). | `tools/mcp_tool_transport.py:413`; `tools/mcp_tool_server_run.py:68,263-276`; `tools/mcp_tool_registration.py:227-228` |
| Tools appear as `mcp__<server>__<tool>`, clamped to 64 characters with a hash suffix. Each server is toolset `mcp-<server>`. With server name `byok`, `byok_task_submit` becomes `mcp__byok__byok_task_submit`. | `tools/mcp_tool_schema.py:153-175`; `tools/mcp_tool_registration.py:135,334` |
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

### 1.4 Gateway, memory and cron facts (from plan v1/v2, unchanged)

- `hermes acp`, `hermes chat -q` and `hermes -z` start a **detached** `gateway run --idle-exit` daemon on first use. It escapes the caller's process tree and lives up to 600 s after it goes idle (`hermes_cli/gateway_client.py:215`; `gateway_runtime_start.py:31-71`; `gateway/run_idle_exit.py:1-20`).
- The gateway runs all tools and MCP connections for its profile. A stdio MCP server that Hermes starts is a child of that gateway, and it stops when the gateway stops, restarts or idle-exits [UNVERIFIED for idle exit with an open MCP session].
- Hermes memory is per profile: `memories/MEMORY.md` (2,200 characters), `USER.md` (1,375 characters), and an optional external provider (`tools/memory_tool.py:2,40`; `config_defaults.py:1325-1343`).
- Hermes cron is per profile: `<profile>/cron/jobs.json`, run by the gateway every 60 s. `cronjob_manage` is in the core toolset (`cron/jobs.py:2,79-83`).

## 2. Delta table: Hermes versus Grok Bot

| Area | Shared (#536) | Grok Bot (#536 §6) | Hermes (this document) |
| --- | --- | --- | --- |
| Server, tools, schemas | One server, `byok_*` tools (§3) | Same | Same. No Hermes-only tool |
| Transport | Streamable HTTP, Host-owned (§2) | Remote HTTPS to a public Host URL | Loopback HTTP. stdio only as a thin client (§3.1) |
| Credential | One byok bot key per Bot (§4) | Custom MCP "Bot's own credential" field | `Authorization` header in the profile `mcp_servers` entry; secret in the profile `.env` (§3.3) |
| Identity | Key → devices, runtimes, optional `AgentRef` (§9 Q4) | One Grok Bot | One Hermes profile (§3.2) |
| Results | `byok_task_status`, wait ≤ 50 s (§5) | Loop plus optional routine-webhook push | Loop only. No push (§4.2) |
| Who codes | Coding agents behind the device daemon | #536 | Hermes coding toolsets off (§4.1) |
| Conversation memory | External Bot owns it (§9 Q1) | xAI side | Hermes profile memory (§5) |
| byok memory | `byok_memory_read` read-only in v1 (§9 Q9) | Same | Same; never mirrored into Hermes memory (§5) |
| Routines | `byok_routine_*` (§3.2) | Same | Same; Hermes cron off (§4.4) |
| Process | Host owns server; daemon owns agents | Remote client | User-owned Hermes gateway (§6) |
| Data exposure | Results leave the Host (§9 Q10) | xAI/Cursor storage | Hermes `state.db`, Hermes memory provider, Hermes messaging platforms (§5) |

## 3. Connection

### 3.1 Transport

- **Loopback Streamable HTTP** is the #536 choice for Hermes (#536 §2). The Host owns the server process. A Hermes restart or idle exit does not touch byok state or running coding tasks. The #536 HTTP rules apply: loopback bind, Origin check, 4 MiB body cap (#536 §4).
- **stdio thin client**, only if #536 ships one. The Hermes gateway starts it as a child process. It reads `BYOK_BOT_KEY` from its env and relays calls to the Host. It keeps no task state. A gateway restart then kills only the relay.

Profile template (written by the user, never by byok; the port comes from the Host setup page):

```yaml
# ~/.hermes/profiles/<bot>/config.yaml
mcp_servers:
  byok:
    url: http://127.0.0.1:<port>/mcp
    headers:
      Authorization: "Bearer ${BYOK_BOT_KEY}"   # [UNVERIFIED: env interpolation in headers; S0 item 2]
    timeout: 120                                 # > 50 s status wait, < 300 s default
platform_toolsets:
  <platform>: [mcp-byok, web, vision, todo, clarify, memory]   # allow-list, see §4.1
```

### 3.2 Identity

- One dedicated Hermes profile per byok bot key. The user creates the profile (`hermes profile create <name>`). byok does not write into `~/.hermes`.
- Two profiles must not share a key. Quota and the task ledger are per key, and a key sees only its own tasks (#536 §4).
- Routines and `byok_memory_read` need the key to bind one `AgentRef` (#536 §9 Q4). Since §4.4 moves scheduled work from Hermes cron to `byok_routine_*`, a Hermes key needs an `AgentRef` (Q2).
- Hermes's own Bot Mode (rooms, `message_agent`, peers) stays inside Hermes. Each Hermes Bot that calls byok uses its own key.

### 3.3 Key custody

- The secret lives in the profile `.env`, which Hermes already uses for secrets (`environment-variables.md:9`). Hermes, not byok, holds it at rest. The Host stores only a salted hash (#536 §4).
- With `terminal` and `code_execution` off (§4.1), the model has no tool that can print the environment. With them on, the model could read the key. That is one more reason for §4.1.
- byok model-provider keys (`packages/keys`) never go to Hermes. Hermes provider keys never go to byok. Coding agents use their own device lanes.
- Revocation applies to the next call (#536 §4). A Hermes user who rotates the key edits only the `.env`.

## 4. Behavior deltas

### 4.1 Hermes must not code

The ruling says coding agents do the work. A Hermes profile with default toolsets can run `claude -p` through `terminal`, patch files, or delegate. The byok Bot profile uses an allow-list:

- Keep: `mcp-byok`, chat tools (`web`, `vision`, `todo`, `clarify`, `memory`).
- Remove: `terminal` (`terminal`, `process_manage`), `file`, `code_execution`, `delegation`, `browser`, `computer_use`, `kanban`, `cronjob` (§4.4), `a2a`.
- Use the allow-list, not `agent.disabled_toolsets`, which can remove shared tools by accident. A typo gives zero tools, so the setup check must show the resolved tool list.

byok cannot enforce this. Hermes is the user's program, and the server sees only valid keys. Q1 asks for a setup confirmation.

### 4.2 Long-running work and results

- `byok_task_submit` returns `{taskId, state, deduplicated}` within seconds (#536 §5).
- `byok_task_status` with `waitSeconds` up to 50 fits inside the 120 s `timeout` of §3.1 and Hermes's 300 s default.
- v1 delivery: the model loops `byok_task_status`, or calls it when the user asks or at the start of its next turn. The task id stays in the Hermes conversation. `byok_task_list` recovers lost ids.
- No push into Hermes. #536 §6 marks push as not needed for Hermes. A2A inbound or `hermes mcp serve` would need byok to hold a Hermes credential.

### 4.3 Idempotency and retries

- #536 §5 derives `taskId` from the key and either `clientRequestId` or the argument hash within a 15-minute window. A Hermes transport retry of the same call returns the same task with `deduplicated: true`.
- Hermes delta 1: S0 must show that a Hermes retry re-sends identical arguments [UNVERIFIED: Hermes MCP client retry policy]. If Hermes changes any argument, the window rule does not catch it.
- Hermes delta 2: when the user asks to run the same task again within 15 minutes, the model must pass a new `clientRequestId`, or the server returns the old task. The Hermes setup page and the tool description must say this.
- Cancel is only `byok_task_cancel`. Closing the Hermes session, an MCP `notifications/cancelled`, or a gateway stop does not cancel byok tasks (#536 §5).

### 4.4 Routine versus Hermes cron

- Scheduled coding work uses `byok_routine_create` / `_list` / `_cancel` (#536 §3.2). byok then owns the schedule, the quota (8 routines per key) and the ledger.
- Hermes cron (`cronjob_manage`) would be a second scheduler that byok cannot see or count. The Bot profile removes `cronjob` (Q3).

### 4.5 Outcome and ledger

- The outcome of a coding task is `byok_task_status.document`: the `submit_result` document that the device daemon validated against the caller's `resultSchema` (#536 §3.4). Hermes passes `resultSchema` when it needs a structured answer.
- The ledgers are `byok_task_list` and `byok_routine_list`.
- `bot-turn-outcome.v1` actions are Bot mode contracts and do not apply in the beta (#536 §3.4). This is not a Hermes limit.

## 5. Memory boundary

Default per #536 §9 Q1 (to confirm), with the Hermes details:

- Hermes keeps the conversation memory: `MEMORY.md`, `USER.md` and any Hermes memory provider in that profile.
- byok keeps tasks, artifacts, the ledgers and its own Agent-home memory. `byok_memory_read` is read-only in v1 (#536 §9 Q9). Its description names byok Agent-home memory in its first sentence (#536 §3.3).
- Hermes stores references (task ids, short summaries), not artifact bodies or byok memory text. Hermes memory is small anyway (2,200 and 1,375 characters).
- Hermes's own `memory` tool and `byok_memory_read` coexist in one tool list. The setup page tells the user that the first is the Bot's notes and the second is a read view of byok's Agent memory.

Data flow to disclose (#536 §9 Q10, Hermes form): task results, artifact URLs and byok memory text that Hermes reads enter Hermes `state.db`, Hermes memory, and possibly an external Hermes memory provider or a Hermes messaging platform. byok cannot track them after the tool returns. Short-lived artifact URLs (#536 §3.1) limit, but do not remove, that exposure.

## 6. Gateway ownership and process risk

- The Hermes gateway is the user's: an installed service, Desktop, a manual run, or an idle-exit daemon. byok never runs `hermes acp`, `hermes chat`, `hermes -z`, `gateway run|ensure|start` or any command that opens a session. A byok doctor check may run `hermes --version` only.
- If the user tests the setup with `hermes chat -q`, Hermes starts an idle-exit gateway. That is Hermes behavior on the user's machine. It is not a byok process and it holds no byok task.
- The MCP server runs in the Host process (#536 §2). Coding-agent processes are children of the device daemon. So a gateway restart cannot kill byok state or coding work, in either transport form.

## 7. S0 (Hermes items; #536 §7 item 9)

S0 runs on a scratch profile that S0 creates and deletes. It never touches the user's default profile. It needs a #536 B3 build or a fake MCP server with the same tool shapes.

1. Hermes connects over loopback HTTP (and over the stdio thin client, if #536 ships one). Tools show as `mcp__byok__byok_*`.
2. `${VAR}` interpolation works in `headers` (and `env`), or S0 records the supported form.
3. The allow-list in §4.1 leaves only the intended tools (`hermes tools` output). The model has no way to run a coding CLI.
4. A 50 s `byok_task_status` long poll completes inside the configured timeout. `isError` refusals (`quota_exceeded`, `not_found`) reach the model as tool errors.
5. Retry behavior: a forced transport error during `byok_task_submit` shows whether Hermes re-sends the same call with identical arguments, and the server answers `deduplicated: true`.
6. Gateway restart and idle exit during a running coding task: the task continues, and `byok_task_status` works after Hermes reconnects.
7. Process audit: during a full cycle byok starts no `hermes` process and no new `gateway run --idle-exit` appears.
8. Hermes approval prompts for MCP tool calls: whether they appear, and on which platforms.
9. Memory: after three tasks, Hermes `MEMORY.md` holds references only [behavioral; record, not a hard gate].

One paid model run needs Aimpact approval. If item 3, 5 or 7 fails, stop and report.

## 8. Open questions (Hermes-specific)

Shared questions are in #536 §9: the memory boundary (Q1), the key (Q2), placement (Q3), identity (Q4), idempotency (Q6), quota (Q7), herdr (Q8), memory write (Q9), disclosure (Q10). These are the Hermes deltas:

| # | Question | Recommended answer | Reason |
| --- | --- | --- | --- |
| Q1 | byok cannot enforce "Hermes must not code". Require the user to confirm the §4.1 toolset setup before the key is issued, with a check that shows the resolved tool list? | Yes | The ruling assigns coding to coding agents |
| Q2 | Bind an `AgentRef` to every Hermes key, so `byok_routine_*` and `byok_memory_read` work (#536 §9 Q4)? | Yes | §4.4 moves scheduled work from Hermes cron to byok routines |
| Q3 | Hermes cron in the Bot profile: off? | Off. Scheduled work uses byok routines | One scheduler, one quota |
| Q4 | Hermes stores only references in its own memory, never artifact bodies or byok memory text? | Yes, stated in the setup page and the tool descriptions | Smaller exposure; Hermes memory is small |
| Q5 | Is Hermes in the first beta cohort with Grok Bot, or second? | Second, after the Grok Bot client passes #536 S0 | Grok Bot is the declared first client |
| Q6 | Platforms: macOS first; Windows when Hermes's own gateway passes S0 there? | Yes | The client side is Hermes's platform risk |
| Q7 | #519 still asks for a `HermesAdapter` runtime. Retitle it to "Hermes as a byok MCP client (external Bot beta)"? | The issue owner retitles after this plan is accepted | This PR does not edit issues |

## 9. Slices (Hermes only; #536 B7, after #536 B1–B3)

- **H0. S0 evidence** (§7). No product code. Probe in `/tmp`, record in `tasks/runs/`, note in `docs/notes/`.
- **H1. Hermes client guide.** The profile template, the toolset allow-list, key custody, the `clientRequestId` rule and the data-flow disclosure, as a docs page next to the #536 Grok Bot guide (B6). No code.
- **H2. Setup check text.** The expected `byok_whoami` output for a Hermes key, and the expected `hermes tools` list. Docs only.
- **H3. Live acceptance.** One Hermes profile submits a task to each allowed runtime, waits, reads the document and an artifact, lists tasks, creates and cancels one routine, and cancels one task. Paid runs need approval.

No slice here changes SDK packages, the protocol or the vendored OAR fork. Those changes, if any, belong to #536.

## 10. Risks

- Hermes is fast-moving (a breaking API auth change in July 2026, `website/docs/user-guide/features/api-server.md:885-893`). S0 and the version in the client guide are the guards.
- The user can turn `terminal` back on at any time. Then Hermes can code by itself and can read the key. byok cannot detect this.
- A model that does not loop `byok_task_status` leaves finished tasks unread. The tool descriptions and the guide must say when to call it.
- Content read through MCP can leave the device through Hermes memory providers or platforms.
- #536 is a draft. A change to its transport, auth or tool shapes changes §3 and §7 here.
