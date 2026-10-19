# #519 Hermes Agent as a Bot: architecture plan (v2)

Baseline: byok-sdk `origin/main@5b988a6e` (2026-10-19, includes K8-S #525). Draft branches read, not merged: K4 #532 `e5afad26`, K8a #530 `c9dabb9e`, K8b #531 `23132486`, P5a #529 `e92980af`, PRD v3 #524 `caac794a`. Vendored OAR `c264f17` (0.67.0). Upstream OAR `main@5296675b` (0.68.1). Local Hermes Agent `354ad3d4` (2026-10-18, `v0.22.2+1687.g354ad3d`).

Status: plan only. It does not authorize implementation, release, issue edits or downstream changes.

Rulings this version follows (Aimpact, 2026-10-19 about 13:46 HKT, relayed by PM; not yet written on #519):

- R1. "If OAR does not support Hermes, Hermes is positioned as a Bot, not a coding agent." OAR does not (§1.1). So Hermes is **not** a `RuntimeAdapter` beside Pi, Claude and Codex.
- R2. Answer how Hermes joins Bot mode: identity and persona, memory, group seat, outcome and apply, routine, gateway ownership and isolation, credentials. Reuse the Bot mode PRD and the K4/K8 contracts.
- R3. Keep `shared/acp` vendoring only if the Bot integration needs it, with the reason. Grok (#514) has its own ruling: Grok Bot first, Grok CLI as a side task.
- R4. PRD Q8 ("v1 Bot execution runtime: Pi only") does not change. This plan lists it as an open question with a recommendation.
- R5. Keep the gateway risk and the S0 evidence gate.

Plan v1 (commit `ab704346`, a `HermesAdapter` runtime) is superseded. Its inventory stays in §1 because the facts did not change.

Evidence labels: `(verified: <source>)` means a command ran or source was read on 2026-10-19. `[UNVERIFIED]` means docs or inference only. S0 must prove each one.

## Conclusion

1. A Hermes Bot is an **external Bot member**. It is one dedicated Hermes profile on the user's device. Hermes owns its persona (`SOUL.md`), its memory and its own cron. The Host owns the roster entry, the per-Agent FIFO, the Conversation and room ledgers, seats and routines that target it.
2. The Host reaches the Bot through the Hermes gateway's loopback **HTTP API server** (`/p/<profile>/v1/runs`). The Host never starts a `hermes` process, a gateway or `hermes acp`. So the detached-gateway leak found in v1 cannot come from the Host.
3. Reuse: the K4 core runs Hermes intents unchanged, with one new seam, an execution port. The SDK port wraps the existing `executions.submit` and `tasks.*` calls. A Hermes port maps the same lifecycle onto Hermes runs. K4 `taskId` becomes the Hermes `Idempotency-Key`. Hermes stores that key durably for 24 h, so it carries the K4 rule "read the terminal before a new generation". K8b seats, K2 wakes, routine pure functions and the `bot-turn-outcome.v1` validators are reused as they are.
4. First version: text only. A Hermes Bot answers private turns and posts in room seats. It takes no `bot-turn-outcome.v1` actions (no delegate, ask_user, confirmable action, routine, room_call, Main Bot actions) and it cannot `pass`. The reason: Hermes's HTTP API has no per-run MCP injection and no structured output. So `submit_result` (K7) cannot reach it, and the Host must not parse actions from text (K7 and K8 rules).
5. No SDK package change. No protocol change. No new dependency. No `shared/acp` vendoring. ACP stays the only verified per-session MCP path into Hermes. It is recorded as option H2 for a later version that needs actions. H2 reuses `shared/acp` only if #514 vendors it for Grok CLI.

## 1. Inventory

### 1.1 OAR has no Hermes runtime (unchanged from v1)

| Check | Result | Evidence |
| --- | --- | --- |
| Upstream runtime directories | `antigravity claude codex cursor grok kimi opencode pi-durable pi` | (verified: `gh api repos/botiverse/oar/contents/packages/oar/src/runtimes?ref=main`, `5296675b`) |
| Upstream `docs/runtimes/`, README "Supported runtimes" | No Hermes | (verified: same API; README table) |
| Full-text search | One unrelated hit, `docs/prior-arts/multica-findings.md:33` (Multica's own `hermesClient`). "nous": 0 | (verified: `grep -rniI` in a shallow clone; `gh search code`) |
| Issues, PRs, branches | None about Hermes. `docs/acp-agent-design` (PR #145) proposes OAR *serving* ACP; no Hermes | (verified: `gh search`, `gh api .../compare`) |
| Local checkout `/Users/chris/Projects/oar` | Stale (0.29.0, 2026-10-07); no Hermes | (verified: `git log -1`) |
| SDK fork `vendor/oar/c264f17` | Codex closure only; no ACP | (verified: `PROVENANCE.md`) |

OAR does ship a generic ACP client, `packages/oar/src/shared/acp/` (19 files, 2,250 lines; closure 74 files, of which 32 are already in the SDK fork). §6 decides whether a Hermes Bot needs it.

### 1.2 Hermes Agent surfaces (source read; only `--version` and `--help` ran)

Hermes already has its own Bot model:

| Surface | Fact | Evidence |
| --- | --- | --- |
| Bot = profile | A Hermes Bot is a profile, an isolated home `~/.hermes/profiles/<name>/` with its own `config.yaml`, `.env`, `SOUL.md`, memory, `state.db`, cron and skills. `-p <name>` sets `HERMES_HOME`. Hermes "Bot Mode" adds a canonical "Bot Chat" session, `message_agent` and rooms of 2-6 Bots. It is driven by Desktop markers. | `hermes_cli/main.py:430-508`; `website/docs/user-guide/bot-mode.md:12-15,221-240`; `tools/bot_mode_probe.py:1-14` |
| Persona | `$HERMES_HOME/SOUL.md` is slot 1 of the system prompt. Per request, `instructions` (Runs, Responses) or a `system` message is layered on top; tools, memory and skills stay. | `agent/prompt_builder.py:1541`; `agent/system_prompt.py:551-556`; `website/docs/user-guide/features/api-server.md:849-855` |
| Memory | Built-in `memories/MEMORY.md` and `USER.md` in the profile, injected into the prompt. Switches `memory.memory_enabled`, `memory.user_profile_enabled`; optional external provider (honcho, mem0, ...). No read-only mode; `memory.write_approval` stages writes. `X-Hermes-Session-Key` gives providers a stable scope. | `tools/memory_tool.py:2,40,307-309`; `config_defaults.py:1325-1343`; `api-server.md:834-847` |
| HTTP API server | A gateway platform, default `127.0.0.1:8642`, Bearer `API_SERVER_KEY`. Routes include `/v1/runs` (+ `events`, `stop`, `approval`, `clarify`, `steer`, `resolve-unknown`), `/v1/responses`, `/v1/capabilities`, `/v1/toolsets`, `/health`. With `gateway.multiplex_profiles` (default on) each profile is served at `/p/<profile>/` and accepts only that profile's own key. | `gateway/platforms/api_server.py:80-103,229-232,1649-1671`; `api-server.md:857-895` |
| Run idempotency | `POST /v1/runs` with `Idempotency-Key` (1-255 visible ASCII) is reserved durably before work starts. An exact retry returns the original `run_id` (HTTP 202, `Idempotency-Replayed: true`), also after a gateway restart and after the run ended. A different payload with the same key is 409 `idempotency_key_conflict`. Retention: 24 h after the last status update. Draining or a locked store is 503 with `Retry-After`. | `api-server.md:548-575` |
| Conversation | A non-empty `conversation_history` is authoritative. API sessions cannot bind a session that another surface owns (409 `permission_denied`). | `api-server.md:56-73,575-585` |
| Terminal states | Runs report `completed`, `failed`, `cancelled`; Chat Completions maps them to `finish_reason`. | `api-server.md:63-70` |
| Per-run MCP / structured output | None found. The API server builds its toolsets from profile config (`_get_platform_tools(config, "api_server", include_default_mcp_servers=False)`). No `response_format` or JSON-schema option in the request options. | (verified: `gateway/platforms/api_server.py:2900`; `grep` of `api_server_request_options.py`) |
| ACP | `hermes acp` is a viewer. On the first session call it starts a **detached** `gateway run --idle-exit` (Windows breakaway) that lives up to 600 s after it goes idle. `session/new.mcpServers` is the only verified per-session MCP injection. | `acp_adapter/entry.py:201-202`; `hermes_cli/gateway_client.py:215`; `gateway_runtime_start.py:31-71`; `gateway/run_idle_exit.py:1-20`; `acp_adapter/gateway_server.py:245-268` |
| Gateway ownership | Gateways are owned by the user: an installed service (launchd/systemd), Desktop (`gateway ensure`), a manual `hermes gateway run`, or an idle-exit daemon a client started. `--external-supervisor` exists for a foreground owner. | `gateway/run_idle_exit.py:12-15`; `hermes gateway run --help` |
| Credentials | Provider secrets live in `<profile>/.env`, `auth.json` (OAuth, pools), `hermes auth`, `hermes secrets`. A profile without its own OAuth login reads the root `auth.json` and writes refreshed tokens back to root. | `website/docs/user-guide/profiles.md:105`; `environment-variables.md:9` |
| Cron | `<profile>/cron/jobs.json`, ticked by the gateway every 60 s. `cron.allow_agent_scheduling` is false by default. No per-home `cron.enabled` key found. | `cron/jobs.py:2,79-83`; `cron.md:356`; `config_defaults.py:1815-1835` |
| Silence | Messaging platforms use `[SILENT]` / `NO_REPLY` tokens. How the API server returns a silent turn is [UNVERIFIED]. | `website/docs/user-guide/messaging/index.md:139-141` |

### 1.3 SDK Bot mode contracts that a Hermes Bot can reuse

| Contract | Owner, state | What it gives | Evidence |
| --- | --- | --- | --- |
| Bot = `AgentRef` + home; fresh execution per wake | ADR-036 D1, ADR-038 d7 | A Bot needs no cross-execution runtime session | `docs/architecture/adr-2026-10-03-cloud-generic-agent.md:17,33`; `adr-2026-10-13-bot-platform.md:27` |
| Host owns Conversation, Room, roster, routine ledgers | ADR-038 d8 | SDK stores no room or conversation | `adr-2026-10-13-bot-platform.md:28` |
| K4 host execution core | draft #532, copy-and-own example | Per-Agent FIFO, `taskId = hash(key, generation)`, terminal read before a new generation, retry policy, settlement apart from the intent conclusion, wake consume | `origin/codex/bot-k4-host-execution-core:examples/host-execution-core/src/{model,core}.ts`; `model.ts:5,64,77-87`; `core.ts:11,241-330` |
| K2 wakes | main | `server.wakes.schedule/cancel/pending`, one-shot time points | PRD v3 §5 |
| Routine pure functions | main (#525) | `checkRoutineSchedule`, `nextRoutineOccurrence`, 368-day horizon | `packages/core/src/routine-schedule.ts:24,100,143` |
| `bot-turn-outcome.v1` fragments and limits | main (#525) | `speech`, `roomCall`, `delegate`, `askUser`, `confirmableAction`, routine and Main Bot fragments; `composeBotTurnOutcomeSchema` | `packages/protocol/src/bot-turn-outcome.ts:6-37,105-198` |
| K7 `submit_result` | main | Schema-validated, fsynced staged outcome; success without it fails `result_not_submitted` | `docs/spec.md:2442-2446` |
| K8b room seats | draft #531 | Mention-only seats; seat = fresh execution with required `speech`; empty speech is a visible failure; 240 s waiting and running graces; ContextPack | `origin/codex/k8b-group-chat:examples/bot-collaboration/README.md:145-171`; `src/schema.ts:57-76` |
| Persona projection | main + K8b | `enqueueAgentHomeProjection` writes Host persona into the SDK home | `docs/spec.md:1788-1806`; K8b `src/persona.ts:7-20` |
| SDK memory | main + P5a | `MEMORY.md`/`notes/`, `memory_recall`/`memory_save`, projection, intents, 8 KiB resident layer | `docs/architecture/sdk-architecture.md:1495-1523`; P5a `examples/host-execution-core/src/memory.ts:13` |
| Invariant A1 | PRD v3 | A Bot execution has no tool with external side effects | PRD v3 line 114 |
| Custom harness (`harnessId`) | main (#167) | Device-side custom `RuntimeAdapter` identity | `docs/protocol.md` "Additive custom-harness contract" |

No PRD or ADR defines an external Bot member (verified: grep of PRD v3, platform PRD v3, ADR-036, ADR-038 for external, webhook, harness, bring, Hermes). The nearest precedent is downstream: AiphaBee integrates Grok Bot (the xAI App) as an external Bot through a webhook wake and MCP, built in AiphaBee, not in the SDK (AiphaBee `plans/plan-20261018-grok-bot-integration.md`, decision K-D1, PR Ancienttwo/aiphabee#243).

### 1.4 Name history

"Hermes Bot Mode" in this repo never meant the Nous Hermes Agent. It was the label of a Salesko host work plan (WP1-I prepared memory, WP2-I device memory CAS) (`git show 32d1a43fc:docs/researches/2026-09-28-hermes-host-lifecycle-design.md`). The only study of the real Hermes Agent says it owns its turn loop, tool registry, memory and skills, so the SDK cannot drive those parts. It also sets a red line: no generic `credentials.get` for Hermes plugins (`git show e46df7630^:docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md` §2). That conclusion supports R1.

### 1.5 Gap

The Host has a FIFO, seats, routines and an outcome vocabulary, but every execution goes through `executions.submit` to an SDK runtime. There is no path for a Bot whose brain, persona and memory live in another product on the same device. This plan adds that path at the Host port, not in the SDK packages.

## 2. Options

| Option | How | Verdict |
| --- | --- | --- |
| H0. `HermesAdapter` runtime (plan v1) | Device daemon drives `hermes acp` as a coding-agent runtime | Rejected by R1 |
| **H1. Host-side Hermes executor over the HTTP API server** | K4 intent → Hermes port → `POST /p/<profile>/v1/runs` on loopback | **Recommended for v1.** No SDK package or protocol change. The Host never spawns Hermes. Hermes keeps its own persona and memory. Limit: text only |
| H2. Device-side Bot bridge over ACP | A custom harness (`harnessId: "hermes-bot"`) attaches `hermes acp` to the user's running gateway and injects `byokagentresult` through `session/new.mcpServers` | Deferred. It is the only way to give a Hermes Bot K7 actions. Cost: `shared/acp` vendoring, a device-side adapter (close to what R1 rejects), and the v1 gateway-viewer risk |
| H3. Host as a Hermes messaging platform | A Hermes platform plugin in `~/.hermes/plugins/` delivers Host room messages to Hermes | Rejected. Hermes would decide when to speak, so K8b mention-only seats, graces and the FIFO lose their authority. It also writes into the user's Hermes install |
| H4. Hermes gateway WebSocket (`hermes-gateway-v1`) | The protocol used by the TUI, Desktop and ACP viewer | Rejected. Same-UID ticket bootstrap over a private socket, no stability promise, three internal consumers (`gateway/control_socket.py:305-344`; `tui_gateway/AGENTS.md`) |

## 3. Goals and non-goals

Goals (v1):

- A user can bind one dedicated Hermes profile as a Bot in the Host roster.
- The Hermes Bot answers private turns and posts in room seats where it is mentioned.
- Host routines can target it, through K2 wakes and the K4 FIFO.
- Every Hermes run is at most once per K4 `taskId`. Cancel, timeout and failure settle the intent as K4 does for SDK executions.
- The Host never starts, stops or reconfigures Hermes processes, profiles or files.
- Hermes provider credentials stay in Hermes. SDK BYOK keys never reach Hermes.

Non-goals (v1):

- `bot-turn-outcome.v1` actions from a Hermes Bot. A Hermes Bot as Main Bot. `pass` and `room_call` from a Hermes Bot.
- SDK memory tools, memory page, memory intents or persona projection for a Hermes Bot.
- Reading or writing Hermes cron, kanban, skills, sessions or memory.
- Hermes "Bot Mode" rooms, `message_agent` and peers. The Host room is the only room.
- Cloud-only Hosts (topology without a device-local Host process). The API server is loopback.
- Any `RuntimeAdapter`, `harnessId`, protocol, vendoring or npm dependency change.

## 4. Topology

```
Host process on the device (Topology L: embedded server + daemon + K4 core)
 ├─ K4 core ── ExecutionPort ── SdkPort ──── executions.submit / tasks.* (Pi Bots, unchanged)
 │                          └── HermesPort ── loopback HTTP ──┐
 └─ OS keychain: API_SERVER_KEY per Hermes binding            │
                                                              ▼
User-owned Hermes gateway (service, Desktop or manual run; never started by the Host)
 └─ api_server platform, /p/<profile>/v1/runs
     └─ dedicated profile <profile>: SOUL.md, memories/, cron/, .env, state.db
```

## 5. Contract mapping

| Area | SDK Bot (Pi, today) | Hermes Bot (v1) |
| --- | --- | --- |
| Identity | `AgentRef {agentId, profileRevision}`; Host Bot profile has name, role, model | Same `AgentRef`, minted by the Host. Host Bot profile adds `kind: "hermes"` and a binding `{deviceId, profile, apiBase, keyRef}`. `profileRevision` changes only when the binding changes |
| Persona | Host authors it; `enqueueAgentHomeProjection` writes `AGENTS.md` | Hermes `SOUL.md` in the profile is the authority. The Host keeps only display name and role. No projection |
| Memory | SDK home `MEMORY.md`/`notes/`, MCP tools, P5a page, 8 KiB resident layer in ContextPack | Hermes profile memory is the single writer, so invariant M1 holds. No SDK memory surface. No resident layer in ContextPack. The memory page says "managed in Hermes" |
| Execution | K4 intent → `executions.submit` → device runtime | K4 intent → `HermesPort.submit` → `POST /v1/runs` with `Idempotency-Key: <taskId>` |
| Context | ContextPack in the instruction | `instructions` = Host rules + ContextPack JSON; `conversation_history` = Host ledger turns; `input` = the trigger message; no `session_id` |
| Private reply | `messageEgress` → Host accepts the Agent message | Run final text → the Host acceptance transaction writes the turn |
| Room seat | Result document with required `speech`, optional `room_call` | Host builds `{speech: {kind: "post", text}}` from non-empty final text and validates it with the `speech` fragment. Empty or blank text is a visible seat failure (K8b rule). No `pass`, no `room_call` |
| Actions | `submit_result` K7 → Host apply in fixed order | None |
| Routine | Host ledger + K2 wake → K4 intent | Same. Target set by the user or a Pi Main Bot (PRD Q12 rule). The Hermes Bot cannot create routines. Hermes's own cron stays private |
| Cancel | `tasks.cancel` | `POST /v1/runs/{id}/stop` |
| Credentials | BYOK key in OS keychain, launcher-scoped | `API_SERVER_KEY` in the Host OS keychain. Provider keys stay in Hermes |
| Process | SDK owns the runtime process tree | Hermes owns its gateway. The Host owns no Hermes process |

### 5.1 Identity and persona

- The user binds a Bot to an existing dedicated profile: a profile name, the gateway base URL (loopback only) and the profile's `API_SERVER_KEY`. The Host does not create profiles. Setup text tells the user to run `hermes profile create <name>` and to enable the API server in that profile.
- Binding preflight (each in S0): `GET /p/<profile>/health`, `GET /v1/capabilities`, `GET /v1/toolsets`. Refuse the binding if the profile route or the key fails.
- Persona: the Host shows "persona managed in Hermes". Main Bot `update_bot` on a Hermes Bot is rejected at apply with reason `external_persona`. `delete_bot` removes only the roster entry and the keychain item. `create_bot` cannot create a Hermes Bot.
- The Host does not send its own persona text in `instructions`. Two persona authorities would conflict.

### 5.2 Memory

- Hermes built-in memory and any Hermes memory provider belong to the profile. The Host keeps no copy (M1).
- `X-Hermes-Session-Key: byok:<agentId>` gives Hermes memory providers one stable scope per Bot (`api-server.md:834-847`).
- The #519 v1 requirement "three reader turns do not change `MEMORY.md`/`notes/`" no longer applies. A Hermes Bot has no SDK Agent home, and the Host never sends it an SDK home path.
- Room content and private turns enter Hermes memory and Hermes `state.db`. Any configured Hermes memory provider may send them off the device. The binding screen must say this (Q7).

### 5.3 Group chat seat (K8b)

- Seat creation, mention-only rules, budgets, history and ContextPack truncation (2026-10-19 ruling) stay in K8b. The Hermes seat is one K4 intent in that Bot's FIFO.
- Waiting grace: unchanged. Running grace: at expiry the Host calls `stop` and marks the seat `busy` as K8b does. A run that completes later is a late post, written once, as K8b defines.
- Outcome: non-empty final text becomes `speech.post`. The text is cut to the `speech` fragment's limit before validation [UNVERIFIED: exact limit name]. Empty text, `failed` and `cancelled` are visible seat failures. The Host never scans text for names, `[PASS]` or `[SILENT]`.
- A Hermes Bot cannot pass. Mention-only seating means it speaks only when someone asks it to (Q4).

### 5.4 Outcome and apply

- The Hermes port returns a Host-built document: `speech` for seats; none for private turns. Provenance: the Host records that the document came from a Hermes run, not from `submit_result`.
- K4 settlement maps Hermes terminal states: `completed` → `succeeded`; `cancelled` → `cancelled`; `failed` → `failed` (no retry by default, `DEFAULT_RETRY.retryFailures: false`); unknown → `uncertain` until read (§5.7).
- Hermes approvals and clarify requests during a run are answered `deny` through `/v1/runs/{id}/approval` and `/clarify`. The Host never approves for the user (Q10).

### 5.5 Routine

- Host routines, K2 wakes and `recordOccurrence` stay unchanged. An occurrence that targets a Hermes Bot becomes a normal K4 intent with the Hermes template.
- Hermes cron jobs in `<profile>/cron/jobs.json` are Hermes-private. They deliver only to Hermes's own platforms. They never post into Host rooms. The Host does not use `/api/jobs`.

### 5.6 Gateway ownership and isolation

- Ownership: the user's Hermes owns the gateway. The Host never runs `hermes`, `gateway run|ensure|start` or `hermes acp`. So no Host action can start the detached idle-exit daemon from §1.2.
- Gateway down: `submit` fails as connection refused. The intent fails retryable `hermes_unavailable` under the K4 retry policy. Seats show a visible failure. The Host does not start Hermes to recover.
- Isolation: one dedicated profile per Hermes Bot. Profile-bound keys mean a key for one profile cannot drive another (`api-server.md:867-895`).
- Side effects (PRD invariant A1): the preflight reads `/v1/toolsets` and refuses the binding when the api_server toolsets include tools with external side effects: terminal, file write, browser, computer use, messaging send, cron, kanban, delegation, peers [UNVERIFIED: exact toolset names; S0]. The check repeats before each run, because the user can change the profile at any time (Q9).

### 5.7 Transcript, idempotency and errors

- Transcript authority: the Host ledger. Each run gets `conversation_history` from the ledger and no `session_id`, so each run is a fresh execution (ADR-036 D1). Hermes keeps its own copy in the profile `state.db`; that copy is not a product record.
- Idempotency: `Idempotency-Key` = K4 `taskId` (64 hex characters). A retry with the same `taskId` gets the original `run_id`. A new generation makes a new `taskId`, so a new run. The Hermes port stores `run_id` in the K4 execution row at the first answer.
- The 24 h key retention is shorter than some K4 windows. If an `uncertain` submission is older than 24 h and no `run_id` is stored, the port must not resubmit. It settles `failed` with reason `hermes_outcome_unknown`.

| Hermes answer | K4 result |
| --- | --- |
| Connection refused, timeout before an answer | `uncertain` submission; read again before resubmit |
| 202 `Idempotency-Replayed` | Same run; continue reading |
| 401 | Binding invalid; non-retryable; user re-enters the key |
| 409 `idempotency_key_conflict` | Bug; non-retryable |
| 409 `permission_denied` | Non-retryable |
| 503 `runtime_draining`, `storage_unavailable` | Retryable after `Retry-After` |
| Run `failed` | `failed` |
| Run `cancelled` | `cancelled` |
| Run state unknown after a gateway restart | Read `GET /v1/runs/{id}`; `resolve-unknown` only if S0 shows it is safe |

### 5.8 Credentials

- `API_SERVER_KEY` is the only Hermes secret the Host holds. The user enters it once per binding. The Host keeps it in the OS keychain through a Host-supplied secret port (AiphaBee: `local-agent-secret-store`, as for Grok Bot K2a). It never goes to the cloud, logs or ContextPack (ADR-036 D2/D3).
- Provider credentials stay in Hermes: `<profile>/.env`, the profile or root `auth.json`, `hermes auth`. Model cost goes to the user's Hermes provider account.
- SDK BYOK keys and the keys launcher never serve a Hermes Bot. The SDK offers Hermes no `credentials.get` (red line in §1.4).
- A key rotation in Hermes makes runs answer 401. The Host marks the binding invalid and asks the user for the new key. It does not retry.

## 6. `shared/acp` decision (R3)

Not vendored for this plan. H1 uses HTTP only.

The one reason to keep it: ACP `session/new.mcpServers` is the only verified way to give Hermes per-execution MCP servers (`acp_adapter/gateway_server.py:245-268`). Per-execution MCP is what `submit_result` (K7) and `send_agent_message` need. So Hermes Bot actions (H2) would need `shared/acp`. If #514 vendors `shared/acp` for Grok CLI, H2 reuses that vendoring. Hermes alone does not justify it.

## 7. Gateway risk and the S0 gate (R5)

The v1 finding stays: a client of `hermes acp` or `hermes chat -q` starts a detached gateway that escapes the caller's process tree for up to 600 s. H1 removes the risk only if the Host never calls those commands. That must be tested, not assumed.

S0 runs on a scratch profile that S0 creates and deletes. It never touches the user's default profile. Pass conditions:

1. A dedicated profile with the API server on, reached at `/p/<profile>/` with its own key. Another profile's key gets 401.
2. `POST /v1/runs` with `Idempotency-Key`: an exact retry after completion and after a gateway restart returns the same `run_id`.
3. `instructions` and `conversation_history` are honored, and no `session_id` means no transcript carried between runs.
4. How a silent turn (`[SILENT]`/`NO_REPLY`) ends: empty final text, a token in the text, or a status.
5. `stop` during a run gives `cancelled`.
6. Approval and clarify requests can be answered `deny`, and the run then ends.
7. `/v1/toolsets` shows the api_server toolsets. Removing terminal and file-write tools in the profile config takes effect. Exact toolset names.
8. Memory writes land only in that profile.
9. Gateway down and draining give the error shapes in §5.7.
10. Process audit: during a full H1 cycle the Host creates no `hermes` process, and no new `gateway run --idle-exit` process appears.
11. Cold run latency, for the K8b 240 s running grace.

One paid model run needs Aimpact approval. If item 2, 7 or 10 fails, stop and report. Do not build S1.

H2 keeps the v1 gate in addition: the ACP viewer attaches to a ready, user-owned gateway and never spawns one; dispose leaves no process and no lock.

## 8. Testing

- Fake Hermes API server: a Node HTTP fixture in the example's tests. It implements `/p/<profile>/health`, `/v1/capabilities`, `/v1/toolsets`, `/v1/runs` (idempotency ledger with replay, conflict and a simulated 24 h expiry), `GET /v1/runs/{id}`, `events`, `stop`, `approval`, `clarify`. It can also inject 401, 409, 503 + `Retry-After`, connection refused, a hang, empty final text, and approval requests.
- K4 tests: the existing suite runs unchanged on `SdkPort` (proof that the seam is neutral). Added cases cover the Hermes port: at-most-once per `taskId`, terminal read before a new generation, `uncertain` older than 24 h, cancel, retry policy.
- K8b tests: a Hermes member is seated only on mention. Post from text. Empty text is a visible failure. Running grace calls `stop`. A late post is written once. `update_bot` on a Hermes Bot is rejected.
- Routine test: an occurrence targeting a Hermes Bot runs once per wake.
- Live script: local only, against an S0-style scratch profile, with approved paid runs. The record goes to `tasks/runs/` (git-ignored).

## 9. Packaging and code location

- SDK packages (`client`, `protocol`, `server`, `core`): no change.
- `examples/host-execution-core` (K4): add the `ExecutionPort` seam after #532 lands. Today `validateInput` requires `payload.runtime` (`model.ts:84-85`). The template becomes a union `{kind: "sdk", input} | {kind: "hermes", binding}`.
- New copy-and-own reference module, for example `examples/hermes-bot-bridge/` (name for Aimpact, Q2): `HermesPort`, binding preflight, fake server, tests. It uses `fetch` only. No new dependency.
- AiphaBee copies the reference, adds the binding UI, keychain storage and disclosure. That work is downstream and is not in this repo.

## 10. Open questions for Aimpact

| # | Question | Recommended answer | Reason |
| --- | --- | --- | --- |
| Q1 | Interface for Hermes Bot v1: HTTP API server (H1) or ACP bridge (H2)? | H1 | No SDK change, no Hermes process ownership, no vendoring. H2 only when actions are required |
| Q2 | Where does the Hermes executor live: SDK `examples/` reference (with the K4 seam) or AiphaBee only (Grok Bot K-D1 precedent)? | SDK `examples/` for the K4 seam and the reference port; AiphaBee copies them | The seat and settlement rules live in the K4/K8 examples. One reference keeps them aligned |
| Q3 | v1 scope: text only (private reply and room post), no actions, not Main Bot? | Yes | No per-run MCP or structured output in the HTTP API. Parsing actions from text breaks K7 and K8 |
| Q4 | A Hermes Bot cannot `pass` in a seat; empty text is a visible failure (K8b rule). Accept? | Accept for v1 | Mention-only seats mean it speaks only when asked. Pass needs H2 |
| Q5 | Persona authority is Hermes `SOUL.md`; the Host cannot edit it; `update_bot` is rejected. Accept? | Yes | One persona authority |
| Q6 | Memory is Hermes-owned; no SDK memory page, tools or intents for Hermes Bots. Accept? | Yes | Invariant M1: one writer |
| Q7 | Data flow disclosure: room and private content enter Hermes `state.db`, Hermes memory and any Hermes memory provider or messaging platform. Per-Bot opt-in, default off? | Yes, like Grok Bot K3 `external_ask_enabled` | Same data-leaves-the-Host risk as Grok Bot |
| Q8 | PRD Q8 "v1 Bot execution runtime: Pi only" (unchanged per R4). How does a Hermes Bot relate to it? | Keep Q8 as written for SDK-executed Bots. A Hermes Bot is an external Bot, outside Q8. Do not put external Bots in the v1 launch gate; ship them after K8b, behind the per-Bot opt-in | Q8's reasons (`agentMemory` on prepared Pi, `submit_result` measured on Pi) are about SDK runtimes. H1 uses neither |
| Q9 | A1 policy: refuse a binding whose api_server toolsets include side-effect tools, checked before each run? | Yes, strict | PRD invariant A1. The user can change the profile at any time |
| Q10 | Hermes approval and clarify requests during a run: deny automatically? | Yes, and record it | The Host must not approve for the user. No interactive channel in v1 |
| Q11 | Topology: device-local Host only (loopback API)? | Yes | `API_SERVER_KEY` and the gateway stay on the device. A cloud Host would need a device relay |
| Q12 | Platforms (PRD Q14 requires macOS and Windows). | Qualify macOS and Linux in S0. Windows when Hermes's Windows gateway passes the same S0 | H1 is HTTP only, so the platform risk is Hermes's own |
| Q13 | #519 title and body still ask for a `HermesAdapter` runtime. Update them? | The issue owner retitles #519 to "Hermes Agent as a Bot" after this plan is accepted | This PR does not edit issues |

## 11. Slices (for later Codex execution)

Each slice is one PR and runs the root checks (`bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`).

- **S0. Evidence** (§7). No product code. A probe script in `/tmp`, a record in `tasks/runs/`, a note in `docs/notes/`. Gate for S1-S5.
- **S1. K4 execution port seam.** After #532 merges. `ExecutionPort`, `SdkPort` wrapping today's calls, the template union. All existing K4 tests pass unchanged.
- **S2. Hermes port and fake server.** Submit, read, stop, approval and clarify deny, error mapping, 24 h rule. K4 Hermes cases.
- **S3. Binding and preflight.** Binding model, a Host-supplied secret port (keychain in AiphaBee), health, capabilities and toolset checks, per-run recheck.
- **S4. K8b seat integration.** After #531 merges. Roster `kind: "hermes"`, post mapping, graces with `stop`, apply-time rejections.
- **S5. Routine target and docs.** Routine occurrence test. README. A PRD amendment proposal for the docs owner (external Bot member, Q3-Q8 answers).
- **Deferred.** H2 (actions through ACP and `submit_result`), Windows, Hermes Bot as Main Bot.

## 12. Risks

- The Hermes API server is fast-moving (a breaking auth change in July 2026 per `api-server.md:885-893`). Mitigation: S0 record, preflight on `/v1/capabilities`, live script.
- The user's profile can change between the preflight and the run. The per-run toolset recheck narrows the gap. It cannot close it.
- Text-only Hermes Bots can feel weaker than Pi Bots in rooms. Q3/Q4 make that explicit.
- Content sent to a Hermes Bot can leave the device through Hermes memory providers or platforms. Opt-in and disclosure (Q7).
- K4 and K8b are draft PRs. S1 and S4 wait for them, and a change in them can move the seam.
