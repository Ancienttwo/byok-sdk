import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * `DaemonConfig.mcpLaunchCwd` was removed with the trusted MCP launch
 * directory. MCP servers start in the session cwd, as the agent runtime does.
 * A host that still sets the key gets a clear construction error, so it does
 * not believe a launch boundary is in force.
 */
describe('createDaemonWithAdapters: removed DaemonConfig.mcpLaunchCwd', () => {
  it('refuses the removed key instead of ignoring it', async () => {
    const config = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test Product',
      productId: 'test-product-mcp-launch-cwd',
      serverUrl: 'http://localhost:1',
      workspaceRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'byok-launch-cwd-workspace-')),
      storeDir: await fs.mkdtemp(path.join(os.tmpdir(), 'byok-launch-cwd-store-')),
      mcpLaunchCwd: { dir: '/' },
    } as DaemonConfig;
    try {
      expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi', { kind: 'available' })]))
        .toThrow('DaemonConfig.mcpLaunchCwd was removed: MCP servers start in the session cwd, as the agent runtime does');
    } finally {
      await fs.rm(config.workspaceRoot!, { recursive: true, force: true });
      await fs.rm(config.storeDir!, { recursive: true, force: true });
    }
  });
});
