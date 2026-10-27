# B6 §8 live checklist worksheet (GO-A)

Branch `spike/grok-bot-harness`, local only. Source checklist:
[examples/byok-mcp-server/docs/grok-bot.md §8](../examples/byok-mcp-server/docs/grok-bot.md#8-owner-live-acceptance-checklist-s0-items-14).
Host entry: `examples/byok-mcp-server/src/host-compose.ts` (`bun run host`).

## Status

| Item | Status | Evidence / what is left |
| --- | --- | --- |
| Server: auth (401 + `WWW-Authenticate: Bearer realm="byok-mcp"`) | **PASS (local)** | `grok-bot-mode-g.test.ts`, `host-compose.test.ts`, CLI smoke |
| Server: versions `2025-06-18` / `2025-11-25` connect; `2024-11-05` → 400 | **PASS (local)** | `grok-bot-mode-g.test.ts` |
| Server: session `GET` → 405 `Allow: POST, DELETE` | **PASS (local)** | `grok-bot-mode-g.test.ts` |
| Server: scoped `tools/list`, `byok_whoami`, unknown task → `isError` `not_found` | **PASS (local)** | `grok-bot-mode-g.test.ts` |
| Server: submit → status wait → `Complete` + `finalMessage` | **PASS (local)** | both tests, real daemon library, scripted runtime |
| Server: revoke → 401 on next call | **PASS (local)** | both tests |
| Host: start, pair, issue key, print entry, stable port on restart | **PASS (local)** | `host-compose.test.ts`; CLI smoke (`bun run host`) |
| G1 `placement: "client"` reaches a loopback URL | **PENDING** | owner + Grok Bot account |
| 1 Custom MCP connection | **PENDING** | owner + Grok Bot account |
| 2 Reachability | **PENDING** | owner + Grok Bot account + public HTTPS/tunnel |
| 3 50 s status long poll | **PENDING** | owner + Grok Bot account + paired device with a paid runtime |
| 4 Routine webhook pointer | **PENDING** | owner + Grok Bot routine; the Host has no automatic push (§5) |

## Owner run steps

1. **Start the Host and pair a device.**
   ```sh
   bun ci && bun run build
   bun run --cwd examples/byok-mcp-server host -- --state <private-dir> --issue-key
   ```
   It prints the MCP URL and a `byok-agent pair <code> --server <origin> --config <cfg>` command.
   The daemon config's `productId` must be `byok-mcp-host` (or `BYOK_MCP_HOST_PRODUCT_ID`) and its
   `serverUrl` the printed origin. Run `pair`, then `start`, with a runtime that is installed and
   signed in (default key runtime `pi`; add `--runtime codex` etc. to the Host command to grant others).
2. **Copy the entry.** After the device registers, the Host prints the key ID and, once, the entry:
   `{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}`.
   Keep the token only in Grok Bot.
3. **G1 first (decides the URL).** In Grok Bot, add a custom MCP server with that entry plus
   `"placement":"client"`. Ask the Bot to call `byok_whoami`. PASS only if the Host answers it and
   the Bot shows the result. Record the Grok Bot version, the UI field names and whether the Host saw
   the request. If it fails, use step 4.
4. **Cloud path.** Put the origin behind public HTTPS (tunnel or reverse proxy) and replace `url`
   with the public `https://…/mcp`. The listener only accepts `Host: 127.0.0.1:<port>`, so the proxy
   must send that Host header (for cloudflared: `--http-host-header 127.0.0.1:<port>`). The beta
   endpoint answers 403 to any `Origin` header other than the loopback origin; a 403 here is a B6
   finding, record it.
5. **Items 1–4.** Follow grok-bot.md §8 exactly, with its evidence fields (UTC times, Bot-visible
   result, HTTP status, Host log line, commit, negotiated version). Use the suggested Bot instruction
   text from grok-bot.md §3. For item 3 give a task that stays non-terminal for more than 50 s.
6. **Revoke after the run.** Stop the Host, then
   `bun run --cwd examples/byok-mcp-server host -- --state <private-dir> --revoke <keyId>`.

## Blockers for the live half

- A Grok Bot account and its UI; nobody else can run G1 or items 1–4.
- A paired device with a paid, signed-in runtime for item 3 and the end-to-end task.
- For the cloud path: a public HTTPS origin or tunnel that rewrites `Host`.
- Item 4: a Grok Bot routine with a webhook trigger; the pointer is sent by hand (`curl` in the S0
  runbook).

## Results (owner fills in)

| Item | Result | Date (UTC) | Evidence |
| --- | --- | --- | --- |
| G1 placement client | PENDING | | |
| 1 Custom MCP connection | PENDING | | |
| 2 Reachability | PENDING | | |
| 3 50 s long poll | PENDING | | |
| 4 Routine webhook pointer | PENDING | | |
