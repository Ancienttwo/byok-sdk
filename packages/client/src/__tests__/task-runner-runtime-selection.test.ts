import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import type { RuntimeCapabilities } from '../types';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * M5 batch-3 (workstream 1): runtime auto-selection order + pre-claim
 * capability matching (`TaskRunner.pickAdapter`, `daemon/task-runner.ts`).
 *
 * Problems this closes (see task-runner.ts's `DEFAULT_RUNTIME_PREFERENCE`/
 * `adapterSupportsMode` doc comments for the full rationale):
 *  1. pi used to be the de-facto DEFAULT auto-selected runtime (an accident
 *     of `ALL_RUNTIME_IDS`'s construction order doubling as selection
 *     order), contradicting the product decision that pi is the FALLBACK —
 *     tried only once nothing better is available/capable.
 *  2. Policy-mode support used to be discovered only at `adapter.start()`
 *     time (a `PolicyUnsupportedError` AFTER claim) — a `confirm`-mode task
 *     auto-selected onto pi failed even when claude was sitting right there,
 *     capable and present.
 *
 * Mirrors `daemon-task-loop.test.ts`'s own `StubRuntimeAdapter` + `TestServer`
 * convention (full daemon/wire-level assertions on decline/claim envelopes)
 * rather than a directly-constructed `TaskRunner`, since these scenarios are
 * fundamentally about which of SEVERAL adapters gets picked.
 */

/** pi/codex-like: cannot express `confirm`/`plan` — mirrors their real declared `permissionModes` (`pi-adapter.ts`/`codex-adapter.ts`). */
const NO_CONFIRM: RuntimeCapabilities = { steer: true, resume: true, permissionModes: ['auto', 'readonly'] };
/** claude-like: the one bundled adapter that declares `confirm` support (`claude-adapter.ts`). */
const CONFIRM_CAPABLE: RuntimeCapabilities = { steer: false, resume: true, permissionModes: ['auto', 'readonly', 'plan', 'confirm'] };

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('TaskRunner.pickAdapter — runtime selection + capability matching (M5 batch-3)', () => {
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

  async function setup(adapters: StubRuntimeAdapter[], configOverrides: Partial<DaemonConfig> = {}): Promise<Daemon> {
    const workspaceRoot = await tmpDir('byok-selection-workspace-');
    const storeDir = await tmpDir('byok-selection-store-');
    daemon = createDaemonWithAdapters(
      {
        productName: 'Test Product',
        productId: 'test-product-selection',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        ...configOverrides,
      },
      adapters,
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return daemon;
  }

  describe('default auto-select order (no runtimePreference configured)', () => {
    it('claude wins over pi when both are present (pi is the fallback, not the default)', async () => {
      const pi = new StubRuntimeAdapter('pi');
      const claude = new StubRuntimeAdapter('claude');
      await setup([pi, claude]);

      server.send(
        createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-order-1', seq: server.nextSeq() }),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ runtime: 'claude' });
      // `task.claim` is sent before `adapter.start()` is actually invoked
      // (workspace-dir creation awaits in between — see `handleOffer`) —
      // wait for `task.started` too before asserting on `startCalls`,
      // mirroring daemon-task-loop.test.ts's own claim-then-started
      // convention, so this isn't a race against that async gap.
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-order-1');
      expect(claude.startCalls).toHaveLength(1);
      expect(pi.startCalls).toHaveLength(0);
    });

    it('pi wins when it is the only runtime present (the fallback actually works)', async () => {
      const pi = new StubRuntimeAdapter('pi');
      await setup([pi]);

      server.send(
        createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-order-2', seq: server.nextSeq() }),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ runtime: 'pi' });
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-order-2');
      expect(pi.startCalls).toHaveLength(1);
    });
  });

  it('runtimePreference overrides the default order: codex wins when listed first, even with claude and pi both present', async () => {
    const pi = new StubRuntimeAdapter('pi');
    const claude = new StubRuntimeAdapter('claude');
    const codex = new StubRuntimeAdapter('codex');
    await setup([pi, claude, codex], { runtimePreference: ['codex', 'claude', 'pi'] });

    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-preference-1', seq: server.nextSeq() }),
    );

    const claim = await server.waitFor((e) => e.type === 'task.claim');
    expect(claim.payload).toMatchObject({ runtime: 'codex' });
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-preference-1');
    expect(codex.startCalls).toHaveLength(1);
    expect(claude.startCalls).toHaveLength(0);
    expect(pi.startCalls).toHaveLength(0);
  });

  describe('capability matching at admission (pre-claim)', () => {
    it('confirm-mode offer: claude is picked over pi, since pi cannot express confirm', async () => {
      const pi = new StubRuntimeAdapter('pi', { present: true, version: '0.0.0' }, NO_CONFIRM);
      const claude = new StubRuntimeAdapter('claude', { present: true, version: '0.0.0' }, CONFIRM_CAPABLE);
      await setup([pi, claude]);

      server.send(
        createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'confirm' } }, { taskId: 'task-cap-1', seq: server.nextSeq() }),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ runtime: 'claude' });
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-cap-1');
      expect(claude.startCalls).toHaveLength(1);
      expect(pi.startCalls).toHaveLength(0);
    });

    it('confirm-mode offer declines pre-claim (no claim, no fail) when only a non-confirm-capable runtime is present', async () => {
      const pi = new StubRuntimeAdapter('pi', { present: true, version: '0.0.0' }, NO_CONFIRM);
      await setup([pi]);

      server.send(
        createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'confirm' } }, { taskId: 'task-cap-2', seq: server.nextSeq() }),
      );

      const decline = await server.waitFor((e) => e.type === 'task.decline');
      expect(decline.payload).toMatchObject({ retryable: true });
      expect((decline.payload as { reason: string }).reason).toMatch(/confirm/i);
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-cap-2')).toBe(false);
      expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-cap-2')).toBe(false);
      expect(pi.startCalls).toHaveLength(0);
    });

    it('explicit runtime=pi + confirm-mode offer declines pre-claim, even though pi is present (no claim, no fail)', async () => {
      const pi = new StubRuntimeAdapter('pi', { present: true, version: '0.0.0' }, NO_CONFIRM);
      await setup([pi]);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'confirm' }, runtime: 'pi' },
          { taskId: 'task-cap-3', seq: server.nextSeq() },
        ),
      );

      const decline = await server.waitFor((e) => e.type === 'task.decline');
      expect(decline.payload).toMatchObject({ retryable: false });
      expect((decline.payload as { reason: string }).reason).toMatch(/confirm/i);
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-cap-3')).toBe(false);
      expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-cap-3')).toBe(false);
      expect(pi.startCalls).toHaveLength(0);
    });
  });

  describe('explicit-runtime regression pin (unchanged by this batch)', () => {
    it('an explicit runtime request that is not detected present still declines pre-claim, never claims', async () => {
      // Regression pin for the pre-existing (M1 gap #5) behavior — unchanged
      // by this batch's capability-matching/preference-order additions. Also
      // covered end-to-end by daemon-task-loop.test.ts's own identical
      // scenario; asserted again here so this workstream's own test file is
      // self-contained proof the explicit path wasn't disturbed.
      const pi = new StubRuntimeAdapter('pi', { present: false });
      await setup([pi]);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' }, runtime: 'pi' },
          { taskId: 'task-unavailable-1', seq: server.nextSeq() },
        ),
      );

      const decline = await server.waitFor((e) => e.type === 'task.decline');
      expect(decline.payload).toMatchObject({ retryable: true });
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-unavailable-1')).toBe(false);
      expect(pi.startCalls).toHaveLength(0);
    });
  });
});
