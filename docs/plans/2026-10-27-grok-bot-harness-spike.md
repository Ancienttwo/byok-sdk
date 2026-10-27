# Grok Bot (product) as the Aiphabee local-agent harness: design and spike

Status: spike, draft branch `spike/grok-bot-harness`, base `origin/main@990abd60`. No product code.
Probe: `scripts/spikes/grok-bot-probe.mjs` (test: `scripts/spikes/grok-bot-probe.test.mjs`).
Report: `Garbage/grok-bot-harness-spike-report.md`.
Parents: [external-Bot MCP beta](2026-10-19-byok-mcp-server-external-bot-beta.md),
[#514 Grok CLI adapter plan](2026-10-19-514-grok-adapter-plan.md),
[B6 Grok Bot client guide](../../examples/byok-mcp-server/docs/grok-bot.md).

## 0. The gap: `grok` is not Grok Bot

The client adapter `grok` (`packages/client/src/adapters/grok/grok-adapter.ts`) drives
**Grok Build**, the xAI coding CLI, over ACP on stdio (`grok agent … stdio`). It does not
drive **Grok Bot**, the desktop assistant product. They are separate products:

| | `grok` adapter target | Grok Bot (this GO) |
| --- | --- | --- |
| Binary | `~/.grok/bin/grok-1.0.62`; `grok --help` prints "Grok Build TUI" | `/Applications/Grok Bot.app`, Electron, bundle id `com.anysphere.sand` (Anysphere/Cursor, team `DCNK4UB866`), 0.75.8 |
| Control surface | ACP JSON-RPC on stdio, owned child process | GUI only; see §2 |
| Where the agent runs | Local child of the byok daemon | Evidence points to the Cursor backend: agent `harness` values `temporal` and `box`, a `cloud-agents` client slice, a `pod_hibernated` refusal reason, backend host `api2.cursor.sh` |
| Auth | `~/.grok/auth.json` | Cursor account inside the app (`sand-secrets.json`, encrypted gateway descriptor) |

The only link found between them is account linking: the CLI binary contains "Link your
Cursor account from the Grok Bot flow on grok.com". That is not a control channel. The
existing adapter does not satisfy this GO, and extending it would not either.

## 1. Target architecture

The GO describes `Aiphabee host → byok-sdk → Grok Bot`. The spike shows byok cannot push
work into Grok Bot and read the reply (§2). The working shape inverts the call direction and
is the one already ruled on 2026-10-19 (beta plan §0):

```
User ── chat ──> Grok Bot (desktop client; agent runs in the Cursor backend)
                   │ custom MCP, Remote HTTPS, Authorization: Bearer <byok bot key>
                   ▼
           Aiphabee Host: byok MCP endpoint (examples/byok-mcp-server, B1–B5)
                   │ @byok-sdk/server dispatch / tasks.*
                   ▼
           paired device daemon ──> RuntimeAdapter ──> Pi | Codex | Claude | Grok CLI
```

- Grok Bot talks with the user and owns its conversation memory.
- "Aiphabee dispatches work" means the Host makes byok tasks available and Grok Bot picks
  them up through `byok_task_*` tools. A Host-initiated nudge goes through a Grok Bot routine
  webhook carrying a pointer only (B6 §5), never through the desktop app.
- byok never treats Grok Bot as a `RuntimeAdapter`.

## 2. Spike findings (what can drive the installed app)

All from the installed artifact and the running process on this Mac; nothing was sent to the
app. Commands and output are in the report.

| Candidate surface | Result |
| --- | --- |
| ACP / stdio | None. No ACP method names (`session/prompt`, `session/new`, `agent-client-protocol`) in any bundled JS. No command-line switch accepts a prompt; the switches found are `--user-data-dir`, `--updated`, `--sand-wayland-client` and an `--inspect`/`--debug` check on child `execArgv`. |
| Local TCP API | None. No Grok Bot process holds a listening TCP socket (`lsof -iTCP -sTCP:LISTEN` on all 14 app pids). |
| Dev control HTTP server | Exists in code (agent list/create, onboarding), started only when `!app.isPackaged` and `SAND_DEV_CAPABILITY=1`. The shipped app never serves it. |
| Node inspector / `NODE_OPTIONS` / run-as-node | Closed by Electron fuses: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off; asar integrity and `OnlyLoadAppFromAsar` on. |
| Single-instance socket | Electron's `SingletonSocket` forwards a second launch's argv into the same deep-link handler. Nothing more. |
| Deep link `grokbot://app/v1/prompt?text=…[&id=<agent>]` | Exists. `text` at most 1000 chars. The renderer handler only writes the composer draft and focuses the agent; it returns `prefilled`, or `kept-draft` when a draft already exists. It never sends, and there is no reply channel. A human must press send. |
| Other deep links | `agent`, `thread`, `task`, `sidebar`, `settings`, `open`, `marketplace`, `plugin-add`, connector OAuth callbacks: navigation only. |
| MCP client inside Grok Bot | Present: in-app RPC `addMcpServer({ name, configJson })`, per-agent `getGrokBotAgentMcpServers`, `stdio`/`sse`/`http` config shapes, `streamableHttpSession`. Configured by the user in the app UI, not from outside. This is the surface the beta already targets. |
| Cloud API to message a bot | Not found in the app as a public surface; the app talks to the private Cursor backend. Absence of a public API stays UNVERIFIED (as in beta plan §1.4). |

Verdict: **fail-closed**. No surface on this machine lets byok submit a prompt to Grok Bot
without a human and read the result.

## 3. Paths, ranked

1. **Pull through the byok MCP endpoint (recommended, already built).** Grok Bot adds the
   Aiphabee Host's byok MCP endpoint as a custom MCP server and uses `byok_task_submit` /
   `byok_task_status`. Code exists (`examples/byok-mcp-server`, B1–B5); B6 documents the client
   side. Remaining work is Aiphabee Host composition behind public HTTPS and the B6 §8 owner
   live checklist, which is still PENDING. No new adapter id.
2. **Host-initiated nudge through a Grok Bot routine webhook (optional).** Pointer-only POST
   (`task_done`, `taskId`, `state`), at most one run per 5 minutes, no retry (UNVERIFIED). Host
   code, not SDK code. B6 item 4 verifies it.
3. **Human handoff by deep link (optional UX).** An Aiphabee desktop surface may open
   `grokbot://app/v1/prompt?text=<≤1000 chars>` so the user sees a prefilled Grok Bot composer.
   It is a convenience for the user, not a harness: no submit, no result, local only, and the
   result still returns through path 1. Do not wrap it as an adapter.
4. **Use the `grok` CLI instead.** Already supported (`grok` adapter, #514). It is a valid
   coding runtime behind path 1, but it is not Grok Bot. Pick it only if product accepts the
   substitute.
5. **New `RuntimeAdapter` id `grok-bot` — rejected now, fail closed.** No submit-and-result
   surface exists, so any adapter would fake completion. It also contradicts the 2026-10-19
   ruling. Reopen only if Anysphere publishes a documented local or cloud API (for example
   ACP, a local socket, or a public bot-messaging endpoint); rerun the probe, which flags
   `needs-review` when ACP markers, a TCP listener, a served dev port or a submitting deep link
   appear.
6. **Extend the existing `grok` adapter — rejected.** Different product, binary, auth and
   runtime location.
7. **UI automation, accessibility scripting, asar patching or inspector injection —
   rejected.** Private surface, blocked by fuses and asar integrity, breaks on every
   auto-update (the app self-updates through ShipIt), and needs elevated trust.

## 4. Non-goals

- No adapter, shim or registry entry that claims Grok Bot is a byok runtime.
- No sending of `grokbot://` links from the SDK or daemon.
- No reading of Grok Bot transcripts, secrets or encrypted gateway state.
- No Cross-Bot messaging for external Bots (beta v1 exclusion stands).
- No change to the `grok` CLI adapter.
- No public-HTTPS hosting decision for Aiphabee; that is the Host's.

## 5. Acceptance criteria for a later full implementation (path 1, plus 2 if chosen)

1. Aiphabee Host composes `examples/byok-mcp-server` behind a public HTTPS origin; one byok bot
   key per Grok Bot with only the scopes it needs.
2. B6 §8 items 1–3 PASS on a live Grok Bot with recorded evidence: custom MCP accepted over
   Streamable HTTP with the bearer, `tools/list` matches scopes, `isError` reaches the model,
   a 50 s `byok_task_status` long poll survives, the Bot reports `finalMessage` as returned.
3. One end-to-end task: user asks Grok Bot → `byok_task_submit` → task runs on a paired device
   with a real coding runtime → terminal state → Grok Bot answers from the tool result.
   Host log, device log and Bot transcript agree on `taskId` and state.
4. Revoking the key gives HTTP 401 on the next call; a running task is unaffected.
5. If path 2 is chosen: B6 item 4 PASS (routine run calls `byok_task_status` with the pointer's
   `taskId`).
6. The probe still reports `fail-closed` for the installed Grok Bot version, or, if it reports
   `needs-review`, a new GO evaluates the new surface before any adapter work.
