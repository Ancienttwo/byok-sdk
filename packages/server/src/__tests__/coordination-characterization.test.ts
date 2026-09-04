import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import {
  createByokServer,
  StaleApprovalError,
  SteerRejectedError,
  type ByokServer,
  type TaskHandle,
} from '../index';
import {
  CLAUDE_RUNTIME_INFO,
  connectFakeDaemonLongPoll,
  PI_RUNTIME_INFO,
  stopServer,
  type FakeLongPollDaemon,
} from './test-support';

/**
 * WP3B Step 0 — coordination characterization
 * (`docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md`
 * §5, ten cases; §7 Step 0).
 *
 * These ten cases pin today's `@byok-sdk/server` coordination semantics on
 * the PUBLIC surface only: `createByokServer` goes in; HTTP status/body,
 * `TaskHandle`, `byok.tasks.get/list`, `byok.machines.list`, and
 * `byok.stats()` come out. Nothing here imports `hub.ts`, `http.ts`, or any
 * other internal module — only the package index and the two exported error
 * classes it re-exports — so every assertion below must survive Step 2's
 * deletion of `hub.ts` byte-for-byte. A case that needed an internal to be
 * expressed would be a Step 1 gap, recorded in the notes, not a licence to
 * reach inside.
 *
 * Transport: LONG-POLL ONLY. {@link startHttpOnlyServer} deliberately mounts
 * only `byok.hono.fetch`, so no WS upgrade handler exists on any
 * server in this file and no `ws` client is ever constructed — the WS
 * transport is deleted in Step 2b, and a pin that depended on it would die
 * with it. This is also what makes case 1's "no WS ever opened" a structural
 * property of the whole file rather than one test's claim.
 *
 * Timing discipline: no fixed sleep is ever used as a completion signal.
 * `POST /byok/messages` applies its envelopes synchronously inside the
 * request, so an awaited `send()` is itself the barrier for every state
 * change it caused; where a barrier genuinely cannot be derived that way
 * (the rate limiter's wall-clock refill, case 10) the test polls a public
 * read with a bounded deadline instead.
 */

const PRODUCT_ID = 'acme';
/**
 * `GET /byok/events` hold. Short so the cases that deliberately prove an
 * EMPTY page (6, 9) cost ~200ms instead of the ~50s default; never asserted
 * on, since hold timing is a `hub.ts` implementation detail Step 2 may
 * change.
 */
const SHORT_HOLD_MS = 200;
/**
 * Retention cutoff for case 7's sweep: a canonical ISO-8601 UTC instant far
 * enough ahead that every row appended before the call is past it, so the sweep
 * depends on nothing about how fast the test ran. Retention is a TIME cutoff,
 * never a count — that is the whole difference from the replay ring this case
 * used to pin.
 */
const SWEEP_EVERYTHING_BEFORE = '2999-01-01T00:00:00.000Z';

/**
 * This file needs a server that provably cannot speak WS at all (see the file
 * header), so it serves `byok.hono.fetch` and nothing else. Hostname pinning matches
 * `startServer`'s for the same reason it does there (`port-shadowing.test.ts`).
 */
async function startHttpOnlyServer(
  byok: ByokServer,
): Promise<{ server: HttpServer; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: byok.hono.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server: server as HttpServer, baseUrl: `http://127.0.0.1:${String(info.port)}` });
    });
  });
}

/** Poll a public read until it holds, or fail loudly at `timeoutMs`. Never a completion signal for a state change the test itself caused. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sendOne(daemon: FakeLongPollDaemon, envelope: Envelope): Promise<{ status: number; body: unknown }> {
  const res = await daemon.send(envelope);
  return { status: res.status, body: await res.json() };
}

/** Offered -> Claimed -> Running over the long-poll send path, asserting each hop landed. */
async function claimAndStartOverLongPoll(
  byok: ByokServer,
  daemon: FakeLongPollDaemon,
  handle: TaskHandle,
  runtime?: 'pi' | 'claude' | 'codex',
  capabilities?: { steer?: boolean; resume?: boolean; approvalInteractive?: boolean; permissionModes?: string[] },
): Promise<void> {
  const claimEnvelope = createEnvelope(
    'task.claim',
    { deviceId: daemon.deviceId, runtime, capabilities: capabilities as never },
    { taskId: handle.taskId },
  );
  const claim = await sendOne(daemon, claimEnvelope);
  expect(claim).toEqual({
    status: 200,
    body: { outcomes: [{ id: claimEnvelope.id, outcome: 'accepted' }] },
  });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('Claimed');

  const startedEnvelope = createEnvelope('task.started', {}, { taskId: handle.taskId });
  const started = await sendOne(daemon, startedEnvelope);
  expect(started).toEqual({
    status: 200,
    body: { outcomes: [{ id: startedEnvelope.id, outcome: 'accepted' }] },
  });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('Running');
}

describe('WP3B Step 0: coordination characterization (public surface, long-poll only)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(opts: Parameters<typeof createByokServer>[0] = { productId: PRODUCT_ID }): Promise<{
    byok: ByokServer;
    baseUrl: string;
  }> {
    const instance = createByokServer({ longPollHoldMs: SHORT_HOLD_MS, ...opts });
    const started = await startHttpOnlyServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  // -------------------------------------------------------------------
  // §5.1
  // -------------------------------------------------------------------

  it('case 1: pair -> challenge -> token -> dispatch delivers the first task.offer over long-poll, with no WebSocket anywhere', async () => {
    const started = await start();
    // The fixture itself is the pair -> challenge -> token leg: the token it
    // returns came from `POST /byok/token`, not from the pairing response,
    // so everything below is authenticated by the RENEWED credential.
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    // conn.hello over `POST /byok/messages` is the long-poll equivalent of
    // the WS handshake: presence is established with no socket at all.
    expect(await started.byok.machines.list()).toEqual([
      expect.objectContaining({ deviceId: daemon.deviceId, connected: true }),
    ]);

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'first offer' });

    expect(daemon.cursor()).toBe(0);
    const page = await daemon.next();
    expect(page.map((envelope) => envelope.type)).toEqual(['task.offer']);
    expect(page[0]?.task_id).toBe(handle.taskId);
    expect(daemon.cursor()).toBeGreaterThan(0);
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Offered');
  });

  // -------------------------------------------------------------------
  // §5.2 — the §3 invariant: `result()` and `tasks.get()` are the same fact.
  // -------------------------------------------------------------------

  it('case 2: TaskHandle.result() and tasks.get() report the completed task field by field', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'do the thing' });
    await daemon.next();
    await claimAndStartOverLongPoll(started.byok, daemon, handle);

    const completeEnvelope = createEnvelope(
      'task.complete',
      { summary: 'all done', sessionRef: 'session-abc', document: { ok: true, items: [1, 2, 3] } },
      { taskId: handle.taskId },
    );
    const complete = await sendOne(daemon, completeEnvelope);
    expect(complete).toEqual({
      status: 200,
      body: { outcomes: [{ id: completeEnvelope.id, outcome: 'accepted' }] },
    });

    const result = await handle.result();
    const snapshot = await started.byok.tasks.get(handle.taskId);
    if (snapshot === undefined) throw new Error('tasks.get() lost the task it just completed');

    // Field by field, both directions — the handle must never be a second
    // authority that can answer differently from the store.
    expect(result).toEqual(snapshot.result);
    expect(result.state).toBe('Complete');
    expect(result.state).toBe(snapshot.state);
    expect(result.summary).toBe('all done');
    expect(result.sessionRef).toBe('session-abc');
    expect(result.sessionRef).toBe(snapshot.sessionRef);
    expect(result.document).toEqual({ ok: true, items: [1, 2, 3] });
    expect(result.artifactRefs).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.retryable).toBeUndefined();

    // Timestamps: `TaskSnapshot` is the only one of the two that exposes
    // any (`TaskResult` carries none), so the pin is that the snapshot's own
    // pair is coherent across the terminal transition.
    expect(Date.parse(snapshot.updatedAt)).toBeGreaterThanOrEqual(Date.parse(snapshot.createdAt));

    // Re-reading is stable: `result()` is not a one-shot drain.
    expect(await handle.result()).toEqual(snapshot.result);
    expect((await started.byok.tasks.list()).tasks).toEqual([snapshot]);
  });

  // -------------------------------------------------------------------
  // §5.3
  // -------------------------------------------------------------------

  it('case 3: first terminal wins — a second task.complete with a different payload never overwrites the recorded result', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'race the terminal' });
    await daemon.next();
    await claimAndStartOverLongPoll(started.byok, daemon, handle);

    const firstEnvelope = createEnvelope(
      'task.complete',
      { summary: 'first', sessionRef: 'session-first' },
      { taskId: handle.taskId },
    );
    const first = await sendOne(daemon, firstEnvelope);
    expect(first).toEqual({
      status: 200,
      body: { outcomes: [{ id: firstEnvelope.id, outcome: 'accepted' }] },
    });
    const recorded = (await started.byok.tasks.get(handle.taskId))?.result;
    expect(recorded).toEqual({ state: 'Complete', summary: 'first', sessionRef: 'session-first', artifactRefs: undefined, document: undefined });

    // A distinct envelope (own `id`, different payload) for an
    // already-terminal task: the fresh envelope is accepted while the handler
    // drops it silently (§9 stale-terminal rule).
    const secondEnvelope = createEnvelope(
      'task.complete',
      { summary: 'second', sessionRef: 'session-second' },
      { taskId: handle.taskId },
    );
    const second = await sendOne(daemon, secondEnvelope);
    expect(second).toEqual({
      status: 200,
      body: { outcomes: [{ id: secondEnvelope.id, outcome: 'accepted' }] },
    });

    expect((await started.byok.tasks.get(handle.taskId))?.result).toEqual(recorded);
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Complete');
    expect((await started.byok.tasks.get(handle.taskId))?.sessionRef).toBe('session-first');
    expect(await handle.result()).toEqual(recorded);
  });

  // -------------------------------------------------------------------
  // §5.4
  // -------------------------------------------------------------------

  it('case 4: cancel() is authoritative immediately — a late task.complete leaves the result Cancelled', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'cancel me' });
    await daemon.next();
    await claimAndStartOverLongPoll(started.byok, daemon, handle);

    await handle.cancel('operator stopped it');
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Cancelled');

    const lateEnvelope = createEnvelope(
      'task.complete',
      { summary: 'finished anyway', sessionRef: 'session-late', document: { applied: true } },
      { taskId: handle.taskId },
    );
    const late = await sendOne(daemon, lateEnvelope);
    expect(late).toEqual({
      status: 200,
      body: { outcomes: [{ id: lateEnvelope.id, outcome: 'accepted' }] },
    });

    const result = await handle.result();
    expect(result.state).toBe('Cancelled');
    expect(result.reason).toBe('operator stopped it');
    expect(result.summary).toBeUndefined();
    expect(result.document).toBeUndefined();
    expect((await started.byok.tasks.get(handle.taskId))?.result).toEqual(result);
    expect((await started.byok.tasks.get(handle.taskId))?.sessionRef).toBeUndefined();

    // The cancellation notification is still redelivered through the
    // terminal state (N1/F4) — the device is told to stop local work.
    expect((await daemon.next()).map((envelope) => envelope.type)).toEqual(['task.cancel']);
  });

  // -------------------------------------------------------------------
  // §5.5
  // -------------------------------------------------------------------

  it('case 5: approval targeting — the previous round\'s approvalId is stale, the current one resolves', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'two approvals' });
    await daemon.next();
    await claimAndStartOverLongPoll(started.byok, daemon, handle);

    // Round one.
    const roundOneEnvelope = createEnvelope(
      'task.await_approval',
      { summary: 'round one', approvalId: 'approval-1' },
      { taskId: handle.taskId },
    );
    expect(await sendOne(daemon, roundOneEnvelope)).toEqual({
      status: 200,
      body: { outcomes: [{ id: roundOneEnvelope.id, outcome: 'accepted' }] },
    });
    expect((await started.byok.tasks.get(handle.taskId))?.pendingApprovalId).toBe('approval-1');
    await handle.approve({ approvalId: 'approval-1' });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');
    // Leaving AwaitApproval clears the id centrally, so round two can never
    // inherit it.
    expect((await started.byok.tasks.get(handle.taskId))?.pendingApprovalId).toBeUndefined();

    // Round two.
    const roundTwoEnvelope = createEnvelope(
      'task.await_approval',
      { summary: 'round two', approvalId: 'approval-2' },
      { taskId: handle.taskId },
    );
    expect(await sendOne(daemon, roundTwoEnvelope)).toEqual({
      status: 200,
      body: { outcomes: [{ id: roundTwoEnvelope.id, outcome: 'accepted' }] },
    });
    expect((await started.byok.tasks.get(handle.taskId))?.pendingApprovalId).toBe('approval-2');

    const stale = await handle.approve({ approvalId: 'approval-1' }).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(StaleApprovalError);
    if (!(stale instanceof StaleApprovalError)) throw new Error('unreachable');
    expect(stale.taskId).toBe(handle.taskId);
    expect(stale.requestedApprovalId).toBe('approval-1');
    expect(stale.currentApprovalId).toBe('approval-2');

    // Zero side effects: no transition, and nothing new in the mailbox.
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');
    expect((await started.byok.tasks.get(handle.taskId))?.pendingApprovalId).toBe('approval-2');

    await handle.approve({ approvalId: 'approval-2' });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');
    expect((await started.byok.tasks.get(handle.taskId))?.pendingApprovalId).toBeUndefined();

    // Exactly one `task.approve` per successful approval reached the device
    // (the stale attempt contributed none).
    expect((await daemon.next()).map((envelope) => envelope.type)).toEqual(['task.approve', 'task.approve']);
  });

  // -------------------------------------------------------------------
  // §5.6
  // -------------------------------------------------------------------

  it('case 6: the steer gate reads the claim, not the connection — a steerable conn.hello does not unlock a non-steerable claim', async () => {
    const started = await start();
    // The CONNECTION declares a steerable runtime (pi, `steer: true`).
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      runtimes: [PI_RUNTIME_INFO, CLAUDE_RUNTIME_INFO],
    });
    expect((await started.byok.machines.list())[0]?.runtimes).toEqual([PI_RUNTIME_INFO, CLAUDE_RUNTIME_INFO]);
    expect((await started.byok.machines.list())[0]?.runtimes?.some((info) => info.capabilities?.steer === true)).toBe(true);

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'steer me' });
    await daemon.next();
    // The CLAIM reports claude (`steer: false`) — that is the authority.
    await claimAndStartOverLongPoll(started.byok, daemon, handle, 'claude', CLAUDE_RUNTIME_INFO.capabilities);
    expect((await started.byok.tasks.get(handle.taskId))?.claimedRuntime).toBe('claude');
    expect((await started.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities).toEqual(CLAUDE_RUNTIME_INFO.capabilities);

    const rejection = await handle.steer('change course').catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(SteerRejectedError);
    if (!(rejection instanceof SteerRejectedError)) throw new Error('unreachable');
    expect(rejection.code).toBe('steer_unsupported_runtime');
    expect(rejection.runtime).toBe('claude');
    expect(rejection.state).toBe('Running');

    // Refused BEFORE any envelope exists: the device's next page is empty.
    expect(await daemon.next()).toEqual([]);
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');
  });

  // -------------------------------------------------------------------
  // §5.7 — GAP-3.
  //
  // RE-PINNED in WP3B Step 2 (the ONE Step 0 case that was, see the packet's
  // §5 item 7 and §8). The original pin was written against `hub.ts`'s
  // in-process outbox, which kept a 500-entry ring of ALREADY-ACKED entries and
  // replayed them: "the same cursor twice returns a byte-identical page" held
  // even after those rows had been consumed, and the only way to move the
  // recoverable floor was to overflow that ring by count.
  //
  // The kernel's mailbox is a different, stronger contract, and it is the one
  // hosted production already runs on:
  //
  //   - READING IS NOT ACKING. `readAfter` mutates nothing, so two reads at the
  //     same cursor return the same page for as long as nothing was acked.
  //   - THE ACK IS MONOTONIC AND IRREVERSIBLE. The only ack is the cursor the
  //     daemon brings back on its NEXT poll; it retires the rows at or below it,
  //     and a later poll from a LOWER cursor neither un-acks them nor sees them
  //     again. Consumed is not lost.
  //   - THE FLOOR MOVES ON EXPIRY, NOT ON CAPACITY. `recoverableFrom` is one
  //     past the highest row DEAD-LETTERED by a retention sweep, so `409
  //     cursor_too_old` is reachable only through expiry — never by appending
  //     more rows. The 500-entry replay ring is dropped, not rebuilt: a second
  //     count-bounded store beside the mailbox would be a second retention
  //     authority for the same rows.
  //
  // Every assertion below is on the same public surface as before
  // (`GET /byok/events` status + body). `byok.mailbox.collectRetired` is the
  // host control-plane sweep core defines and this façade forwards verbatim —
  // it names no policy, and nothing in the stack runs it on a timer.
  // -------------------------------------------------------------------

  it('case 7: reading does not ack, an ack is irreversible, and a cursor below rows lost to expiry fails closed with 409 cursor_too_old', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const handles: TaskHandle[] = [];
    for (let index = 0; index < 3; index++) {
      handles.push(await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: `replay-${String(index)}` }));
    }

    const readPage = async (cursor: number): Promise<{ status: number; taskIds: string[]; cursor: number }> => {
      const res = await daemon.replay(cursor);
      const body = (await res.json()) as { events: Envelope[]; cursor: number };
      return { status: res.status, taskIds: body.events.map((envelope) => envelope.task_id ?? ''), cursor: body.cursor };
    };

    const expectedIds = handles.map((handle) => handle.taskId);

    // (a) Reading is not acking: the same cursor twice, byte-identical page.
    const firstRead = await readPage(0);
    const secondRead = await readPage(0);
    expect(firstRead.status).toBe(200);
    expect(firstRead.taskIds).toEqual(expectedIds);
    expect(secondRead).toEqual(firstRead);

    // (b) The ONLY ack is the cursor the daemon brings back on its next poll.
    // `next()` reads at 0 and adopts the returned cursor; the `next()` after it
    // is the poll that carries it, and that is what retires rows 1..3.
    await daemon.next();
    expect(daemon.cursor()).toBe(firstRead.cursor);
    expect(await daemon.next()).toEqual([]);

    // A row appended after the ack is still pending and still owed.
    const afterAck = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'after-ack' });

    // Going BACK below the ack watermark returns ONLY what is still pending —
    // the acked rows are gone from the delivery set, not replayed — and does
    // not un-ack them...
    const backwards = await readPage(0);
    expect(backwards.status).toBe(200);
    expect(backwards.taskIds).toEqual([afterAck.taskId]);

    // ...which the next poll at the higher cursor proves: nothing that was
    // acked is re-delivered, only the row that was never acked.
    const forwards = await readPage(firstRead.cursor);
    expect(forwards.status).toBe(200);
    expect(forwards.taskIds).toEqual([afterAck.taskId]);

    // (c) The floor moves only when rows are LOST. `after-ack` was delivered
    // twice and never acked, so the sweep dead-letters it (the acked rows above
    // it are deleted, which is not a loss and moves nothing); the cutoff is a
    // timestamp, so a canonical far-future instant retires everything appended
    // so far and nothing appended later.
    const swept = await started.byok.mailbox.collectRetired({
      deviceId: daemon.deviceId,
      ackedBefore: SWEEP_EVERYTHING_BEFORE,
      expireUnackedBefore: SWEEP_EVERYTHING_BEFORE,
    });
    expect(swept.expiredCount).toBe(1);

    // A row that arrives after the sweep is inside the retained window.
    const afterSweep = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'after-sweep' });

    const gapRes = await daemon.replay(0);
    expect(gapRes.status).toBe(409);
    const gapBody = (await gapRes.json()) as { error: string; recoverableFrom: number };
    expect(gapBody.error).toBe('cursor_too_old');
    expect(gapBody.recoverableFrom).toBeGreaterThan(1);

    // The floor is a boundary, not a hint: one below it still fails closed.
    expect((await daemon.replay(gapBody.recoverableFrom - 2)).status).toBe(409);

    // `recoverableFrom - 1` is still serviceable — a caller sitting exactly at
    // the floor is served the retained tail rather than forced to resync.
    const recovered = await readPage(gapBody.recoverableFrom - 1);
    expect(recovered.status).toBe(200);
    expect(recovered.taskIds).toEqual([afterSweep.taskId]);
  });

  // -------------------------------------------------------------------
  // §5.8
  // -------------------------------------------------------------------

  it('case 8: an identical envelope id applies once, and a foreign device cannot terminate someone else\'s task', async () => {
    const started = await start();
    const owner = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    const stranger = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName: 'stranger-laptop',
    });
    expect(stranger.deviceId).not.toBe(owner.deviceId);

    const handle = await started.byok.dispatch({ deviceId: owner.deviceId, instruction: 'dedup and ownership' });
    await owner.next();
    await claimAndStartOverLongPoll(started.byok, owner, handle);

    // One envelope, sent twice. The second submission carries the same
    // `id`, which is the dedup key.
    const awaitApproval = createEnvelope(
      'task.await_approval',
      { summary: 'needs a human ok', approvalId: 'approval-dedup' },
      { taskId: handle.taskId },
    );

    expect(await sendOne(owner, awaitApproval)).toEqual({
      status: 200,
      body: { outcomes: [{ id: awaitApproval.id, outcome: 'accepted' }] },
    });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');

    await handle.approve();
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');

    const dedupBefore = (await started.byok.stats()).dedupDrops;
    // Replaying it must NOT drive the task back into AwaitApproval — that
    // observable difference is what proves it applied exactly once. The wire
    // identifies the replay as a duplicate (§8.2/§9).
    expect(await sendOne(owner, awaitApproval)).toEqual({
      status: 200,
      body: { outcomes: [{ id: awaitApproval.id, outcome: 'duplicate' }] },
    });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');
    expect((await started.byok.stats()).dedupDrops).toBe(dedupBefore + 1);

    // A different, paired, authenticated device cannot terminate a task it
    // does not own — and this one IS separately rejected, not silently
    // absorbed.
    const snapshotBefore = await started.byok.tasks.get(handle.taskId);
    const foreignEnvelope = createEnvelope(
      'task.complete',
      { summary: 'not mine', sessionRef: 'session-stranger' },
      { taskId: handle.taskId },
    );
    const foreign = await sendOne(stranger, foreignEnvelope);
    expect(foreign).toEqual({
      status: 200,
      body: { outcomes: [{ id: foreignEnvelope.id, outcome: 'rejected', reason: 'inbound_rejected' }] },
    });
    expect(await started.byok.tasks.get(handle.taskId)).toEqual(snapshotBefore);
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');
    expect((await started.byok.tasks.get(handle.taskId))?.result).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // §5.9
  // -------------------------------------------------------------------

  it('case 9: capability admission runs before the mailbox append — a refused Agent dispatch leaves no task and no outbound row', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [], // no `agent-home-contract`
    });
    expect((await started.byok.machines.list())[0]?.connected).toBe(true);

    await expect(
      started.byok.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'agent work',
        agentRef: { agentId: 'agent-1', profileRevision: 'profile-r7' },
      }),
    ).rejects.toThrow(/agent-home-contract/);

    // Nothing was created...
    expect((await started.byok.tasks.list()).tasks).toEqual([]);
    expect((await started.byok.stats()).taskCountsByState).toEqual({
      Offered: 0,
      Claimed: 0,
      Running: 0,
      AwaitApproval: 0,
      Complete: 0,
      Failed: 0,
      Cancelled: 0,
    });
    // ...and nothing was enqueued: the device's next page holds out the full
    // long-poll window and comes back empty, with the cursor still at zero.
    expect(await daemon.next()).toEqual([]);
    expect(daemon.cursor()).toBe(0);

    // A legacy (non-Agent) dispatch to the same device still works, so the
    // refusal above was the capability gate and not a dead device.
    const ok = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'plain work' });
    expect((await daemon.next()).map((envelope) => envelope.task_id)).toEqual([ok.taskId]);
  });

  // -------------------------------------------------------------------
  // §5.10 — GAP-5.
  // -------------------------------------------------------------------

  it('case 10: a rate-limit episode rejects with 429, counts every rejected envelope in stats(), and admits again after the bucket refills', async () => {
    // 1 token/s with a burst of 2: the fixture's own `conn.hello` spends one,
    // the first send below spends the other, and everything after that is
    // over budget until the bucket refills — deterministic without any
    // dependence on how fast the two requests happen to be.
    const started = await start({ productId: PRODUCT_ID, rateLimit: { messagesPerSecond: 1, burst: 2 } });
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    expect((await started.byok.stats()).rateLimitEvents).toBe(0);

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'rate limited' });
    await daemon.next(); // `GET /byok/events` is not on the inbound bucket at all.

    const admittedEnvelope = createEnvelope(
      'task.claim',
      { deviceId: daemon.deviceId },
      { taskId: handle.taskId },
    );
    const admitted = await sendOne(daemon, admittedEnvelope);
    expect(admitted).toEqual({
      status: 200,
      body: { outcomes: [{ id: admittedEnvelope.id, outcome: 'accepted' }] },
    });
    expect((await started.byok.stats()).rateLimitEvents).toBe(0);

    // Over budget: the documented long-poll enforcement is a whole-request
    // 429 (a WS device would instead be closed 1008 — there is no WS here).
    const firstRejected = await sendOne(daemon, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    expect(firstRejected).toEqual({ status: 429, body: { error: 'rate limit exceeded' } });
    expect((await started.byok.stats()).rateLimitEvents).toBe(1);

    // The counter is PER REJECTED ENVELOPE, not per episode — the
    // once-per-episode coalescing applies to the `device.rate_limited`
    // embedder event, never to `stats().rateLimitEvents`.
    const secondRejected = await sendOne(daemon, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    expect(secondRejected).toEqual({ status: 429, body: { error: 'rate limit exceeded' } });
    expect((await started.byok.stats()).rateLimitEvents).toBe(2);

    // Nothing rejected ever reached a handler.
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Claimed');

    // Once the bucket refills the same device is admitted again — the limiter
    // is a window, not a latch. Bounded poll, no fixed sleep.
    let rateLimitedWhileRecovering = 0;
    await waitFor(async () => {
      const attemptEnvelope = createEnvelope('task.started', {}, { taskId: handle.taskId });
      const attempt = await sendOne(daemon, attemptEnvelope);
      if (attempt.status === 429) {
        rateLimitedWhileRecovering++;
        return false;
      }
      expect(attempt).toEqual({
        status: 200,
        body: { outcomes: [{ id: attemptEnvelope.id, outcome: 'accepted' }] },
      });
      return true;
    });

    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Running');
    expect((await started.byok.stats()).rateLimitEvents).toBe(2 + rateLimitedWhileRecovering);
  });
});
