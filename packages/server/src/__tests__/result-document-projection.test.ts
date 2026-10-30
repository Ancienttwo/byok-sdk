import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, RESULT_DOCUMENT_MAX_BYTES, createEnvelope, type MessagesSendResponse } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type TaskHandle } from '../index';
import {
  connectFakeDaemonLongPoll,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

/** Offered -> Claimed -> Running over the long-poll send path, asserting each hop landed. */
async function claimAndStart(byok: ByokServer, daemon: FakeLongPollDaemon, handle: TaskHandle): Promise<void> {
  const claim = await daemon.send(createEnvelope('task.claim', { agentRef: TEST_AGENT_REF, deviceId: daemon.deviceId }, { taskId: handle.taskId }));
  expect(await claim.json()).toMatchObject({ accepted: 1 });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('Claimed');
  const started = await daemon.send(createEnvelope('task.started', {}, { taskId: handle.taskId }));
  expect(await started.json()).toMatchObject({ accepted: 1 });
  expect((await byok.tasks.get(handle.taskId))?.state).toBe('Running');
}

/**
 * `task.complete.document` (wire v3 baseline): the projection of the daemon's
 * structured terminal result into `TaskResult.document`, the absence of the
 * retired v2 `result-document` capability flag (v3 folded it into the
 * baseline), and the unchanged behavior of every `task.complete` that carries
 * no document.
 */
describe('additive-minor: task.complete.document projection', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function startWithDaemon(): Promise<{ byok: ByokServer; baseUrl: string; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    return { byok: instance, baseUrl: started.baseUrl, daemon };
  }

  it('no longer advertises the retired result-document capability flag on the long-poll transport', async () => {
    const { daemon } = await startWithDaemon();
    const res = await daemon.replay(0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities?: string[] };
    expect(body.capabilities).toBeInstanceOf(Array);
    expect(body.capabilities).not.toContain('result-document');
  });

  it('projects payload.document verbatim into TaskResult.document', async () => {
    const { byok: instance, daemon } = await startWithDaemon();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'produce a structured result' });
    await claimAndStart(instance, daemon, handle);

    const document = { kind: 'invoice', lines: [{ sku: 'a', qty: 2 }], total: 42.5, note: null, nested: { deep: [1, 2] } };
    await daemon.send(createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'sess_1', document }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_1', document });
    expect(result.document).toEqual(document);
    expect((await instance.tasks.get(handle.taskId))?.result?.document).toEqual(document);
  });

  it('projects payload.finalMessage into TaskResult.finalMessage, apart from the joined summary (#322)', async () => {
    const { byok: instance, daemon } = await startWithDaemon();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'reply with exactly: CONSOLIDATED' });
    await claimAndStart(instance, daemon, handle);

    await daemon.send(createEnvelope('task.complete', {
      agentRef: TEST_AGENT_REF,
      summary: 'I will consolidate memory.CONSOLIDATED',
      finalMessage: 'CONSOLIDATED',
      sessionRef: 'sess_1',
    }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({
      state: 'Complete',
      summary: 'I will consolidate memory.CONSOLIDATED',
      finalMessage: 'CONSOLIDATED',
      sessionRef: 'sess_1',
    });
    expect((await instance.tasks.get(handle.taskId))?.result?.finalMessage).toBe('CONSOLIDATED');
  });

  it('projects a non-object JSON root unchanged — the channel is schema-neutral', async () => {
    const { byok: instance, daemon } = await startWithDaemon();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'produce an array' });
    await claimAndStart(instance, daemon, handle);

    await daemon.send(
      createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'sess_1', document: [1, 'two', null] }, { taskId: handle.taskId }),
    );

    const result = await handle.result();
    expect(result.document).toEqual([1, 'two', null]);
  });

  it('leaves TaskResult.document absent when the daemon sends no document (an offer with no result-document terminal projection) — byte-identical to the pre-change result', async () => {
    const { byok: instance, daemon } = await startWithDaemon();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'no structured result' });
    await claimAndStart(instance, daemon, handle);

    await daemon.send(createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'sess_1' }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result.document).toBeUndefined();
    // Serialized (the shape that actually reaches storage and an embedder's
    // JSON boundary): no `document` key at all, exactly as before the field
    // existed.
    expect(JSON.parse(JSON.stringify(result))).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_1' });
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Complete');
  });

  it('never attaches a document to a non-Complete terminal result (task.fail is untouched by this change)', async () => {
    const { byok: instance, daemon } = await startWithDaemon();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'will fail' });
    await claimAndStart(instance, daemon, handle);

    await daemon.send(createEnvelope('task.fail', { agentRef: TEST_AGENT_REF, reason: 'boom', retryable: false }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Failed', reason: 'boom', retryable: false });
    expect('document' in result).toBe(false);
  });

  it('drops an over-cap task.complete at the inbound boundary — the task does not complete with a truncated or partial document', async () => {
    const { byok: instance, baseUrl, daemon } = await startWithDaemon();
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'oversized result' });
    await claimAndStart(instance, daemon, handle);

    const framing = JSON.stringify({ a: '' }).length;
    const overCap = { a: 'x'.repeat(RESULT_DOCUMENT_MAX_BYTES + 1 - framing) };
    // Hand-rolled frame on purpose: `createEnvelope` validates the payload it
    // is handed and would throw on this document before it could ever be sent
    // (the codec is itself a fail-closed layer). Only a peer that does NOT use
    // this codec can put an over-cap document on the wire, so that is exactly
    // what this test has to imitate.
    const oversized = {
      v: PROTOCOL_VERSION,
      id: '00000000-0000-4000-8000-0000000000f1',
      ts: new Date().toISOString(),
      type: 'task.complete',
      task_id: handle.taskId,
      // DISTINCT summary/sessionRef from the valid follow-up below, so an
      // accept-and-strip implementation (one that dropped just the oversized
      // `document` and applied the rest) is caught: it would terminate the task
      // with THESE values, which the final assertions reject (F4, codex
      // adversarial review).
      payload: { summary: 'oversized attempt', sessionRef: 'sess_oversized', document: overCap },
    };
    // The awaited request IS the barrier: `POST /byok/messages` applies (or
    // refuses) its envelopes synchronously inside the request, so by the time
    // this resolves the oversized frame's (non-)effect is settled. The refusal
    // is that envelope's own `payload_invalid` outcome at the codec boundary
    // (#1121): it is decoded before it is dispatched, so an over-cap document
    // cannot be half-applied.
    const oversizedRes = await fetch(`${baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
      body: JSON.stringify({ messages: [oversized] }),
    });
    expect(oversizedRes.status).toBe(200);
    expect((await oversizedRes.json() as MessagesSendResponse).outcomes).toEqual([{ id: oversized.id, outcome: 'rejected', reason: 'payload_invalid' }]);

    // The task is STILL RUNNING — the oversized completion neither completed
    // it nor half-applied. `handle.result()` is deliberately not awaited here;
    // it must still be unsettled.
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    const settled = await Promise.race([
      handle.result().then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(settled).toBe('pending');

    // A well-formed completion afterwards still lands normally, proving the
    // transport survived — and it is THIS one's values that win.
    await daemon.send(createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'real done', sessionRef: 'sess_valid' }, { taskId: handle.taskId }));
    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'real done', sessionRef: 'sess_valid' });
    expect(result.document).toBeUndefined();
  });
});

// Deleted with `sqlite-task-store.ts` (WP3B Step 2b): the
// "TaskResult.document persistence parity" describe drove `SqliteTaskStore`
// directly. There is no embedder-supplied task store any more (ADR-028), and
// the durable adapter facts belong to the Step 3 SQLite composition run
// against the conformance suites — see the notes' 2b conformance skim, class
// (C).
