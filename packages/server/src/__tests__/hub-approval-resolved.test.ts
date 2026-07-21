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
 * M4 (additive-minor): the EXPLICIT wire `task.approval_resolved` handler
 * (`ConnectionHub.onApprovalResolved`, `hub.ts`) — the daemon reporting a
 * LOCALLY-resolved approval immediately, instead of the server only
 * inferring it after the fact once evidence arrives (that pre-existing
 * inference path, `resumeIfImplicitlyApproved`, is exercised by this file's
 * sibling `hub-implicit-approval-resume.test.ts` and is untouched by this
 * addition — see both handlers' own doc comments in `hub.ts` for the full
 * relationship between them).
 */
describe('M4 (additive-minor): explicit task.approval_resolved handling', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('advertises the approval_resolved capability flag in the handshake conn.ack', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    expect(daemon.ack.capabilities).toContain('approval_resolved');
  });

  it('AwaitApproval -> Running on task.approval_resolved, and emits a task.approval_resolved embedder event carrying approvalId/decision/resolvedBy', async () => {
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
        'task.approval_resolved',
        { approvalId: 'appr-1', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );

    const event = await waitForServerEvent(byok, (e) => e.kind === 'task.approval_resolved' && e.taskId === handle.taskId);
    if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
    expect(event.approvalId).toBe('appr-1');
    expect(event.decision).toBe('approve');
    expect(event.resolvedBy).toBe('local');

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');

    // The pre-existing implicit-inference path must NOT ALSO have fired for
    // this same resolution — the explicit message already moved the record
    // out of AwaitApproval, so resumeIfImplicitlyApproved's own guard is
    // already true by the time anything else could invoke it.
    const implicitFired = await Promise.race([
      waitForServerEvent(byok, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId).then(
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(implicitFired).toBe(false);
  });

  it('AwaitApproval -> Running on task.approval_resolved with decision: reject moves the task through Running (approval flow only decides resume vs stop the runtime side; the wire decision itself does not change server state here)', async () => {
    // Note: unlike task.reject (server -> daemon, which the SERVER's own
    // rejectTask() moves to Failed authoritatively), task.approval_resolved
    // is daemon -> server REPORTING a decision the daemon already acted on
    // locally. A local reject means the daemon already stopped the runtime
    // and will report task.fail itself — the server's own job here is only
    // to stop treating the task as AwaitApproval, which is the same
    // AwaitApproval -> Running transition every case uses (mirroring
    // resumeIfImplicitlyApproved's own unconditional transition-to-Running
    // regardless of what the daemon goes on to report next).
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
        'task.approval_resolved',
        { approvalId: 'appr-2', decision: 'reject', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );

    const event = await waitForServerEvent(byok, (e) => e.kind === 'task.approval_resolved' && e.taskId === handle.taskId);
    if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
    expect(event.decision).toBe('reject');

    // The daemon follows up with task.fail (as it would after a local
    // reject) — proving the record was left in a state that legally accepts it.
    send(ws, createEnvelope('task.fail', { reason: 'rejected locally' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Failed');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Failed');
  });

  it('idempotent no-op when the record is already Running (evidence — or the implicit path — already beat the message to it)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle);

    // The implicit path resumes it first (task.progress arriving while AwaitApproval).
    send(ws, createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: handle.taskId }));
    await waitForServerEvent(byok, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId);
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');

    // A second, independent task used only as an ordering marker (mirrors
    // hub-implicit-approval-resume.test.ts's own convention for proving a
    // message was already processed without an arbitrary sleep).
    const marker = await byok.dispatch({ instruction: 'marker task' });
    await claimAndStart(ws, daemon.deviceId, marker);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The explicit message now arrives late (a redelivered/racing report for
    // the SAME approval the implicit path already resolved) — must be a
    // silent idempotent no-op, not a warning and not a second event.
    send(
      ws,
      createEnvelope(
        'task.approval_resolved',
        { approvalId: 'appr-3', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );
    send(ws, createEnvelope('task.progress', { seq: 1, events: [{ type: 'progress', text: 'marker' }] }, { taskId: marker.taskId }));
    await waitForTaskEvent(marker, (e) => e.kind === 'agent');

    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running'); // unchanged
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('task.approval_resolved'));
    warnSpy.mockRestore();
  });

  it('stale no-op (console.warn) when the record is already terminal — never force-failed', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle);
    // A server-side decision crosses in flight and wins first (the residual
    // race docs/protocol.md now documents): the SaaS rejects, moving the
    // record to Failed BEFORE the daemon's own local-resolution report ever
    // arrives.
    await handle.reject('SaaS decided first');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Failed');

    // A second, independent task used only as an ordering marker.
    const marker = await byok.dispatch({ instruction: 'marker task' });
    await claimAndStart(ws, daemon.deviceId, marker);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send(
      ws,
      createEnvelope(
        'task.approval_resolved',
        { approvalId: 'appr-4', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );
    send(ws, createEnvelope('task.progress', { seq: 1, events: [{ type: 'progress', text: 'marker' }] }, { taskId: marker.taskId }));
    await waitForTaskEvent(marker, (e) => e.kind === 'agent');

    expect(byok.tasks.get(handle.taskId)?.state).toBe('Failed'); // unchanged — never resurrected, never force-failed again
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropping task.approval_resolved'));
    warnSpy.mockRestore();
  });

  it('stale no-op (console.warn) when the record never reached AwaitApproval at all (e.g. still Claimed) — a genuinely out-of-sequence report', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'x' });
    send(ws, createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send(
      ws,
      createEnvelope(
        'task.approval_resolved',
        { approvalId: 'appr-5', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );
    send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropping task.approval_resolved'));
    warnSpy.mockRestore();
  });

  it('an unknown taskId is a silent no-op (no crash, no event, mirrors every other handler\'s missing-record guard)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    send(
      ws,
      createEnvelope(
        'task.approval_resolved',
        { approvalId: 'appr-6', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: 'no-such-task' },
      ),
    );

    // A second, real task used only to prove the connection/hub are still
    // alive and processing traffic normally after the unknown-taskId message.
    const handle = await byok.dispatch({ instruction: 'still alive' });
    await claimAndStart(ws, daemon.deviceId, handle);
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
  });
});
