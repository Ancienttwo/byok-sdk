import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * M5 batch-3 (workstream 1): offer admission gates for two payload fields
 * that were previously accepted and silently ignored (see
 * `TaskRunner.handleOffer`'s own doc comments in `daemon/task-runner.ts` for
 * the full rationale):
 *
 *  - `payload.limits.maxTokens` — no bundled runtime adapter has hard
 *    token-limit enforcement. Silently accepting it would let a caller
 *    believe a cap is in effect when nothing checks it.
 *  - `payload.policy.workspaceRoot` (on the OFFER itself) — merged into the
 *    effective policy and handed to the adapter, but no bundled adapter
 *    reads or enforces it; every adapter confines a task via
 *    `ctx.workspaceDir` instead. A security control that looks live but
 *    isn't.
 *
 * Both are declined fail-closed, pre-claim (never claim-then-fail). A
 * device-local CEILING (`DaemonConfig.permissionDefaults.workspaceRoot`) is
 * a different, operator-owned case: it does NOT decline every offer — it
 * only produces a one-time startup warning (see `create-daemon.ts`'s
 * `start()`).
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
    const workspaceRoot = await tmpDir('byok-admission-workspace-');
    const storeDir = await tmpDir('byok-admission-store-');
    daemon = createDaemonWithAdapters(
      {
        productName: 'Test Product',
        productId: 'test-product-admission',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        ...configOverrides,
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return { daemon, adapter };
  }

  describe('limits.maxTokens', () => {
    it('declines pre-claim (never claims) when limits.maxTokens is set', async () => {
      const { adapter } = await setup();

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' }, limits: { maxTokens: 4000 } },
          { taskId: 'task-maxtokens-1', seq: server.nextSeq() },
        ),
      );

      const decline = await server.waitFor((e) => e.type === 'task.decline');
      expect(decline.payload).toMatchObject({ retryable: true });
      expect((decline.payload as { reason: string }).reason).toMatch(/maxTokens/i);
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-maxtokens-1')).toBe(false);
      expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-maxtokens-1')).toBe(false);
      expect(adapter.startCalls).toHaveLength(0);
    });

    it('does NOT decline when only limits.maxDurationMs is set (maxTokens absent)', async () => {
      const { adapter } = await setup();

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' }, limits: { maxDurationMs: 60_000 } },
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

  describe('policy.workspaceRoot', () => {
    it('an OFFER whose own policy sets workspaceRoot declines pre-claim (never claims)', async () => {
      const { adapter } = await setup();

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto', workspaceRoot: '/some/offered/path' } },
          { taskId: 'task-wsroot-offer-1', seq: server.nextSeq() },
        ),
      );

      const decline = await server.waitFor((e) => e.type === 'task.decline');
      expect(decline.payload).toMatchObject({ retryable: true });
      expect((decline.payload as { reason: string }).reason).toMatch(/workspaceRoot/i);
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-wsroot-offer-1')).toBe(false);
      expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-wsroot-offer-1')).toBe(false);
      expect(adapter.startCalls).toHaveLength(0);
    });

    it('a LOCAL ceiling (permissionDefaults.workspaceRoot) does not decline offers — tasks still run — and warns exactly once at startup', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { adapter } = await setup({ permissionDefaults: { mode: 'auto', workspaceRoot: '/ceiling/path' } });

        const workspaceRootWarnings = warnSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('workspaceRoot'),
        );
        expect(workspaceRootWarnings).toHaveLength(1);

        server.send(
          createEnvelope(
            'task.offer',
            { instruction: 'x', policy: { mode: 'auto' } }, // offer itself names no workspaceRoot
            { taskId: 'task-wsroot-ceiling-1', seq: server.nextSeq() },
          ),
        );

        await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-wsroot-ceiling-1');
        expect(server.received.some((e) => e.type === 'task.decline' && e.task_id === 'task-wsroot-ceiling-1')).toBe(false);
        await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-wsroot-ceiling-1');
        expect(adapter.startCalls).toHaveLength(1);

        // Still exactly once — not re-emitted per task/offer.
        const warningsAfterOffer = warnSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('workspaceRoot'),
        );
        expect(warningsAfterOffer).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('no ceiling workspaceRoot configured: no startup warning is emitted', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await setup();
        const workspaceRootWarnings = warnSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].includes('workspaceRoot'),
        );
        expect(workspaceRootWarnings).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
