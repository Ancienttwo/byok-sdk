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

  it('falls back to long-poll after N consecutive WS failures, runs a full task lifecycle over POST /byok/messages while degraded (finding F6), and recovers WS periodically', async () => {
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

    // Finding F6: long-poll is now a full transport, not receive-only — the
    // offer is claimed and run exactly as it would over WS, with every
    // outbound envelope reaching the server over POST /byok/messages
    // instead of queueing on the (dead) WS outbox / being declined outright.
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-degraded-1');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-degraded-1');
    expect(server.httpRequests.some((r) => r.method === 'POST' && r.pathname === '/byok/messages')).toBe(true);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    expect(daemon.status().degraded).toBe(true); // still degraded the whole time — work proceeds regardless

    adapter.sessions[0]?.emit({ type: 'progress', text: 'working while degraded' });
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-degraded-1');
    expect(complete.payload).toMatchObject({ summary: 'working while degraded' });
    expect(server.received.some((e) => e.type === 'task.decline' && e.task_id === 'task-degraded-1')).toBe(false);

    // --- WS recovery: the periodic probe must succeed once WS stops rejecting ---
    server.setRejectWs(false);
    await vi.waitFor(() => expect(daemon?.status().degraded).toBe(false), { timeout: 5000 });
    expect(daemon.status().connected).toBe(true);

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
