import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { connectFakeDaemon, send, startServer, stopServer, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';

/** M4 Phase 4 (part B.1): `ConnectionHub.stats()` / `ByokServer.stats()`. */
describe('M4 Phase 4: ConnectionHub.stats() (part B.1)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('starts at zero/empty for a fresh server (no connections, no tasks, no traffic yet)', () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const stats = byok.stats();

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
    expect(stats.envelopesOut).toBe(0);
    expect(stats.dedupDrops).toBe(0);
    expect(stats.rateLimitEvents).toBe(0);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);

    byok.stop();
  });

  it('reflects connected devices, task counts by state, envelope in/out totals, and dedup drops as real traffic happens', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    expect(byok.stats().connectedDeviceCount).toBe(1);

    // dispatch() sends task.offer (envelopesOut), on top of the conn.ack
    // already sent during the handshake above.
    const handle = await byok.dispatch({ instruction: 'x' });
    expect(byok.stats().envelopesOut).toBeGreaterThanOrEqual(2);
    expect(byok.stats().taskCountsByState.Offered).toBe(1);

    const claimEnvelope = createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId });
    send(ws, claimEnvelope);
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    let stats = byok.stats();
    expect(stats.taskCountsByState.Claimed).toBe(1);
    expect(stats.taskCountsByState.Offered).toBe(0);
    expect(stats.envelopesIn).toBeGreaterThanOrEqual(1);
    expect(stats.dedupDrops).toBe(0);

    // Resend the EXACT same envelope (same id) — a dedup no-op (N3) — then a
    // fresh task.started right behind it on the same ordered WS stream.
    // Waiting for the Running transition proves the duplicate (sent first,
    // same socket, processed strictly in order) already landed in stats by
    // the time this observes it.
    send(ws, claimEnvelope);
    send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    stats = byok.stats();
    expect(stats.dedupDrops).toBe(1);
    expect(stats.taskCountsByState.Running).toBe(1);
    expect(stats.taskCountsByState.Claimed).toBe(0);
  });

  it('is a plain serializable object (round-trips through JSON with nothing lost)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const stats = byok.stats();
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
    byok.stop();
  });
});

/** M4 Phase 4 (part B.2): the opt-in `GET /healthz` liveness route. */
describe('M4 Phase 4: GET /healthz (part B.2)', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server) await stopServer(server);
    server = undefined;
  });

  it('is not mounted at all unless opted in', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/healthz`);
    expect(res.status).toBe(404);
  });

  it('once opted in, answers 200 with {ok:true, uptimeMs} and requires no auth', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, healthzRoute: true });
    const started = await startServer(byok);
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
