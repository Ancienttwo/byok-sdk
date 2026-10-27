# Grok Bot and Aiphabee: dual-mode plan (Mode G and Mode A)

Status: spike plan on draft branch `spike/grok-bot-harness` (base `origin/main@990abd60`). No product
code. Report: `Garbage/grok-bot-harness-spike-report.md`.
Parents: [external-Bot MCP beta](2026-10-19-byok-mcp-server-external-bot-beta.md) (#536),
[B6 Grok Bot client guide](../../examples/byok-mcp-server/docs/grok-bot.md),
[Bot mode PRD](2026-10-18-bot-mode-product-prd.md).

## 0. Locked scope

One Aiphabee/byok agent backend, two front doors:

| Mode | Where the user chats | Who runs the conversation | How work reaches byok |
| --- | --- | --- | --- |
| **G** | Grok Bot (Cursor/Anysphere desktop app, `com.anysphere.sand`) | Grok Bot | Grok Bot is an **MCP client** of the Host's byok MCP endpoint (`byok_task_*`, optionally routines and memory read) |
| **A** | Aiphabee frontend | The Aiphabee Host (byok Bot mode) | Host calls `@byok-sdk/server` directly (`executions.submit`, wakes, `submit_result`, message egress) |

Neither mode makes byok or Aiphabee drive Grok Bot. The earlier probe
(`scripts/spikes/grok-bot-probe.mjs`, verdict `fail-closed`) is the evidence: the installed app has
no ACP, stdio, local API or IPC surface that submits a prompt and returns a reply, and
`grokbot://app/v1/prompt` only prefills the composer.

Contrast, not part of either mode: the client adapter `grok`
(`packages/client/src/adapters/grok/`) drives the **Grok Build CLI** over ACP. It is a coding runtime
that can sit behind either mode like Pi, Codex or Claude. It is not Grok Bot.

## 1. Architecture

```
Mode G                                         Mode A
User ── chat ──> Grok Bot                      User ── chat ──> Aiphabee frontend
                   │ custom MCP entry                              │
                   │ {type:"http", url,                            ▼
                   │  headers:{Authorization:                Aiphabee Host (Bot mode: K4 core,
                   │   "Bearer <byok bot key>"}}             AgentRef + home, wakes, egress)
                   ▼                                               │ executions.submit / dispatch
           byok MCP endpoint in the Aiphabee Host ───────┐         │
           (examples/byok-mcp-server: ledger, tools)     ▼         ▼
                                          @byok-sdk/server (one embedded server)
                                                         │
                                          paired device daemon ──> RuntimeAdapter
                                                         (Pi | Codex | Claude | Grok CLI)
```

Shared backend means one embedded `@byok-sdk/server`, one device daemon, one K4 Host core. A Mode G
key may carry the same `AgentRef` as a Mode A Bot; then `byok_memory_read` reads that Agent's
`MEMORY.md` projection and `byok_routine_*` schedule on the same K4 ledger. Mode G tasks stay
ordinary coding tasks: an `AgentRef` on a key "does not force the Host to turn an ordinary coding
task into an Agent execution" (`examples/byok-mcp-server/README.md`, Keys and ownership).

## 2. Mode G

### 2.1 Reachability: where Grok Bot's MCP calls come from

Read from the installed Grok Bot 0.75.8 (`app.asar`, `dist/electron-main/main-app.cjs`); none of this is
a vendor statement.

- The add-server RPC is `addMcpServer({ name, configJson })`. `configJson` parses against a union of
  two entry shapes:
  - command: `{ type?: "stdio", command, args?, env?, envFile?, cwd?, enabledTools?, startupTimeoutSec? }`
  - remote: `{ type?: "http" | "sse", url, headers?, auth?: { CLIENT_ID, CLIENT_SECRET?, scopes? }, tls?: { caBundle }, placement?: "server" | "client", enabledTools? }`
- `headers` carries a static `Authorization: Bearer <key>`. That answers the B6 question "which field
  sends a static bearer" at the config level; the UI path still needs the live check.
- New servers are written to the **account** config (`writeAccountServer` → `addServersToAccount`) and
  listed through `backendMcpExec.listTools` and `listBoxServers` (the Bot's cloud computer, "box").
  So a remote entry is called from the Cursor backend, and a command entry runs on the Bot's cloud
  computer, not on the user's Mac. The local helper `local-exec-daemon` was not running here.
- `placement: "client"` exists in the schema; no readable code says what it changes. If it means the
  desktop client makes the calls, a loopback URL on the user's Mac would work. UNVERIFIED; live item G1.

Consequences, ranked:

1. **Remote HTTPS (cloud path, works by design).** The Host serves the endpoint at a public HTTPS
   origin (or a tunnel to a laptop Host). This is B6 as written.
2. **Loopback with `placement: "client"` (local path, unproven).** Only if live item G1 passes. The
   server half is already proven on loopback (§2.2).
3. **Command entry on the Bot's cloud computer.** The command runs in Cursor's box, so it still has
   to reach the Host over the network. It removes no public-endpoint need and would need a thin
   stdio-to-HTTPS bridge that byok does not ship. Not recommended unless the box gets private
   network access to the Host.
4. **Local stdio on the user's Mac.** Not available: Grok Bot does not run account MCP servers on the
   Mac (code evidence above).

### 2.2 What is proven locally

Runnable Host: `bun run --cwd examples/byok-mcp-server host -- --state <dir> --issue-key`
(`src/host-compose.ts`, smoke in `src/host-compose.test.ts`). Live checklist status and owner steps:
`Garbage/b6-live-checklist-goa.md`.

`examples/byok-mcp-server/src/grok-bot-mode-g.test.ts` builds a client from the exact Grok Bot remote
entry (`{ type: "http", url, headers: { Authorization } }`, no `Origin`), against the real composition:
embedded `@byok-sdk/server`, `BetaLedger`, `createTaskTools`, the real device daemon with a scripted
runtime, all on `127.0.0.1`. It passes:

- 401 with `WWW-Authenticate: Bearer realm="byok-mcp"` for a missing or wrong bearer;
- `2025-06-18` and `2025-11-25` negotiate; `2024-11-05` initialize gets HTTP 400;
- `GET` on the session gets 405 with `Allow: POST, DELETE`;
- `tools/list` matches the key's scopes; `byok_whoami` matches the key; an unknown task is an
  `isError` result with `not_found`;
- `byok_task_submit` returns at once; `byok_task_status { waitSeconds: 50 }` returns when the device
  reaches a terminal; the outcome is `Complete` with `finalMessage`;
- after `revokeKey`, the same entry gets 401.

### 2.3 B6 §8 items that still need a human, a Grok Bot account and a live session

| Item | Still live-only |
| --- | --- |
| G1 (new) | Does `placement: "client"` make the desktop app call a loopback URL? Record the Host log source address. Decides path 2. |
| 1 Custom MCP connection | Grok Bot accepts the URL and the `headers` bearer in its UI; negotiated version; whether requests carry `Origin`; whether it sends `GET`; that the **model** sees `isError`; tool-call timeout. |
| 2 Reachability | Entirely live: public ingress log ↔ Host tool log, egress IPs. |
| 3 50 s long poll | That Grok Bot's connector holds a 50 s call without timing out, and that the Bot loops to a terminal state. |
| 4 Routine webhook pointer | Entirely live: Grok Bot routine with webhook trigger, spacing, no retry. |

## 3. Mode A: Aiphabee frontend on byok Bot mode

Existing in this repo:

| Capability | Where |
| --- | --- |
| Bot execution primitives: `executions.submit` with `AgentRef` (K5), wake queue (K2), typed busy codes (K6), `submit_result` (K7), reply drafts (#500), `messageEgress` | `@byok-sdk/server`; Bot mode PRD §0 |
| Agent home and memory: `MEMORY.md`/`notes/`, `memory_recall`/`memory_save`, `agent.memory.projection`, `agent.memory.intent` (device CAS) | spec "Durable Agent homes"; PRD §1 |
| Device-local Host execution core: ledgers, routines, sealed executions | `examples/host-execution-core` (K4) |
| Bot collaboration, local topology L | `examples/bot-collaboration` (K8a/K8b) |
| Hosted topology H on Node and Postgres | `examples/hosted-bot-collaboration` (README: "Do not use this example as a deployed Host yet") |
| Browser activity timeline boundary | `examples/live-activity-host` |

Gaps:

1. Aiphabee wiring. The PRD records Aiphabee as topology L (`apps/local-agent/src/research-pass-host.ts`,
   embedded server and daemon in one process), with bot chat on the ordinary fresh lane. Moving that
   chat onto K4/K8 Bot mode (PRD A1–A4) is Aiphabee work and is not verified from this repo.
2. Bot mode runs on Pi only (PRD Q8, kept by the beta ruling). Mode A cannot pick Codex, Claude or
   the Grok CLI as the Bot runtime without reopening Q8.
3. The hosted H reference is not deployable yet; a cloud Aiphabee Host for Mode A needs its own GO.
4. One backend, two doors: decide whether Mode G keys carry the Mode A Bot's `AgentRef`. If yes, Grok
   Bot reads the same byok memory and routines; Grok Bot's own conversation memory stays separate
   (beta §9 Q1), and beta v1 has no memory write.

## 4. Non-goals

- A `RuntimeAdapter` (new id or the existing `grok`) for the Grok Bot product.
- Aiphabee, the Host, the SDK or the daemon driving Grok Bot: no `grokbot://` sending, UI scripting,
  inspector injection or private-backend calls.
- Changing the `grok` CLI adapter.
- Cross-Bot messaging for external Bots (beta v1 exclusion).
- A stdio-to-HTTPS bridge for the box command path, unless a later GO asks for it.
- Choosing Aiphabee's public hosting or tunnel.

## 5. Acceptance criteria for the full implementation

Mode G:

1. The Aiphabee Host composes `examples/byok-mcp-server` on its embedded server, issues one byok bot
   key per Grok Bot with only the needed scopes, and serves the endpoint at HTTPS (or loopback if G1
   passes).
2. B6 §8 items 1–3 PASS live, with the evidence fields B6 lists; item 4 PASS if the routine nudge ships.
3. One recorded end-to-end run: user asks in Grok Bot → `byok_task_submit` → real coding runtime on a
   paired device → terminal → Grok Bot answers from the tool result; Host log, device log and Bot
   transcript agree on `taskId` and state.
4. `grok-bot-mode-g.test.ts` stays green in the example suite.

Mode A:

5. Aiphabee chat runs as Bot-mode executions on K4 (Pi), with the Agent's home memory and egress.
6. If keys share an `AgentRef`: a routine created in Mode G shows up in Mode A's K4 ledger and the
   other way round; `byok_memory_read` returns the Mode A Bot's projection.

Both:

7. No code path sends input to Grok Bot. The probe still reports `fail-closed` for the installed
   version; a `needs-review` result opens a new GO, never an adapter.
