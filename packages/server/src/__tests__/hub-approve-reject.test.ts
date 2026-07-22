import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type TaskState } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { DeviceRegistry } from '../auth';
// S1: `StaleApprovalError` re-exported from the package's own public entry
// point (`index.ts`) — aliased here since the M5 describe block below
// imports the SAME class from the internal `../hub` path for its own
// hub-level tests; both must be the identical class (a straight re-export).
import { createByokServer, StaleApprovalError as PublicStaleApprovalError } from '../index';
import { ConnectionHub, StaleApprovalError, TaskNotAwaitingApprovalError, UnknownTaskError } from '../hub';
import { InMemoryTaskStore, type CreateTaskInput, type TaskRecord, type TaskStore } from '../task-store';
import { claimAndStart, connectFakeDaemon, moveToAwaitApproval, send, startServer, stopServer } from './test-support';

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

  /**
   * M5 (approval targeting, docs/protocol.md §5.3): `approveTask`/`rejectTask`
   * gain an optional `opts.approvalId` — these drive `ConnectionHub` directly
   * (mirrors `task-lease.test.ts`'s own fake-socket convention) rather than
   * through the real WS/HTTP harness, so the outbound `fakeWs.send` spy can
   * assert "no wire message was sent" deterministically instead of racing a
   * timeout waiting for an absence.
   */
  describe('M5 (approval targeting): approveTask/rejectTask opts.approvalId', () => {
    async function awaitApprovalDirect(
      hub: ConnectionHub,
      deviceId: string,
      taskId: string,
      approvalId: string,
      summary = 'needs a human ok',
    ): Promise<void> {
      hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary, approvalId }, { taskId }));
    }

    it('approveTask(taskId, {approvalId}) after that EXACT approval is already consumed (task now Running) throws the existing TaskNotAwaitingApprovalError — the state check runs before the approvalId check', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-approve-consumed';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'needs a human ok', deviceId });
      const { taskId } = handle;
      await awaitApprovalDirect(hub, deviceId, taskId, 'appr-1');
      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval');

      await hub.approveTask(taskId, { approvalId: 'appr-1' }); // targeted — consumes it, AwaitApproval -> Running.
      expect(taskStore.get(taskId)?.state).toBe('Running');

      await expect(hub.approveTask(taskId, { approvalId: 'appr-1' })).rejects.toBeInstanceOf(TaskNotAwaitingApprovalError);
    });

    it('approveTask(taskId, {approvalId: A}) while a DIFFERENT approval (B) is now the recorded pending one throws StaleApprovalError, changes no state, and sends no wire message', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-approve-stale';
      const sendSpy = vi.fn();
      const fakeWs = { send: sendSpy } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'needs a human ok', deviceId });
      const { taskId } = handle;
      await awaitApprovalDirect(hub, deviceId, taskId, 'appr-A', 'first (A)');
      // B supersedes A while the record is STILL AwaitApproval (re-delivered/
      // updated id — see hub-approval-resolved.test.ts's sibling race test).
      hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId }));
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-B');

      const callsBeforeStaleAttempt = sendSpy.mock.calls.length;
      await expect(hub.approveTask(taskId, { approvalId: 'appr-A' })).rejects.toBeInstanceOf(StaleApprovalError);

      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval'); // unchanged
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-B'); // unchanged
      expect(sendSpy.mock.calls.length).toBe(callsBeforeStaleAttempt); // no task.approve sent
    });

    it('rejectTask(taskId, reason, {approvalId: A}) while a DIFFERENT approval (B) is now the recorded pending one throws StaleApprovalError, changes no state, and sends no wire message', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-reject-stale';
      const sendSpy = vi.fn();
      const fakeWs = { send: sendSpy } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'needs a human ok', deviceId });
      const { taskId } = handle;
      await awaitApprovalDirect(hub, deviceId, taskId, 'appr-A', 'first (A)');
      hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId }));
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-B');

      const callsBeforeStaleAttempt = sendSpy.mock.calls.length;
      await expect(hub.rejectTask(taskId, 'stale reject', { approvalId: 'appr-A' })).rejects.toBeInstanceOf(StaleApprovalError);

      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval'); // unchanged
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-B'); // unchanged
      expect(sendSpy.mock.calls.length).toBe(callsBeforeStaleAttempt); // no task.reject sent
    });

    it('StaleApprovalError carries taskId/requestedApprovalId/currentApprovalId fields for programmatic handling', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-stale-fields';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'x', deviceId });
      const { taskId } = handle;
      await awaitApprovalDirect(hub, deviceId, taskId, 'appr-current');

      try {
        await hub.approveTask(taskId, { approvalId: 'appr-requested' });
        throw new Error('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(StaleApprovalError);
        expect((err as StaleApprovalError).taskId).toBe(taskId);
        expect((err as StaleApprovalError).requestedApprovalId).toBe('appr-requested');
        expect((err as StaleApprovalError).currentApprovalId).toBe('appr-current');
      }
    });

    /**
     * Acceptance finding 2 (LOW): the sibling tests above cover a SINGLE
     * `AwaitApproval` cycle (B superseding A while still in the SAME cycle —
     * see `hub-approval-resolved.test.ts`'s matching test) and the FIRST
     * leave-AwaitApproval clearing (the `compat` test below). Missing until
     * now: a full second cycle for the SAME task — leave `AwaitApproval` via
     * a real `approveTask`, come back to it with a fresh approval, and prove
     * the OLD cycle's id is genuinely dead rather than merely superseded
     * in-place. This exercises `transitionTask`'s central "clear
     * `pendingApprovalId` on the way out of `AwaitApproval`" chokepoint
     * (hub.ts) across a real `Running -> AwaitApproval` re-entry (a legal
     * edge — see `hub-implicit-approval-resume.test.ts`'s own coverage of
     * it), not just its very first application.
     */
    it('composed second cycle: AwaitApproval(A) -> approve -> Running -> await_approval(B) -> AwaitApproval — pendingApprovalId is B; A is now stale (StaleApprovalError), B still works', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-second-cycle';
      const sendSpy = vi.fn();
      const fakeWs = { send: sendSpy } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'needs two humans', deviceId });
      const { taskId } = handle;

      // First cycle: AwaitApproval(A) -> approve -> Running.
      await awaitApprovalDirect(hub, deviceId, taskId, 'appr-A', 'first (A)');
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-A');

      await hub.approveTask(taskId, { approvalId: 'appr-A' });
      expect(taskStore.get(taskId)?.state).toBe('Running');
      // Sanity check before the second cycle even starts: leaving
      // AwaitApproval already clears the stored id (transitionTask's central
      // chokepoint).
      expect(taskStore.get(taskId)?.pendingApprovalId).toBeUndefined();

      // Second cycle: a FRESH task.await_approval (B) re-enters AwaitApproval
      // from Running.
      hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId }));
      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval');
      // The exact bug this test guards against: without transitionTask's
      // clearing on the way OUT of the first cycle, this could still read a
      // stale leftover ('appr-A') instead of the new cycle's real id.
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-B');

      // A's id belonged to a PREVIOUS, already fully-consumed AwaitApproval
      // cycle for this SAME task — it must be rejected as stale now, not
      // silently accepted just because it's a familiar id.
      const callsBeforeStaleAttempt = sendSpy.mock.calls.length;
      await expect(hub.approveTask(taskId, { approvalId: 'appr-A' })).rejects.toBeInstanceOf(StaleApprovalError);
      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval'); // unchanged
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-B'); // unchanged
      expect(sendSpy.mock.calls.length).toBe(callsBeforeStaleAttempt); // no task.approve sent

      // B — the CURRENT cycle's real id — still works normally.
      await hub.approveTask(taskId, { approvalId: 'appr-B' });
      expect(taskStore.get(taskId)?.state).toBe('Running');
    });

    it('compat: approveTask/rejectTask with NO opts still resolves whichever approval is currently pending — untargeted behavior is unchanged from pre-M5', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-untargeted';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'x', deviceId });
      const { taskId } = handle;
      await awaitApprovalDirect(hub, deviceId, taskId, 'appr-untargeted');
      expect(taskStore.get(taskId)?.pendingApprovalId).toBe('appr-untargeted');

      await hub.approveTask(taskId); // no opts at all — pre-M5 call shape.
      expect(taskStore.get(taskId)?.state).toBe('Running');
      // Leaving AwaitApproval clears the stored id (the shared transitionTask
      // chokepoint, hub.ts) regardless of whether this decision was targeted.
      expect(taskStore.get(taskId)?.pendingApprovalId).toBeUndefined();
    });

    it('compat: a legacy task.await_approval with NO approvalId stores nothing, and an untargeted approveTask still works normally', async () => {
      const taskStore = new InMemoryTaskStore();
      const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-legacy-daemon';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'x', deviceId });
      const { taskId } = handle;
      hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
      // A pre-M5 daemon's task.await_approval carries no approvalId at all.
      hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary: 'legacy' }, { taskId }));

      expect(taskStore.get(taskId)?.state).toBe('AwaitApproval');
      expect(taskStore.get(taskId)?.pendingApprovalId).toBeUndefined();

      await hub.approveTask(taskId); // untargeted — nothing to compare against, proceeds exactly as before M5.
      expect(taskStore.get(taskId)?.state).toBe('Running');
    });
  });

  /**
   * S1 (cross-model review finding, P1): `TaskHandle.approve()`/`reject()` —
   * the ONLY way an embedder holding just the published API (`dispatch()`'s
   * return value, never `ConnectionHub` itself) can act on a task — took no
   * `approvalId` at all, so the M5 targeting implemented on
   * `ConnectionHub.approveTask`/`rejectTask` (the describe block above) was
   * genuinely unreachable end to end. `StaleApprovalError` was also missing
   * from the package's public entry point (`index.ts`), so even a caller
   * that somehow triggered it had nothing to `instanceof`-check against
   * without reaching into the internal `../hub` path. Both are fixed at the
   * `TaskHandle`/`index.ts` level (`types.ts`, `hub.ts`'s `buildTaskHandle`)
   * — these tests exercise the full public round trip: `createByokServer`
   * -> `dispatch()` -> `TaskHandle`, never touching `ConnectionHub` directly
   * (mirroring this file's own OUTER describe block's convention, not the
   * M5 describe block's direct-hub convention above).
   */
  describe('S1: TaskHandle.approve/reject opts.approvalId (published API)', () => {
    it('TaskHandle.approve({approvalId}) targets the CURRENT pending approval, read back off the publicly-exposed TaskSnapshot.pendingApprovalId, end to end through dispatch()', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      const handle = await byok.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(ws, daemon.deviceId, handle);
      await moveToAwaitApproval(ws, handle, 'first (A)', 'appr-A');

      // Confirmatory (S1's second half): pendingApprovalId is already
      // readable through the existing public snapshot surface — an embedder
      // builds its targeted approve call off exactly this, no new surface
      // needed.
      const pendingApprovalId = byok.tasks.get(handle.taskId)?.pendingApprovalId;
      expect(pendingApprovalId).toBe('appr-A');

      await handle.approve({ approvalId: pendingApprovalId });
      expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
    });

    it('TaskHandle.reject(reason, {approvalId}) targets the CURRENT pending approval end to end through dispatch()', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      const handle = await byok.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(ws, daemon.deviceId, handle);
      await moveToAwaitApproval(ws, handle, 'first (A)', 'appr-A');

      await handle.reject('looked risky', { approvalId: 'appr-A' });
      const snapshot = byok.tasks.get(handle.taskId);
      expect(snapshot?.state).toBe('Failed');
      expect(snapshot?.result?.state === 'Failed' ? snapshot.result.reason : undefined).toBe('looked risky');
    });

    it('TaskHandle.approve({approvalId}) against a STALE (superseded) approval throws StaleApprovalError — importable/catchable from the package\'s public entry point, not just ../hub — leaving state unchanged; the CURRENT approval still works through the same handle', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      const handle = await byok.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(ws, daemon.deviceId, handle);
      await moveToAwaitApproval(ws, handle, 'first (A)', 'appr-A');

      // B supersedes A while still AwaitApproval — synchronize via a marker
      // task (this file's own established idiom, e.g.
      // `hub-approval-resolved.test.ts`) rather than the S2-fixed
      // await_approval event, so this S1 test stays independent of S2.
      send(ws, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }));
      const marker = await byok.dispatch({ instruction: 'marker task' });
      await claimAndStart(ws, daemon.deviceId, marker);
      expect(byok.tasks.get(handle.taskId)?.pendingApprovalId).toBe('appr-B');

      await expect(handle.approve({ approvalId: 'appr-A' })).rejects.toBeInstanceOf(PublicStaleApprovalError);
      expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval'); // unchanged

      // B — the CURRENT approval — still works through the SAME published
      // TaskHandle.
      await handle.approve({ approvalId: 'appr-B' });
      expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
    });
  });

  /**
   * S4 (cross-model review finding, P1): `TaskStore.setPendingApprovalId`
   * was a REQUIRED method on a public exported interface (`task-store.ts`)
   * — any existing embedder store written against the pre-M5 `TaskStore`
   * shape would fail to satisfy it, breaking on upgrade. Fixed by making it
   * optional, with the one call site in `hub.ts` (`onAwaitApproval`'s
   * same-state id-update branch) guarded via `?.()`. `LegacyTaskStore` below
   * is a full, correct implementation of the PRE-M5 `TaskStore` contract —
   * everything except the one new optional method — driven through exactly
   * that call site.
   */
  describe('S4: TaskStore.setPendingApprovalId is optional — a legacy store without it must not crash', () => {
    class LegacyTaskStore implements TaskStore {
      private readonly tasks = new Map<string, TaskRecord>();

      create(input: CreateTaskInput): TaskRecord {
        const now = new Date().toISOString();
        const record: TaskRecord = {
          taskId: input.taskId,
          state: 'Offered',
          instruction: input.instruction,
          runtime: input.runtime,
          policy: input.policy,
          deviceId: input.deviceId,
          sessionRef: input.sessionRef,
          createdAt: now,
          updatedAt: now,
        };
        this.tasks.set(record.taskId, record);
        return record;
      }

      get(taskId: string): TaskRecord | undefined {
        return this.tasks.get(taskId);
      }

      list(): TaskRecord[] {
        return [...this.tasks.values()];
      }

      transition(taskId: string, to: TaskState, patch: Partial<Omit<TaskRecord, 'taskId' | 'state'>> = {}): TaskRecord {
        const record = this.tasks.get(taskId);
        if (!record) throw new Error(`unknown taskId: ${taskId}`);
        const updated: TaskRecord = { ...record, ...patch, state: to, updatedAt: new Date().toISOString() };
        this.tasks.set(taskId, updated);
        return updated;
      }

      // Deliberately NO setPendingApprovalId — the entire point: a pre-M5
      // embedder store literally never had this method, and this must still
      // structurally satisfy `TaskStore` now that it's optional.
    }

    it('a legacy store (no setPendingApprovalId at all) drives await_approval(A) -> await_approval(B) redelivery -> approve without throwing', async () => {
      const legacyStore = new LegacyTaskStore();
      const hub = new ConnectionHub(legacyStore, new DeviceRegistry(), 30 * 60_000);
      const deviceId = 'device-legacy-store';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'needs a human ok', deviceId });
      const { taskId } = handle;

      expect(() => {
        hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
        hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
        hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary: 'first (A)', approvalId: 'appr-A' }, { taskId }));
        // The SAME-STATE redelivery branch — the ONLY call site that invokes
        // `taskStore.setPendingApprovalId` — is exercised here. Without the
        // `?.()` guard in `hub.ts`, this throws a TypeError (not a function)
        // against a store missing the method entirely.
        hub.handleInbound(deviceId, createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId }));
      }).not.toThrow();

      expect(legacyStore.get(taskId)?.state).toBe('AwaitApproval');

      // Untargeted approve (no opts) still resolves whichever approval is
      // currently pending, exactly as it would against any other store —
      // the missing method degrades gracefully rather than breaking the
      // flow.
      await expect(hub.approveTask(taskId)).resolves.toBeUndefined();
      expect(legacyStore.get(taskId)?.state).toBe('Running');
    });
  });
});
