import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { DEFAULT_MAX_INLINE_EVENT_BYTES, MIN_MAX_INLINE_EVENT_BYTES } from '../daemon/event-spill';
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
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
      productId: 'test-product-resource-limits',
      serverUrl: 'http://localhost:1',
      workspaceRoot: await tmpDir('byok-resource-limits-workspace-'),
      agentHome: testAgentHomeConfig(),
      storeDir: await tmpDir('byok-resource-limits-store-'),
      maxTaskOutputBytes,
    };
  }

  it('rejects 0 synchronously with a clear message', async () => {
    const config = await buildConfig(0);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).toThrow(/maxTaskOutputBytes/);
  });

  it('rejects a negative number synchronously', async () => {
    const config = await buildConfig(-1);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).toThrow(/maxTaskOutputBytes/);
  });

  it('rejects NaN synchronously', async () => {
    const config = await buildConfig(Number.NaN);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).toThrow(/maxTaskOutputBytes/);
  });

  it('accepts Number.POSITIVE_INFINITY as the documented explicit opt-out', async () => {
    const config = await buildConfig(Number.POSITIVE_INFINITY);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).not.toThrow();
  });

  it('accepts an ordinary positive number', async () => {
    const config = await buildConfig(1024);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).not.toThrow();
  });

  it('accepts an unset value (the default applies later, inside TaskRunner)', async () => {
    const config = await buildConfig(undefined);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).not.toThrow();
  });
});

describe('createDaemonWithAdapters: DaemonConfig.progressBatch validation', () => {
  async function buildConfig(progressBatch?: DaemonConfig['progressBatch']): Promise<DaemonConfig> {
    return {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
      productId: 'test-product-progress-batch',
      serverUrl: 'http://localhost:1',
      workspaceRoot: await tmpDir('byok-progress-batch-workspace-'),
      agentHome: testAgentHomeConfig(),
      storeDir: await tmpDir('byok-progress-batch-store-'),
      progressBatch,
    };
  }

  it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid maxBatchBytes %s synchronously',
    async (maxBatchBytes) => {
      const config = await buildConfig({ maxBatchBytes } as never);
      expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...config }, [new StubRuntimeAdapter()])).toThrow(/maxBatchBytes/);
    },
  );

  it('rejects invalid count and timer bounds through the same config authority', async () => {
    const badCount = await buildConfig({ maxBatchSize: 0 });
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(badCount) }, [new StubRuntimeAdapter()])).toThrow(/maxBatchSize/);

    const badInterval = await buildConfig({ flushIntervalMs: 0 });
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(badInterval) }, [new StubRuntimeAdapter()])).toThrow(/flushIntervalMs/);
  });

  it('accepts timing and count policy with server-owned bytes', async () => {
    const configured = await buildConfig({
      maxBatchSize: 10,
      flushIntervalMs: 250,
    });
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(configured) }, [new StubRuntimeAdapter()])).not.toThrow();

    const unset = await buildConfig(undefined);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(unset) }, [new StubRuntimeAdapter()])).not.toThrow();
  });
});

/**
 * `DaemonConfig.maxInlineEventBytes` config validation. Unlike
 * `maxTaskOutputBytes` there is deliberately NO opt-out value: an unbounded
 * per-event `tool_use.input`/`tool_result.output` is the exact state this cap
 * exists to prevent, and a cap under `MIN_MAX_INLINE_EVENT_BYTES` cannot hold
 * the spill descriptor that documents the omission.
 */
describe('createDaemonWithAdapters: DaemonConfig.maxInlineEventBytes validation', () => {
  async function buildConfig(maxInlineEventBytes?: number): Promise<DaemonConfig> {
    return {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test Product',
      productId: 'test-product-inline-event-bytes',
      serverUrl: 'http://localhost:1',
      workspaceRoot: await tmpDir('byok-inline-event-workspace-'),
      agentHome: testAgentHomeConfig(),
      storeDir: await tmpDir('byok-inline-event-store-'),
      maxInlineEventBytes,
    };
  }

  it.each([0, -1, 4095, 4096.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s synchronously with a clear message',
    async (maxInlineEventBytes) => {
      const config = await buildConfig(maxInlineEventBytes);
      expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).toThrow(/maxInlineEventBytes/);
    },
  );

  it('accepts exactly the documented minimum (4096)', async () => {
    const config = await buildConfig(MIN_MAX_INLINE_EVENT_BYTES);
    expect(MIN_MAX_INLINE_EVENT_BYTES).toBe(4096);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()])).not.toThrow();
  });

  it('accepts the default value and an unset value', async () => {
    expect(DEFAULT_MAX_INLINE_EVENT_BYTES).toBe(64 * 1024);
    const explicit = await buildConfig(DEFAULT_MAX_INLINE_EVENT_BYTES);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(explicit) }, [new StubRuntimeAdapter()])).not.toThrow();
    const unset = await buildConfig(undefined);
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(unset) }, [new StubRuntimeAdapter()])).not.toThrow();
  });
});
