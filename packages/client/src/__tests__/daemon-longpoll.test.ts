import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('long-poll fallback (protocol §8)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('falls back to long-poll after N consecutive WS failures, receives events, declines offers as transport-degraded, and recovers WS periodically', async () => {
    server = await TestServer.start();
    server.setRejectWs(true); // every WS upgrade fails from the very first attempt

    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 10, maxMs: 30, factor: 2 },
        longPoll: { wsFailureThreshold: 2, wsRetryIntervalMs: 150, retryDelayMs: 20 },
      },
    );

    await daemon.pair('code');
    // Must resolve promptly via the long-poll settle path, not hang waiting
    // for a WS ack that will never come.
    await daemon.start();

    expect(daemon.status().degraded).toBe(true);
    expect(daemon.status().connected).toBe(false);
    // Exactly the configured threshold of WS attempts before giving up —
    // proof this isn't just a slow/lucky WS connect.
    expect(server.wsUpgradeAttempts).toBe(2);

    // --- receive path: an event queued for long-poll pickup must reach the task runner ---
    const offerSeq = server.nextSeq();
    server.pushLongPollEvent(
      createEnvelope(
        'task.offer',
        { instruction: 'do the thing', policy: { mode: 'auto' } },
        { taskId: 'task-degraded-1', seq: offerSeq },
      ),
    );

    // Transport-degraded: never claims/runs the offer — declined immediately
    // instead. The decline itself has nowhere to go over HTTP (protocol §8
    // has no daemon->server send path), so it queues on the still-down WS
    // outbox; we can't observe it on the wire yet, but we CAN observe that
    // the adapter was never asked to run it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(adapter.startCalls).toHaveLength(0);

    // --- WS recovery: the periodic probe must succeed once WS stops rejecting ---
    server.setRejectWs(false);
    await vi.waitFor(() => expect(daemon?.status().degraded).toBe(false), { timeout: 5000 });
    expect(daemon.status().connected).toBe(true);

    // The queued decline (from the offer received while degraded) must have
    // flushed once WS came back — the full round trip, not just "nothing crashed".
    const decline = await server.waitFor(
      (e) => e.type === 'task.decline' && e.task_id === 'task-degraded-1',
      5000,
    );
    expect(decline.payload).toMatchObject({ retryable: true });
    expect((decline.payload as { reason: string }).reason).toMatch(/transport-degraded/i);
    expect(adapter.startCalls).toHaveLength(0);

    // Once WS is back, normal traffic resumes exactly as usual.
    const secondSeq = server.nextSeq();
    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do another thing', policy: { mode: 'auto' } },
        { taskId: 'task-recovered-1', seq: secondSeq },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-recovered-1');
  });
});
