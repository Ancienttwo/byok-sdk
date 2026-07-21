import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DaemonObserver, MAX_TRACKED_TASKS, type DaemonEvent } from '../daemon/observer';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Every event this test session's listener(s) recorded that's scoped to one task. */
function taskEvents(events: DaemonEvent[], taskId: string): DaemonEvent[] {
  return events.filter((e) => 'taskId' in e && e.taskId === taskId);
}

/**
 * M3-2a: local observability API (`DaemonObserver` via `daemon.subscribe`/
 * `daemon.tasks`/`daemon.unpair`/`daemon.approve`/`daemon.reject`) — sourced
 * entirely from hooks `create-daemon.ts` already owned (`TaskRunnerDeps.send`,
 * `ConnectionManagerOptions.onEnvelope`/`onStateChange`) without any change to
 * `task-runner.ts`. See `daemon/observer.ts`'s module doc comment.
 */
describe('daemon local observability (DaemonObserver)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function setupDaemon(
    adapter: StubRuntimeAdapter,
    storeDirOverride?: string,
  ): Promise<{ daemon: Daemon; storeDir: string }> {
    const workspaceRoot = await tmpDir('byok-observer-workspace-');
    const storeDir = storeDirOverride ?? (await tmpDir('byok-observer-store-'));
    daemon = createDaemonWithAdapters(
      { productName: 'Test Product', productId: 'test-product-observer', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return { daemon, storeDir };
  }

  it('emits the expected DaemonEvent sequence for a stub-adapter task end-to-end (offered -> ... -> completed), plus pairing/connection/runtime-detection events', async () => {
    const adapter = new StubRuntimeAdapter();
    const events: DaemonEvent[] = [];
    const workspaceRoot = await tmpDir('byok-observer-workspace-');
    const storeDir = await tmpDir('byok-observer-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test Product', productId: 'test-product-observer', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
    );
    // Subscribe BEFORE pair()/start() so `paired`/`runtimes-detected`/`connection` are all caught too.
    daemon.subscribe((e) => events.push(e));
    await daemon.pair('pairing-code');
    await daemon.start();

    expect(events.some((e) => e.kind === 'paired')).toBe(true);
    expect(events.some((e) => e.kind === 'runtimes-detected')).toBe(true);
    expect(events.some((e) => e.kind === 'connection')).toBe(true);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do the thing', policy: { mode: 'auto' } },
        { taskId: 'task-seq-1', seq: server.nextSeq() },
      ),
    );

    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;

    session?.emit({ type: 'progress', text: 'working...' });
    session?.emit({ type: 'turn_end' });

    await server.waitFor((e) => e.type === 'task.complete');

    // `progress` + `turn_end` land in the SAME flushed task.progress batch
    // (matches daemon-task-loop.test.ts's identical assertion) — the
    // observer emits one `progress` DaemonEvent per normalized AgentEvent,
    // so that single envelope yields two local `progress` events here.
    const kinds = taskEvents(events, 'task-seq-1').map((e) => e.kind);
    expect(kinds).toEqual(['offered', 'claimed', 'started', 'progress', 'progress', 'completed']);

    const completed = events.find((e) => e.kind === 'completed' && e.taskId === 'task-seq-1');
    if (completed?.kind !== 'completed') throw new Error('unreachable');
    expect(completed.summary).toBe('working...');
    expect(completed.sessionRef).toBe(session?.sessionRef);

    const offered = events.find((e) => e.kind === 'offered' && e.taskId === 'task-seq-1');
    expect(offered).toMatchObject({ kind: 'offered', taskId: 'task-seq-1' });
  });

  it('a pre-claim task.decline maps to a `failed` DaemonEvent with preClaim:true (protocol\'s Offered -> Failed convention), and tasks() reflects declined:true', async () => {
    // Exercises decline via the permission-ceiling path, exactly like
    // daemon-task-loop.test.ts's own decline coverage: a `runtime` field
    // constrained to a real RuntimeId ('stub' would fail createEnvelope's
    // own schema validation before the offer is even sent) isn't needed to
    // trigger a decline.
    const adapter = new StubRuntimeAdapter();
    const workspaceRoot = await tmpDir('byok-observer-workspace-');
    const storeDir = await tmpDir('byok-observer-store-');
    daemon = createDaemonWithAdapters(
      {
        productName: 'Test Product',
        productId: 'test-product-observer-decline',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        permissionDefaults: { mode: 'readonly' },
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    const d = daemon;
    const events: DaemonEvent[] = [];
    d.subscribe((e) => events.push(e));

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do something risky', policy: { mode: 'auto' } },
        { taskId: 'task-decline-1', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.decline');

    await vi.waitFor(() => {
      const info = d.tasks().find((t) => t.taskId === 'task-decline-1');
      expect(info?.state).toBe('Failed');
      expect(info?.declined).toBe(true);
    });

    const failedEvent = events.find((e) => e.kind === 'failed' && e.taskId === 'task-decline-1');
    if (failedEvent?.kind !== 'failed') throw new Error('unreachable');
    expect(failedEvent.preClaim).toBe(true);
    expect(failedEvent.retryable).toBe(false);
  });

  it('tasks() reflects an in-flight then completed task', async () => {
    const adapter = new StubRuntimeAdapter();
    const { daemon: d } = await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do work', policy: { mode: 'auto' } },
        { taskId: 'task-list-1', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;

    const inFlight = d.tasks().find((t) => t.taskId === 'task-list-1');
    expect(inFlight?.state).toBe('Running');

    session?.emit({ type: 'progress', text: 'partial summary' });
    session?.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete');

    const done = d.tasks().find((t) => t.taskId === 'task-list-1');
    expect(done?.state).toBe('Complete');
    expect(done?.summary).toBe('partial summary');
    expect(done?.sessionRef).toBe(session?.sessionRef);
  });

  it('unpair() clears the device store so a subsequent start() requires re-pair', async () => {
    const adapter = new StubRuntimeAdapter();
    const { daemon: d, storeDir } = await setupDaemon(adapter);
    const events: DaemonEvent[] = [];
    d.subscribe((e) => events.push(e));

    expect(d.status().paired).toBe(true);
    await expect(fs.readFile(path.join(storeDir, 'device.json'), 'utf8')).resolves.toEqual(expect.any(String));

    await d.unpair();

    expect(d.status().paired).toBe(false);
    expect(events.some((e) => e.kind === 'unpaired')).toBe(true);
    await expect(fs.readFile(path.join(storeDir, 'device.json'), 'utf8')).rejects.toThrow();
    await expect(d.start()).rejects.toThrow(/not paired/i);

    // Re-pairing after unpair still works (fresh device identity, same store dir).
    await d.pair('pairing-code-2');
    await d.start();
    expect(d.status().paired).toBe(true);
  });

  it('unpair() is safe to call on a daemon that was never paired/started', async () => {
    const workspaceRoot = await tmpDir('byok-observer-workspace-');
    const storeDir = await tmpDir('byok-observer-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test Product', productId: 'test-product-observer-fresh', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await expect(daemon.unpair()).resolves.toBeUndefined();
    expect(daemon.status().paired).toBe(false);
  });

  it('subscribe/unsubscribe is leak-free: unsubscribe stops delivery to that listener without affecting others', async () => {
    const adapter = new StubRuntimeAdapter();
    const { daemon: d } = await setupDaemon(adapter);
    const eventsA: DaemonEvent[] = [];
    const eventsB: DaemonEvent[] = [];
    const unsubscribeA = d.subscribe((e) => eventsA.push(e));
    d.subscribe((e) => eventsB.push(e));

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' } },
        { taskId: 'task-unsub-1', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-unsub-1');
    await vi.waitFor(() => expect(taskEvents(eventsA, 'task-unsub-1').length).toBeGreaterThan(0));
    expect(taskEvents(eventsB, 'task-unsub-1').length).toEqual(taskEvents(eventsA, 'task-unsub-1').length);

    unsubscribeA();
    const beforeA = eventsA.length;
    const beforeB = eventsB.length;

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'y', policy: { mode: 'auto' } },
        { taskId: 'task-unsub-2', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-unsub-2');
    await vi.waitFor(() => expect(eventsB.length).toBeGreaterThan(beforeB));

    // The unsubscribed listener received nothing further; the still-subscribed one did.
    expect(eventsA.length).toBe(beforeA);
    expect(taskEvents(eventsA, 'task-unsub-2')).toHaveLength(0);
    expect(taskEvents(eventsB, 'task-unsub-2').length).toBeGreaterThan(0);
  });

  it('a throwing listener is caught and logged — it never breaks other listeners or the real task pipeline', async () => {
    const adapter = new StubRuntimeAdapter();
    const { daemon: d } = await setupDaemon(adapter);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodEvents: DaemonEvent[] = [];

    d.subscribe(() => {
      throw new Error('listener boom');
    });
    d.subscribe((e) => goodEvents.push(e));

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' } },
        { taskId: 'task-throw-1', seq: server.nextSeq() },
      ),
    );

    // The real pipeline (claim goes out over the wire) is unaffected by the throwing listener.
    const claim = await server.waitFor((e) => e.type === 'task.claim');
    expect(claim.task_id).toBe('task-throw-1');

    await vi.waitFor(() => expect(taskEvents(goodEvents, 'task-throw-1').length).toBeGreaterThan(0));
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('finding #6: an async (rejecting) listener does not produce an unhandled promise rejection, and does not break delivery to other subscribers or the real task pipeline', async () => {
    const adapter = new StubRuntimeAdapter();
    const { daemon: d } = await setupDaemon(adapter);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodEvents: DaemonEvent[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // Typed as `DaemonEventListener` (`(event) => void`) but actually
      // `async` — TypeScript's structural typing allows this at every real
      // call site too (a promise satisfies a `void`-expected return), so this
      // is exactly the shape a real subscriber (e.g. a CLI's async renderer)
      // could hand `subscribe()` today.
      d.subscribe(async () => {
        throw new Error('async listener boom');
      });
      d.subscribe((e) => goodEvents.push(e));

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' } },
          { taskId: 'task-async-throw-1', seq: server.nextSeq() },
        ),
      );

      // The real pipeline (claim goes out over the wire) is unaffected by the rejecting async listener.
      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.task_id).toBe('task-async-throw-1');
      await vi.waitFor(() => expect(taskEvents(goodEvents, 'task-async-throw-1').length).toBeGreaterThan(0));

      // Give the rejected promise's microtask — and any unhandledRejection
      // Node would schedule for it — a real chance to surface before
      // asserting its absence.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[byok/client] daemon event listener rejected (async)',
        expect.any(Error),
      );
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      consoleErrorSpy.mockRestore();
    }
  });

  describe('DaemonObserver: standalone unit tests (no daemon/server needed)', () => {
    it('finding P2/#11 (observer half): the task registry is bounded even when every tracked task stays nonterminal — evicts the oldest rather than growing without limit', () => {
      const observer = new DaemonObserver();
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Every one of these is offered and never resolved (no claim/complete/
      // fail/cancel follows) — i.e. every tracked entry stays nonterminal,
      // exactly the case `evictIfNeeded`'s "no terminal entry available"
      // branch has to handle without just giving up.
      const total = MAX_TRACKED_TASKS * 2;
      for (let i = 0; i < total; i++) {
        observer.handleInboundEnvelope(
          createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: `t-${i}`, seq: i + 1 }),
        );
      }

      const tasks = observer.tasks();
      expect(tasks).toHaveLength(MAX_TRACKED_TASKS);
      expect(tasks.some((t) => t.taskId === 't-0')).toBe(false); // oldest evicted
      expect(tasks.some((t) => t.taskId === `t-${total - MAX_TRACKED_TASKS - 1}`)).toBe(false);
      expect(tasks.some((t) => t.taskId === `t-${total - MAX_TRACKED_TASKS}`)).toBe(true); // oldest SURVIVOR
      expect(tasks.some((t) => t.taskId === `t-${total - 1}`)).toBe(true); // newest survives
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    describe('finding F4: noteApprovalDispatched attaches approvalId to the matching awaiting-approval DaemonEvent', () => {
      it('attaches the stashed approvalId to the awaiting-approval event for the matching taskId', () => {
        const observer = new DaemonObserver();
        const events: DaemonEvent[] = [];
        observer.subscribe((e) => events.push(e));

        observer.noteApprovalDispatched('task-a', 'appr-1');
        observer.handleOutboundEnvelope(createEnvelope('task.await_approval', { summary: 'Bash: rm -rf /tmp' }, { taskId: 'task-a' }));

        const awaiting = events.find((e) => e.kind === 'awaiting-approval');
        if (awaiting?.kind !== 'awaiting-approval') throw new Error('unreachable');
        expect(awaiting.approvalId).toBe('appr-1');
      });

      it('is read-and-delete: a second task.await_approval for the SAME task with no fresh dispatch call never inherits the already-consumed id', () => {
        const observer = new DaemonObserver();
        const events: DaemonEvent[] = [];
        observer.subscribe((e) => events.push(e));

        observer.noteApprovalDispatched('task-a', 'appr-1');
        observer.handleOutboundEnvelope(createEnvelope('task.await_approval', { summary: 'first' }, { taskId: 'task-a' }));
        observer.handleOutboundEnvelope(createEnvelope('task.await_approval', { summary: 'second' }, { taskId: 'task-a' }));

        const awaitingEvents = events.filter((e) => e.kind === 'awaiting-approval');
        expect(awaitingEvents).toHaveLength(2);
        if (awaitingEvents[0]?.kind !== 'awaiting-approval' || awaitingEvents[1]?.kind !== 'awaiting-approval') {
          throw new Error('unreachable');
        }
        expect(awaitingEvents[0].approvalId).toBe('appr-1');
        expect(awaitingEvents[1].approvalId).toBeUndefined();
      });

      it('never leaks a DIFFERENT task\'s stashed approvalId onto this one\'s awaiting-approval event', () => {
        const observer = new DaemonObserver();
        const events: DaemonEvent[] = [];
        observer.subscribe((e) => events.push(e));

        observer.noteApprovalDispatched('task-other', 'appr-other');
        observer.handleOutboundEnvelope(createEnvelope('task.await_approval', { summary: 'x' }, { taskId: 'task-b' }));

        const awaiting = events.find((e) => e.kind === 'awaiting-approval');
        if (awaiting?.kind !== 'awaiting-approval') throw new Error('unreachable');
        expect(awaiting.approvalId).toBeUndefined();
      });
    });
  });

  describe('approve()/reject() — local wiring onto the same code path a server-sent task.approve/task.reject drives', () => {
    it('approve() resolves approval(true) on the active session via runner.handleEnvelope', async () => {
      const adapter = new StubRuntimeAdapter();
      const { daemon: d } = await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'needs a human', policy: { mode: 'auto' } },
          { taskId: 'task-approve-local-1', seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const [session] = adapter.sessions;

      await d.approve('task-approve-local-1');

      expect(session?.resolveApprovalCalls).toEqual([{ approved: true }]);
    });

    it('reject() resolves approval(false, reason) and reports task.fail', async () => {
      const adapter = new StubRuntimeAdapter();
      const { daemon: d } = await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'needs a human', policy: { mode: 'auto' } },
          { taskId: 'task-reject-local-1', seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const [session] = adapter.sessions;

      await d.reject('task-reject-local-1', 'not allowed locally');

      expect(session?.resolveApprovalCalls).toEqual([{ approved: false, reason: 'not allowed locally' }]);
      const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'task-reject-local-1');
      expect(fail.payload).toMatchObject({ reason: 'not allowed locally', retryable: false });
    });

    it('approve() on an unknown/inactive taskId is a safe no-op', async () => {
      const adapter = new StubRuntimeAdapter();
      const { daemon: d } = await setupDaemon(adapter);
      await expect(d.approve('no-such-task')).resolves.toBeUndefined();
    });

    it('approve()/reject() before start() throw a clear precondition error', async () => {
      const workspaceRoot = await tmpDir('byok-observer-workspace-');
      const storeDir = await tmpDir('byok-observer-store-');
      daemon = createDaemonWithAdapters(
        { productName: 'Test Product', productId: 'test-product-observer-not-started', serverUrl: server.url, workspaceRoot, storeDir },
        [new StubRuntimeAdapter()],
      );
      await expect(daemon.approve('task-x')).rejects.toThrow(/not started/i);
      await expect(daemon.reject('task-x')).rejects.toThrow(/not started/i);
    });
  });
});
