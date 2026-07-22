// BYOK SDK example: a hono server embedding `@byok/server`'s in-memory M0
// reference implementation, plus a plain HTML/JS demo UI (no frontend build
// step — the page is served as a static file with inline <script>).
//
// This is the "examples/ (不发布)" app from the plan's 服务端参考实现 section:
// pair -> list machines -> dispatch a task -> stream progress -> show the
// result -> approve/cancel. See README.md for how to run the whole loop.
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  createByokServer,
  LocalDiskBlobStore,
  SqliteBlobStore,
  SqliteTaskStore,
  type BlobStore,
  type DispatchInput,
  type TaskHandle,
  type TaskStore,
} from '@byok/server';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
// One product = one daemon process = one server instance (plan: "一产品一
// daemon 进程"); this must match the `productId` the paired `byok-agent`
// config uses.
const PRODUCT_ID = process.env.BYOK_EXAMPLE_PRODUCT_ID ?? 'byok-example-basic';

// `RuntimeId` from @byok/protocol is 'pi' | 'claude' | 'codex'; M0 only ships
// the pi adapter (see plan: 里程碑 M0), but the wire/select still names all
// three so the demo is representative of the full protocol shape. Mirrors
// the same literal allowlist `packages/server/src/hub.ts` keeps locally
// rather than pulling in @byok/protocol just for this one array.
const KNOWN_RUNTIMES = new Set(['pi', 'claude', 'codex']);

// Constructing our own `blobStore` (rather than letting `createByokServer`
// default one internally) is the M1 `CreateByokServerOptions.blobStore`
// override in action: it gives this embedder a handle to the exact store
// instance in use, so `/api/blobs/:blobId/url` below can mint a download URL
// for the browser directly — the browser has no device bearer token of its
// own, so it can't call the bearer-authed `GET /byok/blobs/:id/url` route on
// `byok.hono` itself (see docs/protocol.md §7).
//
// Storage mode (M3): `BYOK_STORE=sqlite` swaps both reference stores for
// their `node:sqlite`-backed persistent counterparts (`SqliteTaskStore`/
// `SqliteBlobStore`, from `@byok/server`) so task RECORDS and blob bytes
// survive a restart of this demo process (record persistence only — an
// in-flight task is not resumed/reconnected; see the README) — data lands
// under `examples/basic/data/`
// (gitignored). Requires Node.js 22.5+ (`node:sqlite`'s minimum — see
// `packages/server/src/sqlite-support.ts`). Anything else, including unset,
// keeps the zero-setup default: in-memory tasks + local-disk blobs, both
// lost on restart.
const STORE_MODE = process.env.BYOK_STORE === 'sqlite' ? 'sqlite' : 'memory';

let blobStore: BlobStore;
let taskStore: TaskStore | undefined; // undefined -> createByokServer's own in-memory default

if (STORE_MODE === 'sqlite') {
  const dataDir = path.join(exampleDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  blobStore = new SqliteBlobStore({ path: path.join(dataDir, 'blobs.db') });
  taskStore = new SqliteTaskStore({ path: path.join(dataDir, 'tasks.db') });
  console.log(`byok example: BYOK_STORE=sqlite — persisting to ${dataDir}`);
} else {
  blobStore = new LocalDiskBlobStore();
}

const byok = createByokServer({ productId: PRODUCT_ID, blobStore, taskStore });

// `createByokServer`'s public surface only exposes read-only task snapshots
// (`tasks.get`/`tasks.list`) — the live `TaskHandle` (events/approve/reject/
// cancel/steer) is handed back exactly once, by `dispatch()`. An embedder
// that wants to act on a task again later (a second HTTP request) has to
// keep its own map from taskId -> handle; this is that map.
const handles = new Map<string, TaskHandle>();

const publicDir = path.join(exampleDir, 'public');
const indexHtml = await readFile(path.join(publicDir, 'index.html'), 'utf8');

// Compose our own app and mount byok's routes into it (`POST /byok/pair`),
// the way a real product would alongside its own unrelated routes — rather
// than bolting the demo's routes directly onto `byok.hono`.
const app = new Hono();
app.route('/', byok.hono);

app.get('/', (c) => c.html(indexHtml));

app.post('/api/pair', (c) => c.json(byok.pairing.createPairingCode()));

app.get('/api/machines', (c) => c.json(byok.machines.list()));

// M1 §6.3: revocation is server-side only, no wire message — the daemon's
// next challenge/token/WS attempt gets a 401 and its only recourse is to
// re-pair. Nothing else to await here; the effect shows up next time the
// device tries to renew or reconnect (see public/index.html's revoke button).
app.post('/api/machines/:deviceId/revoke', (c) => {
  byok.devices.revoke(c.req.param('deviceId'));
  return c.json({ ok: true });
});

app.get('/api/tasks', (c) => c.json(byok.tasks.list()));

app.get('/api/tasks/:taskId', (c) => {
  const snapshot = byok.tasks.get(c.req.param('taskId'));
  if (!snapshot) return c.json({ error: 'unknown taskId' }, 404);
  return c.json(snapshot);
});

app.post('/api/tasks', async (c) => {
  let body: { instruction?: unknown; runtime?: unknown; sessionRef?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.instruction !== 'string' || body.instruction.trim().length === 0) {
    return c.json({ error: 'instruction is required' }, 400);
  }
  if (body.runtime !== undefined && !KNOWN_RUNTIMES.has(body.runtime as string)) {
    return c.json({ error: `unknown runtime "${String(body.runtime)}"` }, 400);
  }
  if (body.sessionRef !== undefined && typeof body.sessionRef !== 'string') {
    return c.json({ error: 'sessionRef must be a string' }, 400);
  }

  const input: DispatchInput = {
    instruction: body.instruction,
    runtime: body.runtime as DispatchInput['runtime'],
    // M0's only implemented adapter (pi) can't express `confirm`/`plan` (see
    // packages/client/src/adapters/pi/permission-mapping.ts) — the SDK's own
    // dispatch() default is the safer `confirm`, but this demo only ever
    // talks to pi, so it opts into `auto` explicitly rather than dispatching
    // a task that would fail-closed on every run.
    policy: { mode: 'auto' },
    // Optional follow-up-turn pass-through: a caller that already has a
    // prior task's reported `sessionRef` (see GET /api/tasks/:taskId) can
    // carry it into a new dispatch so the runtime adapter resumes that same
    // runtime session (e.g. pi's own `--session`) instead of starting a
    // fresh one. `DispatchInput.sessionRef` already exists at the SDK level
    // (packages/server/src/types.ts) — this demo just didn't expose it yet.
    sessionRef: body.sessionRef as string | undefined,
  };

  try {
    const handle = await byok.dispatch(input);
    handles.set(handle.taskId, handle);
    return c.json({ taskId: handle.taskId });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

// The browser-facing counterpart of the bearer-authed `GET
// /byok/blobs/:id/url` (protocol §7): this embedder is trusted server-side
// code, so it mints the presigned download URL directly off its own
// `blobStore` handle instead of requiring the browser to hold a device
// token. Used by the UI when an `artifact` event carries a `blobRef` (a
// >64KB artifact — see task.artifact's inline-vs-blob split).
app.get('/api/blobs/:blobId/url', async (c) => {
  const downloadUrl = await blobStore.getDownloadUrl(c.req.param('blobId'));
  if (!downloadUrl) return c.json({ error: 'blob not found' }, 404);
  return c.json({ downloadUrl });
});

app.get('/api/tasks/:taskId/events', (c) => {
  const handle = handles.get(c.req.param('taskId'));
  if (!handle) return c.json({ error: 'unknown taskId' }, 404);

  return streamSSE(c, async (stream) => {
    for await (const event of handle.events()) {
      if (stream.aborted) break;
      await stream.writeSSE({ data: JSON.stringify(event) });
    }
  });
});

// M5 (approval targeting): an optional `approvalId` in the request body
// targets one specific pending approval rather than "whichever one is
// currently pending" (the untargeted default when omitted, unchanged from
// pre-M5) — see `TaskHandle.approve`'s own doc comment (`@byok/server`'s
// `types.ts`). A caller that already knows the approvalId it's acting on
// (e.g. an operator UI rendering `TaskSnapshot.pendingApprovalId`, or
// reacting to a `task.await_approval` ServerTaskEvent) passes it through
// here so a stale decision against a since-superseded approval throws
// `StaleApprovalError` instead of silently resolving the WRONG one.
app.post('/api/tasks/:taskId/approve', async (c) => {
  const handle = handles.get(c.req.param('taskId'));
  if (!handle) return c.json({ error: 'unknown taskId' }, 404);
  let approvalId: string | undefined;
  try {
    approvalId = (await c.req.json())?.approvalId;
  } catch {
    // no body / not JSON — approve untargeted (whichever approval is
    // currently pending), same as pre-M5.
  }
  try {
    await handle.approve(approvalId !== undefined ? { approvalId } : undefined);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

// M4 Phase 3: the approvals-panel counterpart to /approve above — mirrors it
// exactly (same handle lookup, same optional-reason-body parsing /cancel
// already uses, same 404/409 error shape). Calls TaskHandle.reject()
// in-process, the SAME way /approve calls TaskHandle.approve(). Approval is
// deliberately NOT an SDK-level HTTP route at all (see http.ts's own M4
// Phase 3 note): the SDK's wire-facing routes are bearer-authed with a
// DEVICE's access token, and any validly-paired device approving/rejecting
// ANY task is a footgun, not a feature. `ConnectionHub.approveTask`/
// `rejectTask` (called here via `TaskHandle`) is the supported entry point —
// an embedder builds its own operator-facing surface (own auth, own routes)
// on top of it, exactly like this file does.
app.post('/api/tasks/:taskId/reject', async (c) => {
  const handle = handles.get(c.req.param('taskId'));
  if (!handle) return c.json({ error: 'unknown taskId' }, 404);
  let reason: string | undefined;
  let approvalId: string | undefined;
  try {
    const body = await c.req.json();
    reason = body?.reason;
    // M5 (approval targeting): same optional targeting as /approve above —
    // see that route's own comment.
    approvalId = body?.approvalId;
  } catch {
    // no body / not JSON — reject with no reason, untargeted
  }
  try {
    await handle.reject(reason, approvalId !== undefined ? { approvalId } : undefined);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.post('/api/tasks/:taskId/cancel', async (c) => {
  const handle = handles.get(c.req.param('taskId'));
  if (!handle) return c.json({ error: 'unknown taskId' }, 404);
  let reason: string | undefined;
  try {
    reason = (await c.req.json())?.reason;
  } catch {
    // no body / not JSON — cancel with no reason
  }
  try {
    await handle.cancel(reason);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  byok.attachWebSocket(server as HttpServer);
  console.log(`byok example server listening on http://localhost:${info.port} (productId=${PRODUCT_ID})`);
});
