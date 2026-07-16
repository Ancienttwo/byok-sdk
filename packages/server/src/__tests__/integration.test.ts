import type { Server as HttpServer } from 'node:http';
import { createEnvelope } from '@byok/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createByokServer } from '../index';
import type { ServerTaskEvent } from '../types';
import { connectFakeDaemon, nextEnvelope, send, startServer, stopServer, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';

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
    expect(offerEnvelope.payload.taskId).toBe(handle.taskId);
    expect(offerEnvelope.payload.instruction).toBe('say hello');
    expect(offerEnvelope.payload.policy).toEqual({ mode: 'confirm' }); // M0 fail-closed default

    send(
      ws,
      createEnvelope(
        'task.claim',
        { taskId: handle.taskId, deviceId: daemon.deviceId },
        { taskId: handle.taskId },
      ),
    );
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
      { taskId: handle.taskId, deviceId: daemon.deviceId },
      { taskId: handle.taskId },
    );
    send(ws, claimEnvelope);
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    // Retry the exact same claim (e.g. the daemon didn't observe the first
    // one land) — must not be treated as an illegal Running -> Claimed move.
    send(ws, claimEnvelope);
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
        { taskId: handle.taskId, deviceId: daemon.deviceId },
        { taskId: handle.taskId },
      ),
    );
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

  it('device disconnect mid-task fails the task as retryable', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;

    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'never finishes' });
    await nextEnvelope(ws); // task.offer

    send(
      ws,
      createEnvelope(
        'task.claim',
        { taskId: handle.taskId, deviceId: daemon.deviceId },
        { taskId: handle.taskId },
      ),
    );
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    ws.terminate();
    ws = undefined;

    const result = await handle.result();
    expect(result).toEqual({ state: 'Failed', reason: 'device disconnected', retryable: true });
  });
});
