import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * M5 batch-3 (workstream 2): `DaemonConfig.maxTaskOutputBytes` config
 * validation — thrown synchronously from `createDaemonWithAdapters` (before
 * any adapter/store/control-socket construction), so a misconfigured
 * embedder finds out immediately rather than only once a task happens to
 * flood output. `0`/negative is a deliberate config error, NOT a supported
 * way to disable the cap — `Number.POSITIVE_INFINITY` is the documented
 * explicit opt-out (see `DaemonConfig.maxTaskOutputBytes`'s own doc
 * comment, `create-daemon.ts`).
 */
describe('createDaemonWithAdapters: DaemonConfig.maxTaskOutputBytes validation', () => {
  async function buildConfig(maxTaskOutputBytes?: number) {
    return {
      productName: 'Test Product',
      productId: 'test-product-resource-limits',
      serverUrl: 'ws://localhost:1',
      workspaceRoot: await tmpDir('byok-resource-limits-workspace-'),
      storeDir: await tmpDir('byok-resource-limits-store-'),
      maxTaskOutputBytes,
    };
  }

  it('rejects 0 synchronously with a clear message', async () => {
    const config = await buildConfig(0);
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()])).toThrow(/maxTaskOutputBytes/);
  });

  it('rejects a negative number synchronously', async () => {
    const config = await buildConfig(-1);
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()])).toThrow(/maxTaskOutputBytes/);
  });

  it('rejects NaN synchronously', async () => {
    const config = await buildConfig(Number.NaN);
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()])).toThrow(/maxTaskOutputBytes/);
  });

  it('accepts Number.POSITIVE_INFINITY as the documented explicit opt-out', async () => {
    const config = await buildConfig(Number.POSITIVE_INFINITY);
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()])).not.toThrow();
  });

  it('accepts an ordinary positive number', async () => {
    const config = await buildConfig(1024);
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()])).not.toThrow();
  });

  it('accepts an unset value (the default applies later, inside TaskRunner)', async () => {
    const config = await buildConfig(undefined);
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()])).not.toThrow();
  });
});
