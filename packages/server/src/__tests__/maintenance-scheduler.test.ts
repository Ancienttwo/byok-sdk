import { afterEach, describe, expect, it, vi } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import * as cloudModule from '@byok-sdk/cloud';
import * as storeModule from '../stores';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { claimAndStart, connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer, TEST_AGENT_DISPATCH, TEST_AGENT_REF } from './test-support';
import type { MaintenanceReport } from '@byok-sdk/cloud';
import { MaintenanceScheduler } from '../maintenance-scheduler';
import { createByokServer } from '../index';
const report: MaintenanceReport = { tenantId: tenantId('schedule-test'), now: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z', steps: [] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('maintenance scheduler', () => {
  it('runs timer passes within jitter bounds and rearms only after completion', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(1);
    const run = vi.fn(async () => report);
    const scheduler = new MaintenanceScheduler(run, 1000, error => { throw error; });
    try {
      await vi.advanceTimersByTimeAsync(799);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1199);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await scheduler.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles close after a rejected pass and releases the SQLite owner without rearming', async () => {
    vi.useFakeTimers();
    const path = mkdtempSync(join(tmpdir(), 'byok-412-close-'));
    let reject!: (error: Error) => void;
    const run = vi.fn(() => new Promise<MaintenanceReport>((_resolve, fail) => { reject = fail; }));
    const create = cloudModule.createByokCloud;
    const spy = vi.spyOn(cloudModule, 'createByokCloud').mockImplementation(options => ({ ...create(options), runMaintenance: run }));
    const options = { productId: 'maintenance-close', storage: { kind: 'sqlite' as const, path: join(path, 'server.sqlite') } };
    const server = createByokServer(options);
    try {
      const pass = server.maintenance.runNow();
      const failure = expect(pass).rejects.toThrow('injected pass failure');
      await Promise.resolve();
      const closing = server.close();
      // Wake calls close immediately even while maintenance still owns storage.
      await expect(server.wakes.pending()).rejects.toThrow('closed');
      reject(new Error('injected pass failure'));
      await failure;
      await expect(closing).resolves.toBeUndefined();
      expect(server.close()).toBe(closing);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(run).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      const reopened = createByokServer(options);
      await reopened.close();
    } finally { await server.close(); rmSync(path, { recursive: true, force: true }); }
  });

  it('sweeps one day of delivery state while retaining task identity and session facts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-14T00:00:00.000Z');
    vi.setSystemTime(t0);
    const compose = storeModule.composeFacadeStores;
    let composition!: ReturnType<typeof compose>;
    vi.spyOn(storeModule, 'composeFacadeStores').mockImplementation(options => (composition = compose(options)));
    const productId = 'maintenance-one-day';
    const tenant = storeModule.serverTenantId(productId);
    const server = createByokServer({ productId, longPollHoldMs: 10 });
    const records = vi.spyOn(composition.cloud.receipts, 'record');
    const http = await startServer(server);
    try {
      const daemon = await connectFakeDaemonLongPoll(http.baseUrl, server, { productId });
      await server.pairing.createPairingCode({ productId, ttlMs: 1_000 });
      const handle = await server.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'retain identity' });
      await nextEnvelope(daemon);
      await claimAndStart(server, daemon, handle);
      const complete = await daemon.send(createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'retained-session' }, { taskId: handle.taskId }));
      expect(complete.status).toBe(200);
      await daemon.next(); // The next cursor acknowledges the delivered offer.
      const before = await server.tasks.get(handle.taskId);
      expect(before).toMatchObject({ state: 'Complete', sessionRef: 'retained-session' });
      const keys = [...new Set(records.mock.calls.map(([, input]) => input.key))];
      for (const prefix of ['task-offer:', 'task-offer-delivered:', 'task:']) {
        expect(keys.some(key => key.startsWith(prefix))).toBe(true);
      }
      const fences = await Promise.all(keys.map(key => composition.cloud.receipts.get(tenant, key)));
      expect(fences.every(receipt => receipt !== undefined)).toBe(true);
      vi.setSystemTime(t0 + 86_400_001);
      const result = await server.maintenance.runNow();
      expect(result.steps.find(step => step.step === 'mailbox')).toMatchObject({ status: 'ok', removed: 1, expired: 0, releasedBytes: 0n });
      expect(result.steps.find(step => step.step === 'pairingCodes')).toMatchObject({ status: 'ok', removed: 1 });
      expect(result.steps.find(step => step.step === 'presence')).toMatchObject({ status: 'ok', removed: 1 });
      expect(result.steps.find(step => step.step === 'receipts')).toMatchObject({ status: 'ok', removed: 0 });
      const after = await server.tasks.get(handle.taskId);
      expect(after?.createdAt).toBe(before?.createdAt);
      expect(after?.sessionRef).toBe(before?.sessionRef);
      expect(await Promise.all(keys.map(key => composition.cloud.receipts.get(tenant, key)))).toEqual(fences);
      expect((await server.maintenance.runNow()).steps.find(step => step.step === 'mailbox')).toMatchObject({ status: 'ok', removed: 0 });
    } finally { await server.close(); await stopServer(http.server); }
  });

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
      expect(result.steps).toHaveLength(13);
      expect(result.steps[12]).toEqual({ step: 'proofReceipts', status: 'ok', removed: 0, expired: 0, releasedBytes: 0n, more: false });
      expect(await event).toMatchObject({ value: { kind: 'maintenance.completed', report: result } });
      expect('mailbox' in server).toBe(false);
    } finally { await events.return?.(); await server.close(); }
  });
  it('prunes proof receipts through the SQLite composition', async () => {
    const path = mkdtempSync(join(tmpdir(), 'byok-901-proof-receipts-'));
    const server = createByokServer({ productId: 'maintenance-proof-receipts', storage: { kind: 'sqlite', path: join(path, 'server.sqlite') } });
    try {
      const result = await server.maintenance.runNow();
      expect(result.steps[12]).toEqual({ step: 'proofReceipts', status: 'ok', removed: 0, expired: 0, releasedBytes: 0n, more: false });
    } finally { await server.close(); rmSync(path, { recursive: true, force: true }); }
  });
  it.each([{ intervalMs: 0 }, { policy: { mailboxAckedRetentionMs: 0n } }, { limit: 0 }])('rejects invalid construction before creating storage %s', maintenance => {
    expect(() => createByokServer({ productId: 'invalid-maintenance', maintenance })).toThrow();
  });
});
