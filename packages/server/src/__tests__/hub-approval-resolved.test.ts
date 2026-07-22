import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { DeviceRegistry } from '../auth';
import { ConnectionHub } from '../hub';
import { createByokServer, type ByokServerEvent } from '../index';
import { InMemoryTaskStore } from '../task-store';
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

  it('M5 (approval targeting): await_approval(A) stored, await_approval(B) re-delivered for the SAME task while still AwaitApproval, then approval_resolved(A) arrives — task stays AwaitApproval, never Running', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);

    // A: the first await_approval, stored as this task's pendingApprovalId.
    await moveToAwaitApproval(ws, handle, 'first (A)', 'appr-A');
    expect(byok.tasks.get(handle.taskId)?.pendingApprovalId).toBe('appr-A');

    // B: the daemon has moved on (e.g. resolved A entirely locally with no
    // approval_resolved capability negotiated) and dispatched a fresh
    // approval for the SAME task — re-sent while the server's own record is
    // STILL AwaitApproval (AwaitApproval -> AwaitApproval is not a state
    // transition, so this must update pendingApprovalId in place, not be
    // rejected as illegal).
    send(ws, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }));
    // No new 'state' event fires (still AwaitApproval) — wait on a distinct,
    // observable side effect instead: a marker task proves ordering without
    // an arbitrary sleep.
    const marker = await byok.dispatch({ instruction: 'marker task' });
    await claimAndStart(ws, daemon.deviceId, marker);
    expect(byok.tasks.get(handle.taskId)?.pendingApprovalId).toBe('appr-B');
    expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval'); // unchanged

    // A late task.approval_resolved arrives, carrying A's now-superseded id.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send(
      ws,
      createEnvelope(
        'task.approval_resolved',
        { approvalId: 'appr-A', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );
    send(ws, createEnvelope('task.progress', { seq: 1, events: [{ type: 'progress', text: 'marker' }] }, { taskId: marker.taskId }));
    await waitForTaskEvent(marker, (e) => e.kind === 'agent');

    // The task stays AwaitApproval — the stale report for A must NOT move
    // it to Running (that would be resuming the WRONG approval).
    expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval');
    expect(byok.tasks.get(handle.taskId)?.pendingApprovalId).toBe('appr-B');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stale task.approval_resolved'));
    warnSpy.mockRestore();
  });

  it('S2 (cross-model review finding, P1): await_approval(B) re-delivered while already AwaitApproval re-emits the await_approval ServerTaskEvent carrying B\'s summary — previously the same-state branch updated pendingApprovalId and returned silently, leaving an operator watching TaskHandle.events() still showing A\'s summary', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(ws, daemon.deviceId, handle);
    await moveToAwaitApproval(ws, handle, 'first (A)', 'appr-A');

    // B supersedes A while the record is STILL AwaitApproval — the exact
    // same-state redelivery `hub-approval-resolved.test.ts`'s sibling test
    // above already covers for `pendingApprovalId`; this test's own focus is
    // the previously-missing OBSERVABILITY event, not the stored id.
    send(ws, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }));

    const event = await waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second (B)');
    if (event.kind !== 'await_approval') throw new Error('unreachable');
    expect(event.summary).toBe('second (B)');
    expect(byok.tasks.get(handle.taskId)?.pendingApprovalId).toBe('appr-B');

    // Sanity: a redelivery carrying the SAME id (B again, not a new
    // approval) must NOT re-emit yet another event — only a genuinely NEW id
    // triggers the re-emission (mirrors the pendingApprovalId-update guard's
    // own `payload.approvalId !== record.pendingApprovalId` condition,
    // hub.ts). Mirrors this file's own `implicitFired` race idiom above for
    // asserting a negative without an arbitrary blind sleep.
    send(ws, createEnvelope('task.await_approval', { summary: 'second (B) resent', approvalId: 'appr-B' }, { taskId: handle.taskId }));
    const sawAnotherEvent = await Promise.race([
      waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second (B) resent').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(sawAnotherEvent).toBe(false);
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

  /**
   * Acceptance finding: the `targeted` field on the emitted
   * `task.approval_resolved` `ByokServerEvent` (`onApprovalResolved`,
   * `hub.ts:~1013`) had no coverage — every existing server test passes
   * `undefined` capabilities to `registerConnection`, so `targeted` was only
   * ever exercised on its `false` branch, and only incidentally.
   *
   * These two tests construct a raw `ConnectionHub` directly and drive it
   * with `handleInbound` (mirroring `hub-approve-reject.test.ts`'s own M5
   * "approveTask/rejectTask opts.approvalId" describe block) instead of this
   * file's usual full-stack `createByokServer` + `connectFakeDaemon`
   * harness: `test-support.ts`'s `connectFakeDaemonWs` hard-codes an empty
   * `conn.hello.capabilities: []` with no way to override it, so the
   * full-stack helpers have no way to negotiate the `approval-targeting`
   * flag this needs — `registerConnection`'s own explicit `capabilities`
   * parameter (`hub.ts`) is the direct route.
   */
  describe('M5 (hello-capability plumbing): targeted field on the emitted task.approval_resolved event', () => {
    /**
     * Mirrors `waitForServerEvent` (`test-support.ts`), which takes a full
     * `ByokServer` — these tests construct a raw `ConnectionHub` instead, so
     * that helper doesn't apply here. Same safety as the original: both are
     * backed by the same `AsyncEventQueue` (`event-queue.ts`), whose
     * `subscribe()` always replays from the start of its buffer, so calling
     * this AFTER the triggering (synchronous) `handleInbound` call already
     * ran is safe — not a race against a live push.
     */
    async function waitForHubEvent(
      hub: ConnectionHub,
      predicate: (event: ByokServerEvent) => boolean,
    ): Promise<ByokServerEvent> {
      for await (const event of hub.subscribeServerEvents()) {
        if (predicate(event)) return event;
      }
      throw new Error('server event stream ended before a matching event was seen');
    }

    it('a daemon that advertised the approval-targeting capability produces targeted: true on the emitted event', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-targeted-capability';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined, ['approval-targeting']);

      const handle = await hub.dispatch({ instruction: 'needs a human ok', deviceId });
      const { taskId } = handle;
      hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
      hub.handleInbound(
        deviceId,
        createEnvelope('task.await_approval', { summary: 'needs a human ok', approvalId: 'appr-targeted' }, { taskId }),
      );
      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval');

      hub.handleInbound(
        deviceId,
        createEnvelope(
          'task.approval_resolved',
          { approvalId: 'appr-targeted', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
          { taskId },
        ),
      );

      const event = await waitForHubEvent(hub, (e) => e.kind === 'task.approval_resolved' && e.taskId === taskId);
      if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
      expect(event.targeted).toBe(true);
      expect(taskStore.get(taskId)?.state).toBe('Running');
    });

    it('a legacy daemon with no capabilities advertised at all produces targeted: false on the emitted event', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-legacy-no-capabilities';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined); // no capabilities arg — every pre-M5/legacy call site's shape.

      const handle = await hub.dispatch({ instruction: 'needs a human ok', deviceId });
      const { taskId } = handle;
      hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
      hub.handleInbound(
        deviceId,
        createEnvelope('task.await_approval', { summary: 'needs a human ok', approvalId: 'appr-legacy' }, { taskId }),
      );
      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval');

      hub.handleInbound(
        deviceId,
        createEnvelope(
          'task.approval_resolved',
          { approvalId: 'appr-legacy', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
          { taskId },
        ),
      );

      const event = await waitForHubEvent(hub, (e) => e.kind === 'task.approval_resolved' && e.taskId === taskId);
      if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
      expect(event.targeted).toBe(false);
      expect(taskStore.get(taskId)?.state).toBe('Running');
    });
  });
});
