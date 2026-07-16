import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, type Envelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import type { ServerTaskEvent, TaskHandle } from '../types';
import {
  connectFakeDaemon,
  pairFakeDaemon,
  send,
  startServer,
  stopServer,
  waitForTaskEvent,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll query in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

/** Claim + start a dispatched task over `ws` (Offered -> Claimed -> Running) and wait for the Running event. */
async function claimAndStart(ws: WebSocket, deviceId: string, handle: TaskHandle): Promise<void> {
  send(ws, createEnvelope('task.claim', { deviceId }, { taskId: handle.taskId }));
  send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
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
 * Wave 1 (server-side inbound gate): every daemon -> server envelope, on
 * either transport, now runs through `ConnectionHub.handleInbound`'s fixed
 * gate (type-allow -> ownership -> dedup -> dispatch) before it reaches any
 * per-type handler. These tests exercise the gate itself, distinct from the
 * per-type state-machine tests in integration.test.ts.
 */
describe('inbound gate (Wave 1): idempotency, ownership, type restriction, cancel redelivery', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  describe('POST /byok/messages retry is idempotent (N3 + §9)', () => {
    it('POSTing the same batch (same envelope ids) twice yields one state transition per envelope, progress emitted once, and the retry is not reprocessed', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      const handle = await byok.dispatch({ instruction: 'needs a human ok' });
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
      const awaitState = await iter.next();
      expect(awaitState.value).toMatchObject({ kind: 'state', state: 'AwaitApproval' });
      const awaitEvt = await iter.next();
      expect(awaitEvt.value).toMatchObject({ kind: 'await_approval', summary: 'about to do something risky' });

      expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval');

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
      expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval'); // NOT Failed
    });

    it('a fresh (non-duplicate-id) task.await_approval arriving while already AwaitApproval is an idempotent no-op, not a forced Failed (structural guard, independent of id-based dedup)', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      const handle = await byok.dispatch({ instruction: 'x' });
      await claimAndStart(ws, daemon.deviceId, handle);
      send(ws, createEnvelope('task.await_approval', { summary: 'first' }, { taskId: handle.taskId }));
      await waitForTaskEvent(handle, (e) => e.kind === 'await_approval');
      expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval');

      const iter = handle.events()[Symbol.asyncIterator]();
      // Drain everything buffered so far (Offered, Claimed, Running, AwaitApproval-state, await_approval-event).
      for (let i = 0; i < 5; i++) await iter.next();

      // A brand-new envelope id (not a wire retry) with type task.await_approval,
      // arriving while the record is already AwaitApproval — the dedup
      // window does not catch this; only the onAwaitApproval structural
      // guard (`record.state === 'AwaitApproval' -> return`) does.
      send(ws, createEnvelope('task.await_approval', { summary: 'second, redundant' }, { taskId: handle.taskId }));

      await expectNoMoreEvents(iter);
      expect(byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval'); // NOT Failed
    });
  });

  describe('cross-device task injection is rejected (N2, security)', () => {
    it("device B POSTing task.progress/complete/await_approval for device A's task leaves A's state and event stream untouched, and every envelope is counted rejected", async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;

      const codeA = byok.pairing.createPairingCode().code;
      const deviceA = await connectFakeDaemon(started.baseUrl, started.port, codeA, {
        productId: PRODUCT_ID,
        deviceName: 'device-a',
      });
      ws = deviceA.ws;

      const codeB = byok.pairing.createPairingCode().code;
      // Device B never needs a live connection for this test — POST
      // /byok/messages only requires a valid bearer token, independent of
      // WS/long-poll transport state.
      const deviceB = await pairFakeDaemon(started.baseUrl, codeB, { deviceName: 'device-b' });

      const handle = await byok.dispatch({ instruction: 'owned by A', deviceId: deviceA.deviceId });
      await claimAndStart(deviceA.ws, deviceA.deviceId, handle);
      expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');

      const iter = handle.events()[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) await iter.next(); // drain Offered, Claimed, Running

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

      // Dropped + logged, never force-failed: a force-fail here would be a
      // DoS an attacker (device B, having merely guessed A's taskId) could
      // use to kill A's real task.
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();

      expect(byok.tasks.get(handle.taskId)?.state).toBe('Running'); // untouched — NOT Complete, NOT Failed
      await expectNoMoreEvents(iter);
    });
  });

  describe('POST /byok/messages restricts to daemon->server task.* types (P2)', () => {
    it('a task.offer or conn.ack in the batch is rejected, not counted accepted, and has no side effect', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
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
      expect(byok.tasks.get('task_forged')).toBeUndefined(); // never reached the taskStore at all
    });

    it('a valid daemon->server envelope alongside a rejected one is partially accepted (per-envelope, not whole-batch)', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      const handle = await byok.dispatch({ instruction: 'x' });
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
      expect(byok.tasks.get(handle.taskId)?.state).toBe('Claimed');
    });
  });

  describe('cancel/reject redelivery survives the terminal-task filter (N1/F4)', () => {
    it('collectRelevant (via GET /byok/events) includes an exempted task.cancel for an already-terminal task, and excludes task.offer/task.steer/task.approve for terminal tasks', async () => {
      const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
      const started = await startServer(byok);
      server = started.server;
      const { code } = byok.pairing.createPairingCode();
      const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
      ws = daemon.ws;

      // task1: Running -> steer (non-exempt, non-terminal at send time) -> cancel (exempt, terminal at send time).
      const handle1 = await byok.dispatch({ instruction: 'task one' });
      await claimAndStart(ws, daemon.deviceId, handle1);
      await handle1.steer('keep going');
      await handle1.cancel('changed my mind');
      await handle1.result();
      expect(byok.tasks.get(handle1.taskId)?.state).toBe('Cancelled');

      // task2: Running -> AwaitApproval -> approve (non-exempt, non-terminal
      // at send time) -> cancel (exempt, terminal at send time) — proves
      // approve's exemption would be moot (it's never sent on an
      // already-terminal task) while still confirming it doesn't survive
      // the filter once the task later goes terminal for an unrelated reason.
      const handle2 = await byok.dispatch({ instruction: 'task two' });
      await claimAndStart(ws, daemon.deviceId, handle2);
      send(ws, createEnvelope('task.await_approval', { summary: 'need ok' }, { taskId: handle2.taskId }));
      await waitForTaskEvent(handle2, (e) => e.kind === 'await_approval');
      await handle2.approve();
      await handle2.cancel('done after all');
      await handle2.result();
      expect(byok.tasks.get(handle2.taskId)?.state).toBe('Cancelled');

      // Switch this device to long-poll (supersedes the WS, §8 "last one
      // wins") purely to read back collectRelevant's output through the
      // public surface without a full reconnect/redelivery dance.
      const res = await fetch(`${started.baseUrl}/byok/events?cursor=0`, {
        headers: { authorization: `Bearer ${daemon.accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: Envelope[]; cursor: number };
      const seen = body.events.map((e) => `${e.type}:${e.task_id ?? ''}`);

      expect(seen).toContain(`task.cancel:${handle1.taskId}`);
      expect(seen).toContain(`task.cancel:${handle2.taskId}`);
      expect(seen).not.toContain(`task.offer:${handle1.taskId}`);
      expect(seen).not.toContain(`task.offer:${handle2.taskId}`);
      expect(seen).not.toContain(`task.steer:${handle1.taskId}`);
      expect(seen).not.toContain(`task.approve:${handle2.taskId}`);
    });
  });
});
