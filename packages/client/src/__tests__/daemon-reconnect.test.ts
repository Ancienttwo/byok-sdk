import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('daemon reconnect after socket drop', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('reconnects and re-hellos/acks after the connection is forcibly dropped', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
      { backoff: { baseMs: 20, maxMs: 100, factor: 2 } },
    );

    await daemon.pair('code');
    await daemon.start();
    expect(daemon.status().connected).toBe(true);

    const countHellos = (): number => server.received.filter((e) => e.type === 'conn.hello').length;
    expect(countHellos()).toBe(1);

    server.dropConnection();

    // Assert on the monotonic hello count rather than polling the
    // connected boolean: with a fast test backoff, close->reconnect->ack can
    // complete faster than a poll interval, so a transient "false" sample
    // is not guaranteed to ever be observed — but a second conn.hello having
    // arrived is unambiguous proof a reconnect happened.
    await vi.waitFor(() => expect(countHellos()).toBe(2), { timeout: 5000 });
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(true), { timeout: 2000 });
  });

  it('terminates and reconnects when no data/ping arrives within the liveness timeout', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
      { backoff: { baseMs: 20, maxMs: 100, factor: 2 }, liveness: { timeoutMs: 150, checkIntervalMs: 30 } },
    );

    await daemon.pair('code');
    await daemon.start();
    expect(daemon.status().connected).toBe(true);

    const countHellos = (): number => server.received.filter((e) => e.type === 'conn.hello').length;
    expect(countHellos()).toBe(1);

    // No explicit drop this time — the server (correctly) sends nothing
    // further, and the client's own liveness check must notice the silence,
    // terminate, and reconnect on its own (server pings every 30s in
    // production; this test just proves the client-side half of that
    // contract without needing a real 75s/30s wait).
    await vi.waitFor(() => expect(countHellos()).toBe(2), { timeout: 5000 });
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(true), { timeout: 2000 });
  });
});

describe('redelivery cursor (protocol §9)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('persists the highest processed seq across a restart and sends it as conn.hello.cursor', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-'); // shared across both daemon instances below

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await daemon.pair('code');
    await daemon.start();

    const offerSeq = server.nextSeq();
    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-A', seq: offerSeq }),
    );
    await server.waitFor((e) => e.type === 'task.claim');

    await daemon.stop();

    // A fresh daemon instance, same storeDir — no re-pair needed (device.json
    // persists), and it should know the cursor without ever having been told
    // directly: it's read back from disk.
    const daemon2 = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    daemon = daemon2;
    await daemon2.start();

    const hellos = server.received.filter((e) => e.type === 'conn.hello');
    expect(hellos).toHaveLength(2);
    expect(hellos[1]?.payload).toMatchObject({ cursor: offerSeq });
  });

  it('dedupes a redelivered envelope whose seq is <= the already-processed cursor', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await daemon.pair('code');
    await daemon.start();

    const firstSeq = server.nextSeq();
    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-A', seq: firstSeq }),
    );
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-A');

    // A "redelivered" envelope carrying a seq the daemon has already
    // processed must be silently dropped before it ever reaches the task
    // runner — proven here by a *different* taskId that must never be
    // claimed/declined, not just "no duplicate claim for task-A".
    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' } },
        { taskId: 'task-A-redelivered', seq: firstSeq },
      ),
    );

    // Prove normal traffic still flows: a fresh, higher seq for a new task
    // must go through exactly as usual.
    const secondSeq = server.nextSeq();
    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-B', seq: secondSeq }),
    );
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-B');

    expect(
      server.received.some((e) => (e.type === 'task.claim' || e.type === 'task.decline') && e.task_id === 'task-A-redelivered'),
    ).toBe(false);
  });
});
