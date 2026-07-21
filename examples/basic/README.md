# @byok/example-basic

End-to-end walking-skeleton demo for the BYOK SDK (see `docs`/plan: 里程碑 M0).
A hono server embeds `@byok/server`'s in-memory reference implementation and
serves a single plain-HTML/JS page (no frontend build step). A separate
`byok-agent` daemon process (from `@byok/client`) runs on "the user's
machine" and drives the local `pi` coding-agent runtime.

Not published — this package is `private` and lives under `examples/`.

## Prerequisites

From the repo root:

```sh
pnpm install
pnpm -r build
```

`@byok/client`'s `pi` runtime is an optionalDependency
(`@earendil-works/pi-coding-agent`); if it fails to install for your platform
the daemon falls back to a `pi` binary on `PATH` (see
`packages/client/src/adapters/pi/resolve-bin.ts`).

## Run it

**Terminal 1 — the server:**

```sh
pnpm --filter @byok/example-basic dev
```

Starts the hono app on `http://localhost:8787` (override with `PORT`).

**Terminal 2 — the daemon**, pointed at an isolated store dir so it never
touches `~/.byok`:

```sh
cat > /tmp/byok-example-config.json <<'EOF'
{
  "productName": "BYOK Example",
  "productId": "byok-example-basic",
  "serverUrl": "http://localhost:8787",
  "workspaceRoot": "/tmp/byok-example-workspace",
  "storeDir": "/tmp/byok-example-store"
}
EOF

# Get a pairing code from the web page (step 1 below) first, then:
node packages/client/dist/bin/byok-agent.js pair <code> --server http://localhost:8787 --config /tmp/byok-example-config.json
node packages/client/dist/bin/byok-agent.js start --config /tmp/byok-example-config.json
```

(Once `@byok/client` publishes its `byok-agent` bin, this is just `byok-agent
pair`/`byok-agent start` on PATH — see that package's own docs. Invoking
`dist/bin/byok-agent.js` directly here just avoids requiring a global/linked
install for the demo.)

`productId` in the daemon config **must** match the server's
`BYOK_EXAMPLE_PRODUCT_ID` (defaults to `byok-example-basic` on both sides —
see `server.ts`); a mismatch is rejected at the WS handshake.

**Browser:** open `http://localhost:8787`.

1. Click **Create pairing code** and copy it into the daemon's `pair` command
   above.
2. Once `byok-agent start` logs `daemon started: ...`, the machine appears
   under **Connected machines** (polled every 2s).
3. Enter an instruction (runtime defaults to `pi`, the only adapter M0
   implements) and click **Dispatch**. The progress feed streams live via
   SSE; approve/cancel buttons call the task's `TaskHandle` directly.

## Persistent storage (M3)

By default this demo's task/blob state is in-memory + local-disk and is lost
whenever the server process restarts. Set `BYOK_STORE=sqlite` to swap in
`@byok/server`'s `node:sqlite`-backed reference stores (`SqliteTaskStore`/
`SqliteBlobStore`) instead — task **records** and blob bytes then survive a
restart, persisted under `examples/basic/data/` (gitignored):

> Note: this is **record persistence**, not live-task recovery. A restarted
> server recovers the stored task/blob rows, but an *in-flight* task is not
> resumed — the fresh process has no live runtime connection, event queue,
> result promise, or device session for it, and previously paired devices
> reconnect as new sessions. Reconnection/resume of active work is out of
> scope for the M3 reference stores.

```sh
BYOK_STORE=sqlite pnpm --filter @byok/example-basic dev
```

Requires Node.js 22.5+ (`node:sqlite`'s minimum); on an older Node this fails
fast with a clear error rather than a cryptic one (see
`packages/server/src/sqlite-support.ts`).

## Provider API key (for a *real* pi run)

`pi` needs a model provider credential to actually call an LLM. Set one of
the env vars pi/the adapter recognize before starting the daemon, e.g.:

```sh
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, GEMINI_API_KEY, etc.
```

Without one, pi's `prompt` call fails immediately with "No API key found..."
and the task reports `task.fail`. This is normal, expected fail-closed
behavior — not a bug — and is exactly what the M0 acceptance run's fake-pi
fixture path also exercises (see the SDK repo's M0 report), just without
needing a real key.

## Testing with z.ai GLM

`pi` (the `@earendil-works/pi-coding-agent@^0.74.2`, `legacy-node20`-dist-tag
version this SDK's optionalDependency pins — see
`packages/client/src/adapters/pi/resolve-bin.ts`) already ships a **built-in**
`zai` provider — no extension, no `models.json`, no code change anywhere in
this SDK is needed. Empirically confirmed (2026-07-16) against the actually
installed 0.74.2, and cross-checked against the current `latest` (0.80.7,
`@earendil-works/pi-ai`'s bundled `providers/zai.models.js`): both versions
define it identically —

```
provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4"
```

— i.e. the OpenAI-completions-compatible z.ai coding-plan endpoint the task
brief called out, not the Anthropic-compatible one (`api.z.ai/api/anthropic`);
there was no need to touch the latter, since a ready-made provider already
exists for the former. **0.74.2 fully suffices** — no Node-baseline bump is
needed for this. The only difference in `latest` (0.80.7) is one newer model
(`glm-5.2`, 1M context) and a separate `zai-coding-cn` region-variant
provider (`ZAI_CODING_CN_API_KEY`) for the mainland-China z.ai endpoint;
neither changes the mechanism below.

### Exact model IDs (from the installed 0.74.2's own bundled registry)

```
zai/glm-4.5-air   (131K context,  98K max output)
zai/glm-4.7       (204.8K context, 131K max output)
zai/glm-5-turbo   (200K context,  131K max output)
zai/glm-5.1       (200K context,  131K max output)
zai/glm-5v-turbo  (200K context,  131K max output, vision)
```

(`glm-4.6`, sometimes mentioned elsewhere as a z.ai coding-plan model, is not
in this registry snapshot — already superseded. `glm-4.7` is current and is
this doc's recommended default.)

### Config mechanism

The byok-sdk `PiAdapter` never passes `--model`/`--provider` on pi's command
line (`pi-adapter.ts` only adds `--mode rpc --session-id <ref>` plus
permission-mapping flags) — so GLM has to be pi's own **default** model, set
once, rather than something byok selects per task:

1. **API key** — the installed pi's env-var-to-provider map
   (`@earendil-works/pi-ai`'s `env-api-keys.ts`) recognizes exactly
   `ZAI_API_KEY` for the `zai` provider. None of `Z_AI_API_KEY`,
   `ZHIPUAI_API_KEY`, `ZHIPU_API_KEY`, `GLM_API_KEY`, or `BIGMODEL_API_KEY`
   are recognized by pi itself (they're other tools' conventions for the same
   underlying z.ai/Zhipu/GLM account) — only `ZAI_API_KEY` works here:

   ```sh
   export ZAI_API_KEY=your-z.ai-coding-plan-api-key
   ```

2. **Default model** — write (or merge into) `~/.pi/agent/settings.json`:

   ```json
   {
     "defaultProvider": "zai",
     "defaultModel": "glm-4.7"
   }
   ```

   (Want full isolation from your real `~/.pi/agent/`? Run the daemon with
   `HOME` pointed at a scratch directory instead, e.g.
   `HOME=/tmp/byok-glm-home node packages/client/dist/bin/byok-agent.js start ...`,
   and put `.pi/agent/settings.json` under that scratch `HOME` instead.)

3. **Do not set `BYOK_PI_BIN`** for this — that env var swaps in the
   fake-pi test fixture; leave it unset so `resolvePiBin()` resolves the real
   installed `@earendil-works/pi-coding-agent` optionalDependency.

4. Run the daemon exactly as in "Run it" above (`pair` then `start`) with
   `ZAI_API_KEY` exported and the settings file in place, then dispatch:

   ```sh
   curl -s -X POST http://localhost:8787/api/tasks \
     -H 'content-type: application/json' \
     -d '{"instruction": "Create a file named hello.txt containing '"'"'hello from GLM'"'"'", "runtime": "pi"}'
   ```

   or use the web UI's dispatch form with that same instruction. Verify via
   the task's SSE feed / `GET /api/tasks/:taskId`: `state: "Complete"`, and
   `hello.txt` actually written into that task's workspace dir
   (`<workspaceRoot>/<taskId>/hello.txt`) containing `hello from GLM`.

### Verified mechanism, blocked on a real key

Empirically verified end-to-end **except** the final live-inference call
(no `ZAI_API_KEY`-shaped key was present in the environment this was
verified in — checked presence-only: `ZAI_API_KEY`, `Z_AI_API_KEY`,
`ZHIPUAI_API_KEY`, `ZHIPU_API_KEY`, `GLM_API_KEY`, `BIGMODEL_API_KEY` were
all absent):

- `pi --list-models` (offline, with a dummy `ZAI_API_KEY` and the
  `defaultProvider`/`defaultModel` settings above) correctly lists exactly
  the 5 `zai` models above — confirms the config is recognized.
- `pi -p "say hi"` (same setup, no `--provider`/`--model` flags, dummy key)
  produced `401 token expired or incorrect` — a genuine response from the
  real `api.z.ai` endpoint, confirming the request really is routed to z.ai
  by default, authenticated with the configured key, with no further config
  needed. A real key in place of the dummy one is the only missing piece.

Note also: pi-adapter.ts's own `authPresent` heuristic (surfaced in this
example's "runtime chips") only recognizes a fixed list of common provider
env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. — see
`KNOWN_PROVIDER_ENV_VARS` in `pi-adapter.ts`); `ZAI_API_KEY` isn't in that
list, so a GLM-configured device's runtime chip will show `✗auth` in this
demo's UI even when correctly configured — cosmetic only, not a functional
gap (this is a deliberately non-exhaustive, "common providers" list per its
own doc comment, not a bug).

## Policy mode

The dispatch form only asks for an instruction + runtime (per the M0 spec);
`server.ts` always dispatches with `policy: { mode: 'auto' }`. M0's pi
adapter cannot express `confirm`/`plan` (no built-in per-call approval gate —
see `packages/client/src/adapters/pi/permission-mapping.ts`), and
`byok.dispatch()`'s own default policy is the safer `confirm` — so a demo
that dispatched with the SDK default would fail-closed on every single run.
`auto` is this example's deliberate choice, not the SDK's.

## Debugging a stuck task

If a dispatched task never claims, check the daemon's stdout for a
`task.fail` reason — most likely an unavailable runtime (`pi` not
installed/on PATH and no `BYOK_PI_BIN` override) or an unsupported policy.
`byok-agent start` logs daemon status every 5s.
