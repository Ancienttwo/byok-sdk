import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { connectFakeDaemon, connectFakeDaemonWs, pairFakeDaemon, startServer, stopServer, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so the empty-timeout case doesn't take the real ~50s default. */
const SHORT_HOLD_MS = 150;

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('long-poll fallback (§8)', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server) await stopServer(server);
    server = undefined;
  });

  it('resolves immediately once an event arrives, without waiting out the hold', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    // Start the poll before there's anything to deliver, then confirm the
    // server has actually registered this device as long-polling (so
    // dispatch() below is targeting a "connected" device) before triggering
    // the event — avoids racing the HTTP request's own arrival.
    const pollPromise = fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await waitUntil(() => byok.machines.list().some((m) => m.deviceId === deviceId && m.connected));

    const triggeredAt = Date.now();
    const handle = await byok.dispatch({ instruction: 'x', deviceId });
    const pollRes = await pollPromise;
    const elapsedMs = Date.now() - triggeredAt;

    expect(pollRes.status).toBe(200);
    const body = (await pollRes.json()) as { events: Envelope[]; cursor: number };
    expect(body.events.map((e) => e.type)).toEqual(['task.offer']);
    expect(body.events[0]?.task_id).toBe(handle.taskId);
    expect(elapsedMs).toBeLessThan(SHORT_HOLD_MS);
  });

  it('returns an empty events array once the hold elapses with nothing pending', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const startedAt = Date.now();
    const pollRes = await fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(pollRes.status).toBe(200);
    const body = (await pollRes.json()) as { events: Envelope[]; cursor: number };
    expect(body.events).toEqual([]);
    expect(typeof body.cursor).toBe('number');
    expect(elapsedMs).toBeGreaterThanOrEqual(SHORT_HOLD_MS - 20); // actually held for ~the configured duration, not an immediate return
  });

  it('a long-poll supersedes an existing WS connection for the same device (last one wins, §8)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });

    const wsClosed = new Promise<{ code: number }>((resolve) => {
      daemon.ws.once('close', (closeCode) => resolve({ code: closeCode }));
    });

    const pollPromise = fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${daemon.accessToken}` },
    });

    const { code: closeCode } = await wsClosed;
    expect(closeCode).toBe(1000);

    const pollRes = await pollPromise;
    expect(pollRes.status).toBe(200); // still answered normally even though it superseded a live WS
  });

  it('reconnecting via WS resolves a pending long-poll immediately (last one wins, §8)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 10_000 }); // deliberately long — proves WS reconnect wins the race, not the hold timing out
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const pollPromise = fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await waitUntil(() => byok.machines.list().some((m) => m.deviceId === deviceId && m.connected));

    let ws: WebSocket | undefined;
    try {
      const startedAt = Date.now();
      // Reconnect as the SAME already-paired device — the pairing code was
      // single-use and was already redeemed above.
      const { ws: reconnected } = await connectFakeDaemonWs(started.port, {
        deviceId,
        accessToken,
        productId: PRODUCT_ID,
      });
      ws = reconnected;

      const pollRes = await pollPromise;
      const elapsedMs = Date.now() - startedAt;

      expect(pollRes.status).toBe(200);
      expect(elapsedMs).toBeLessThan(10_000); // resolved on takeover, not the (long) hold timeout
    } finally {
      ws?.terminate();
    }
  });

  it('rejects an unauthenticated poll', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(byok);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/byok/events?cursor=0`);
    expect(res.status).toBe(401);
  });
});

/**
 * Finding F6: `POST /byok/messages` is the daemon's outbound send path while
 * long-polling — a device has no live WS to carry `task.claim`/`progress`/
 * etc in that mode. Each accepted envelope must be routed through the exact
 * same inbound handling (`hub.handleEnvelope`) a WS connection's messages
 * get, not some parallel/lesser path.
 */
describe('POST /byok/messages (§8, finding F6)', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server) await stopServer(server);
    server = undefined;
  });

  it('routes a batched task.claim through the same inbound path as WS, advancing real task state', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    // A device only counts as "connected" (and thus dispatchable) once it
    // has actually shown up over one of the two transports — simulate the
    // long-poll equivalent of that with the same fire-and-forget-poll +
    // waitUntil pattern the sibling GET /byok/events tests above use (not
    // awaited directly: with nothing yet to deliver, it would otherwise
    // hang for the full hold duration).
    void fetch(`${started.baseUrl}/byok/events?cursor=0`, { headers: { authorization: `Bearer ${accessToken}` } });
    await waitUntil(() => byok.machines.list().some((m) => m.deviceId === deviceId && m.connected));

    const handle = await byok.dispatch({ instruction: 'x', deviceId });
    const claim = createEnvelope('task.claim', { deviceId }, { taskId: handle.taskId });

    const res = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messages: [claim] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Claimed');
  });

  it('rejects an unauthenticated send', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body (messages not an array of envelopes)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const res = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messages: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
  });
});
