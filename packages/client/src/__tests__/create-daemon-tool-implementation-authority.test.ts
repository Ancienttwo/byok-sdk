import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * `DaemonConfig.toolImplementationAuthority` was removed with the attestation
 * stack. The SDK does not attest tool or runtime executables, so a host that
 * still sets the key gets a clear construction error.
 */
describe('createDaemonWithAdapters: removed DaemonConfig.toolImplementationAuthority', () => {
  it('refuses the removed key instead of ignoring it', async () => {
    const config = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test Product',
      productId: 'test-product-tool-authority',
      serverUrl: 'http://localhost:1',
      workspaceRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'byok-tool-authority-workspace-')),
      storeDir: await fs.mkdtemp(path.join(os.tmpdir(), 'byok-tool-authority-store-')),
      toolImplementationAuthority: { mode: 'dev' },
    } as DaemonConfig;
    try {
      expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi', { kind: 'available' })]))
        .toThrow('DaemonConfig.toolImplementationAuthority was removed: the SDK does not attest tool or runtime executables');
    } finally {
      await fs.rm(config.workspaceRoot!, { recursive: true, force: true });
      await fs.rm(config.storeDir!, { recursive: true, force: true });
    }
  });
});
