import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { HostExecutionCore, type ExecutionServer } from '../../execution-core/core';
import { HostLedger } from '../../execution-core/ledger';

it.each(['reject', 'return', 'node-abort', 'unrelated-error', 'other-abort'] as const)('retains pending Host work across shutdown: %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'host-job-shutdown-'));
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'shutdown-test');
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const server = { wakes: { schedule: vi.fn(async () => {}), cancel: vi.fn(async () => {}), pending: vi.fn(async () => []) } } as unknown as ExecutionServer;
  const otherController = new AbortController(); otherController.abort();
  const failure = mode === 'other-abort' ? otherController.signal.reason as Error : new Error('independent handler failure');
  const fails = mode === 'unrelated-error' || mode === 'other-abort';
  const handler = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    enter();
    if (mode === 'node-abort') await delay(60_000, undefined, { signal });
    else await new Promise<void>((resolve, reject) => signal.addEventListener('abort', () => {
      if (mode === 'reject') reject(signal.reason);
      else if (fails) reject(failure);
      else resolve();
    }, { once: true }));
    return { summary: 'must not commit after shutdown' };
  });
  const core = new HostExecutionCore(server, ledger, { now: () => 1000, hostJobs: { check: handler } });
  let recovered: HostExecutionCore | undefined;
  try {
    await core.addRoutine({ id: 'check', version: 1, timeZone: 'UTC', rule: { anchorMs: 2000, everyMs: 60_000 },
      hostJob: { type: 'check', input: null }, waitMs: 60_000, lateAfterMs: 1000 });
    const consuming = core.consume({ wakeId: 'delivery', dedupKey: 'check:1:2000', availableAt: 2000,
      deliveredAt: 2000, delivery: 1 }, new AbortController().signal);
    // Attach before close triggers cancellation, including on the unfixed baseline.
    const consumed = consuming.then(() => undefined, error => error);
    await entered;
    if (fails) {
      await expect(core.close()).rejects.toMatchObject({ errors: [failure] });
      expect(await consumed).toMatchObject({ errors: [failure] });
    } else {
      await expect(core.close()).resolves.toBeUndefined();
      expect(await consumed).toBeUndefined();
    }
    expect(Object.values(ledger.snapshot().occurrences)[0]).toMatchObject({ job: { attempts: 1 } });
    expect(Object.values(ledger.snapshot().occurrences)[0]?.conclusion).toBeUndefined();
    expect(Object.values(ledger.snapshot().occurrences)[0]?.job?.summary).toBeUndefined();
    expect(Object.values(ledger.snapshot().outbox).filter(row => row.kind === 'host-job')).toHaveLength(1);
    const pending = Object.values(ledger.snapshot().outbox).find(row => row.kind === 'host-job')!;
    expect(pending.lastError).toBe(fails ? failure.message : undefined);
    const retry = vi.fn(async () => ({ summary: 'recovered' }));
    recovered = new HostExecutionCore(server, ledger, { now: () => 1000, hostJobs: { check: retry } });
    await recovered.recover();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(Object.values(ledger.snapshot().occurrences)[0]).toMatchObject({ conclusion: 'succeeded', job: { attempts: 2, summary: 'recovered' } });
  } finally {
    await core.close(); await recovered?.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
  }
});
