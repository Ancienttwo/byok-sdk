import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import {
  claimAndStart,
  connectFakeDaemon,
  moveToAwaitApproval,
  send,
  startServer,
  stopServer,
  waitForServerEvent,
  waitForTaskEvent,
} from './test-support';

const PRODUCT_ID = 'acme';

/**
 * M4 Phase 3 hardening (orchestrator-directed fix for the server-state-
 * machine trace finding — see `hub.ts`'s `resumeIfImplicitlyApproved` doc
 * comment for the full design rationale): a task the daemon resolved
 * entirely LOCALLY (M4 Phase 3's `approvals.resolve` control-socket path,
 * `packages/client`) never sends a wire `task.approve`/`task.reject`, so the
 * server's own record is still `AwaitApproval` when the daemon's next
 * `task.progress`/`task.artifact`/`task.complete` arrives. Before this fix
 * that traffic was force-failed or dropped (an illegal `AwaitApproval ->
 * Running`/`Complete` transition); now it implicitly resumes the task
 * (`AwaitApproval -> Running`, already a legal `TASK_TRANSITIONS` edge) and
 * processes the message normally, exactly as if a real wire `task.approve`
 * had arrived first.
 */
describe('M4 Phase 3: implicit approval resume (daemon traffic while server still thinks AwaitApproval)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('(a) task.progress arriving while AwaitApproval implicitly resumes to Running, applies the progress, and emits task.approval_resolved_implicit — NOT force-failed', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle);

    send(
      ws,
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'still working' }] },
        { taskId: handle.taskId },
      ),
    );

    const implicitEvent = await waitForServerEvent(
      byok,
      (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId,
    );
    expect(implicitEvent).toBeDefined();

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    const agentEvent = await waitForTaskEvent(handle, (e) => e.kind === 'agent');
    expect(agentEvent).toMatchObject({ kind: 'agent', event: { type: 'progress', text: 'still working' } });

    // The whole point: this must be Running, never Failed.
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
  });

  it('(b) task.complete arriving directly while AwaitApproval implicitly resumes to Running THEN completes normally — NOT force-failed', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle);

    send(
      ws,
      createEnvelope('task.complete', { summary: 'done after local approval', sessionRef: 'sess-1' }, { taskId: handle.taskId }),
    );

    await waitForServerEvent(byok, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId);
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Complete');

    const snapshot = byok.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Complete');
    expect(snapshot?.result?.state === 'Complete' ? snapshot.result.summary : undefined).toBe('done after local approval');
    expect(snapshot?.result?.state === 'Complete' ? snapshot.result.sessionRef : undefined).toBe('sess-1');
  });

  it('(c) a second task.await_approval after an implicit resume transitions cleanly back to AwaitApproval (Running -> AwaitApproval is legal)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs two human oks' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle, 'first approval needed');

    // Implicit resume, as (a) proves in isolation — synchronize on the
    // implicit-resolve SERVER event (unique to this one resume), not a bare
    // "state === Running" task-event predicate: this task already passed
    // through Running once already (claimAndStart's own Claimed -> Running),
    // and waitForTaskEvent always replays from the start of the task's whole
    // history, so re-waiting on the same predicate would just re-match that
    // EARLIER event instead of waiting for this one.
    send(ws, createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: handle.taskId }));
    await waitForServerEvent(byok, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId);
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');

    // A genuinely NEW await_approval for the same task, after the implicit
    // resume, must still work cleanly — this is the existing onAwaitApproval
    // logic, untouched: Running -> AwaitApproval was already a legal edge.
    send(ws, createEnvelope('task.await_approval', { summary: 'second approval needed' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second approval needed');

    expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval');
  });

  it('(d) existing behavior preserved: task.progress on an already-terminal task is still silently dropped (console.warn), not force-failed and not implicitly resumed', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle1 = await byok.dispatch({ instruction: 'task one' });
    await claimAndStart(ws, daemon.deviceId, handle1);
    await handle1.cancel('server decided');
    expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled');

    // A second, independent Running task used only as an ordering marker on
    // the same WS connection (mirrors integration.test.ts's own precedent for
    // this exact class of "prove a stale message was already processed
    // without an arbitrary sleep" problem): frames on one socket are handled
    // in receipt order, so awaiting ITS effect proves the stale message
    // below already ran.
    const handle2 = await byok.dispatch({ instruction: 'task two' });
    await claimAndStart(ws, daemon.deviceId, handle2);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send(ws, createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: handle1.taskId }));
    send(
      ws,
      createEnvelope('task.progress', { seq: 1, events: [{ type: 'progress', text: 'marker' }] }, { taskId: handle2.taskId }),
    );
    await waitForTaskEvent(handle2, (e) => e.kind === 'agent');

    expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled'); // unchanged, not resumed/re-failed
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('task.progress received while not Running'));
    warnSpy.mockRestore();
  });
});
