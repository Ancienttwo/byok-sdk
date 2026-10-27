# Grok Bot dual-mode spike: report

Date: 2026-10-27. Branch `spike/grok-bot-harness` (base `origin/main@990abd60`). Local commits only, not pushed.
Scope: RESTEER dual-mode (Mode G = Grok Bot as MCP client; Mode A = Aiphabee frontend on byok Bot mode).

## GO-A update (Host compose + B6 prep)

**PASS for everything runnable without a Grok Bot account.** Live items stay PENDING.

| Path | Change |
| --- | --- |
| `examples/byok-mcp-server/src/host-compose.ts` | New runnable Host: embedded SDK server (SQLite) + `BetaLedger` + `createBetaMcpServer` + `createTaskTools` on one `listenLoopback` origin; pairing command; `--issue-key` (task-only Grok Bot key, entry printed once); `--revoke` |
| `examples/byok-mcp-server/src/host-compose.test.ts` | Smoke: start → real daemon library pairs → key → entry drives `byok_whoami`, submit → `Complete` → revoke → 401 → restart keeps the port |
| `examples/byok-mcp-server/package.json`, `bun.lock` | `host` script; `tsx ^4.19.2` dev dependency (same range as sibling examples; `bun install --frozen-lockfile` clean) |
| `examples/byok-mcp-server/README.md`, `docs/plans/2026-10-27-grok-bot-dual-mode-plan.md` | Pointers to the entry and the worksheet |
| `Garbage/b6-live-checklist-goa.md` | B6 §8 worksheet: local PASS rows, live PENDING rows, owner steps, blockers |

Runs:

- `npx vitest run src/host-compose.test.ts` → 1 passed; `src/grok-bot-mode-g.test.ts` → 1 passed.
- Full example suite: 44/44 passed in 4 of 5 runs. One run, at load average about 22, had 4 failures;
  the failing names were not captured and three reruns right after passed 44/44.
- `npx tsc --noEmit` → exit 0.
- CLI smoke (`bun run host -- --state <tmp>`, scratch driver): banner with MCP URL and pairing command;
  `POST /mcp` without bearer → 401 `Bearer realm="byok-mcp"`; request with `Host: localhost:<port>` → 403;
  SIGINT stops it (`bun run` reports 130); `--revoke k_missing` → "no active key". The CLI
  `--issue-key` path was not run with the real `byok-agent` binary, to keep the device credential
  store and keychain untouched; the same code path runs in the smoke test with the daemon library.

Live-half blockers: a Grok Bot account (G1, items 1–4), a paired device with a paid signed-in runtime
(item 3), public HTTPS or a tunnel that sends `Host: 127.0.0.1:<port>` (cloud path), a Grok Bot routine
with a webhook trigger (item 4).

Not pushed, no PR, no merge, Aiphabee staging untouched.

## Result (dual-mode spike)

**PASS.**

- Mode G, server half: proven on loopback. A client built from Grok Bot's own remote-MCP entry shape
  completes auth, version negotiation, scoped `tools/list`, the submit/status loop to `Complete`,
  and revocation against the real `examples/byok-mcp-server` composition.
- Mode G, Grok Bot half: not provable without a live account. Code reading of Grok Bot 0.75.8 shows
  its custom MCP servers live in the account config and run from the Cursor backend or the Bot's
  cloud computer, so the cloud path (public HTTPS) is the one that works by design. Loopback from the
  Mac depends on an unverified `placement: "client"` option.
- Mode A: existing Bot-mode surfaces and gaps are listed; no new adapter work.
- Driving Grok Bot stays fail-closed (earlier probe), kept as negative evidence.

## Artifacts

| Path | What |
| --- | --- |
| `docs/plans/2026-10-27-grok-bot-dual-mode-plan.md` | Dual-mode plan (renamed from `…-grok-bot-harness-spike.md`): architecture, Mode G reachability, what is proven, live-only checklist items, Mode A capabilities and gaps, non-goals, acceptance |
| `examples/byok-mcp-server/src/grok-bot-mode-g.test.ts` | Mode G loopback spike test (Grok-Bot-shaped client, real SDK server + ledger + tools + daemon) |
| `scripts/spikes/grok-bot-probe.mjs`, `scripts/spikes/grok-bot-probe.test.mjs` | Earlier read-only probe: Grok Bot cannot be driven (negative evidence only) |
| `Garbage/grok-bot-harness-spike-report.md` | This report |

## Evidence (commands run)

Setup: `bun install --frozen-lockfile` (449 packages), `bun run build` (exit 0), short `TMPDIR`.

1. `npx vitest run src/grok-bot-mode-g.test.ts` (in `examples/byok-mcp-server`) → 1 passed. Asserts:
   401 + `WWW-Authenticate: Bearer realm="byok-mcp"` for missing/wrong bearer; `2025-06-18` and
   `2025-11-25` connect, `2024-11-05` initialize → HTTP 400; session `GET` → 405 `Allow: POST, DELETE`;
   scoped tool list (6 tools for `tasks.dispatch|read|cancel`); `byok_whoami` matches the key;
   unknown task → `isError` `not_found`; submit → `waitSeconds: 50` status returns on the device
   terminal → `{ state: "Complete", finalMessage: "Mode G answer", artifacts: [] }`; after
   `revokeKey` → 401.
2. `npx vitest run` (whole example) → 9 files, 43 tests passed. `npx tsc --noEmit` → exit 0.
3. Grok Bot 0.75.8 `app.asar` read in place (extracts in the session scratchpad, deleted after):
   - `configJson` schema: command entry `{type?:"stdio", command, args?, env?, envFile?, cwd?, enabledTools?, startupTimeoutSec?}`;
     remote entry `{type?:"http"|"sse", url, headers?, auth?:{CLIENT_ID, CLIENT_SECRET?, scopes?}, tls?:{caBundle}, placement?:"server"|"client", enabledTools?}`.
   - `addNewServer` → `writeAccountServer` → `addServersToAccount`; listing via `backendMcpExec.listTools`
     and `listBoxServers`.
   - `pgrep -fl "local-exec-daemon|node-agent-coordinator"` → nothing running.
   - No code found that explains `placement`.
4. Earlier probe `node scripts/spikes/grok-bot-probe.mjs` → `verdict: "fail-closed"` (unchanged).

No `grokbot://` link was opened. No Grok Bot secrets, account config or transcripts were read.

## B6 §8 status after this spike

| Item | Local (this spike) | Still needs a human + Grok Bot account |
| --- | --- | --- |
| G1 `placement: "client"` loopback | — | Yes: decides whether Mode G can stay on the Mac |
| 1 Custom MCP connection | Server side PASS (auth, versions, GET 405, scoped tools, `not_found` isError) | UI accepts URL + `headers` bearer; negotiated version; `Origin`; model sees `isError`; timeout |
| 2 Reachability | — | Entirely live |
| 3 50 s long poll | Server side PASS (status wait returns on terminal) | Connector holds 50 s; Bot loops to terminal |
| 4 Routine webhook pointer | — | Entirely live |

## Separate GO needed?

Yes. **GO: Aiphabee Host compose + live B6 checklist.** Compose `examples/byok-mcp-server` on the
Aiphabee Host's embedded server, decide whether Mode G keys share the Mode A Bot's `AgentRef`, expose
the endpoint (public HTTPS or tunnel), then run G1 and B6 items 1–3 (4 if the routine nudge is wanted)
with the owner's Grok Bot account. Acceptance: plan §5.

Mode A wiring (Aiphabee chat onto K4 Bot mode, PRD A1–A4) is Aiphabee-side and can be its own GO;
nothing in this spike blocks it.

## Residual risk

- Grok Bot findings come from minified code of one version (0.75.8); the app self-updates.
- "Remote calls come from the Cursor backend" is code-reading evidence, consistent with B6, not a
  vendor statement.
- The new test proves byok's half with a scripted runtime; no paid model ran.
- This worktree now has `node_modules` and build output from the install/build; remove them when the
  branch is done.
