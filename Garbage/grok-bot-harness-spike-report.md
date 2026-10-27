# Grok Bot harness spike: report

Date: 2026-10-27. Branch `spike/grok-bot-harness` (base `origin/main@990abd60`). Not pushed.

## Result

**PASS (fail-closed).** Grok Bot is installed and running on this Mac, and byok cannot
drive it: no ACP, stdio, local API or IPC surface submits a prompt and returns the
reply. The only inbound surface, `grokbot://app/v1/prompt`, prefills the composer and never
sends. The supported shape is the existing external-Bot MCP beta: Grok Bot calls the
Aiphabee Host's byok MCP endpoint as an MCP client.

## Artifacts

| Path | What |
| --- | --- |
| `docs/plans/2026-10-27-grok-bot-harness-spike.md` | Design: gap, target architecture, ranked paths, non-goals, acceptance criteria |
| `scripts/spikes/grok-bot-probe.mjs` | Read-only probe; prints a JSON verdict (`fail-closed` / `needs-review` / `not-installed`) |
| `scripts/spikes/grok-bot-probe.test.mjs` | Unit test of the probe's parsers and verdict rule (synthetic inputs) |
| `Garbage/grok-bot-harness-spike-report.md` | This report |

## Evidence (commands run)

1. `node scripts/spikes/grok-bot-probe.mjs` → exit 0, `verdict: "fail-closed"`:
   - bundle `com.anysphere.sand`, "Grok Bot" 0.75.8, URL schemes `grokbot`, `sand`
   - `desktop-status.json`: signed in, pid alive; 14 app processes
   - Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
     `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on,
     `OnlyLoadAppFromAsar` on
   - entrypoints in `app.asar`: `dist/electron-main/main.cjs`, `dist/local-exec-daemon/main.cjs`,
     `dist/node-agent-coordinator/main.cjs`
   - deep-link routes: `agent`, `marketplace`, `plugin-add`, `plugin-native`, four
     `*-connect-callback`, two `onepassword-*-callback`, `open`, `prompt`, `create-team-bot`,
     `settings`, `thread`, `task`, `vault`, `sidebar`
   - prompt handler outcomes `superseded`, `no-main-agent`, `found`, `added`, `kept-draft`,
     `prefilled`; `setsDraft: true`, `submits: false`
   - dev control server: `unpackaged-only`; ACP markers: none; TCP listeners: none
   - `grok` CLI: `grok 1.0.62 (1474f9cbdd91)`, product "Grok Build"
2. `node --test scripts/spikes/grok-bot-probe.test.mjs` → 5 pass, 0 fail.
3. Manual reads of the extracted bundles (scratchpad only, not committed):
   - `main-core.cjs`: deep-link table `schemes:["grokbot","sand"], authority:"app"`,
     `prompt: /v1/prompt {id?, text ≤1000}`; single-instance argv goes to the same handler.
   - renderer `index.eager-app-*.js`, function handling `prompt`: `t.drafts.setDraft(a,{prompt:e.text})`,
     then `ingestFocusAgent`, returns `prefilled`.
   - `main-app.cjs`: `e.isPackaged||(e.startDevControlServer??Jtt)(…)`; gate text "only served to
     an unpackaged app started with SAND_DEV_CAPABILITY=1".
   - `main-app.cjs`: in-app RPC `addMcpServer({name, configJson})`, `getGrokBotAgentMcpServers`;
     agent `harness==="temporal"` / `"box"`; backend `api2.cursor.sh`.
4. `strings ~/.grok/bin/grok-1.0.62`: one Grok Bot mention, "Link your Cursor account from the
   Grok Bot flow on grok.com" (account linking only).

Not done, by design: no `grokbot://` link was opened (it would change the user's draft), no
secrets or transcripts were read, the app was not restarted or modified.

## Is a separate GO needed next?

Yes, one of these, owner's choice:

- **GO-A (recommended): Aiphabee Host adopts the byok MCP beta for Grok Bot.** Compose
  `examples/byok-mcp-server` in the Aiphabee Host behind public HTTPS, issue a Grok Bot key,
  and run the B6 §8 owner live checklist (items 1–3, item 4 if the routine nudge is wanted).
  Acceptance criteria are in design §5.
- **GO-B (optional UX): deep-link handoff** from an Aiphabee surface to a prefilled Grok Bot
  composer. Small, Aiphabee-side, no SDK change.

No GO for a `grok-bot` RuntimeAdapter until Anysphere ships a documented driving API and the
probe reports `needs-review`.

## Residual risk

- The probe reads minified bundle text; an app update can rename the markers it looks for.
  A missing marker shows as `null`/`unknown`, not as a pass to `drivable`.
- "Agent runs in the Cursor backend" and "no public bot-messaging API" rest on code evidence
  and earlier research, not on a vendor statement.
- The probe is not wired into `test:scripts` or CI; it is macOS-only and needs the app.
