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
