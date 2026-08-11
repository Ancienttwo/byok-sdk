import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { RESULT_DOCUMENT_MAX_BYTES, createEnvelope } from '@byok-sdk/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { SqliteTaskStore } from '../sqlite-task-store';
import { isSqliteAvailable } from '../sqlite-support';
import { claimAndStart, connectFakeDaemon, send, startServer, stopServer, testPairingClaims, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';

/**
 * additive-minor (`task.complete.document`): the hub's projection of the
 * daemon's structured terminal result into `TaskResult.document`
 * (`ConnectionHub.onComplete`, `hub.ts`), the `result-document` capability
 * advertisement that gates a daemon into sending one at all, and the
 * unchanged behavior of every `task.complete` that carries no document.
 */
describe('additive-minor: task.complete.document projection', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  async function startWithDaemon() {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;
    return { byok, daemon, ws: daemon.ws };
  }

  it('advertises the result-document capability flag in the handshake conn.ack', async () => {
    const { daemon } = await startWithDaemon();
    expect(daemon.ack.capabilities).toContain('result-document');
  });

  it('projects payload.document verbatim into TaskResult.document', async () => {
    const { byok, ws: socket, daemon } = await startWithDaemon();
    const handle = await byok.dispatch({ instruction: 'produce a structured result' });
    await claimAndStart(socket, daemon.deviceId, handle);

    const document = { kind: 'invoice', lines: [{ sku: 'a', qty: 2 }], total: 42.5, note: null, nested: { deep: [1, 2] } };
    send(socket, createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_1', document }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_1', document });
    expect(result.document).toEqual(document);
    expect(byok.tasks.get(handle.taskId)?.result?.document).toEqual(document);
  });

  it('projects a non-object JSON root unchanged — the channel is schema-neutral', async () => {
    const { byok, ws: socket, daemon } = await startWithDaemon();
    const handle = await byok.dispatch({ instruction: 'produce an array' });
    await claimAndStart(socket, daemon.deviceId, handle);

    send(socket, createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_1', document: [1, 'two', null] }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result.document).toEqual([1, 'two', null]);
  });

  it('leaves TaskResult.document absent when the daemon sends no document (an old daemon, or one with no extractor configured) — byte-identical to the pre-change result', async () => {
    const { byok, ws: socket, daemon } = await startWithDaemon();
    const handle = await byok.dispatch({ instruction: 'no structured result' });
    await claimAndStart(socket, daemon.deviceId, handle);

    send(socket, createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_1' }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result.document).toBeUndefined();
    // Serialized (the shape that actually reaches storage and an embedder's
    // JSON boundary): no `document` key at all, exactly as before the field
    // existed.
    expect(JSON.parse(JSON.stringify(result))).toEqual({ state: 'Complete', summary: 'done', sessionRef: 'sess_1' });
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Complete');
  });

  it('never attaches a document to a non-Complete terminal result (task.fail is untouched by this change)', async () => {
    const { byok, ws: socket, daemon } = await startWithDaemon();
    const handle = await byok.dispatch({ instruction: 'will fail' });
    await claimAndStart(socket, daemon.deviceId, handle);

    send(socket, createEnvelope('task.fail', { reason: 'boom', retryable: false }, { taskId: handle.taskId }));

    const result = await handle.result();
    expect(result).toEqual({ state: 'Failed', reason: 'boom', retryable: false });
    expect('document' in result).toBe(false);
  });

  it('drops an over-cap task.complete at the inbound boundary — the task does not complete with a truncated or partial document', async () => {
    const { byok, ws: socket, daemon } = await startWithDaemon();
    const handle = await byok.dispatch({ instruction: 'oversized result' });
    await claimAndStart(socket, daemon.deviceId, handle);

    const framing = JSON.stringify({ a: '' }).length;
    const overCap = { a: 'x'.repeat(RESULT_DOCUMENT_MAX_BYTES + 1 - framing) };
    // Hand-rolled frame on purpose: `createEnvelope` validates the payload
    // it is handed and would throw on this document before it could ever be
    // sent (the codec is itself a fail-closed layer). Only a peer that does
    // NOT use this codec can put an over-cap document on the wire, so that
    // is exactly what this test has to imitate.
    socket.send(
      JSON.stringify({
        v: 1,
        id: '00000000-0000-4000-8000-0000000000f1',
        ts: new Date().toISOString(),
        type: 'task.complete',
        task_id: handle.taskId,
        // DISTINCT summary/sessionRef from the valid follow-up below, so an
        // accept-and-strip implementation (one that dropped just the
        // oversized `document` and applied the rest) is caught: it would
        // terminate the task with THESE values, which the final assertions
        // reject (F4, codex adversarial review).
        payload: { summary: 'oversized attempt', sessionRef: 'sess_oversized', document: overCap },
      }),
    );

    // Prove the oversized frame was fully PROCESSED and dropped before
    // asserting anything about state: a later frame on the same socket is
    // handled strictly after it, so once its effect is observable, the
    // oversized frame's (non-)effect is settled too.
    send(socket, createEnvelope('task.progress', { seq: 1, events: [{ type: 'progress', text: 'still working' }] }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'agent');

    // The task is STILL RUNNING — the oversized completion neither completed
    // it nor half-applied. `handle.result()` is deliberately not awaited
    // here; it must still be unsettled.
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
    const settled = await Promise.race([
      handle.result().then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(settled).toBe('pending');

    // A well-formed completion afterwards still lands normally, proving the
    // connection survived — and it is THIS one's values that win.
    send(socket, createEnvelope('task.complete', { summary: 'real done', sessionRef: 'sess_valid' }, { taskId: handle.taskId }));
    const result = await handle.result();
    expect(result).toEqual({ state: 'Complete', summary: 'real done', sessionRef: 'sess_valid' });
    expect(result.document).toBeUndefined();
  });
});

/**
 * Persistence parity: `document` is carried by the SAME `result_json` blob
 * that already carries `summary`/`artifactRefs` (`sqlite-task-store.ts`), so
 * durable storage needs no column, no migration, and no second authority for
 * it. This test is the pin on that claim.
 */
describe.skipIf(!isSqliteAvailable())('additive-minor: TaskResult.document persistence parity', () => {
  it('round-trips document through result_json with the same fidelity as summary', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    store.create({ taskId: 'task_1', instruction: 'do the thing', policy: { mode: 'auto' }, deviceId: 'dev_1', sessionRef: 'session-abc' });
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');

    const document = { kind: 'invoice', total: 42.5, lines: [{ sku: 'a' }], flag: true, none: null };
    store.transition('task_1', 'Complete', { result: { state: 'Complete', summary: 'ok', document } });

    expect(store.get('task_1')?.result).toEqual({ state: 'Complete', summary: 'ok', document });
    store.close();
  });

  it('stores no document key at all when the result has none', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    store.create({ taskId: 'task_1', instruction: 'do the thing', policy: { mode: 'auto' }, deviceId: 'dev_1', sessionRef: 'session-abc' });
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');
    store.transition('task_1', 'Complete', { result: { state: 'Complete', summary: 'ok' } });

    expect(store.get('task_1')?.result).toEqual({ state: 'Complete', summary: 'ok' });
    expect('document' in (store.get('task_1')?.result ?? {})).toBe(false);
    store.close();
  });
});
