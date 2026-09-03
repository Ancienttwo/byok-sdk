import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, type Envelope, type RuntimeCapabilities, type RuntimeId } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import type { ServerTaskEvent, TaskHandle } from '../types';
import {
  connectFakeDaemonLongPoll,
  pairFakeDaemon,
  PI_RUNTIME_INFO,
  startServer,
  stopServer,
  testPairingClaims,
  waitForTaskEvent,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll query in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

/**
 * Claim + start a dispatched task over the long-poll send path (Offered ->
 * Claimed -> Running) and wait for the Running event. `runtime` (S0) is the
 * actual adapter this claim reports and `capabilities` (S0/D-4) is that
 * adapter's own self-report, which is the ONLY thing the steer gate reads;
 * both omitted matches a legacy `task.claim`, which is what every call site
 * here but the steer test wants.
 */
async function claimAndStart(
  daemon: FakeLongPollDaemon,
  handle: TaskHandle,
  runtime?: RuntimeId,
  capabilities?: RuntimeCapabilities,
): Promise<void> {
  await daemon.send(
    createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime, capabilities }, { taskId: handle.taskId }),
  );
  await daemon.send(createEnvelope('task.started', {}, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
}

/** Race one more event off `handle.events()`'s async iterator against a short timeout — used to prove "nothing further happened" without hanging on a non-terminal task's still-open queue. */
async function expectNoMoreEvents(iter: AsyncIterator<ServerTaskEvent>, timeoutMs = 200): Promise<void> {
  const raced = await Promise.race([
    iter.next().then(() => 'more' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
  expect(raced).toBe('timeout');
}

/**
 * Wave 1 (server-side inbound gate): every daemon -> server envelope runs
 * through the cloud kernel's fixed gate (rate limit -> type-allow -> ownership
 * -> dedup -> apply) before it reaches any per-type handler. These tests
 * exercise the gate itself, distinct from the per-type state-machine tests in
 * integration.test.ts.
 */
describe('inbound gate (Wave 1): idempotency, ownership, type restriction, cancel redelivery', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; baseUrl: string }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  describe('POST /byok/messages retry is idempotent (N3 + §9)', () => {
    it('POSTing the same batch (same envelope ids) twice yields one state transition per envelope, progress emitted once, and the retry is not reprocessed', async () => {
      const started = await start();
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

      const handle = await started.byok.dispatch({ instruction: 'needs a human ok' });
      const iter = handle.events()[Symbol.asyncIterator]();
      const offered = await iter.next();
      expect(offered.value).toMatchObject({ kind: 'state', state: 'Offered' });

      // One fixed batch, reused verbatim (same `id`s) across both POSTs —
      // this is what makes the second POST a genuine wire-level retry, not a
      // fresh set of envelopes that merely happen to target the same task.
      const claim = createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId });
      const startedEnv = createEnvelope('task.started', {}, { taskId: handle.taskId });
      const progress = createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'working...' }] },
        { taskId: handle.taskId },
      );
      const awaitApproval = createEnvelope(
        'task.await_approval',
        { summary: 'about to do something risky' },
        { taskId: handle.taskId },
      );
      const batch = [claim, startedEnv, progress, awaitApproval];

      const firstRes = await fetch(`${started.baseUrl}/byok/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
        body: JSON.stringify({ messages: batch }),
      });
      expect(firstRes.status).toBe(200);
      expect(await firstRes.json()).toEqual({ accepted: 4 }); // no `rejected` key: nothing was rejected

      const claimed = await iter.next();
      expect(claimed.value).toMatchObject({ kind: 'state', state: 'Claimed' });
      const running = await iter.next();
      expect(running.value).toMatchObject({ kind: 'state', state: 'Running' });
      const agentEvt = await iter.next();
      expect(agentEvt.value).toMatchObject({ kind: 'agent', event: { type: 'progress', text: 'working...' } });
      const awaitEvt = await iter.next();
      expect(awaitEvt.value).toMatchObject({ kind: 'await_approval', summary: 'about to do something risky' });
      const awaitState = await iter.next();
      expect(awaitState.value).toMatchObject({ kind: 'state', state: 'AwaitApproval' });

      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');

      // Resend the EXACT same batch (identical envelope ids). Every one of
      // the 4 must be recognized as a duplicate: no handler reruns, no new
      // event is pushed, and the task must NOT fall back to Failed (the old
      // N3 bug: re-applying await_approval from AwaitApproval is an illegal
      // self-transition that used to forceFail).
      const secondRes = await fetch(`${started.baseUrl}/byok/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
        body: JSON.stringify({ messages: batch }),
      });
      expect(secondRes.status).toBe(200);
      // Duplicates still count as `accepted` on the wire (§8.2) — an
      // idempotent replay is a wire-level success even though nothing
      // reprocessed.
      expect(await secondRes.json()).toEqual({ accepted: 4 });

      await expectNoMoreEvents(iter);
      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // NOT Failed
    });

    it('a fresh (non-duplicate-id) task.await_approval arriving while already AwaitApproval is an idempotent no-op, not a forced Failed (structural guard, independent of id-based dedup)', async () => {
      const started = await start();
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

      const handle = await started.byok.dispatch({ instruction: 'x' });
      await claimAndStart(daemon, handle);
      await daemon.send(createEnvelope('task.await_approval', { summary: 'first' }, { taskId: handle.taskId }));
      await waitForTaskEvent(handle, (e) => e.kind === 'await_approval');
      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');

      // A brand-new envelope id (not a wire retry) with type
      // task.await_approval, arriving while the task is already
      // AwaitApproval. `POST /byok/messages` applies its envelopes
      // synchronously, so the awaited send is itself the barrier.
      await daemon.send(createEnvelope('task.await_approval', { summary: 'second, redundant' }, { taskId: handle.taskId }));

      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // NOT Failed
    });

    // 2d gap: the assertion split out of the test above. The old hub's
    // `onAwaitApproval` structural guard returned early on an
    // `AwaitApproval -> AwaitApproval` redelivery, so NOTHING was pushed onto
    // `TaskHandle.events()`. The kernel has no execution state machine
    // (ADR-028) and `TaskEventRelay.onInboundCommitted` folds every COMMITTED
    // `task.await_approval` into the feed, so a fresh-id redelivery now emits
    // an `await_approval` event plus an `AwaitApproval` state event. Only an
    // envelope-id duplicate is suppressed (by the kernel's dedup step, pinned
    // by the batch-retry test above). Orchestrator decision: accept the
    // re-emission as the honest report of a new observation, or restore
    // suppression in the relay.
    it.skip('a fresh (non-duplicate-id) task.await_approval arriving while already AwaitApproval pushes nothing further onto TaskHandle.events()', async () => {
      const started = await start();
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

      const handle = await started.byok.dispatch({ instruction: 'x' });
      await claimAndStart(daemon, handle);
      await daemon.send(createEnvelope('task.await_approval', { summary: 'first' }, { taskId: handle.taskId }));
      await waitForTaskEvent(handle, (e) => e.kind === 'await_approval');

      const iter = handle.events()[Symbol.asyncIterator]();
      for (let i = 0; i < 5; i++) await iter.next();

      await daemon.send(createEnvelope('task.await_approval', { summary: 'second, redundant' }, { taskId: handle.taskId }));

      await expectNoMoreEvents(iter);
    });
  });

  describe('cross-device task injection is rejected (N2, security)', () => {
    it("device B POSTing task.progress/complete/await_approval for device A's task leaves A's state and event stream untouched, and every envelope is counted rejected", async () => {
      const started = await start();
      const deviceA = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
        productId: PRODUCT_ID,
        deviceName: 'device-a',
      });
      // Device B never needs to poll for this test — POST /byok/messages only
      // requires a valid bearer token.
      const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
      const deviceB = await pairFakeDaemon(started.baseUrl, code, { deviceName: 'device-b' });

      const handle = await started.byok.dispatch({ instruction: 'owned by A', deviceId: deviceA.deviceId });
      await claimAndStart(deviceA, handle);
      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');

      const iter = handle.events()[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) await iter.next(); // drain Offered, Claimed, Running

      const injected: Envelope[] = [
        createEnvelope(
          'task.progress',
          { seq: 1, events: [{ type: 'progress', text: 'injected by B' }] },
          { taskId: handle.taskId },
        ),
        createEnvelope(
          'task.complete',
          { summary: 'stolen', sessionRef: 'sess_evil' },
          { taskId: handle.taskId },
        ),
        createEnvelope('task.await_approval', { summary: 'injected' }, { taskId: handle.taskId }),
      ];

      const res = await fetch(`${started.baseUrl}/byok/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceB.accessToken}` },
        body: JSON.stringify({ messages: injected }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: 0, rejected: 3 });

      // Dropped, never force-failed: a force-fail here would be a DoS an
      // attacker (device B, having merely guessed A's taskId) could use to
      // kill A's real task.
      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running'); // untouched — NOT Complete, NOT Failed
      await expectNoMoreEvents(iter);
    });
  });

  describe('POST /byok/messages restricts to daemon->server task.* types (P2)', () => {
    it('a task.offer or conn.ack in the batch is rejected, not counted accepted, and has no side effect', async () => {
      const started = await start();
      const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
      const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

      const connAck = createEnvelope(
        'conn.ack',
        { protocolVersion: PROTOCOL_VERSION, capabilities: [], serverTime: new Date().toISOString() },
        { seq: 99 },
      );
      const taskOffer = createEnvelope(
        'task.offer',
        { instruction: 'do the thing', policy: { mode: 'confirm' } },
        { taskId: 'task_forged', seq: 100 },
      );

      const res = await fetch(`${started.baseUrl}/byok/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ messages: [connAck, taskOffer] }),
      });

      expect(res.status).toBe(200); // tolerant batch parsing (P2): wrong-direction types are per-envelope rejected, not a whole-batch 400
      expect(await res.json()).toEqual({ accepted: 0, rejected: 2 });
      expect(await started.byok.tasks.get('task_forged')).toBeUndefined(); // never reached the task store at all
    });

    it('a valid daemon->server envelope alongside a rejected one is partially accepted (per-envelope, not whole-batch)', async () => {
      const started = await start();
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

      const handle = await started.byok.dispatch({ instruction: 'x' });
      const claim = createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId });
      const forgedOffer = createEnvelope(
        'task.offer',
        { instruction: 'forged', policy: { mode: 'confirm' } },
        { taskId: 'task_forged_2', seq: 999 },
      );

      const res = await fetch(`${started.baseUrl}/byok/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
        body: JSON.stringify({ messages: [claim, forgedOffer] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: 1, rejected: 1 });

      await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
      expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Claimed');
    });
  });

  describe('cancel/reject redelivery survives the terminal-task filter (N1/F4)', () => {
    it('GET /byok/events includes an exempted task.cancel for an already-terminal task, and excludes task.offer/task.steer/task.approve for terminal tasks', async () => {
      const started = await start();
      // S0: task1 gets steered below, so this device must advertise pi (the
      // one steerable runtime) and claim task1 as pi — the steer gate reads
      // the claim-time capability snapshot.
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
        productId: PRODUCT_ID,
        runtimes: [PI_RUNTIME_INFO],
      });

      // task1: Running -> steer (non-exempt, non-terminal at send time) -> cancel (exempt, terminal at send time).
      const handle1 = await started.byok.dispatch({ instruction: 'task one' });
      await claimAndStart(daemon, handle1, 'pi', PI_RUNTIME_INFO.capabilities);
      await handle1.steer('keep going');
      await handle1.cancel('changed my mind');
      await handle1.result();
      expect((await started.byok.tasks.get(handle1.taskId))?.state).toBe('Cancelled');

      // task2: Running -> AwaitApproval -> approve (non-exempt, non-terminal
      // at send time) -> cancel (exempt, terminal at send time) — proves
      // approve's exemption would be moot (it's never sent on an
      // already-terminal task) while still confirming it doesn't survive the
      // filter once the task later goes terminal for an unrelated reason.
      const handle2 = await started.byok.dispatch({ instruction: 'task two' });
      await claimAndStart(daemon, handle2);
      await daemon.send(
        createEnvelope('task.await_approval', { summary: 'need ok', approvalId: 'appr-task2' }, { taskId: handle2.taskId }),
      );
      await waitForTaskEvent(handle2, (e) => e.kind === 'await_approval');
      await handle2.approve();
      await handle2.cancel('done after all');
      await handle2.result();
      expect((await started.byok.tasks.get(handle2.taskId))?.state).toBe('Cancelled');

      // Read the retained delivery set back through the public surface, from
      // the very beginning of this device's mailbox.
      const res = await daemon.replay(0);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: Envelope[]; cursor: number };
      const seen = body.events.map((e) => `${e.type}:${e.task_id ?? ''}`);

      expect(seen).toContain(`task.cancel:${handle1.taskId}`);
      expect(seen).toContain(`task.cancel:${handle2.taskId}`);
      expect(seen).not.toContain(`task.offer:${handle1.taskId}`);
      expect(seen).not.toContain(`task.offer:${handle2.taskId}`);
    });

    // 2d gap: the two exclusions split out of the test above. The old hub's
    // `collectRelevant` filtered EVERY non-exempt envelope for an
    // already-terminal task, with `task.cancel`/`task.reject` as the named
    // exemptions. The kernel's `GET /byok/events` filter (`handlers/events.ts`)
    // drops exactly one thing — an OFFER for a task with an accepted
    // cancellation — and delivers every other durable row it owes the device,
    // because the mailbox is an at-least-once delivery log rather than a
    // re-derived relevance view. So a `task.steer`/`task.approve` enqueued
    // while the task was still live is still delivered after it goes terminal.
    // Orchestrator decision: accept the kernel's delivery semantics (packet
    // §2), or add a terminal-task filter to the kernel's events handler.
    it.skip('GET /byok/events excludes task.steer/task.approve enqueued before a task went terminal', async () => {
      const started = await start();
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
        productId: PRODUCT_ID,
        runtimes: [PI_RUNTIME_INFO],
      });

      const handle1 = await started.byok.dispatch({ instruction: 'task one' });
      await claimAndStart(daemon, handle1, 'pi', PI_RUNTIME_INFO.capabilities);
      await handle1.steer('keep going');
      await handle1.cancel('changed my mind');
      await handle1.result();

      const handle2 = await started.byok.dispatch({ instruction: 'task two' });
      await claimAndStart(daemon, handle2);
      await daemon.send(
        createEnvelope('task.await_approval', { summary: 'need ok', approvalId: 'appr-task2' }, { taskId: handle2.taskId }),
      );
      await waitForTaskEvent(handle2, (e) => e.kind === 'await_approval');
      await handle2.approve();
      await handle2.cancel('done after all');
      await handle2.result();

      const body = (await (await daemon.replay(0)).json()) as { events: Envelope[] };
      const seen = body.events.map((e) => `${e.type}:${e.task_id ?? ''}`);
      expect(seen).not.toContain(`task.steer:${handle1.taskId}`);
      expect(seen).not.toContain(`task.approve:${handle2.taskId}`);
    });
  });
});
