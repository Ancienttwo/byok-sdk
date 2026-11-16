import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * `limits.maxDurationMs` is the only offer limit (wire v7 removed
 * `limits.maxTokens`); an offer that sets it is admitted and claimed.
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('task.offer admission gates (M5 batch-3)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function setup(configOverrides: Partial<DaemonConfig> = {}): Promise<{ daemon: Daemon; adapter: StubRuntimeAdapter }> {
    const adapter = new StubRuntimeAdapter('pi');
    const storeDir = await tmpDir('byok-admission-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-admission',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,
        storeDir,
        ...configOverrides,
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return { daemon, adapter };
  }

  describe('limits.maxDurationMs', () => {
    it('does NOT decline when limits.maxDurationMs is set', async () => {
      const { adapter } = await setup();

      server.send(
        createEnvelope(
          'task.offer',
          { target: { lane: 'auto' }, agentRef: freshTestAgentRef(),  instruction: 'x', limits: { maxDurationMs: 60_000 }, ...FRESH_OFFER },
          { taskId: 'task-maxduration-1', seq: server.nextSeq() },
        ),
      );

      await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-maxduration-1');
      expect(server.received.some((e) => e.type === 'task.decline' && e.task_id === 'task-maxduration-1')).toBe(false);
      // `task.claim` is sent before `adapter.start()` is actually invoked
      // (workspace-dir creation awaits in between — see `handleOffer`) —
      // wait for `task.started` too before asserting on `startCalls`,
      // mirroring daemon-task-loop.test.ts's own claim-then-started
      // convention, so this isn't a race against that async gap.
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-maxduration-1');
      expect(adapter.startCalls).toHaveLength(1);
    });
  });
});
