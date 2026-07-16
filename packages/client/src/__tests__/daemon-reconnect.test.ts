import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
