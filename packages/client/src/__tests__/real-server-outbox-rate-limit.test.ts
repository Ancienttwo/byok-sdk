import { createTestDeviceStore } from './fixtures/device-credentials';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, MAX_MESSAGES_PER_BATCH } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';
import { waitForOpen } from './fixtures/lifecycle-barrier';

/**
 * #1118 (PR #1146 review P1): an outbox chunk may hold more envelopes than the
 * device's burst. The server used to debit envelope by envelope while it
 * applied them, answer 429 for the whole request once the bucket ran dry, and
 * drop the applied prefix's outcomes; the client resent the full chunk, the
 * prefix's duplicates spent the refilled bucket again, and the suffix never
 * landed, however long the client waited. The batch is now admitted or
 * refused as one unit before any envelope applies.
 */
describe('a backlog larger than the rate burst still drains (real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let connection: ConnectionManager | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await connection?.stop();
    await real.close();
  });

  it('delivers every queued envelope when one chunk exceeds the burst', async () => {
    const burst = 100;
    real = await startRealServer({
      productId: 'test-product',
      longPollHoldMs: 200,
      rateLimit: { messagesPerSecond: 500, burst },
    });

    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-outbox-rate-'));
    const auth = new AuthManager({ serverUrl: real.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair((await real.createPairingCode()).code);

    const delivered = new Set<string>();
    const refusedBatchSizes: number[] = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const res = await originalFetch(input, init);
      if (url.includes('/byok/messages') && typeof init?.body === 'string') {
        const { messages } = JSON.parse(init.body) as { messages: Array<{ id: string; type: string }> };
        if (res.status === 429) refusedBatchSizes.push(messages.length);
        if (res.ok) for (const message of messages) if (message.type !== 'conn.hello') delivered.add(message.id);
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
      cursorStore: new CursorStore(storeDir),
      onEnvelope: () => {},
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await waitForOpen(connection);

    const total = MAX_MESSAGES_PER_BATCH + 44;
    const sent = new Set<string>();
    for (let i = 0; i < total; i++) {
      const envelope = createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: `rate-task-${i}` });
      sent.add(envelope.id);
      connection.send(envelope);
    }

    await vi.waitFor(() => expect(delivered.size).toBe(total), { timeout: 10_000 });
    expect(delivered).toEqual(sent);
    // The first chunk is larger than the whole burst, yet it was never refused.
    expect(refusedBatchSizes.filter(size => size > burst)).toEqual([]);
  }, 20_000);
});
