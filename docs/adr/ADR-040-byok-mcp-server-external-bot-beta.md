# ADR-040: byok MCP server for external Bots (beta)

> **Origin**: PR [#536](https://github.com/Ancienttwo/byok-sdk/pull/536), issue [#514](https://github.com/Ancienttwo/byok-sdk/issues/514). The decisions are §0 Ruling, §9 Q1–Q11 and §10 Non-goals. The other sections are their context.
> **Moved**: #1291 moved this file here from the retired plans directory (`2026-10-19-byok-mcp-server-external-bot-beta.md`). The text is unchanged, except links to moved or removed files, which now point to the new path or to the PR that merged the removed file.

Status: beta plan, docs only. No product code. Date: 2026-10-19. Q1–Q11 DECIDED (Aimpact, 2026-10-19 14:11 HKT; §9).
PR: [#536](https://github.com/Ancienttwo/byok-sdk/pull/536) (this main document). Hermes client deltas: [#539](https://github.com/Ancienttwo/byok-sdk/pull/539), https://github.com/Ancienttwo/byok-sdk/pull/539. Optional Grok CLI runtime: [#514 plan](https://github.com/Ancienttwo/byok-sdk/pull/536).
Baseline: byok-sdk `origin/main@5b988a6e` (includes K8-S, #525). OAR `c264f17` (0.67.0).

## 0. Ruling

Aimpact, 2026-10-19, about 14:00 HKT. This ruling replaces all earlier Grok and Hermes instructions.

- The external Bot beta line is one byok MCP server. External Bots (Grok Bot first, then Hermes) connect to it as MCP clients.
- The MCP server exposes the existing byok Bot infrastructure as tools: dispatch work to coding agents (Pi, Codex, Claude), memory, routines, outcomes and ledgers. Tasks go through the device daemon and OAR; herdr is not on the execution path (Q8).
- Do not build a second, separate stack. Do not make Grok or Hermes a `RuntimeAdapter` as the main form.
- Auth and quota are per Bot, with keys.
- Memory boundary (Q1, decided): the external Bot owns its conversation memory; byok owns tasks, artifacts and its own Agent-home memory.

Aimpact, 2026-10-19 14:11 HKT: all recommended answers Q1–Q11 are product-locked (§9). Product structure stays: Session mode and Bot mode do not change (Bot mode is Pi-only; PRD Q4 and Q8 keep their 2026-10-18 meaning). External-bot integration is a separate beta track, not Bot mode. Grok Bot is the first MCP client and Hermes the second. There is no separate stack.

Out of beta v1 (Aimpact, about 14:15 HKT): no `byok_agent_message` and no Cross-Bot collaboration for external Bots. External Bots work together only through tasks and artifacts. Revisit after K8b Cross-Bot lands in Bot mode.

The Bot mode PRD (`docs/adr/ADR-039-bot-mode-product-prd.md`) does not change. Beta and Bot mode are different things. In Bot mode, byok runs the Bot (persona, memory, fresh executions). In this beta, a third-party Bot talks to the user and uses byok as a tool server. Coding agents still do the work.

## 1. Inventory (P1): what exists, what to reuse

### 1.1 MCP code in the SDK (`origin/main`)

| Item | Location | Fact | Reuse |
| --- | --- | --- | --- |
| MCP server core | `packages/client/src/mcp-server/{index,dispatch,framing}.ts`, export `@byok-sdk/client/mcp-server` | Hand-rolled, tools-only, stdio NDJSON. Protocol 2025-11-25, 2025-06-18, 2024-11-05. Bounded line, frame and in-flight limits (`index.ts:266-268`). `notifications/cancelled` aborts the call signal. "Transport plus baseline, never product semantics" (`index.ts:1-12`). | **Yes.** Keep `dispatch.ts` as the one JSON-RPC/tools authority. Add a Streamable HTTP framing beside the stdio framing. |
| Reserved helpers | `packages/client/src/bin/byok-agent-{message,result,memory,team}-mcp.ts` → `sdk-reserved-helper-runners.ts:124-155` | stdio servers for one running task: `send_agent_message`, `submit_result`, `memory_recall`/`memory_save`, `post/read/ack_team_messages`. Each authenticates with a task-scoped context token in a child-only env (`BYOK_AGENT_*_CONTEXT`) and calls the daemon control socket (HMAC handshake, `daemon/control-server.ts`). | **Inside tasks only.** The coding agents keep using them. The beta server does not proxy them: they are device-local and task-scoped by design. |
| Helper injection | `daemon/task-runner.ts:3466-3499`, `:3581-3683` | The daemon adds the reserved servers to `input.mcpServers` for ordinary-lane tasks, mints and revokes tokens per task, preflights message and result helpers. | **Yes, unchanged.** A beta task gets `submit_result` when it asks for a result document. |
| Host toolsets | `daemon/toolset-registry.ts`, `types.ts:88-99`, wire `requiredToolsets` (`protocol/src/messages.ts:122-126`) | Device-configured stdio MCP toolsets, selected per task by id. Adapter flag `capabilities.mcpToolsets`. | **Yes.** `byok_task_submit` can pass `toolsets` ids. |
| MCP dependency | `packages/client/package.json:87` | Only `@modelcontextprotocol/client` 2.0.0. No MCP server library. No HTTP MCP server anywhere. No OAuth or API-key scheme for MCP. | Gap: HTTP transport and per-Bot auth. |

### 1.2 Host API the tools sit on (`packages/server/src/index.ts:175-287`)

| Tool group | Existing API | Notes |
| --- | --- | --- |
| Dispatch | `dispatch(DispatchInput)`: pre-persisted `taskId` + `deviceId`, `instruction`, `runtime`/`runtimeId`, `requiredToolsets`, `messageEgress`, `terminalProjection`, `homeAccess` (`types.ts:157-190`) | Coding-agent task on a paired device. |
| Agent execution | `executions.submit(AgentExecutionInput)`; `taskId` is the idempotency key; a delivered id conflicts with `agent_task_already_exists`, recover with `tasks.offer` | Needs an `AgentRef`. |
| Task state, result, ledger | `tasks.get` (`TaskResult`: `state`, `summary`, `finalMessage`, `artifactRefs`, `document`, `reason`, `code`, `retryable`; `types.ts:236-275`), `tasks.list` (paged, default 100), `tasks.cancel(taskId, reason?)`, `tasks.deviceTerminal`, `tasks.agentMessage`, `tasks.messageDraft` | `document` is the `submit_result` outcome, validated by the daemon against the frozen schema. |
| Artifacts | `blobs.getDownloadUrl` | Files referenced by `artifactRefs`. |
| Routines | `wakes.schedule({dedupKey, availableAt, payload?})`, `wakes.cancel(dedupKey)`, `wakes.pending()`; `nextRoutineOccurrence`, `checkRoutineSchedule` (`packages/core/src/routine-schedule.ts`, #525); `create_routine` fragment (`packages/protocol/src/bot-turn-outcome.ts`) | The routine ledger is Host-owned (PRD §5.5). K4 (`examples/host-execution-core`, in progress) is its reference home. |
| Memory | `enqueueAgentHomeProjection`, `readAgentHomeProjection`, `requestAgentContentRead`; hosted redacted `agent.memory.projection`; `agent.memory.intent` (device CAS) | No `ByokServer` method for memory intents was found; the Host half is PRD P5 work. UNVERIFIED: the cloud-side intent surface. |
| Limits | `rateLimit` option: per-device token bucket on inbound daemon envelopes, 50/s, burst 100 (`server/src/rate-limiter.ts:38-60`) | No limit on Host calls. No per-caller accounting anywhere. |

`packages/keys` manages model-provider credentials on the device (keystores, sealed provisioning, Pi projection). It has no API key for external callers. Per-Bot MCP keys are new Host-side state (§4).

### 1.3 OAR (`c264f17`)

| Item | Location | Fact | Reuse |
| --- | --- | --- | --- |
| `oar mcp` | `packages/cli/src/{mcp-command,mcp-tools,mcp}.ts` | stdio MCP server for subagents. Tools `runtimes`, `run` (blocking), `spawn`, `send`, `wait`, `list`, `interrupt`, `close`. Flags `--runtimes`, `--max-running` (default 4), `--max-depth`, `--cwd`, `--log-dir`. "Subagents run with full permissions in their working directory." Built on `@botiverse/oar/agents` `createSubagents`. | **Design reference only.** The async split (start, wait, interrupt, list) and the concurrency cap carry over. Not embedded: its subagents are children of the MCP process, it has no per-caller auth, and it bypasses the SDK daemon (process tree, egress, outcome validation). |
| Host-served tools over HTTP | `packages/oar/src/mcp/{serve-tools,http}.ts` | Streamable HTTP subset on 127.0.0.1, bearer compared with `timingSafeEqual`, 4 MiB body cap, Origin check, SSE keep-alive. | **Reference** for the HTTP framing (§3.2). Not vendored; the SDK core stays the authority. |
| Coding-agent runtimes | SDK vendors the Codex session (`packages/client/vendor/oar/c264f17`) | The daemon's `CodexAdapter` runs it. | Coding work reaches OAR through the daemon, as today. |

### 1.4 herdr and external Bot facts

- herdr 0.9.3 (`/opt/homebrew/bin/herdr`): `herdr agent start <NAME> --kind <pi|claude|codex|grok|hermes|…> --pane <ID>` starts an interactive agent in a pane. Completion is inferred from the screen. repo-harness rule: "OAR owns coding-agent execution. Herdr owns panes and visibility" (from #539's research).
- herdr notify plugin (`~/Projects/repo-harness/docs/reference-configs/herdr-notify.md`): posts pane events (`blocked`, optional `done`) to a Bot routine webhook with `Authorization: Bearer` and `x-webhook-key`. 5 s timeout, no retry queue. macOS and Linux only. This is a working push path to Grok Bot today.
- Grok Bot surfaces (AiphaBee research `aiphabee/docs/researches/2026-10-18-grok-bot-integration.md` §10 and `plans/plan-20261018-grok-bot-integration.md`): no public "message the bot" API (UNVERIFIED absence). Usable: custom MCP (Remote HTTPS with the Bot's own credential, executed by the Cursor backend; or a Command server on the Bot's cloud computer), routine webhook trigger (Bearer, at least 5 min between runs, no retry), plugins. UNVERIFIED: MCP transport, how a static bearer is entered in the UI, public reachability rule, MCP call timeout, connector egress IPs.
- Precedent: AiphaBee K3 (PR #253) ships hosted MCP tools `list_bots`, `ask_bot`, `read_bot_reply` (long poll, `wait_seconds` ≤ 50) with an API-key scope `bots.chat`. That is the same async shape this beta uses.
- Hermes facts (from #539): MCP client per profile `mcp_servers` in `config.yaml`; no per-run MCP injection; MCP calls time out at 300 s by default; Hermes ignores MCP progress.

### 1.5 Gap

| Need | Present | Gap |
| --- | --- | --- |
| MCP over HTTP for remote clients | stdio core only | Streamable HTTP framing for the SDK core |
| Per-Bot auth, scopes, quota | none | Key ledger and checks in the beta server |
| External-caller task tools | in-process `ByokServer` API | Tool layer that maps tools to that API |
| Idempotent submit under client retry | `taskId` idempotency in `dispatch`/`executions.submit` | Derive `taskId` from the caller and the call (§5) |
| Routine and ledger tools | wakes, routine pure functions, outcome fragments | Host routine ledger (K4) |
| Completion push to the Bot | herdr notify (pane events), AiphaBee K2a (device webhook) | Optional task-completion webhook (§6) |

## 2. Architecture

```
User ── chat ──> External Bot (Grok Bot app | Hermes)        owns conversation + its memory
                    │  MCP client (Remote HTTPS | loopback HTTP)
                    ▼
            byok MCP server (Host process)                    owns keys, quota, task/routine ledger
              ├─ auth: Authorization: Bearer <byok bot key>
              ├─ tools ──> @byok-sdk/server API (dispatch, tasks.*, wakes.*, blobs, projections)
              ▼
            device daemon (paired) ──> RuntimeAdapter ──> coding agent (Pi | Codex via OAR | Claude | Grok CLI optional)
                                        reserved helpers inside the task: submit_result, send_agent_message, memory_*
```

- The MCP server runs in the Host process, beside `@byok-sdk/server`. It is long-lived and Host-owned. Coding agents are never children of a client-started process; they stay children of the device daemon (#539 ask c).
- Transport: Streamable HTTP. Grok Bot reaches it through Remote HTTPS, so the Host needs a public HTTPS endpoint. Hermes uses loopback HTTP. A stdio entry, if any, is a thin client with no task state.
- Execution: every task goes through the paired device daemon and its adapters. OAR runs where it already runs (the vendored Codex session). herdr is not on the execution path. It is optional, for visibility and webhook notices only (Q8, decided).
- Placement (Q3, decided): a copy-and-own example `examples/byok-mcp-server` on the public `@byok-sdk/server` API, beside K4's `examples/host-execution-core`. The one SDK slice is the HTTP framing for the existing MCP core. This follows PRD §5.1 (reference implementations in `examples/`) and AiphaBee K-D1 (prove the shape before lifting it into a package).

## 3. Tool catalogue

All tools use the `byok_` prefix (`^[\w-]{1,64}$`). Every tool resolves the caller from the key, never from arguments. Every result is JSON text. A refusal is an `isError` result with `{ code, message, retryAfterSeconds? }`.

### 3.1 Tasks: dispatch, state, outcome, artifacts

| Tool | Input | Result | API | Scope |
| --- | --- | --- | --- | --- |
| `byok_whoami` | `{}` | Bot label, key id, scopes, quota now (running, remaining per hour), devices and runtimes allowed | key ledger, `machines.list` | any |
| `byok_runtimes` | `{}` | Runtimes the allowed devices advertise (`pi`, `codex`, `claude`, maybe `grok`), installed or not | `machines.list` | `tasks.read` |
| `byok_task_submit` | `{ runtime, instruction, workspace?, toolsets?, resultSchema?, clientRequestId? }` | `{ taskId, state, deduplicated }` within seconds | `dispatch` with derived `taskId`; `terminalProjection: result-document` when `resultSchema` is set | `tasks.dispatch` |
| `byok_task_status` | `{ taskId, waitSeconds? }` (0–50, default 0) | `{ state, finalMessage?, document?, artifacts: [{index, name, contentType}], reason?, code?, retryable? }` | `tasks.get`; long poll on task events | `tasks.read` |
| `byok_task_cancel` | `{ taskId, reason? }` | `{ state }` (idempotent) | `tasks.cancel` | `tasks.cancel` |
| `byok_task_list` | `{ cursor?, limit? (≤ 50), state? }` | This key's tasks, newest first | key-filtered `tasks.list` | `tasks.read` |
| `byok_artifact_url` | `{ taskId, index }` | Short-lived download URL | `blobs.getDownloadUrl` | `artifacts.read` |

`workspace` is a Host-registered workspace id, never a raw path. `runtime` must be in the key's allow list. `instruction` is untrusted user text; the coding agent's own guardrails apply (ADR-037).

### 3.2 Routines

| Tool | Input | Result | API | Scope |
| --- | --- | --- | --- | --- |
| `byok_routine_create` | `{ localId, schedule: { cron, tz }, task: <byok_task_submit input> }` | `{ routineId, nextAt }`; same `localId` returns the same routine | `checkRoutineSchedule`, `nextRoutineOccurrence`, K4 routine ledger, `wakes.schedule` (`dedupKey = <routineId>:<version>:<t>`) | `routines.write` |
| `byok_routine_list` | `{}` | Routines of this key, with `nextAt` and last task id | K4 ledger | `routines.read` |
| `byok_routine_cancel` | `{ routineId }` | `{ state: "completed" }` | ledger + `wakes.cancel` | `routines.write` |

Each occurrence runs one `byok_task_submit` equivalent. Its `taskId` derives from `(routineId, version, t)`. Per-key routine cap: 8 (PRD §5.5 value).

### 3.3 Memory (byok side only)

These tools touch byok's Agent-home memory, not the external Bot's own memory. Each description says so in its first sentence (#539 ask d). They need the key to map to one `AgentRef` (§9 Q4).

| Tool | Input | Result | API | Scope |
| --- | --- | --- | --- | --- |
| `byok_memory_read` | `{ path? }` (`MEMORY.md` default, or `notes/**`) | Redacted projection text and `revision`, with its time | hosted `agent.memory.projection` | `memory.read` |
| `byok_memory_propose` | `{ op: replace\|delete, path, content?, baseRevision }` | `{ intentId, state }` (`applied`, `conflict`, `rejected`, `uncertain` later) | `agent.memory.intent` through the Host ledger and device CAS | `memory.write`; not in beta v1 (§9 Q9) |

Coding agents inside a task keep using `memory_recall`/`memory_save` through `byokagentmemory` when the task is an Agent execution.

### 3.4 Outcomes and ledgers

- The outcome of a task is `byok_task_status.document`: the `submit_result` document that the daemon validated against the schema in `resultSchema`. The beta server stores no second copy.
- The task ledger is `byok_task_list`. The routine ledger is `byok_routine_list`.
- `bot-turn-outcome.v1` actions (`confirmable_action`, `delegate`, …) are Bot-mode contracts. The beta does not apply them. A coding task that needs a structured answer passes its own `resultSchema`.

## 4. Auth

- Credential: one **byok bot key** per external Bot. HTTP header `Authorization: Bearer <byok bot key>`. Stdio thin client: env `BYOK_BOT_KEY`.
- The Host stores `{ keyId, tenant, label, hash, scopes[], deviceIds[], runtimes[], agentRef?, quota, createdAt, revokedAt? }`. Only a salted hash of the secret is stored. Compare in constant time (OAR `http.ts` pattern). Revocation applies to the next call. A running task is not killed by revocation; `byok_task_cancel` is separate.
- Scopes: `tasks.dispatch`, `tasks.read`, `tasks.cancel`, `artifacts.read`, `routines.read`, `routines.write`, `memory.read`, `memory.write`.
- A key sees only its own tasks and routines. Unknown or foreign `taskId` answers `not_found`, never `forbidden` (no existence oracle).
- HTTP rules: HTTPS only for remote; loopback for local; refuse browser `Origin` values that are not the Host's own (DNS rebinding, as OAR `localOrigin`); 4 MiB body cap.
- Grok Bot: the key goes in the custom MCP "Bot's own credential" field (UI form UNVERIFIED, S0). Hermes: the key goes in the profile `mcp_servers` entry (#539).

## 5. Quota, idempotency, cancellation

Quota (abuse limits, not billing; ADR-038 has no execution metering). The first three rows are the decided Q7 defaults. The last two rows are implementation limits outside Q7; B2 reviews them.

| Limit | Default | On refusal |
| --- | --- | --- |
| Running tasks per key | 4 (as `oar mcp --max-running`) | `quota_exceeded`, `retryAfterSeconds` |
| Submits per key per hour | 60 | `quota_exceeded` |
| Routines per key | 8 | `quota_exceeded` |
| `instruction` size | 32 KiB | `invalid_input` |
| `byok_task_status` calls per key per minute | 120 | `rate_limited` |

Counters live in the beta server's ledger. The existing per-device `rateLimit` stays as is.

Idempotency:

- `taskId = H(keyId, clientRequestId)` when the client sends `clientRequestId`.
- Without it, `taskId = H(keyId, sha256(canonical arguments), window)`. The window is 15 minutes, and the server keeps the first `taskId` of a window in its ledger. A client retry of the same call therefore returns the same task with `deduplicated: true`. No model-chosen key is needed (#539 ask b). A deliberate repeat inside the window needs a different `clientRequestId`. The `byok_task_submit` description tells the model this: for a deliberate rerun (for example, the user says "run it again") within 15 minutes, send a new `clientRequestId`, or the old task comes back.
- The server calls `dispatch` with that pre-persisted `taskId`. A kernel conflict on retry is resolved by reading the task back, as `executions.submit` documents.
- Routine occurrences use `H(routineId, version, t)`; `routine_create` is idempotent on `(keyId, localId)`.

Asynchrony and cancellation:

- `byok_task_submit` returns within seconds and never waits for the task (#539 ask a).
- `byok_task_status` waits at most 50 s (AiphaBee K3 value; below Hermes's 300 s default and the unknown Grok Bot limit). The client loops.
- An MCP `notifications/cancelled` aborts only the waiting call (SDK core maps it to the call signal). It never cancels the task.
- Only `byok_task_cancel` cancels a task, through `tasks.cancel`. The daemon then interrupts the adapter and disposes its process tree, as for any cancelled task. It is idempotent; a terminal task returns its state.

## 6. External Bot integration

| Step | Grok Bot (first client) | Hermes (#539) |
| --- | --- | --- |
| Connect | Custom MCP, Remote HTTPS, Host public URL, byok bot key as the Bot credential | Profile `mcp_servers` entry, loopback HTTP (or stdio thin client) |
| Ask for work | Model calls `byok_task_submit` | same |
| Get results | Model loops `byok_task_status`; optional completion push | same; no push needed |
| Completion push (optional) | Beta server posts `{event: "task_done", taskId, state}` to the Bot's routine webhook (Bearer + `x-webhook-key`, herdr notify pattern). Pointers only, no result content. Merge events inside the 5-minute routine spacing. | not needed |
| Memory | Grok Bot keeps its own; `byok_memory_*` only for byok Agent-home memory | #539 |
| Data exposure | Every tool result enters xAI/Cursor storage. Results carry only what the key's scopes allow. Artifact URLs are short-lived. | #539 |

## 7. S0 verification items

B1 gates only on S0 items 5–8. Their local evidence is recorded in [#545](https://github.com/Ancienttwo/byok-sdk/pull/545). Each gated item needs a command output, a recorded run, or a `file:line`.

Aimpact ruling, 2026-10-19 19:24 SGT (session instruction, #514 track): the design is MCP-generic. Grok Bot account evidence must not gate B1. Items 1–4 are client-acceptance checks before beta release. Once the Host has public HTTPS, the PM bot itself runs the Grok Bot checks as an MCP client. These checks are not prerequisites for B1. B1 uses a standard MCP client for verification. Item 9 stays with #539.

1. Grok Bot custom MCP: Streamable HTTP accepted; how the static bearer is entered; tool-call timeout; whether `isError` results reach the model.
2. Reachability: the Cursor backend reaches the Host's public HTTPS URL; record the egress IPs if shown.
3. A 50 s `byok_task_status` long poll completes inside Grok Bot's timeout.
4. Grok Bot routine webhook receives a `task_done` pointer and the routine can call `byok_task_status`.
5. SDK MCP core: `dispatch.ts` can serve an HTTP framing without changing the four stdio helpers (code read plus a spike test in `/tmp`).
6. `dispatch` with a pre-persisted `taskId` is idempotent under a repeated call on the embedded server.
7. `tasks.cancel` from the Host reaches the device and the adapter disposes its tree (existing tests or a new probe).
8. Memory: does a Host-side `agent.memory.intent` surface exist for `byok_memory_propose`? (UNVERIFIED in §1.2)
9. Hermes items: owned by #539.

## 8. Slices (for later Codex execution; each one PR, draft)

| Slice | Scope | Where |
| --- | --- | --- |
| B0 | S0 items 1–8. Docs only. | `docs/researches/` |
| B1 | Streamable HTTP framing for the SDK MCP core: POST JSON replies, 202 for notifications, optional SSE for `list_changed`, body cap, Origin rule. No tool semantics. | `packages/client/src/mcp-server/` (or a new subpath; §9 Q3) |
| B2 | Key ledger, scopes, quota counters, idempotency ledger. | `examples/byok-mcp-server` |
| B3 | Task tools: `whoami`, `runtimes`, `task_submit`, `task_status`, `task_cancel`, `task_list`, `artifact_url`. Synthetic test: embedded server, daemon, fake runtime. | `examples/byok-mcp-server` |
| B4 | Routine tools on K4's routine ledger. Depends on K4. | `examples/byok-mcp-server` |
| B5 | `byok_memory_read`. `byok_memory_propose` only after §9 Q9 and PRD P5. | `examples/byok-mcp-server` |
| B6 | Grok Bot client guide and one live run (S0 1–4 repeated on the real tools). | docs |
| B7 | Hermes client deltas. | #539 |
| B8 | Optional Grok CLI runtime. | #514 plan |

## 9. Decisions (Q1–Q11, DECIDED)

Aimpact approved every recommended answer on 2026-10-19 at 14:11 HKT. Record: `_ops/bot-wo/PRODUCT-RULINGS-2026-10-19.md`, "External-bot beta Q1–Q11 — DECIDED". The text below matches that record.

| # | Topic | Decision |
| --- | --- | --- |
| Q1 | Memory boundary | The external Bot owns its conversation memory. byok owns tasks, artifacts and its own Agent-home memory. |
| Q2 | Per-Bot key | A new byok bot key held by the Host (§4). `packages/keys` stays for model-provider keys on the device. |
| Q3 | Code location | `examples/byok-mcp-server` (copy-and-own, public server API). Only the HTTP transport goes into the SDK. |
| Q4 | Identity mapping | Each key binds to allowed devices and runtimes. Memory and routine tools also need one `AgentRef` per key. Without an `AgentRef`, the key gets task tools only. Hermes keys therefore need an `AgentRef`, because #539 moves Hermes scheduled work to `byok_routine_*`. |
| Q5 | Public reachability | Grok Bot MCP calls come from the Cursor backend, so the Host needs a public HTTPS URL. A laptop Host needs a relay or tunnel. |
| Q6 | Idempotency | If the client sends no `clientRequestId`, the task id is a hash of the arguments within a 15-minute window (§5). |
| Q7 | Quota defaults | 4 running tasks, 60 submits per hour, 8 routines (§5). |
| Q8 | herdr role | Not on the execution path. Optional, for visibility and webhook notices only. Tasks go through the daemon and OAR. |
| Q9 | Memory writes in beta v1 | Read-only. Writes wait for PRD P5. |
| Q10 | Disclosure | Tool results go into xAI/Cursor storage. The Host page must disclose this. |
| Q11 | Grok CLI worker runtime | Optional (#514 plan, slice B8). |

## 10. Non-goals

- Changing the Bot mode PRD, its Q4 or its Q8.
- A second task, memory or routine stack inside the MCP server.
- Grok or Hermes as the main `RuntimeAdapter` form.
- Running `bot-turn-outcome.v1` actions (`confirmable_action` and the rest) for external Bots.
- Proxying the task-scoped reserved helpers to external clients.
- `byok_agent_message` or Cross-Bot collaboration for external Bots in beta v1 (they work together only through tasks and artifacts).
- Billing or execution metering.
- Local command execution through the Grok desktop app (AiphaBee K4 rejected it: data flows back to Cursor, and approvals expire per command).

## 11. Risks

- Grok Bot's MCP client behavior is not documented (transport, credential field, timeout). S0 can fail and change the transport.
- A public Host endpoint is a new attack surface. Keys, scopes and quotas are the only gate; a leaked key can dispatch work to the user's device.
- `instruction` comes from a third-party model. Coding agents run with their usual permissions (ADR-037). A key's runtime and workspace allow lists bound the reach.
- Results leave to xAI/Cursor storage.
- Routines depend on K4, which is still in progress.
- Memory write depends on PRD P5 and on the platform proofs (macOS, Windows).

## Rollback

This document changes no code. B1 is an additive transport. B2–B5 live in an example. Removing the example stops the beta. Revoking a key stops one Bot.

## Verification of this document

- Inventory of SDK MCP code, daemon injection, server API, K8-S and keys: read-only sweep of `origin/main@5b988a6e` with `git show` and `git grep`; spot checks of `packages/server/src/index.ts` (`tasks.cancel`, `tasks.list`), `packages/server/src/types.ts:157-190` (`DispatchInput`) and `:236-275` (`TaskResult`).
- OAR: `/tmp/oar514` at `c264f17`: `packages/cli/src/mcp-command.ts` (flags), `mcp-tools.ts` (tool names; `run` description), `packages/oar/src/mcp/{serve-tools,http}.ts`.
- herdr: `herdr --version` (0.9.3), `herdr agent start --help` (kinds include `grok` and `hermes`); `herdr-notify.md`.
- Grok Bot facts: AiphaBee `plans/plan-20261018-grok-bot-integration.md` (read in full).
