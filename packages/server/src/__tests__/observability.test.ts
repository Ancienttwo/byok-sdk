import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

/** M4 Phase 4 (part B.1): `ByokServer.stats()`. */
describe('M4 Phase 4: ByokServer.stats() (part B.1)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  it('starts at zero/empty for a fresh server (no connections, no tasks, no traffic yet)', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID });
    byok = instance;
    const stats = await instance.stats();

    expect(stats.connectedDeviceCount).toBe(0);
    expect(stats.taskCountsByState).toEqual({
      Offered: 0,
      Claimed: 0,
      Running: 0,
      AwaitApproval: 0,
      Complete: 0,
      Failed: 0,
      Cancelled: 0,
    });
    expect(stats.envelopesIn).toBe(0);
    expect(stats.dedupDrops).toBe(0);
    expect(stats.rateLimitEvents).toBe(0);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('reflects connected devices, task counts by state, inbound envelope totals, and dedup drops as real traffic happens', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });

    expect((await instance.stats()).connectedDeviceCount).toBe(1);

    const handle = await instance.dispatch({ instruction: 'x' });
    expect((await instance.stats()).taskCountsByState.Offered).toBe(1);

    const claimEnvelope = createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId });
    expect((await daemon.send(claimEnvelope)).status).toBe(200);
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    let stats = await instance.stats();
    expect(stats.taskCountsByState.Claimed).toBe(1);
    expect(stats.taskCountsByState.Offered).toBe(0);
    expect(stats.envelopesIn).toBeGreaterThanOrEqual(1);
    expect(stats.dedupDrops).toBe(0);

    // Resend the EXACT same envelope (same id) — a dedup no-op (N3) — then a
    // fresh task.started behind it. `POST /byok/messages` applies its
    // envelopes synchronously inside the request, so each awaited send is
    // itself the barrier: by the time the second returns, the duplicate has
    // already been counted.
    expect((await daemon.send(claimEnvelope)).status).toBe(200);
    expect((await daemon.send(createEnvelope('task.started', {}, { taskId: handle.taskId }))).status).toBe(200);
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    stats = await instance.stats();
    expect(stats.dedupDrops).toBe(1);
    expect(stats.taskCountsByState.Running).toBe(1);
    expect(stats.taskCountsByState.Claimed).toBe(0);
  });

  it('is a plain serializable object (round-trips through JSON with nothing lost)', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID });
    byok = instance;
    const stats = await instance.stats();
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
  });
});

/** M4 Phase 4 (part B.2): the opt-in `GET /healthz` liveness route. */
describe('M4 Phase 4: GET /healthz (part B.2)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  it('is not mounted at all unless opted in', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/healthz`);
    expect(res.status).toBe(404);
  });

  it('once opted in, answers 200 with {ok:true, uptimeMs} and requires no auth', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, healthzRoute: true });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;

    // Deliberately no Authorization header at all — liveness must not
    // require a device credential.
    const res = await fetch(`${started.baseUrl}/healthz`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs as number).toBeGreaterThanOrEqual(0);
    // No sensitive data — liveness only (no device ids, no counts).
    expect(Object.keys(body).sort()).toEqual(['ok', 'uptimeMs']);
  });
});
