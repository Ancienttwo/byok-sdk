// BYOK SDK example: a hono server embedding `@byok-sdk/server`, plus a plain
// HTML/JS demo UI (no frontend build step: the page is served as a static file
// with an inline <script>).
//
// Copy this file, with task-events-route.ts, as is. It passes no `longPollHoldMs` or other transport
// override, so it runs with the SDK defaults, and `quickstart-smoke.test.ts`
// starts it unmodified to prove the README loop works with those defaults.
// Do not shorten the hold to hide a readiness problem.
//
// The loop: pair -> list machines -> submit a task -> stream its state ->
// show the result -> approve/cancel. See README.md for how to run it.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createByokServer, type AgentExecutionInput } from '@byok-sdk/server';
import { taskEventsRoute } from './task-events-route';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
// One product = one daemon process = one server instance (plan: "一产品一
// daemon 进程"); this must match the `productId` the paired `byok-agent`
// config uses.
const PRODUCT_ID = process.env.BYOK_EXAMPLE_PRODUCT_ID ?? 'byok-example-basic';

// The tenant is no longer a parameter anywhere on this surface: an embedded
// server serves exactly one product and derives its one tenant from
// `productId` at construction, so `createPairingCode` takes only the product.
// `BYOK_EXAMPLE_TENANT_ID` is therefore no longer read.

// `KNOWN_RUNTIMES` is the allowlist for the `runtime` a caller may request: the
// `RuntimeId` set from @byok-sdk/protocol ('pi' | 'claude' | 'codex'), kept as
// a local literal so this example does not import @byok-sdk/protocol for one
// array. It only validates the request. Which runtimes a given machine can run
// is whatever that machine reports in `GET /api/machines`, and the page builds
// its runtime list from that report.
const KNOWN_RUNTIMES = new Set(['pi', 'claude', 'codex']);
type Runtime = AgentExecutionInput['payload']['runtime'];

// Every task runs as one Agent in the daemon's Agent home. This demo has one
// Agent, so a device runs one of its tasks at a time; a second is declined
// while the first holds the home.
const EXAMPLE_AGENT = { agentId: 'byok-example', profileRevision: '1' } as const;
// The daemon declines an offer whose egress policy differs from its own. This
// is `@byok-sdk/client`'s default, which a daemon configured with
// `"agentEgress": {}` uses.
const EGRESS_POLICY: AgentExecutionInput['payload']['egressPolicy'] = {
  policyRevision: 'default-v1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 },
  reliable: { maxPendingEventsPerAgent: 256, maxPendingBytesPerAgent: 4 * 1024 * 1024, maxPendingBytesPerTenant: 16 * 1024 * 1024 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};

const storageMode = process.env.BYOK_STORE ?? 'memory';
if (storageMode !== 'memory' && storageMode !== 'sqlite') {
  throw new Error(`BYOK_STORE must be "memory" or "sqlite"; received ${JSON.stringify(storageMode)}`);
}
const byok = createByokServer({
  productId: PRODUCT_ID,
  storage:
    storageMode === 'sqlite'
      ? {
          kind: 'sqlite',
          path: process.env.BYOK_SQLITE_PATH ?? path.join(exampleDir, 'data', 'byok.sqlite'),
        }
      : { kind: 'memory' },
});

// `TaskSnapshot` no longer carries `instruction`/`runtime`: the
// coordination kernel stores a task's OUTCOME, not the host's input, so
// re-reading them off a snapshot would mean the kernel keeping a second copy
// of this demo's own form fields. Correct ownership is here — the dispatcher
// already has them — so the list view joins them back in by taskId.
const dispatched = new Map<string, { instruction: string; runtime?: Runtime }>();

const publicDir = path.join(exampleDir, 'public');
const indexHtml = await readFile(path.join(publicDir, 'index.html'), 'utf8');

// Compose our own app and mount byok's routes into it (`POST /byok/pair`),
// the way a real product would alongside its own unrelated routes — rather
// than bolting the demo's routes directly onto `byok.hono`.
// Product routes are registered first. `byok.hono` ends in `ALL /*`, so
// mounting it first swallows `/` and `/api/*`.
const app = new Hono();

app.get('/', (c) => c.html(indexHtml));

app.post('/api/pair', async (c) => c.json(await byok.pairing.createPairingCode({ productId: PRODUCT_ID })));

app.get('/api/machines', async (c) => c.json(await byok.machines.list()));

// M1 §6.3: revocation is server-side only, no wire message — the daemon's
// next challenge/token/WS attempt gets a 401 and its only recourse is to
// re-pair. Nothing else to await here; the effect shows up next time the
// device tries to renew or reconnect (see public/index.html's revoke button).
app.post('/api/machines/:deviceId/revoke', async (c) => {
  await byok.devices.revoke(c.req.param('deviceId'));
  return c.json({ ok: true });
});

app.get('/api/tasks', async (c) => {
  const { tasks, nextCursor } = await byok.tasks.list();
  return c.json({ tasks: tasks.map((task) => ({ ...task, ...dispatched.get(task.taskId) })), nextCursor });
});

app.get('/api/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  const snapshot = await byok.tasks.get(taskId);
  if (!snapshot) return c.json({ error: 'unknown taskId' }, 404);
  return c.json({ ...snapshot, ...dispatched.get(taskId) });
});

app.post('/api/tasks', async (c) => {
  let body: { deviceId?: unknown; instruction?: unknown; runtime?: unknown; sessionRef?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.instruction !== 'string' || body.instruction.trim().length === 0) {
    return c.json({ error: 'instruction is required' }, 400);
  }
  if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
    return c.json({ error: 'deviceId is required' }, 400);
  }
  if (body.runtime !== undefined && !KNOWN_RUNTIMES.has(body.runtime as string)) {
    return c.json({ error: `unknown runtime "${String(body.runtime)}"` }, 400);
  }
  if (body.sessionRef !== undefined && typeof body.sessionRef !== 'string') {
    return c.json({ error: 'sessionRef must be a string' }, 400);
  }
  const instruction = body.instruction;
  const deviceId = body.deviceId;
  const runtime = body.runtime as Runtime;

  try {
    let taskId: string;
    if (typeof body.sessionRef === 'string') {
      // A follow-up turn: a caller that has a prior task's reported
      // `sessionRef` (see GET /api/tasks/:taskId) resumes that runtime session.
      ({ taskId } = await byok.dispatch({ deviceId, instruction, runtime, agentRef: EXAMPLE_AGENT, sessionRef: body.sessionRef }));
    } else {
      // A fresh task. The Host owns the taskId and keeps the input until the
      // submission returns; this demo keeps both only in memory.
      ({ taskId } = await byok.executions.submit({
        taskId: randomUUID(),
        deviceId,
        payload: { instruction, runtime, agentRef: EXAMPLE_AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
      }));
    }
    dispatched.set(taskId, { instruction, ...(runtime === undefined ? {} : { runtime }) });
    return c.json({ taskId });
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
  const downloadUrl = await byok.blobs.getDownloadUrl(c.req.param('blobId'));
  return downloadUrl === undefined
    ? c.json({ error: 'blob not found' }, 404)
    : c.json({ downloadUrl });
});

// Progress, artifacts, approval requests and state, for a task `executions.submit`
// or `dispatch` created. See task-events-route.ts.
app.get('/api/tasks/:taskId/events', taskEventsRoute(byok));

// An optional `approvalId` in the request body targets one specific pending
// approval rather than "whichever one is currently pending" (the default when
// omitted). A caller that already knows the approvalId it acts on (e.g. an
// operator UI rendering `TaskSnapshot.pendingApprovalId`) passes it through so
// a decision against a since-superseded approval throws `StaleApprovalError`
// instead of resolving the wrong one. `byok.tasks.approve` decides by taskId,
// so it works for a task `executions.submit` created.
app.post('/api/tasks/:taskId/approve', async (c) => {
  const taskId = c.req.param('taskId');
  let approvalId: string | undefined;
  try {
    approvalId = (await c.req.json())?.approvalId;
  } catch {
    // no body / not JSON — approve untargeted (whichever approval is
    // currently pending), same as pre-M5.
  }
  try {
    await byok.tasks.approve(taskId, approvalId !== undefined ? { approvalId } : undefined);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

// The approvals-panel counterpart to /approve above, with the same optional
// targeting. Approval is deliberately not an SDK-level HTTP route: the SDK's
// wire-facing routes are bearer-authed with a DEVICE's access token, and any
// paired device deciding any task's approval is a footgun. An embedder builds
// its own operator-facing surface (own auth, own routes) on `byok.tasks`,
// exactly like this file does.
app.post('/api/tasks/:taskId/reject', async (c) => {
  const taskId = c.req.param('taskId');
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
    await byok.tasks.reject(taskId, reason, approvalId !== undefined ? { approvalId } : undefined);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.post('/api/tasks/:taskId/cancel', async (c) => {
  const taskId = c.req.param('taskId');
  let reason: string | undefined;
  try {
    reason = (await c.req.json())?.reason;
  } catch {
    // no body / not JSON — cancel with no reason
  }
  try {
    await byok.tasks.cancel(taskId, reason);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.route('/', byok.hono);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `byok example server listening on http://localhost:${info.port} ` +
      `(productId=${PRODUCT_ID}, storage=${storageMode})`,
  );
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  await byok.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
