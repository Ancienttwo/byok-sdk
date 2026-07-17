import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, MAX_MESSAGES_PER_BATCH } from '@byok/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { startRealServerWithoutWebSocket, type RealServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding P1 (both reviewers / Codex caught, gatekeeper missed): `drainOutbox`
 * used to `splice(0)` the ENTIRE outbox and POST it in a single
 * `/byok/messages` call — the server hard-caps a single batch at
 * `MAX_MESSAGES_PER_BATCH` (protocol §8.2, `MessagesSendRequestSchema`, now
 * exported from `@byok/protocol` so the client references the exact same
 * number rather than a driftable hard-coded copy). More than that queued
 * during a transport outage made the server 400 the WHOLE oversized batch;
 * the client then re-queued and retried the identical oversize batch,
 * unchanged — a permanent stall in long-poll-only mode, since nothing ever
 * got small enough to be accepted.
 *
 * Run against the REAL `@byok/server` (not the lightweight `TestServer`
 * stub) so the cap is genuinely schema-enforced — the stub's
 * `handleMessagesSend` doesn't validate batch size at all, so it wouldn't
 * reproduce the 400. `ConnectionManager` is exercised directly (bypassing
 * `TaskRunner`/`Daemon`) so the test can cheaply queue many synthetic
 * outbound envelopes without spinning up 257+ real adapter sessions.
 */
describe('drainOutbox chunks outbound sends to the server batch cap (finding P1, real @byok/server)', () => {
  let real: RealServerHandle;
  let connection: ConnectionManager | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await connection?.stop();
    await real.close();
  });

  it('queuing more than MAX_MESSAGES_PER_BATCH envelopes while long-poll-only still delivers every one, chunked, with the server never 400ing', async () => {
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 200 });

    const storeDir = await tmpDir('byok-outbox-chunk-store-');
    const auth = new AuthManager({ serverUrl: real.url, store: new DeviceStore(storeDir) });
    const pairing = real.byok.pairing.createPairingCode();
    const record = await auth.pair(pairing.code);
    const cursorStore = new CursorStore(storeDir);

    // Record every /byok/messages POST's batch size + outcome, without
    // needing to inspect server-internal task state — these envelopes
    // reference taskIds that don't exist server-side, which is fine (a
    // task.claim for an unknown task is a documented no-op); this test only
    // cares about the HTTP-level batching/delivery behavior.
    const postedBatchSizes: number[] = [];
    const post400s: number[] = [];
    const acceptedIds = new Set<string>();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const res = await originalFetch(input, init);
      if (url.includes('/byok/messages') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { messages: Array<{ id: string }> };
        postedBatchSizes.push(body.messages.length);
        if (res.status === 400) post400s.push(body.messages.length);
        else if (res.ok) for (const m of body.messages) acceptedIds.add(m.id);
      }
      return res;
    }) as typeof globalThis.fetch;

    connection = new ConnectionManager({
      serverUrl: real.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: () => {},
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });

    await connection.start();
    await connection.waitForAck();
    expect(connection.isTransportDegraded()).toBe(true); // long-poll-only, per startRealServerWithoutWebSocket

    const totalEnvelopes = MAX_MESSAGES_PER_BATCH + 44; // comfortably over the cap — forces >= 2 chunked POSTs
    const sentIds = new Set<string>();
    for (let i = 0; i < totalEnvelopes; i++) {
      const envelope = createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: `chunk-task-${i}` });
      sentIds.add(envelope.id);
      connection.send(envelope);
    }

    await vi.waitFor(
      () => {
        expect(acceptedIds.size).toBe(totalEnvelopes);
      },
      { timeout: 5000 },
    );

    globalThis.fetch = originalFetch;

    expect(post400s).toEqual([]); // the server never rejected a batch as oversized
    expect(postedBatchSizes.every((n) => n <= MAX_MESSAGES_PER_BATCH)).toBe(true); // every POST honored the cap
    expect(postedBatchSizes.length).toBeGreaterThanOrEqual(2); // an over-cap queue required more than one POST
    expect(acceptedIds).toEqual(sentIds); // every single envelope was actually delivered, none dropped
  }, 15000);
});
