import { FRESH_DAEMON_EGRESS } from './fixtures/fresh-offer';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControlClient } from '../bin/control-client';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { defaultServiceHealthCheck } from '../lifecycle/service-installation';

/**
 * HIGH #3 (#1097): the default health check must accept a service-enrollment
 * daemon that is up but has not paired yet. It is exercised here through the
 * real control socket of a real daemon, with no injected health stub.
 */
describe('defaultServiceHealthCheck (#1097)', () => {
  let daemon: Daemon | undefined;
  let server: TestServer | undefined;
  let storeDir: string | undefined;
  let scratchRoot: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop().catch(() => undefined);
    daemon = undefined;
    await server?.close();
    server = undefined;
    if (storeDir !== undefined) await fs.rm(storeDir, { recursive: true, force: true });
    if (scratchRoot !== undefined) await fs.rm(scratchRoot, { recursive: true, force: true });
    storeDir = undefined;
    scratchRoot = undefined;
  });

  it('resolves for an enrolled-but-unpaired daemon instead of waiting for running', async () => {
    server = await TestServer.start();
    storeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-install-health-')));
    // The daemon rejects symlinked ancestors and a runtime socket needs a
    // short root; os.tmpdir() is /var/folders/... under the /var symlink on macOS.
    const shortTemp = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
    scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(shortTemp, 'bh-')));
    const productId = 'byok-install-health';
    daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId,
      serverUrl: server.url,
      agentHome: testAgentHomeConfig(),
      agentEgress: FRESH_DAEMON_EGRESS,
      storeDir,
      serviceEnrollment: { enabled: true },
      storage: { scratchRoot },
    }, [new StubRuntimeAdapter('pi')]);
    await daemon.start();

    const connection = await connectControlClient({ storeDir, productId });
    if (!connection.ok) throw new Error('expected the enrollment control endpoint');
    try {
      const status = await connection.client.request<ControlStatusResult>('status');
      expect(status.paired).toBe(false);
      expect(status.lifecycle).toEqual({ phase: 'awaiting-enrollment' });
    } finally {
      connection.client.close();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await expect(defaultServiceHealthCheck({ storeDir, productId })(controller.signal)).resolves.toBeUndefined();
    } finally {
      clearTimeout(timeout);
    }
  }, 15_000);
});
