import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import {
  announceHello,
  connectFakeDaemonLongPoll,
  pairFakeDaemon,
  startServer,
  stopServer,
  testPairingClaims,
  waitForTaskEvent,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so the empty-timeout case doesn't take the real ~50s default. */
const SHORT_HOLD_MS = 150;

/** Poll a public read until it holds, or fail loudly. Never a completion signal for a state change the test itself caused. */
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('long-poll transport (§8)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  it('resolves immediately once an event arrives, without waiting out the hold', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const { code } = await instance.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);
    // Every v4 offer is an Agent offer, admitted only to a device whose
    // durable capabilities include agent-home-contract.
    const hello = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messages: [createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION], capabilities: ['agent-home-contract'], deviceId, productId: PRODUCT_ID,
      })] }),
    });
    expect(hello.status).toBe(200);

    // Start the poll before dispatch to exercise immediate delivery into a
    // held read. Its TTL observation is the synchronization barrier only;
    // dispatch does not gate on that observation.
    const pollPromise = fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await waitUntil(async () => (await instance.machines.list()).some((m) => m.deviceId === deviceId && m.connected));

    const triggeredAt = Date.now();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, instruction: 'x', deviceId });
    const pollRes = await pollPromise;
    const elapsedMs = Date.now() - triggeredAt;

    expect(pollRes.status).toBe(200);
    const body = (await pollRes.json()) as { events: Envelope[]; cursor: number; capabilities?: string[] };
    expect(body.events.map((e) => e.type)).toEqual(['task.offer']);
    expect(body.events[0]?.task_id).toBe(handle.taskId);
    expect(body.capabilities).toContain('mailbox-read-ahead');
    // Wire v3 folded the former `result-document` flag into the baseline.
    expect(body.capabilities).not.toContain('result-document');
    expect(elapsedMs).toBeLessThan(SHORT_HOLD_MS);
  });

  it('returns an empty events array once the hold elapses with nothing pending', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const { code } = await instance.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
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

  it('rejects an unauthenticated poll', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/byok/events?cursor=0`);
    expect(res.status).toBe(401);
  });
});

/**
 * Finding F6: `POST /byok/messages` is the daemon's outbound send path — a
 * device has no other way to carry `task.claim`/`progress`/etc. Each accepted
 * envelope must be routed through the cloud kernel's one inbound gate.
 */
describe('POST /byok/messages (§8, finding F6)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  it('routes a batched task.claim through the inbound gate, advancing real task state', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, {
      productId: PRODUCT_ID,
      announce: false,
    });

    // A device has an observed presence lease once it has
    // actually shown up — with no `conn.hello` published, a poll is the only
    // signal, so drive one (not awaited directly: with nothing yet to deliver
    // it would otherwise hold for the full hold duration).
    // Swallowed deliberately: this poll is a presence signal, not a read —
    // the fixture tears the server down underneath it at the end of the test.
    void daemon.next().catch(() => undefined);
    await waitUntil(async () =>
      (await instance.machines.list()).some((m) => m.deviceId === daemon.deviceId && m.connected),
    );

    // The Agent offer needs the durable agent-home-contract capability, which
    // only a conn.hello records.
    await announceHello(daemon, { productId: PRODUCT_ID });
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, instruction: 'x', deviceId: daemon.deviceId });
    const res = await daemon.send(createEnvelope('task.claim', { agentRef: TEST_AGENT_REF, deviceId: daemon.deviceId }, { taskId: handle.taskId }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1 });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Claimed');
  });

  it('rejects an unauthenticated send', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body (messages not an array of envelopes)', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const { code } = await instance.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const res = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messages: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
  });
});
