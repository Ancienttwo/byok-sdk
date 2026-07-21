import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { DeviceRegistry } from '../auth';
import { createByokServer } from '../index';
import { ConnectionHub, TaskNotAwaitingApprovalError, UnknownTaskError } from '../hub';
import { InMemoryTaskStore } from '../task-store';
import { claimAndStart, connectFakeDaemon, moveToAwaitApproval, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';

/**
 * M4 Phase 3 (revised per orchestrator decision): `ConnectionHub.approveTask`/
 * `rejectTask` (hub.ts) are the supported entry point — made public so an
 * embedder's own in-process code (a `TaskHandle`, or a hand-built operator
 * surface like `examples/basic/server.ts`'s `/api/tasks/:taskId/approve`)
 * can call them directly. There is deliberately NO bearer-authed HTTP route
 * for this on the SDK's own `http.ts` (see that file's own note on why).
 * These tests replace the earlier HTTP-route-level tests with direct
 * Hub/TaskHandle-level coverage of the same scenarios (happy path for both
 * verbs, unknown taskId, wrong state) plus the typed error classes.
 */
describe('M4 Phase 3: ConnectionHub.approveTask/rejectTask (public API + typed errors)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('approveTask on a task currently AwaitApproval moves it to Running and notifies the daemon over the wire', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle);

    await handle.approve();
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
  });

  it('rejectTask (with a reason) on a task currently AwaitApproval moves it to Failed with that reason', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle);

    await handle.reject('looked risky');
    const snapshot = byok.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Failed');
    expect(snapshot?.result?.state === 'Failed' ? snapshot.result.reason : undefined).toBe('looked risky');
  });

  it('approveTask on an unknown taskId throws UnknownTaskError (404-equivalent)', async () => {
    const hub = new ConnectionHub(new InMemoryTaskStore(), new DeviceRegistry(), 30 * 60_000);
    await expect(hub.approveTask('no-such-task')).rejects.toBeInstanceOf(UnknownTaskError);
    await expect(hub.approveTask('no-such-task')).rejects.toThrow(/unknown taskId/);
  });

  it('rejectTask on an unknown taskId throws UnknownTaskError (404-equivalent)', async () => {
    const hub = new ConnectionHub(new InMemoryTaskStore(), new DeviceRegistry(), 30 * 60_000);
    await expect(hub.rejectTask('no-such-task')).rejects.toBeInstanceOf(UnknownTaskError);
  });

  it('approveTask on a task NOT currently AwaitApproval (e.g. still Running) throws TaskNotAwaitingApprovalError (409-equivalent), leaving state unchanged', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'still running' });
    await claimAndStart(ws, daemon.deviceId, handle);

    await expect(handle.approve()).rejects.toBeInstanceOf(TaskNotAwaitingApprovalError);
    await expect(handle.approve()).rejects.toThrow(/not awaiting approval/);
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running'); // unchanged
  });

  it('rejectTask on a task not currently AwaitApproval throws TaskNotAwaitingApprovalError (409-equivalent)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'still running' });
    await claimAndStart(ws, daemon.deviceId, handle);

    await expect(handle.reject('too late')).rejects.toBeInstanceOf(TaskNotAwaitingApprovalError);
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running'); // unchanged
  });

  it('TaskNotAwaitingApprovalError carries taskId/state fields, and UnknownTaskError carries taskId, for programmatic handling', async () => {
    const hub = new ConnectionHub(new InMemoryTaskStore(), new DeviceRegistry(), 30 * 60_000);
    try {
      await hub.approveTask('missing-1');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownTaskError);
      expect((err as UnknownTaskError).taskId).toBe('missing-1');
    }
  });
});
