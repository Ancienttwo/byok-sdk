# Hermes Agent as a byok MCP client (beta, B7)

This guide connects one Hermes Agent profile to the byok MCP beta server in this
example. Hermes talks to the user. byok coding agents (Pi, Codex, Claude) do the
coding work on a paired device. Hermes reaches them only through the `byok_*` tools.

Sources: the [beta plan](../../../docs/adr/ADR-040-byok-mcp-server-external-bot-beta.md)
§4–§8 and the [Hermes client plan](https://github.com/Ancienttwo/byok-sdk/pull/539)
§3–§9 (H1–H3, issue #593). Tool names, arguments and limits below come from the code
in `src/`, cited as `file:line` at byok-sdk `6fad13af`. Paths are relative to
`examples/byok-mcp-server/` unless they start with `packages/`. Hermes facts come from reading
the installed Hermes source (`~/.hermes/hermes-agent`, `b30f95ac`, `hermes --version`
`v0.21.6+666.gb30f95a`). Only `--help` and `--version` were run. Anything not proven
by code or a run is marked **UNVERIFIED**. The live checklist at the end is how the
owner closes those gaps.

## 1. What runs where

```
User ── chat ──> Hermes gateway (user-owned, profile <bot>)     conversation + Hermes memory
                   │ MCP client, loopback Streamable HTTP, Bearer <byok bot key>
                   ▼
              byok Host process: createBetaMcpServer + BetaLedger   keys, quota, task/routine ledger
                   ▼
              paired device daemon ──> pi | codex | claude          coding work
```

- The Hermes gateway belongs to the user. byok never starts `hermes chat`, `hermes acp`,
  `hermes -z` or a gateway. A Hermes restart does not touch byok tasks (plan §6).
- The MCP endpoint and the coding agents belong to the byok Host and the device
  daemon. Nothing Hermes starts owns them.
- There is no stdio thin client in this example. Hermes uses loopback HTTP only.
- There is no Cross-Bot and no `byok_agent_message` in beta v1. Hermes uses other
  work only as task results it is allowed to read.

## 2. Host prerequisites

This example has no listener, admin route or default key (`README.md:10`). The Host
owner must supply these before Hermes can connect:

1. Compose the endpoint as in `README.md:14-34`, plus `createRoutineTools`
   (`README.md:224-228`) and `createMemoryTools` (`README.md:286-289`) when the key
   gets routine and memory scopes.
2. Use a loopback `origin`, for example `http://127.0.0.1:<port>`. `createBetaMcpServer`
   accepts only one canonical HTTPS or loopback HTTP origin (`src/http.ts:27-31`).
   A request that sends an `Origin` header must match it, or it gets 403
   (`src/http.ts:49-50`).
3. Mount `endpoint.fetch` at one path on a loopback listener. The path is the Host's
   choice. This guide writes it as `/mcp`.
4. Hermes and the Host run on the same machine. A Hermes on another machine would need
   the Host's public HTTPS URL (checklist item L0b).

## 3. Issue one key per Hermes profile

One Hermes profile maps to one byok bot key. Two profiles never share a key: quota,
the task ledger and the routine ledger are per key, and a key sees only its own work.

Issue it from trusted in-process Host code with `ledger.issueKey` (`README.md:56-59`,
`src/ledger.ts:99-108`). Recommended spec for a Hermes Bot:

```ts
const { token, key } = ledger.issueKey({
  label: 'hermes:<bot>',
  scopes: ['tasks.dispatch', 'tasks.read', 'tasks.cancel', 'artifacts.read',
    'routines.read', 'routines.write', 'memory.read'],
  deviceIds: ['<paired device id>'],
  runtimes: ['pi', 'codex', 'claude'],   // subset you allow
  agentRef: <the byok Agent this Bot may schedule and read memory for>,
});
```

- `runtimes` accepts only `pi`, `claude` and `codex` (`packages/protocol/src/messages.ts:52`).
- Dispatch, routine and memory scopes need an `agentRef`. A spec with those scopes and no
  `agentRef` is refused (`src/model.ts:96`, `src/model.ts:118`). Hermes scheduled work
  moves to `byok_routine_*` (§6), so a Hermes key binds an `agentRef` (plan H2).
- Leave out `memory.write`. Beta v1 has no memory-write tool (`README.md:69-71`).
- Default quota (`src/model.ts:9`): 4 occupied task slots, 60 new tasks per rolling
  hour, 8 routines, 120 status reads per rolling minute.
- Grants never change. To change one, revoke the key and issue a new one. Old tasks do
  not move to the new key (`README.md:65-66`).
- The token is `byok_bot_<32 hex>.<43 base64url>` (`src/ledger.ts:101-107`, `:114`).
  It is returned once. Only a salted digest is stored.

## 4. Hermes profile setup

The user creates the profile and writes these files. byok does not write into `~/.hermes`.

```sh
hermes profile create <bot>
```

Key custody: put the token in the profile `.env`, never in `config.yaml`:

```sh
# ~/.hermes/profiles/<bot>/.env
BYOK_BOT_KEY=byok_bot_<keyId>.<secret>
```

Profile config:

```yaml
# ~/.hermes/profiles/<bot>/config.yaml
mcp_servers:
  byok:
    url: http://127.0.0.1:<port>/mcp
    headers:
      Authorization: "Bearer ${BYOK_BOT_KEY}"
    timeout: 120          # longer than the 50 s status wait, shorter than Hermes's 300 s default
platform_toolsets:
  <platform>: [mcp-byok, web, vision, todo, clarify, memory]
```

- `${BYOK_BOT_KEY}` in `headers` is resolved by Hermes from the active profile's secret
  scope. The resolver walks dicts and lists recursively. An unset variable keeps the
  literal placeholder (installed Hermes `tools/mcp_tool_config.py:448-462`, applied at
  `:558`). Verified by source read only. A run is checklist item L2.
- An unset `BYOK_BOT_KEY` therefore sends `Bearer ${BYOK_BOT_KEY}`, and the server answers
  401 (`src/http.ts:73-75`). The same 401 covers a missing, wrong or revoked key
  (`README.md:64`).
- The server name `byok` gives toolset `mcp-byok` (installed Hermes
  `tools/mcp_tool_registration.py:135`) and tool names `mcp__byok__<tool>`
  (`tools/mcp_tool_schema.py:159`, `:171-175`). The longest one,
  `mcp__byok__byok_routine_create`, is 30 characters, under the 64-character clamp.
- `timeout` order: `mcp_servers.<name>.timeout`, then `timeouts.mcp.tool_call`, then 300 s
  (`tools/mcp_tool_common.py:41-57`). The maximum of the platform clamp is UNVERIFIED.
- Optional: `mcp_servers.byok.tools.include: ["byok_*"]` limits registration to the
  byok tools (`tools/mcp_tool_registration.py:217-221`). The server already lists only
  tools whose scope the key holds (`src/http.ts:55`).

### 4.1 Hermes must not code

A default Hermes profile can run coding CLIs through `terminal`, patch files, run code
or delegate. The byok Bot profile uses an allow-list in `platform_toolsets`:

- Keep: `mcp-byok`, `web`, `vision`, `todo`, `clarify`, `memory`.
- Leave out: `terminal` (also removes `process_manage`), `file`, `code_execution`,
  `delegation`, `browser`, `computer_use`, `kanban`, `cronjob`, `skills`. The Hermes
  plan also names `a2a`; installed `b30f95ac` has no toolset by that name, and the
  allow-list keeps it out either way.
- Do not use `agent.disabled_toolsets` for this. It can remove shared tools by accident.
- The default `cli` bundle `hermes-cli` is "everything + cronjob management", and the
  messaging bundles include `terminal` and `file` (installed Hermes
  `cli-config.yaml.example:1398-1407`). Set the allow-list for every platform the
  profile serves.
- The kept names and the left-out names other than `a2a` exist in installed Hermes
  `toolsets.py:76-159`. A wrong name resolves to zero tools, so run the setup check (§8).

byok cannot enforce this. Hermes is the user's program, and the server sees only a
valid key. With `terminal` or `code_execution` on, the model could also print the key
from the environment. The owner confirms the allow-list before issuing the key (plan H1).

## 5. Tools as Hermes sees them

All tools take the caller from the key, never from arguments. A foreign or unknown
`taskId` or `routineId` answers `not_found` (`README.md:156-157`). Every result is
JSON text. A refusal is `isError: true` with `{ code, message, retryAfterSeconds? }`
(`src/http.ts:20-23`). Codes: `unauthorized`, `forbidden`, `not_found`,
`invalid_input`, `quota_exceeded`, `rate_limited`, `idempotency_conflict`,
`unavailable` (`src/model.ts:14`).

| Hermes name | Scope | Arguments and limits | Code |
| --- | --- | --- | --- |
| `mcp__byok__byok_whoami` | any valid key | `{}` | `src/tools.ts:123-136` |
| `mcp__byok__byok_runtimes` | `tasks.read` | `{}`. `installed` is `null` while device presence is stale | `src/tools.ts:140-157` |
| `mcp__byok__byok_task_submit` | `tasks.dispatch` | `runtime` (required), `instruction` (required, ≤ 32 KiB UTF-8), `toolsets?` (1–16 distinct ids), `clientRequestId?` (1–160 of `A-Za-z0-9._:-`) | `src/tools.ts:161-181`, `src/model.ts:11`, `:125-127`, `src/tools.ts:116` |
| `mcp__byok__byok_task_status` | `tasks.read` | `taskId`, `waitSeconds?` 0–50, default 0 | `src/tools.ts:20`, `:185-204` |
| `mcp__byok__byok_task_cancel` | `tasks.cancel` | `taskId`, `reason?` ≤ 512 bytes | `src/tools.ts:208-224` |
| `mcp__byok__byok_task_list` | `tasks.read` | `cursor?`, `limit?` 1–50 (default 20), `state?` | `src/tools.ts:21-22`, `:228-248` |
| `mcp__byok__byok_artifact_url` | `artifacts.read` | `taskId`, `index` ≥ 0 | `src/tools.ts:252-264` |
| `mcp__byok__byok_routine_create` | `routines.write` | `localId` (1–160 of `A-Za-z0-9._:-`), `schedule`, `task: { runtime, instruction, toolsets?, resultSchema? }` | `src/routines.ts:56`, `:135-175` |
| `mcp__byok__byok_routine_list` | `routines.read` | `cursor?`, `limit?` 1–50 (default 20) | `src/routines.ts:43-44`, `:179-201` |
| `mcp__byok__byok_routine_cancel` | `routines.write` | `routineId` | `src/routines.ts:205-213` |
| `mcp__byok__byok_memory_read` | `memory.read` | `path?`, only `MEMORY.md` | `src/memory.ts:25-49` |

Limits that differ from the beta plan draft:

- `byok_task_submit` refuses `resultSchema` and `workspace` before admission
  (`src/tools.ts:113-114`, `README.md:177-181`). A one-off task therefore has no
  `document`. A structured result is available only from a routine with a
  `resultSchema` (`src/routines.ts:65-66`, `:127`).
- Daemon tasks report files as live events and set no `artifactRefs`, so a daemon task
  lists `artifacts: []` and `byok_artifact_url` answers `not_found` (`README.md:195-198`).
- `schedule` is `{ minute, hour, tz }` plus `daysOfWeek` or `dayOfMonth` (optional
  `month`); `tz` is an IANA zone. There is no cron string (`src/routines.ts:141-142`,
  `README.md:230-233`).
- Routine occurrence task ids are not `byok_task_*` tasks. `byok_task_status` answers
  `not_found` for them. Read them in `byok_routine_list` → `lastOccurrence`
  (`README.md:255-258`).
- Cancel of a `Reserved` task changes nothing, and a retry of the same submit still
  starts it (`src/tools.ts:208-209`).

## 6. Rules for the Bot

Put these in the profile's instructions to the model. The tool descriptions already
carry the submit and memory rules (`src/tools.ts:162-163`, `src/memory.ts:26-28`).
The persona file name for a Hermes profile is UNVERIFIED here; use the profile's
system prompt or persona setting.

1. **Coding goes to byok.** For any code change, test run or repository work, call
   `byok_task_submit`. Never run code yourself.
2. **Results are asynchronous.** Submit returns a `taskId` at once. Then call
   `byok_task_status` with `waitSeconds: 50` until `state` is `Complete`, `Failed` or
   `Cancelled`. Tell the user the task id. If the id is lost, use `byok_task_list`.
   There is no push into Hermes.
3. **`clientRequestId` rule.** A retry of the same call returns the same task with
   `deduplicated: true`. Without `clientRequestId`, the same arguments within 15 minutes
   of the first admission return the first task (`src/model.ts:10`, `README.md:102-104`).
   When the user asks to run the same thing again, send a new `clientRequestId`. Reusing
   one with other arguments gives `idempotency_conflict` (`README.md:99-101`).
4. **Cancel only with the tool.** Only `byok_task_cancel` cancels a task. Closing the
   chat, an MCP cancellation or a gateway stop ends only the wait (`README.md:188`).
5. **Schedules use byok routines.** Hermes cron is off (`cronjob` is not in the
   allow-list). Use `byok_routine_create`, `byok_routine_list`, `byok_routine_cancel`.
   A routine never changes: cancel it and create one with a new `localId`.
6. **References-only memory.** Save task ids, routine ids and one-line summaries in
   Hermes memory. Do not copy result documents, artifact contents or byok memory text
   into it. Hermes `memory` is the Bot's own notes. `byok_memory_read` is a read-only
   view of the byok Agent's `MEMORY.md`, not the Bot's memory.
7. **Refusals.** On `quota_exceeded` or `rate_limited`, wait `retryAfterSeconds` before
   trying again. The hint is advisory (`README.md:136`). On `not_found`, check the id.

## 7. Data flow (disclosure)

The Host page that issues a Hermes key must show this (beta plan §9 Q10, Hermes form
in the Hermes plan §5):

- Every tool result Hermes reads — task states, final messages, routine result documents,
  artifact URLs and redacted byok memory text — enters Hermes storage: the profile's
  session store, Hermes memory, any external Hermes memory provider, and any messaging
  platform the profile posts to. byok cannot see or recall it after the tool returns.
- Artifact URLs expire with the SDK blob grant, 15 minutes by default (`README.md:201`).
  That limits the exposure but does not remove it.
- `byok_memory_read` returns only the text that the device's Host-owned redactor
  projected (`README.md:298-299`, `:317-318`).
- The byok bot key stays in the profile `.env` on the user's machine. byok model-provider
  keys never go to Hermes, and Hermes provider keys never go to byok.

## 8. Setup check (H2)

Run these after the profile and the Host are up. They need no paid model run except
the `whoami` call, which needs one model turn in Hermes (see L3).

### 8.1 Expected `byok_whoami` result for a Hermes key

Shape from `src/tools.ts:130-135` and `src/model.ts:68-73`:

```json
{
  "keyId": "byok_bot_<32 hex>",
  "label": "hermes:<bot>",
  "scopes": ["tasks.dispatch", "tasks.read", "tasks.cancel", "artifacts.read",
             "routines.read", "routines.write", "memory.read"],
  "runtimes": ["pi", "codex", "claude"],
  "devices": [{ "deviceId": "<id>", "name": "<device name>", "registered": true, "connected": true }],
  "quota": {
    "limits": { "runningTasks": 4, "submitsPerHour": 60, "routines": 8, "statusPerMinute": 120 },
    "now": { "runningTasks": 0, "remainingSubmits": 60, "routines": 0, "remainingStatusReads": 120 }
  }
}
```

Check:

- `keyId` matches the key the owner issued for this profile, and no other profile uses it.
- `scopes` contains `routines.write` and `memory.read`. That proves the key has an
  `agentRef`, because the ledger refuses those scopes without one (`src/model.ts:118`).
  `whoami` does not print the `agentRef` itself.
- `scopes` has no `memory.write`.
- Each device shows `registered: true`. A device that is not registered shows
  `{ "deviceId": "<id>", "registered": false }` and submit gives `unavailable`
  (`src/tools.ts:46`).
- `quota.now` values depend on earlier use. A fresh key shows the values above.

### 8.2 Expected `hermes tools list` result

```sh
hermes -p <bot> tools list --platform <platform>
```

Expected: enabled toolsets are exactly `mcp-byok`, `web`, `vision`, `todo`, `clarify`
and `memory`. `terminal`, `file`, `code_execution`, `delegation`, `browser`,
`computer_use`, `kanban`, `cronjob` and `skills` are disabled or absent. With
the scopes in §3, `mcp-byok` holds these 11 tools:

```
mcp__byok__byok_whoami          mcp__byok__byok_runtimes
mcp__byok__byok_task_submit     mcp__byok__byok_task_status
mcp__byok__byok_task_cancel     mcp__byok__byok_task_list
mcp__byok__byok_artifact_url    mcp__byok__byok_routine_create
mcp__byok__byok_routine_list    mcp__byok__byok_routine_cancel
mcp__byok__byok_memory_read
```

The exact print format of `hermes tools list`, and whether it lists MCP tools without
a live gateway connection, are UNVERIFIED. If the list shows zero tools, a toolset
name is wrong. If `mcp-byok` is present but empty, check the URL, the 401 case in §4
and the Host composition.

## 9. Live acceptance checklist (H3, owner)

Paid model runs and a real Hermes session need Aimpact approval before they start. Record
each result (command output, tool result JSON or a screenshot) in `tasks/runs/` and note
pass or fail per item. If L2, L4 or L12 fails, stop and report.

Preconditions

- [ ] L0a. Owner approves the paid model runs for this checklist, and names the Hermes
      model and platform (macOS first, plan H5).
- [ ] L0b. Host runs on the same machine as Hermes with a loopback listener (§2).
      Only if Hermes is on another machine: provide a public HTTPS URL for the Host
      and use it as `origin` instead; this guide does not cover that setup.
- [ ] L0c. A device is paired and online with the runtimes to test installed and signed in.
- [ ] L1. A dedicated scratch profile `hermes -p <bot>` exists. The user's default
      profile is not touched. The Bot account or messaging platform the profile
      uses is set up by the owner.

Setup

- [ ] L2. Key issued per §3; token in the profile `.env`; config per §4. The Hermes
      session connects, and an empty `BYOK_BOT_KEY` gives a 401 (env interpolation works).
- [ ] L3. `byok_whoami` matches §8.1.
- [ ] L4. `hermes -p <bot> tools list --platform <platform>` matches §8.2. Ask the model
      to edit a file or run a shell command: it has no tool for it and offers
      `byok_task_submit` instead.

Tasks (one run per allowed runtime: pi, codex, claude)

- [ ] L5. `byok_runtimes` shows each allowed runtime `installed: true` on the device.
- [ ] L6. Submit a small task to each allowed runtime. Each returns a `taskId` within
      seconds.
- [ ] L7. `byok_task_status` with `waitSeconds: 50` returns inside the 120 s timeout.
      The model loops until a terminal state. Record `finalMessage`.
- [ ] L8. Read the outcome document. Expected for a one-off task: no `document`
      (`resultSchema` is refused, §5). Read a document through L11 instead. Record
      what came back.
- [ ] L9. Read an artifact. Expected for a daemon task: `artifacts: []`, and
      `byok_artifact_url` with index 0 answers `not_found` (§5). Record the result; a
      real artifact read stays an open gap until the daemon sets `artifactRefs`.
- [ ] L10. `byok_task_list` shows this key's tasks newest first, and no other key's.
- [ ] L11. Create one routine with a near due time and a small `resultSchema`. Wait for
      one occurrence. `byok_routine_list` shows `lastOccurrence` with its `conclusion`
      and `document`. Then `byok_routine_cancel` returns `state: "completed"`; list
      shows `lifecycle: "completed"` and no new occurrence starts. Record `nextAt`.
- [ ] L12. Submit a longer task, then `byok_task_cancel` it. Status ends `Cancelled`.
      Closing the Hermes chat during another running task does not cancel it.
- [ ] L13. Ask to run a finished task again within 15 minutes. The model sends a new
      `clientRequestId` and gets a new `taskId` (`deduplicated: false`).

Hermes-side items (plan §7)

- [ ] L14. Refusals reach the model as tool errors: `not_found` for a made-up `taskId`;
      `quota_exceeded` when a fifth task is submitted while four occupy slots.
- [ ] L15. Restart the Hermes gateway during a running task. The task continues, and
      `byok_task_status` works after Hermes reconnects.
- [ ] L16. Process audit: during the full cycle byok starts no `hermes` process.
- [ ] L17. Record whether Hermes shows approval prompts for MCP tool calls on this
      platform.
- [ ] L18. After three tasks, the profile's `memories/MEMORY.md` holds ids and short
      summaries only (behavioral; record, not a hard gate).
- [ ] L19. Retry identity (UNVERIFIED): force a transport error during
      `byok_task_submit` and record whether Hermes resends identical arguments and gets
      `deduplicated: true`.
- [ ] L20. Revoke the key. The next call gets 401. A running task is not killed; its
      routines start no new occurrence (`README.md:81-83`, `:266-268`).

## 10. Open and UNVERIFIED items

| Item | State |
| --- | --- |
| `${VAR}` in `headers` | Source read on installed Hermes `b30f95ac`; not run (L2) |
| Hermes MCP retry resends identical arguments | UNVERIFIED (L19) |
| Maximum of Hermes's platform timeout clamp | UNVERIFIED |
| `hermes tools list` print format and MCP listing without a live connection | UNVERIFIED (L4) |
| Hermes approval prompts for MCP calls | UNVERIFIED (L17) |
| Persona or system-prompt file for §6 rules | UNVERIFIED |
| Gateway idle exit with an open MCP HTTP session | UNVERIFIED (L15) |
| One-off task `document` | Not available: `resultSchema` refused (`src/tools.ts:113`) |
| Daemon task artifacts | Not available: no `artifactRefs` (`README.md:196-198`) |
| Windows | Not covered; macOS first (plan H5) |
