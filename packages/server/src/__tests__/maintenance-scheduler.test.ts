import { afterEach, describe, expect, it, vi } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import type { MaintenanceReport } from '@byok-sdk/cloud';
import { MaintenanceScheduler } from '../maintenance-scheduler';
import { createByokServer } from '../index';
const report: MaintenanceReport = { tenantId: tenantId('schedule-test'), now: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z', steps: [] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('maintenance scheduler', () => {
  it('joins manual passes, does not overlap timer work, and waits on close', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let release!: (report: MaintenanceReport) => void;
    const run = vi.fn(() => new Promise<MaintenanceReport>(resolve => { release = resolve; }));
    const scheduler = new MaintenanceScheduler(run, 1000, error => { throw error; });
    const first = scheduler.runNow();
    expect(scheduler.runNow()).toBe(first);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    let closed = false;
    const close = scheduler.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(report);
    await close;
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(scheduler.runNow()).rejects.toThrow('closed');
    vi.restoreAllMocks();
  });
  it('emits a counts-only maintenance report and exposes no separate mailbox GC', async () => {
    const server = createByokServer({ productId: 'maintenance-server' });
    const events = server.events.subscribe()[Symbol.asyncIterator]();
    const event = events.next();
    try {
      const result = await server.maintenance.runNow();
      expect(result.steps).toHaveLength(10);
      expect(await event).toMatchObject({ value: { kind: 'maintenance.completed', report: result } });
      expect('mailbox' in server).toBe(false);
    } finally { await events.return?.(); await server.close(); }
  });
  it.each([{ intervalMs: 0 }, { policy: { mailboxAckedRetentionMs: 0n } }, { limit: 0 }])('rejects invalid construction before creating storage %s', maintenance => {
    expect(() => createByokServer({ productId: 'invalid-maintenance', maintenance })).toThrow();
  });
});
