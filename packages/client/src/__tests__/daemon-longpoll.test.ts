import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('long-poll lifecycle (protocol §8)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('runs a full task lifecycle over GET /byok/events and POST /byok/messages', async () => {
    server = await TestServer.start();

    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
      {
        longPoll: { retryDelayMs: 20 },
      },
    );

    await daemon.pair('code');
    // The first successful events response establishes the long-poll
    // connection and resolves startup.
    await daemon.start();

    expect(daemon.status().connected).toBe(true);

    // --- receive path: an event queued for long-poll pickup must reach the task runner ---
    const offerSeq = server.nextSeq();
    server.pushLongPollEvent(
      createEnvelope(
        'task.offer',
        { instruction: 'do the thing', policy: { mode: 'auto' } },
        { taskId: 'task-long-poll-1', seq: offerSeq },
      ),
    );

    // Long-poll is a full transport, not receive-only: the offer is claimed
    // and run, with outbound envelopes reaching the server over POST.
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-long-poll-1');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-long-poll-1');
    expect(server.httpRequests.some((r) => r.method === 'POST' && r.pathname === '/byok/messages')).toBe(true);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));

    adapter.sessions[0]?.emit({ type: 'progress', text: 'working over long-poll' });
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-long-poll-1');
    expect(complete.payload).toMatchObject({ summary: 'working over long-poll' });
    expect(server.received.some((e) => e.type === 'task.decline' && e.task_id === 'task-long-poll-1')).toBe(false);

    // Subsequent events continue through the same long-poll lifecycle.
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
