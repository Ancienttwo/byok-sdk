import type { Server as HttpServer } from 'node:http';
import { createEnvelope, PROTOCOL_VERSION } from '@byok/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createByokServer } from '../index';
import type { ServerTaskEvent, TaskHandle } from '../types';
import {
  connectFakeDaemon,
  connectFakeDaemonWs,
  nextEnvelope,
  pairFakeDaemon,
  send,
  startServer,
  stopServer,
  waitForTaskEvent,
} from './test-support';

const PRODUCT_ID = 'acme';

/** Claim + start a dispatched task over `ws` (Offered -> Claimed -> Running) and wait for the Running event. */
async function claimAndStart(ws: WebSocket, deviceId: string, handle: TaskHandle): Promise<void> {
  send(ws, createEnvelope('task.claim', { deviceId }, { taskId: handle.taskId }));
  send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
}

describe('server integration (in-process http+ws, fake daemon client)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('pair -> hello/ack -> dispatch -> offer -> claim -> progress -> complete', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    expect(byok.machines.list()).toEqual([
      expect.objectContaining({ deviceId: daemon.deviceId, deviceName: 'test-laptop', connected: true }),
    ]);

    const handle = await byok.dispatch({ instruction: 'say hello' });
    expect(handle.taskId).toBeTruthy();
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Offered');

    const offerEnvelope = await nextEnvelope(ws);
    expect(offerEnvelope.type).toBe('task.offer');
    if (offerEnvelope.type !== 'task.offer') throw new Error('unreachable');
    // M1 gap #7: taskId is no longer duplicated in the payload — the envelope's `task_id` is the sole routing key.
    expect(offerEnvelope.task_id).toBe(handle.taskId);
    expect(offerEnvelope.seq).toBe(2); // seq 1 was conn.ack; per-device seq is a shared counter across all server->daemon types (§1.2)
    expect(offerEnvelope.payload.instruction).toBe('say hello');
    expect(offerEnvelope.payload.policy).toEqual({ mode: 'confirm' }); // M0 fail-closed default

    send(
      ws,
      createEnvelope(
        'task.claim',
        { deviceId: daemon.deviceId },
        { taskId: handle.taskId },
      ),
    );
    // M1 gap #2: claim no longer implies Running — the daemon reports that
    // explicitly via task.started once its runtime session actually starts.
    send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    send(
      ws,
      createEnvelope(
        'task.progress',
        {
          seq: 1,
          events: [
            { type: 'progress', text: 'thinking...' },
            { type: 'turn_end' },
          ],
        },
        { taskId: handle.taskId },
      ),
    );
    send(
      ws,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_1' }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_1' });
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Complete');

    // events() replays from the start even though we're draining it *after*
    // the task already finished — the whole point of AsyncEventQueue.
    const events: ServerTaskEvent[] = [];
    for await (const event of handle.events()) events.push(event);

    expect(events.map((e) => e.kind)).toEqual(['state', 'state', 'state', 'agent', 'agent', 'state']);
    expect(events.map((e) => (e.kind === 'state' ? e.state : null))).toEqual([
      'Offered',
      'Claimed',
      'Running',
      null,
      null,
      'Complete',
    ]);
    expect(events.filter((e) => e.kind === 'agent').map((e) => (e.kind === 'agent' ? e.event.type : null))).toEqual([
      'progress',
      'turn_end',
    ]);
  });

  it('task.claim is an idempotent CAS: a retried claim from the same device is a no-op', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'say hello' });
    await nextEnvelope(ws); // task.offer

    const claimEnvelope = createEnvelope(
      'task.claim',
      { deviceId: daemon.deviceId },
      { taskId: handle.taskId },
    );
    const startedEnvelope = createEnvelope('task.started', {}, { taskId: handle.taskId });
    send(ws, claimEnvelope);
    send(ws, startedEnvelope);
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    // Retry the exact same claim (e.g. the daemon didn't observe the first
    // one land) — must not be treated as an illegal Running -> Claimed move.
    send(ws, claimEnvelope);
    // Same for a retried task.started (§3.1): a repeat from the owning
    // device while already Running is a no-op, not an illegal transition.
    send(ws, startedEnvelope);
    send(ws, createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_3' }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_3' });

    const events: ServerTaskEvent[] = [];
    for await (const event of handle.events()) events.push(event);
    // Offered, Claimed, Running, Complete — the retried claim produced no
    // extra (or Failed) state events.
    expect(events.map((e) => (e.kind === 'state' ? e.state : null))).toEqual([
      'Offered',
      'Claimed',
      'Running',
      'Complete',
    ]);
  });

  it('cancel path: cancel() is authoritative immediately and notifies the daemon', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'a long task' });
    const offer = await nextEnvelope(ws);
    expect(offer.type).toBe('task.offer');

    await handle.cancel('changed my mind');

    const cancelEnvelope = await nextEnvelope(ws);
    expect(cancelEnvelope.type).toBe('task.cancel');
    if (cancelEnvelope.type !== 'task.cancel') throw new Error('unreachable');
    expect(cancelEnvelope.payload.reason).toBe('changed my mind');

    const result = await handle.result();
    expect(result).toEqual({ state: 'Cancelled', reason: 'changed my mind' });
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Cancelled');

    // cancel() is idempotent: calling it again on a terminal task is a no-op, not a throw.
    await expect(handle.cancel('again')).resolves.toBeUndefined();
  });

  it('await_approval -> approve path resumes the task to Running', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'do something risky' });
    await nextEnvelope(ws); // task.offer

    send(
      ws,
      createEnvelope(
        'task.claim',
        { deviceId: daemon.deviceId },
        { taskId: handle.taskId },
      ),
    );
    send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    send(
      ws,
      createEnvelope('task.await_approval', { summary: 'about to rm -rf /tmp/scratch' }, { taskId: handle.taskId }),
    );

    // Synchronize on the server having actually processed await_approval
    // (event delivery is async over the real loopback socket) instead of a
    // fixed sleep.
    await waitForTaskEvent(handle, (e) => e.kind === 'await_approval');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval');

    await handle.approve();

    const approveEnvelope = await nextEnvelope(ws);
    expect(approveEnvelope.type).toBe('task.approve');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');

    send(ws, createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_2' }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_2' });
  });

  it('rejects the WS upgrade with a bad bearer token', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const badWs = new WebSocket(`ws://127.0.0.1:${started.port}/byok/ws`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    ws = badWs;

    const closeOrError = await new Promise<'error' | number>((resolve) => {
      badWs.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      badWs.once('error', () => resolve('error'));
    });
    expect(closeOrError === 401 || closeOrError === 'error').toBe(true);
  });

  it('device disconnect mid-task does not fail it — task state survives for redelivery on reconnect (M1, §9)', async () => {
    // M0 force-failed every in-flight task the instant its device
    // disconnected ("can't be resumed, so it's terminated" — true only
    // absent a redelivery cursor). M1 adds exactly that cursor, so a
    // disconnect must no longer be treated as fatal to the task: it stays
    // in-flight, and — as this test also verifies — can still complete
    // normally once the device reconnects.
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'never finishes' });
    await nextEnvelope(ws); // task.offer
    await claimAndStart(ws, daemon.deviceId, handle);

    const disconnected = (async () => {
      for await (const event of byok.events.subscribe()) {
        if (event.kind === 'device.disconnected' && event.deviceId === daemon.deviceId) return event;
      }
      throw new Error('server event stream ended before device.disconnected');
    })();
    ws.terminate();
    ws = undefined;
    await disconnected; // proves handleDisconnect has actually run before we assert on task state below

    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
    expect(byok.machines.list()).toEqual([expect.objectContaining({ deviceId: daemon.deviceId, connected: false })]);

    // Reconnect as the same device and finish the task normally — proving
    // it genuinely survived the disconnect, not merely "hasn't been
    // GC'd yet".
    const { ws: ws2 } = await connectFakeDaemonWs(started.port, {
      deviceId: daemon.deviceId,
      accessToken: daemon.accessToken,
      productId: PRODUCT_ID,
      cursor: 2, // conn.ack(1) + task.offer(2) — everything this daemon had already seen pre-drop
    });
    ws = ws2;
    send(
      ws2,
      createEnvelope(
        'task.complete',
        { summary: 'done after reconnect', sessionRef: 'sess_reconnect' },
        { taskId: handle.taskId },
      ),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done after reconnect', sessionRef: 'sess_reconnect' });
  });
});

describe('WS handshake rejection gates close with code 1002 (M0 gatekeeper finding #1)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  /** Open an authenticated WS connection but don't send `conn.hello` yet — the caller sends a deliberately-bad one. */
  async function openAuthedSocket(port: number, accessToken: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return socket;
  }

  function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  it('closes with 1002 when conn.hello advertises an unsupported protocol version', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    ws = await openAuthedSocket(started.port, accessToken);
    const closed = waitForClose(ws);
    send(
      ws,
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION + 999],
        capabilities: [],
        deviceId,
        productId: PRODUCT_ID,
      }),
    );

    const { code: closeCode, reason } = await closed;
    expect(closeCode).toBe(1002);
    expect(reason).toMatch(/protocol version/i);
  });

  it('closes with 1002 when conn.hello productId does not match the server', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code);

    ws = await openAuthedSocket(started.port, accessToken);
    const closed = waitForClose(ws);
    send(
      ws,
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: [],
        deviceId,
        productId: 'some-other-product',
      }),
    );

    const { code: closeCode, reason } = await closed;
    expect(closeCode).toBe(1002);
    expect(reason).toMatch(/productId/i);
  });

  it('closes with 1002 when conn.hello deviceId does not match the authenticated token identity', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    ws = await openAuthedSocket(started.port, accessToken);
    const closed = waitForClose(ws);
    send(
      ws,
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: [],
        deviceId: 'dev_someone-else-entirely',
        productId: PRODUCT_ID,
      }),
    );

    const { code: closeCode, reason } = await closed;
    expect(closeCode).toBe(1002);
    expect(reason).toMatch(/deviceId/i);
  });
});

describe('redelivery after reconnect (§9)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('redelivers non-terminal envelopes in seq order, honoring the cursor, skips envelopes for terminal tasks except exempted cancel/reject (N1/F4)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    // task1 stays Running — steer() below produces an envelope the daemon
    // never reads off this connection before it "drops".
    const handle1 = await byok.dispatch({ instruction: 'long running task' });
    const offer1 = await nextEnvelope(ws);
    if (offer1.type !== 'task.offer') throw new Error('unreachable');
    const cursor = offer1.seq; // "I've fully processed everything through this seq"

    await claimAndStart(ws, daemon.deviceId, handle1);
    await handle1.steer('keep going'); // assigns the next seq; deliberately never read off `ws`

    // task2 is cancelled before reconnect — terminal by the time redelivery
    // runs. Its task.offer is NOT exempt from the terminal-task filter and
    // must not be redelivered; its task.cancel IS exempt (N1/F4 — see
    // OutboxEntry.redeliverThroughTerminal/collectRelevant) precisely
    // because cancelTask moves the task to Cancelled *before* queuing that
    // notification, so without the exemption a dropped cancel send could
    // never be redelivered.
    const handle2 = await byok.dispatch({ instruction: 'short task' });
    await handle2.cancel('not needed after all');
    await handle2.result();
    expect(byok.tasks.get(handle2.taskId)?.state).toBe('Cancelled');

    // Simulate a dropped connection: terminate without reading anything past offer1.
    ws.terminate();

    // Reconnect as the SAME device, telling the server we've only seen through `cursor`.
    const { ws: ws2 } = await connectFakeDaemonWs(started.port, {
      deviceId: daemon.deviceId,
      accessToken: daemon.accessToken,
      productId: PRODUCT_ID,
      cursor,
    });
    ws = ws2;

    const redelivered = await nextEnvelope(ws2);
    expect(redelivered.type).toBe('task.steer');
    expect(redelivered.task_id).toBe(handle1.taskId);
    if (redelivered.type !== 'task.steer') throw new Error('unreachable');
    expect(redelivered.payload.text).toBe('keep going');

    // task2's task.cancel follows — exempted from the terminal-task filter
    // even though task2 is Cancelled by now.
    const redelivered2 = await nextEnvelope(ws2);
    expect(redelivered2.type).toBe('task.cancel');
    expect(redelivered2.task_id).toBe(handle2.taskId);

    // Nothing else should follow: task2's task.offer is not exempt and must
    // not reappear.
    const raced = await Promise.race([
      nextEnvelope(ws2).then(() => 'more' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);
    expect(raced).toBe('timeout');
  });
});

describe('task lifecycle: task.started / task.decline / task.cancelled + idempotency (§3, §9)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('task.decline moves Offered -> Failed (pre-claim fail-closed rejection, §3.2)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'unsupported instruction shape' });
    await nextEnvelope(ws); // offer

    send(
      ws,
      createEnvelope('task.decline', { reason: 'no compatible runtime', retryable: true }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Failed', reason: 'no compatible runtime', retryable: true });
  });

  it('a task.decline arriving after the task was already claimed is a stale no-op', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'x' });
    await nextEnvelope(ws);
    await claimAndStart(ws, daemon.deviceId, handle);

    // A decline is only ever legal pre-claim; this one arrives late (e.g. a
    // race) and must not clobber the already-Running task.
    send(ws, createEnvelope('task.decline', { reason: 'too late' }, { taskId: handle.taskId }));
    send(
      ws,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_decline_race' }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_decline_race' });
  });

  it('task.started arriving before any claim forces the task to Failed (Offered -> Running is illegal)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'x' });
    await nextEnvelope(ws); // offer

    send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result.state).toBe('Failed');
  });

  it('task.cancelled is the authoritative trigger when the daemon observes a cancellation the server did not initiate', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'x' });
    await nextEnvelope(ws);
    await claimAndStart(ws, daemon.deviceId, handle);

    // No handle.cancel() call — the daemon decided locally (e.g. a local
    // stop action in the branded CLI's UI) and reports it directly.
    send(ws, createEnvelope('task.cancelled', { reason: 'user stopped it locally' }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Cancelled', reason: 'user stopped it locally' });
  });

  it('task.cancelled after a server-initiated cancel is a silent idempotent ack, not a warning (M0 gatekeeper finding)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle1 = await byok.dispatch({ instruction: 'task one' });
    await nextEnvelope(ws);
    await claimAndStart(ws, daemon.deviceId, handle1);
    await handle1.cancel('server decided');
    await nextEnvelope(ws); // task.cancel best-effort notification
    expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled');

    // A second, independent Running task used only as an ordering marker on
    // the same WS connection — frames on one socket are handled in receipt
    // order, so awaiting ITS effect proves the stale message below already
    // ran, without an arbitrary sleep.
    const handle2 = await byok.dispatch({ instruction: 'task two' });
    await nextEnvelope(ws);
    await claimAndStart(ws, daemon.deviceId, handle2);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send(ws, createEnvelope('task.cancelled', { reason: 'stopped locally' }, { taskId: handle1.taskId }));
    send(
      ws,
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'marker' }] },
        { taskId: handle2.taskId },
      ),
    );
    await waitForTaskEvent(handle2, (e) => e.kind === 'agent');

    expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled'); // unchanged, not re-applied
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('task.fail after a server-initiated cancel is also a silent stale drop, not a warning (§9)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle1 = await byok.dispatch({ instruction: 'task one' });
    await nextEnvelope(ws);
    await claimAndStart(ws, daemon.deviceId, handle1);
    await handle1.cancel('server decided');
    await nextEnvelope(ws);
    expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled');

    const handle2 = await byok.dispatch({ instruction: 'task two' });
    await nextEnvelope(ws);
    await claimAndStart(ws, daemon.deviceId, handle2);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Races a server-initiated cancel that already landed — a stale
    // task.fail must not resurrect/overwrite the Cancelled outcome.
    send(ws, createEnvelope('task.fail', { reason: 'crashed', retryable: false }, { taskId: handle1.taskId }));
    send(
      ws,
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'marker' }] },
        { taskId: handle2.taskId },
      ),
    );
    await waitForTaskEvent(handle2, (e) => e.kind === 'agent');

    expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
