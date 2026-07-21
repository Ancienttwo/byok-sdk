import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * M4 Phase 4 version-negotiation drill, item 2: "unknown NEW message type ->
 * the documented ignore/skip behavior." `packages/protocol`'s own
 * freeze-guard.test.ts already proves `parseMessage`/`decodeEnvelope` throw a
 * distinctly-catchable {@link UnknownMessageTypeError} for a `type` outside
 * the frozen `MESSAGE_TYPES` set — "distinctly skippable from a validation
 * failure" is that test's own framing. What it does NOT prove is what a REAL
 * client transport actually does with that thrown error: does it really
 * skip the frame (connection survives, later traffic still flows), or does
 * it escape and do something worse? `envelope-tolerance.test.ts` (this
 * package) reasons about `ws-transport.ts`'s WS handler from reading its
 * source rather than exercising it; this file drives the REAL transports
 * (`ConnectionManager`/`WsTransport`/`LongPollClient`) against a fake server
 * that can emit a wire payload no CURRENT `@byok/protocol` build recognizes
 * — simulating a hypothetical future minor server's new message type —
 * because `createEnvelope` (the frozen, validated constructor) would itself
 * reject any attempt to build one. `TestServer.sendRaw`/
 * `pushRawLongPollEvent` (fixtures/test-server.ts) are the deliberate
 * escape hatches that make this possible without reimplementing any
 * decode/dispatch logic.
 *
 * FOUND AND FIXED (orchestrator-directed, same session): this file originally
 * documented a genuine gap here — long-poll's whole-batch
 * `EventsPollResponseSchema.parse()` failed the ENTIRE poll batch on a
 * single unrecognized-type entry, discarding every other, otherwise-valid
 * entry alongside it, and stalling that device's cursor against a real
 * (retain-and-redeliver) server. Fixed in `long-poll-transport.ts`
 * (per-entry `parseMessage`, mirroring `ws-transport.ts`'s identical
 * per-frame tolerance) and `connection-manager.ts` (`noteSkippedSeq`, so the
 * cursor advances past a skipped entry even with nothing valid after it).
 * The tests below now assert the fix directly instead of documenting the
 * stall — see docs/protocol.md §13 for the updated drill narrative.
 */
describe('unknown NEW message type tolerance (M4 Phase 4 version-negotiation drill, item 2)', () => {
  let server: TestServer;
  let connection: ConnectionManager | undefined;

  afterEach(async () => {
    await connection?.stop();
    await server.close();
  });

  it('WS: a raw frame with an unrecognized message type is silently skipped by WsTransport — the connection stays open and a subsequent legitimate envelope still arrives normally', async () => {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-unknown-type-ws-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);

    const received: Envelope[] = [];
    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: (envelope) => {
        received.push(envelope);
      },
    });

    await connection.start();
    await connection.waitForAck();
    expect(connection.isConnected()).toBe(true);

    // A hypothetical future minor server's brand-new message type — sent as
    // a raw, hand-crafted line via `sendRaw` (bypassing `createEnvelope`'s
    // own validation on purpose): this is exactly the payload shape a real
    // future server would put on the wire, which this build's frozen
    // `EnvelopeSchema` cannot classify as any known branch.
    server.sendRaw({
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ts: new Date().toISOString(),
      type: 'task.brand_new_future_type',
      task_id: 'task-future-1',
      payload: { someFutureField: 'x' },
    });

    // The connection must not drop or error over this — give it a moment
    // then confirm it's still healthy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connection.isConnected()).toBe(true);

    // A subsequent, legitimate envelope still arrives normally — proof the
    // unknown one was skipped, not fatal to the stream (it never even
    // reaches `onEnvelope`, since `decodeEnvelope` throws before that).
    const taskId = 'task-known-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId, seq: server.nextSeq() }),
    );
    await vi.waitFor(() => {
      expect(received.some((e) => e.type === 'task.offer' && e.task_id === taskId)).toBe(true);
    });

    // conn.ack (handshake) + this one task.offer — the unknown-type frame
    // never became a THIRD `onEnvelope` call at all (it never successfully
    // decodes into an `Envelope` in the first place).
    expect(received.map((e) => e.type)).toEqual(['conn.ack', 'task.offer']);
  });

  /** Shared setup for the long-poll regression tests below: a real degraded (long-poll-only) `ConnectionManager` against `TestServer`, plus a `CursorStore` handle to inspect the PERSISTED cursor directly. */
  async function startLongPollOnly(prefix: string): Promise<{
    record: { deviceId: string };
    cursorStore: CursorStore;
    received: Envelope[];
  }> {
    server = await TestServer.start();
    server.setRejectWs(true); // force long-poll from the very first attempt
    const storeDir = await tmpDir(prefix);
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);

    const received: Envelope[] = [];
    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: (envelope) => {
        received.push(envelope);
      },
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 15,
      longPollIdleDelayMs: 15,
    });

    await connection.start();
    await connection.waitForAck();
    expect(connection.isTransportDegraded()).toBe(true);
    return { record, cursorStore, received };
  }

  it('long-poll (a): a batch [known, unknown-type, known] processes both known entries in order, never fails the whole batch, and advances the cursor past all three — including a trailing skip with nothing known after it', async () => {
    const { record, cursorStore, received } = await startLongPollOnly('byok-unknown-type-lp-mixed-store-');

    const before = createEnvelope('task.offer', { instruction: 'before', policy: { mode: 'auto' } }, { taskId: 'known-before', seq: 1 });
    const unknown = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff01',
      ts: new Date().toISOString(),
      type: 'task.brand_new_future_type',
      task_id: 'future-task-mid',
      seq: 2,
      payload: {},
    };
    const after = createEnvelope('task.offer', { instruction: 'after', policy: { mode: 'auto' } }, { taskId: 'known-after', seq: 3 });

    server.pushLongPollEvent(before);
    server.pushRawLongPollEvent(unknown);
    server.pushLongPollEvent(after);

    await vi.waitFor(() => {
      expect(received.filter((e) => e.type === 'task.offer').map((e) => e.task_id)).toEqual(['known-before', 'known-after']);
    });
    // The unrecognized-type entry never became a THIRD onEnvelope call.
    expect(received).toHaveLength(2);

    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(3);
    });

    // Isolate the fix itself: a batch containing ONLY a trailing
    // unrecognized-type entry (nothing known after it to incidentally push
    // the cursor forward) must STILL advance the durable cursor past it —
    // this is what `ConnectionManager.noteSkippedSeq` exists for.
    const trailingUnknown = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff02',
      ts: new Date().toISOString(),
      type: 'task.another_future_type',
      task_id: 'future-task-trailing',
      seq: 4,
      payload: {},
    };
    server.pushRawLongPollEvent(trailingUnknown);

    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(4);
    });
    // Still exactly the same 2 known envelopes — the trailing skip never
    // produced a THIRD onEnvelope call either.
    expect(received).toHaveLength(2);
  });

  it('long-poll (b, finding F1 fix): a genuinely malformed KNOWN-type entry (recognized type, invalid/missing payload fields) is skipped for its batch but must NOT advance the cursor — unlike an unrecognized type, this is not forward-compat tolerance, so the server must keep redelivering it until a corrected version is processed', async () => {
    // F1: the ORIGINAL bug forwarded EVERY parseMessage failure (regardless
    // of class) to `onSkippedSeq`, which permanently advanced the cursor
    // past a malformed KNOWN-type entry too — e.g. a real `task.offer`
    // whose `PermissionPolicy` rejected an unknown constraint. That
    // silently, permanently acked a control message the daemon never
    // actually understood: the server would stop redelivering it and
    // whatever it was offering got stuck forever. WS never had this
    // hazard — an unparseable WS frame has no skip-side cursor bookkeeping
    // at all, so it simply gets redelivered later (see ws-transport.ts) —
    // this test proves long-poll now matches that same "no silent
    // permanent ack" property for a malformed (not just unrecognized)
    // entry.
    const { record, cursorStore, received } = await startLongPollOnly('byok-unknown-type-lp-malformed-store-');

    const before = createEnvelope('task.offer', { instruction: 'before', policy: { mode: 'auto' } }, { taskId: 'known-before-2', seq: 1 });
    server.pushLongPollEvent(before);

    await vi.waitFor(() => {
      expect(received.some((e) => e.type === 'task.offer' && e.task_id === 'known-before-2')).toBe(true);
    });
    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(1);
    });

    // Pushed ALONE (nothing higher-seq queued right after it in this
    // phase) so its effect on the cursor can be observed in isolation,
    // unmasked by some later, unrelated envelope's own independent
    // success advancing the cursor past it anyway.
    const malformed = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff03',
      ts: new Date().toISOString(),
      type: 'task.offer', // a RECOGNIZED type ...
      task_id: 'malformed-task',
      seq: 2,
      payload: {}, // ... but missing task.offer's required `instruction`/`policy` fields
    };
    server.pushRawLongPollEvent(malformed);

    // Generous real-time window (several retry cycles) — prove the cursor
    // NEVER reaches 2, not just "hasn't yet". `EnvelopeValidationError` is
    // not `UnknownMessageTypeError`, so `onSkippedSeq` must not be called
    // for it at all.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await cursorStore.load(server.url, record.deviceId)).toBe(1);
    expect(received).toHaveLength(1); // still just `before` — the malformed entry never became a second onEnvelope call

    // Redelivery of a CORRECTED version at the same seq (mirrors a real
    // server whose outbox still considers this seq owed to the device,
    // since the cursor never advanced past it, and which redelivers a
    // fixed-up payload) — well-formed this time, so it's processed
    // normally and the cursor finally advances past it.
    const corrected = createEnvelope(
      'task.offer',
      { instruction: 'corrected', policy: { mode: 'auto' } },
      { taskId: 'malformed-task', seq: 2 },
    );
    server.pushLongPollEvent(corrected);

    await vi.waitFor(() => {
      expect(received.some((e) => e.type === 'task.offer' && e.task_id === 'malformed-task')).toBe(true);
    });
    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(2);
    });
    expect(received).toHaveLength(2); // before + corrected — the malformed attempt itself never counted as delivered

    expect(connection?.isTransportDegraded()).toBe(true); // connection itself entirely unaffected throughout
  });

  it('long-poll (c, was: documents the stall — now: asserts the fix): a persistently-redelivered unrecognized-type envelope never blocks forward progress — the cursor keeps advancing through it, and a concurrent known envelope is delivered immediately, no grace period needed', async () => {
    // Mirrors the REAL @byok/server's outbox semantics (hub.ts's
    // collectRelevant): an un-ack'd envelope is RETAINED and redelivered on
    // every subsequent poll until the client's cursor advances past it — it
    // is NOT drained after one delivery attempt regardless of whether the
    // client actually parsed it. TestServer's own long-poll queue is a
    // simple splice-and-drain per poll (unlike the real retain-until-acked
    // outbox ring), so this test re-pushes the SAME poison payload on every
    // cycle itself, to reproduce that persistent-redelivery shape rather
    // than relying on (and being misled by) the stub's simpler drain model.
    const { record, cursorStore, received } = await startLongPollOnly('byok-unknown-type-lp-recover-store-');

    const poison = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
      ts: new Date().toISOString(),
      type: 'task.brand_new_future_type',
      task_id: 'task-future-2',
      seq: 5,
      payload: {},
    };

    let keepPoisoning = true;
    const poisonTimer = setInterval(() => {
      if (keepPoisoning) server.pushRawLongPollEvent(poison);
    }, 10);

    try {
      // Several retry cycles' worth of real time — proves this is a
      // genuine, sustained observation window, not a single shot.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([]); // still nothing real to process — the poison itself never becomes an envelope
      // FIX (was the gap): the cursor is NOT stuck — it already advanced
      // past the poison's own seq, even mid-poisoning, because each
      // redelivered copy is idempotently skip-advanced (`advanceCursor`'s
      // own `seq <= this.cursor` no-op guard makes repeat pushes of the
      // identical seq harmless).
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(5);
    } finally {
      keepPoisoning = false;
      clearInterval(poisonTimer);
    }

    // A genuinely valid envelope pushed immediately (no grace period for a
    // "clean cycle" needed anymore — a straggler poison item landing in the
    // SAME batch as this one no longer corrupts it; only the poison entry
    // itself is skipped) gets through right away.
    const taskId = 'task-known-recover';
    server.pushLongPollEvent(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId, seq: 6 }),
    );

    await vi.waitFor(() => {
      expect(received.some((e) => e.type === 'task.offer' && e.task_id === taskId)).toBe(true);
    });
    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(6);
    });
  });

  /**
   * CRITICAL (gatekeeper-caught regression, fixed in `ConnectionManager
   * .noteSkippedSeq`): the ORIGINAL fix called `advanceCursor(seq)`
   * directly and synchronously from `LongPollClient.loop()`'s per-entry
   * for-loop, completely bypassing the FIFO `processingChain` real
   * envelopes settle through. Batch `[real seq1, unknown seq2]`: `seq1`'s
   * handler is merely CHAINED (not awaited) by the time the loop reaches
   * `seq2`, so the pre-fix code advanced the durable cursor to 2 before
   * `seq1` had even been attempted. If `seq1`'s handler then failed,
   * `stalledAtSeq` became 1 but the cursor was already 2 — permanent
   * envelope loss (every future redelivery of seq1 dedup-dropped forever),
   * exactly the F3 bug class `stalledAtSeq`/the frozen watermark exist to
   * prevent. This test replicates the gatekeeper's own probe scenario.
   */
  it('CRITICAL fix: an in-flight real envelope in the SAME batch as a later skip is never masked — the durable cursor stays behind a still-unresolved failure, a redelivery is retried and succeeds, and only THEN does the cursor advance past both', async () => {
    server = await TestServer.start();
    server.setRejectWs(true);
    const storeDir = await tmpDir('byok-critical-skip-order-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);

    let attempts = 0;
    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: async (envelope) => {
        if (envelope.type !== 'task.offer') return; // ignore conn.ack etc.
        attempts += 1;
        if (attempts === 1) {
          throw new Error('simulated first-attempt failure — retried on redelivery');
        }
        // second+ attempt succeeds
      },
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 15,
      longPollIdleDelayMs: 15,
    });

    await connection.start();
    await connection.waitForAck();
    expect(connection.isTransportDegraded()).toBe(true);

    const realSeq1 = createEnvelope(
      'task.offer',
      { instruction: 'x', policy: { mode: 'auto' } },
      { taskId: 'critical-seq1', seq: 1 },
    );
    const unknownSeq2 = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff10',
      ts: new Date().toISOString(),
      type: 'task.brand_new_future_type',
      task_id: 'future-critical',
      seq: 2,
      payload: {},
    };

    // ONE batch: the real (about-to-fail) envelope FIRST, the unknown-type
    // skip right after it — the gatekeeper's exact probe shape.
    server.pushLongPollEvent(realSeq1);
    server.pushRawLongPollEvent(unknownSeq2);

    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1));

    // Generous real-time window for the FIFO chain (both the failing
    // handler's own settle AND the skip's now-chained cursor bookkeeping)
    // to fully resolve. The durable cursor must NOT have moved AT ALL —
    // not to 1 (seq1 never succeeded) and not to 2 (the skip must not leap
    // ahead of the still-unresolved seq1 failure).
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(attempts).toBe(1); // no redelivery pushed yet — exactly one attempt so far
    expect(await cursorStore.load(server.url, record.deviceId)).toBeUndefined();

    // Redeliver seq1 ONLY (mirrors the real server's retain-and-redeliver
    // outbox, hub.ts's collectRelevant — TestServer's own queue is a plain
    // drain, so the test re-pushes explicitly). This is the "retryAttempts
    // >= 1" the gatekeeper's probe checks for.
    server.pushLongPollEvent(realSeq1);
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));

    // The retry succeeded (attempt 2 doesn't throw) — cursor now advances
    // past seq1.
    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBeGreaterThanOrEqual(1);
    });

    // Redeliver the still-un-acked skip too — nothing is stalled anymore,
    // so it now cleanly advances the cursor the rest of the way to 2.
    server.pushRawLongPollEvent(unknownSeq2);
    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(2);
    });
  });

  /**
   * MEDIUM (gatekeeper advisory, fixed in `extractSkippableSeq`): a skipped
   * entry's raw `seq` must not advance the task cursor unless its `type`
   * is recognizably task-class (`task.` prefix) — finding F2 documents
   * `conn.*` seqs as NEVER cursor-tracked, even when well-formed, and there
   * is no way to tell a hypothetical future `conn.something` type apart
   * from that rule by shape alone once it fails to parse.
   */
  it('MEDIUM fix: a skipped entry with a conn-class type never advances the cursor, even though it carries a numeric seq — only a task-class skip does', async () => {
    const { record, cursorStore } = await startLongPollOnly('byok-skip-conn-class-store-');

    const connLike = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff20',
      ts: new Date().toISOString(),
      type: 'conn.some_future_type',
      seq: 1,
      payload: {},
    };
    server.pushRawLongPollEvent(connLike);

    // Generous window: prove this NEVER advances, not just "hasn't yet".
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await cursorStore.load(server.url, record.deviceId)).toBeUndefined();

    const taskLike = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff21',
      ts: new Date().toISOString(),
      type: 'task.some_future_type',
      task_id: 'skip-task-class',
      seq: 2,
      payload: {},
    };
    server.pushRawLongPollEvent(taskLike);

    await vi.waitFor(async () => {
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(2);
    });
  });
});
