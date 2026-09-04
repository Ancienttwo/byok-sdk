import type { Server as HttpServer } from 'node:http';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import type { ServerTaskEvent } from '../types';
import {
  claimAndStart,
  connectFakeDaemonLongPoll,
  nextEnvelope,
  PI_RUNTIME_INFO,
  sendOne,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll deliberately expecting nothing costs ~200ms, not ~50s. */
const SHORT_HOLD_MS = 200;

/**
 * Transport: LONG-POLL ONLY. WP3B Step 2b deleted the WebSocket path, so every
 * fixture here drives `POST /byok/messages` and `GET /byok/events`.
 *
 * Timing discipline follows Step 0's: `POST /byok/messages` applies its
 * envelopes synchronously inside the request, so an awaited `send` is itself
 * the barrier for every state change it caused — no fixed sleep is ever a
 * completion signal.
 */
describe('server integration (in-process http, fake long-poll daemon client)', () => {
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
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('an older Local Agent release remains observable and completes work when protocol and capabilities match', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      clientVersion: '0.5.0',
      configuredToolsets: ['salesko.connectors'],
    });

    expect(await started.byok.machines.list()).toEqual([
      expect.objectContaining({
        deviceId: daemon.deviceId,
        deviceName: 'test-laptop',
        connected: true,
        clientVersion: '0.5.0',
        configuredToolsets: ['salesko.connectors'],
      }),
    ]);

    const handle = await started.byok.dispatch({ instruction: 'say hello' });
    expect(handle.taskId).toBeTruthy();
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Offered');

    const offerEnvelope = await nextEnvelope(daemon);
    expect(offerEnvelope.type).toBe('task.offer');
    if (offerEnvelope.type !== 'task.offer') throw new Error('unreachable');
    // M1 gap #7: taskId is no longer duplicated in the payload — the envelope's `task_id` is the sole routing key.
    expect(offerEnvelope.task_id).toBe(handle.taskId);
    // Per-device `seq` is one shared counter across all server->daemon types
    // (§1.2). The offer is `1` rather than the pre-fold `2` because there is no
    // `conn.ack` row over long-poll: the announcement is answered by the
    // `POST /byok/messages` response, not by an enqueued envelope.
    expect(offerEnvelope.seq).toBe(1);
    expect(offerEnvelope.payload.instruction).toBe('say hello');
    expect(offerEnvelope.payload.policy).toEqual({ mode: 'confirm' }); // M0 fail-closed default

    await claimAndStart(started.byok, daemon, handle);
    await sendOne(
      daemon,
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
    await sendOne(
      daemon,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_1' }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_1' });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Complete');

    // events() replays from the start even though we're draining it *after*
    // the task already finished — the whole point of AsyncEventQueue — and it
    // ENDS at the terminal, so this loop terminates.
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

  it('keeps a legacy daemon with no release identity connected and does not invent one', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const [machine] = await started.byok.machines.list();
    expect(machine).toMatchObject({ deviceId: daemon.deviceId, connected: true });
    expect(machine).not.toHaveProperty('clientVersion');
  });

  it('events() ends at the terminal, not when the retention window expires', async () => {
    // The retention window is set an hour out, so the ONLY thing that can end
    // either iteration below is the terminal transition closing the feed. A
    // reclamation-terminated iterator would hang here instead — which is what
    // this pins: retention decides when the buffer is dropped, never when a
    // consumer's `for await` completes.
    const instance = createByokServer({
      productId: PRODUCT_ID,
      longPollHoldMs: SHORT_HOLD_MS,
      taskEventRetentionMs: 60 * 60_000,
    });
    const startedServer = await startServer(instance);
    server = startedServer.server;
    byok = instance;
    const daemon = await connectFakeDaemonLongPoll(startedServer.baseUrl, instance, { productId: PRODUCT_ID });

    const handle = await instance.dispatch({ instruction: 'end at the terminal' });
    await nextEnvelope(daemon); // task.offer

    // A consumer already iterating when the terminal lands.
    const live = (async () => {
      const seen: ServerTaskEvent[] = [];
      for await (const event of handle.events()) seen.push(event);
      return seen;
    })();

    await claimAndStart(instance, daemon, handle);
    await sendOne(
      daemon,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_end' }, { taskId: handle.taskId }),
    );

    expect((await live).map((e) => (e.kind === 'state' ? e.state : null))).toEqual([
      'Offered',
      'Claimed',
      'Running',
      'Complete',
    ]);

    // ...and one that only subscribes afterwards still replays the whole feed
    // from the start and then ends, because closing does not empty the buffer.
    const late: ServerTaskEvent[] = [];
    for await (const event of handle.events()) late.push(event);
    expect(late).toEqual(await live);
  });

  it('task.claim is an idempotent CAS: a retried claim from the same device is a no-op', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ instruction: 'say hello' });
    await nextEnvelope(daemon); // task.offer

    const claimEnvelope = createEnvelope(
      'task.claim',
      { deviceId: daemon.deviceId },
      { taskId: handle.taskId },
    );
    const startedEnvelope = createEnvelope('task.started', {}, { taskId: handle.taskId });
    expect(await sendOne(daemon, claimEnvelope)).toEqual({ status: 200, body: { accepted: 1 } });
    expect(await sendOne(daemon, startedEnvelope)).toEqual({ status: 200, body: { accepted: 1 } });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');

    // Retry the exact same claim (e.g. the daemon didn't observe the first
    // one land) — must not be treated as an illegal Running -> Claimed move.
    await sendOne(daemon, claimEnvelope);
    // Same for a retried task.started (§3.1): a repeat from the owning
    // device while already Running is a no-op, not an illegal transition.
    await sendOne(daemon, startedEnvelope);
    await sendOne(
      daemon,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_3' }, { taskId: handle.taskId }),
    );

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
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ instruction: 'a long task' });
    const offer = await nextEnvelope(daemon);
    expect(offer.type).toBe('task.offer');

    await handle.cancel('changed my mind');

    const cancelEnvelope = await nextEnvelope(daemon);
    expect(cancelEnvelope.type).toBe('task.cancel');
    if (cancelEnvelope.type !== 'task.cancel') throw new Error('unreachable');
    expect(cancelEnvelope.payload.reason).toBe('changed my mind');

    const result = await handle.result();
    expect(result).toEqual({ state: 'Cancelled', reason: 'changed my mind' });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Cancelled');

    // cancel() is idempotent: calling it again on a terminal task is a no-op, not a throw.
    await expect(handle.cancel('again')).resolves.toBeUndefined();
  });

  it('await_approval -> approve path resumes the task to Running', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ instruction: 'do something risky' });
    await nextEnvelope(daemon); // task.offer
    await claimAndStart(started.byok, daemon, handle);

    // The daemon reports an `approvalId` (M5, docs/protocol.md §5.3), which is
    // what a current build sends. 2d gap: the PRE-M5 shape — an
    // `task.await_approval` with no id at all — is the narrow hole recorded in
    // 2a's Deviations: the kernel's `approval_resolved` requires a non-blank
    // `approvalId`, so a host decision on an unidentified approval reaches the
    // device but cannot be written to the timeline the read model derives from,
    // and `tasks.get()` keeps reporting `AwaitApproval` while `events()` already
    // reports `Running`. That path is not covered here and is flagged in the
    // notes rather than worked around.
    await sendOne(
      daemon,
      createEnvelope(
        'task.await_approval',
        { summary: 'about to rm -rf /tmp/scratch', approvalId: 'approval-1' },
        { taskId: handle.taskId },
      ),
    );
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');

    await handle.approve();

    const approveEnvelope = await nextEnvelope(daemon);
    expect(approveEnvelope.type).toBe('task.approve');
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');

    await sendOne(
      daemon,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_2' }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_2' });
  });
});

describe('redelivery from a stale cursor (§9)', () => {
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
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  async function pageAt(daemon: FakeLongPollDaemon, cursor: number): Promise<Envelope[]> {
    const res = await daemon.replay(cursor);
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: Envelope[] }).events;
  }

  it('redelivers non-terminal envelopes in seq order, honoring the cursor, skips envelopes for terminal tasks except exempted cancel/reject (N1/F4)', async () => {
    const started = await start();
    // S0: this device must advertise a runtime that can actually be steered
    // (pi) and claim task1 as that runtime — the steer gate reads the
    // claim-time capability snapshot, so a runtime-less claim here would
    // (correctly) be refused before any envelope existed to redeliver.
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      runtimes: [PI_RUNTIME_INFO],
    });

    // task1 stays Running — steer() below produces an envelope the daemon
    // never reads before it "drops".
    const handle1 = await started.byok.dispatch({ instruction: 'long running task' });
    const offer1 = (await pageAt(daemon, 0))[0];
    if (offer1?.type !== 'task.offer') throw new Error('unreachable');
    const cursor = offer1.seq; // "I've fully processed everything through this seq"

    await claimAndStart(started.byok, daemon, handle1, 'pi', PI_RUNTIME_INFO.capabilities);
    await handle1.steer('keep going'); // assigns the next seq; deliberately never read

    // task2 is cancelled before the resync — terminal by the time redelivery
    // runs. Its task.offer is NOT exempt from the terminal-task filter and
    // must not be redelivered; its task.cancel IS exempt (N1/F4) precisely
    // because a cancellation is recorded BEFORE the notification is queued, so
    // without the exemption a dropped cancel could never be redelivered.
    const handle2 = await started.byok.dispatch({ instruction: 'short task' });
    await handle2.cancel('not needed after all');
    await handle2.result();
    expect((await started.byok.tasks.get(handle2.taskId))?.state).toBe('Cancelled');

    // Resync from the stale cursor: reading does not ack, so this is exactly
    // what a daemon that dropped mid-page asks for.
    const redelivered = await pageAt(daemon, cursor);
    expect(
      redelivered.map((envelope) => ({ type: envelope.type, taskId: envelope.task_id })),
    ).toEqual([
      { type: 'task.steer', taskId: handle1.taskId },
      { type: 'task.cancel', taskId: handle2.taskId },
    ]);
    const steer = redelivered[0];
    if (steer?.type !== 'task.steer') throw new Error('unreachable');
    expect(steer.payload.text).toBe('keep going');
  });
});

describe('task lifecycle: task.started / task.decline / task.cancelled + idempotency (§3, §9)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function startWithDaemon(): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    return { byok: instance, daemon };
  }

  it('task.decline moves Offered -> Failed (pre-claim fail-closed rejection, §3.2)', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'unsupported instruction shape' });
    await nextEnvelope(daemon); // offer

    await sendOne(
      daemon,
      createEnvelope('task.decline', { reason: 'no compatible runtime', retryable: true }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Failed', reason: 'no compatible runtime', retryable: true });
  });

  // 2d gap: "a decline is only legal pre-claim" was a rule of the deleted task
  // FSM (`IllegalTaskTransitionError`, `task-store.ts`). The kernel has no
  // execution state machine by design (ADR-028: no execution state in the
  // cloud) — an attempt carries a coarse status and the inbound gate decides
  // ownership and dedup, not legality of a transition — so a late decline is
  // applied rather than dropped as stale. Same family as the FSM assertions
  // 2b's conformance-coverage skim classified as "(A) the concept is deleted;
  // there is nothing to cover".
  it.skip('a task.decline arriving after the task was already claimed is a stale no-op', () => {
    // intentionally empty — see the 2d gap note above.
  });

  // 2d gap: `Offered -> Running is illegal` is verbatim the deleted FSM rule
  // (`IllegalTaskTransitionError` on `Offered -> Running`), named in 2b's
  // conformance-coverage skim under "(A) the concept is deleted; there is
  // nothing to cover (ADR-028)". The kernel records the coarse status the
  // envelope reports and never force-fails a task for arriving out of order, so
  // there is no terminal here and `result()` never settles.
  it.skip('task.started arriving before any claim forces the task to Failed (Offered -> Running is illegal)', () => {
    // intentionally empty — see the 2d gap note above.
  });

  it('task.cancelled is the authoritative trigger when the daemon observes a cancellation the server did not initiate', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'x' });
    await nextEnvelope(daemon);
    await claimAndStart(instance, daemon, handle);

    // No handle.cancel() call — the daemon decided locally (e.g. a local
    // stop action in the branded CLI's UI) and reports it directly.
    await sendOne(
      daemon,
      createEnvelope('task.cancelled', { reason: 'user stopped it locally' }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result).toEqual({ state: 'Cancelled', reason: 'user stopped it locally' });
  });

  it('task.cancelled after a server-initiated cancel is a silent idempotent ack, not a warning (M0 gatekeeper finding)', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'task one' });
    await nextEnvelope(daemon);
    await claimAndStart(instance, daemon, handle);
    await handle.cancel('server decided');
    expect((await nextEnvelope(daemon)).type).toBe('task.cancel'); // best-effort notification
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Cancelled');
    const recorded = (await instance.tasks.get(handle.taskId))?.result;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The send's own response is the barrier — the kernel applied (or dropped)
    // this envelope inside the request, so no ordering marker is needed.
    await sendOne(daemon, createEnvelope('task.cancelled', { reason: 'stopped locally' }, { taskId: handle.taskId }));

    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Cancelled'); // unchanged, not re-applied
    expect((await instance.tasks.get(handle.taskId))?.result).toEqual(recorded);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('task.fail after a server-initiated cancel is also a silent stale drop, not a warning (§9)', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'task one' });
    await nextEnvelope(daemon);
    await claimAndStart(instance, daemon, handle);
    await handle.cancel('server decided');
    expect((await nextEnvelope(daemon)).type).toBe('task.cancel');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Cancelled');
    const recorded = (await instance.tasks.get(handle.taskId))?.result;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Races a server-initiated cancel that already landed — a stale
    // task.fail must not resurrect/overwrite the Cancelled outcome.
    await sendOne(
      daemon,
      createEnvelope('task.fail', { reason: 'crashed', retryable: false }, { taskId: handle.taskId }),
    );

    expect((await instance.tasks.get(handle.taskId))?.result).toEqual(recorded);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Cancelled');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('unknown AgentEvent forwarding (pre-freeze tolerance, @byok-sdk/protocol agent-event.ts)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  it('forwards an unknown-type event alongside a known one instead of dropping it or throwing, with no spurious state change', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });

    const handle = await instance.dispatch({ instruction: 'x' });
    await nextEnvelope(daemon); // offer
    await claimAndStart(instance, daemon, handle);

    // `future_thinking` is not a KNOWN_AGENT_EVENT_TYPES literal — it's the
    // shape a newer daemon/runtime-adapter minor version might produce that
    // this build doesn't recognize yet. It must still validate (as the
    // UnknownAgentEventSchema passthrough) and must still reach the
    // embedder, not be dropped.
    const progressed = await sendOne(
      daemon,
      createEnvelope(
        'task.progress',
        {
          seq: 1,
          events: [
            { type: 'progress', text: 'known' },
            { type: 'future_thinking', budget: 42 },
          ],
        },
        { taskId: handle.taskId },
      ),
    );
    // Accepted rather than refused: handling the unknown event neither threw
    // nor rejected the batch.
    expect(progressed).toEqual({ status: 200, body: { accepted: 1 } });

    // No spurious state change from the unknown event — still Running, and
    // completes normally afterward, proving it didn't corrupt task state.
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    await sendOne(
      daemon,
      createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_unknown_evt' }, { taskId: handle.taskId }),
    );
    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_unknown_evt' });

    const events: ServerTaskEvent[] = [];
    for await (const event of handle.events()) events.push(event);
    const agentEvents = events.filter((e) => e.kind === 'agent');
    expect(agentEvents.map((e) => (e.kind === 'agent' ? e.event.type : null))).toEqual(['progress', 'future_thinking']);
    // The unknown event's extra field survived passthrough intact — not
    // stripped down to just `{ type }`.
    const unknownEvent = agentEvents[1];
    expect(unknownEvent?.kind === 'agent' ? unknownEvent.event : undefined).toEqual({
      type: 'future_thinking',
      budget: 42,
    });
  });
});
