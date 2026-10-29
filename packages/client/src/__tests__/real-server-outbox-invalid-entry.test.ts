import { createTestDeviceStore } from './fixtures/device-credentials';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, type OutboundSettlement } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';
import { waitForOpen } from './fixtures/lifecycle-barrier';

/**
 * #1121: one envelope the server cannot decode is answered `rejected:
 * payload_invalid` on its own. The rest of its batch lands, and the rejected
 * envelope settles once and is never resent, so it cannot hold the queue.
 */
describe('an invalid envelope does not hold the report queue (real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let connection: ConnectionManager | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await connection?.stop();
    await real.close();
  });

  it('delivers the rest of the batch and settles the invalid envelope as rejected exactly once', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-outbox-entry-'));
    const auth = new AuthManager({ serverUrl: real.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair((await real.createPairingCode()).code);

    const posts = new Map<string, number>();
    const statuses: number[] = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const res = await originalFetch(input, init);
      if (url.includes('/byok/messages') && typeof init?.body === 'string') {
        statuses.push(res.status);
        for (const { id } of (JSON.parse(init.body) as { messages: Array<{ id: string }> }).messages) posts.set(id, (posts.get(id) ?? 0) + 1);
      }
      return res;
    }) as typeof globalThis.fetch;

    const settled = new Map<string, OutboundSettlement>();
    connection = new ConnectionManager({
      serverUrl: real.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore: new CursorStore(storeDir),
      onEnvelope: () => {},
      onOutboundSettled: async (settlements) => { for (const settlement of settlements) settled.set(settlement.envelope.id, settlement); },
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await waitForOpen(connection);

    const before = createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: 'entry-task-1' });
    // A payload this wire version cannot decode (task_id must be a string).
    const invalid = { ...createEnvelope('task.started', {}, { taskId: 'entry-task-2' }), task_id: 42 } as unknown as Envelope;
    const after = createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: 'entry-task-3' });
    for (const envelope of [before, invalid, after]) connection.send(envelope);

    await vi.waitFor(() => expect([before, invalid, after].every(envelope => settled.has(envelope.id))).toBe(true), { timeout: 5_000 });
    expect(settled.get(invalid.id)).toMatchObject({ outcome: 'rejected', reason: 'payload_invalid' });
    // Its neighbours name tasks this device was never offered, so the gate
    // itself answers them: they were decoded and judged one by one.
    expect(settled.get(before.id)).toMatchObject({ outcome: 'rejected', reason: 'not_permitted' });
    expect(settled.get(after.id)).toMatchObject({ outcome: 'rejected', reason: 'not_permitted' });
    expect(statuses.every(status => status === 200)).toBe(true);
    expect(posts.get(invalid.id)).toBe(1);
    expect(connection.outboxLength()).toBe(0);
  }, 15_000);
});
