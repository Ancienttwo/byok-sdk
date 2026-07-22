import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { connectFakeDaemon, send, startServer, stopServer, waitForServerEvent, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';

/**
 * M5 (claimed runtime, docs/protocol.md §3.1): `task.claim` now optionally
 * carries `runtime` — the ACTUAL adapter the daemon selected — distinct from
 * `TaskSnapshot.runtime` (the merely REQUESTED runtime, set once at
 * `dispatch()` time and never touched again). These tests exercise
 * `ConnectionHub.onClaim` (`hub.ts`) directly over the real WS/HTTP harness,
 * mirroring `hub-approve-reject.test.ts`'s own conventions.
 */
describe('M5 (claimed runtime): task.claim.runtime -> TaskSnapshot.claimedRuntime', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('an offer dispatched with NO requested runtime (auto-select): task.claim.runtime sets claimedRuntime, while the requested runtime field stays undefined (untouched, never requested)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'auto-select this' });
    expect(byok.tasks.get(handle.taskId)?.runtime).toBeUndefined();

    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime: 'pi' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    const snapshot = byok.tasks.get(handle.taskId);
    expect(snapshot?.claimedRuntime).toBe('pi');
    expect(snapshot?.runtime).toBeUndefined(); // requested field untouched — nothing was ever requested
  });

  it('an offer dispatched WITH a requested runtime: task.claim.runtime is recorded independently as claimedRuntime, leaving the requested runtime field exactly as it was', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'explicit runtime', runtime: 'claude' });
    expect(byok.tasks.get(handle.taskId)?.runtime).toBe('claude');

    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime: 'claude' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    const snapshot = byok.tasks.get(handle.taskId);
    expect(snapshot?.runtime).toBe('claude'); // requested field: unchanged
    expect(snapshot?.claimedRuntime).toBe('claude'); // claimed field: independently recorded
  });

  it('compat: a legacy daemon\'s task.claim with NO runtime field leaves claimedRuntime absent and the claim still succeeds normally', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'legacy daemon claim' });

    // A pre-M5-batch-2 daemon's task.claim payload never had a `runtime` key.
    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    const snapshot = byok.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Claimed'); // nothing breaks
    expect(snapshot?.claimedRuntime).toBeUndefined();
  });

  it('the task.state ByokServerEvent fired on Offered -> Claimed carries claimedRuntime, mirroring the snapshot', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'observe the server event' });
    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime: 'codex' }, { taskId: handle.taskId }));

    const event = await waitForServerEvent(
      byok,
      (e) => e.kind === 'task.state' && e.taskId === handle.taskId && e.state === 'Claimed',
    );
    if (event.kind !== 'task.state') throw new Error('unreachable');
    expect(event.claimedRuntime).toBe('codex');
  });
});
