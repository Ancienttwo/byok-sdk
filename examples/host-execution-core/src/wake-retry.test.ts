import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import { HostExecutionCore, HostLedger, OutboxFullError, project, type HostOptions, type HostLedgerOptions, type AgentRoutineDefinition } from '@byok-sdk/server/execution-core';
import { template } from './test-support';

let root: string | undefined;
let ledger: HostLedger | undefined;
let server: ReturnType<typeof createByokServer> | undefined;
let core: HostExecutionCore | undefined;
afterEach(async () => {
  await core?.close(); await server?.close(); ledger?.close();
  if (root) await rm(root, { recursive: true, force: true });
  core = undefined; server = undefined; ledger = undefined; root = undefined;
  vi.useRealTimers(); vi.restoreAllMocks();
});

// No daemon: fake timers drive only the K4 timers and the embedded server.
async function setup(options: HostOptions = {}, ledgerOptions: HostLedgerOptions = {}) {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 19, 8));
  root = await mkdtemp(path.join(tmpdir(), 'hc-wake-retry-'));
  ledger = new HostLedger(path.join(root, 'host.sqlite'), 'wake-retry', ledgerOptions);
  server = createByokServer({ productId: 'wake-retry', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
    wake: { consume: async () => {} } });
  const probe = { fail: true, attempts: 0, failCancel: false, cancels: 0 };
  const sdk = server;
  core = new HostExecutionCore({ ...sdk, wakes: { ...sdk.wakes, schedule: async input => {
    if (input.dedupKey.startsWith('daily:')) { probe.attempts++; if (probe.fail) throw new Error('schedule unavailable'); }
    return sdk.wakes.schedule(input);
  }, cancel: async key => {
    if (key.startsWith('daily:')) { probe.cancels++; if (probe.failCancel) throw new Error('cancel unavailable'); }
    return sdk.wakes.cancel(key);
  } } }, ledger, { admitSubmit: () => false, ...options });
  return probe;
}
const routine = (): AgentRoutineDefinition => ({ id: 'daily', version: 1, timeZone: 'UTC', rule: { anchorMs: Date.now() + 3_600_000, everyMs: 86_400_000 },
  execution: template('device'), waitMs: 60_000, lateAfterMs: 1000 });
const failedWakes = () => Object.values(ledger!.snapshot().outbox).filter(row => row.kind === 'schedule' && row.lastError !== undefined);

it('reports a pending wake after a committed cancel while drain still rejects', async () => {
  const probe = await setup();
  await core!.enqueue({ key: 'held', source: 'user', execution: template('device'), waitUntil: Date.now() + 60_000 });
  await expect(core!.addRoutine(routine())).rejects.toThrow('Wake dispatch failed');
  expect(await core!.cancel('held')).toEqual({ wakePending: true });
  expect(core!.intent('held')).toMatchObject({ conclusion: 'cancelled' });
  expect(failedWakes()).toEqual([expect.objectContaining({ lastError: 'schedule unavailable' })]);
  await expect(core!.drain()).rejects.toThrow('Wake dispatch failed');
  probe.fail = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(failedWakes()).toEqual([]);
});

it.each(['job', 'capacity'] as const)('returns the original post-commit %s failure and retains retry work', async kind => {
  const jobError = { reason: 'Host source unavailable' };
  let failJob = true;
  const handler = vi.fn(() => { if (failJob) throw jobError; return { summary: 'recovered' }; });
  const probe = await setup({ hostJobs: { watch: handler } }, { projectionOutboxLimits: { maxCount: 1 } });
  await core!.enqueue({ key: 'held', source: 'user', execution: template('device'), waitUntil: Date.now() + 60_000 });
  if (kind === 'job') {
    const at = Date.now() + 100;
    await core!.addRoutine({ ...routine(), id: 'watch', execution: undefined, hostJob: { type: 'watch', input: null },
      rule: { anchorMs: at, everyMs: 86_400_000 } });
    await expect(core!.consume({ wakeId: 'watch', dedupKey: `watch:1:${at}`, availableAt: at, deliveredAt: at, delivery: 1 },
      new AbortController().signal)).rejects.toMatchObject({ errors: [jobError] });
  } else ledger!.transaction(state => project(state, 'occupied', null));
  // Cover the non-wake failure alone, then the same failure mixed with wake dispatch.
  for (const mixed of [false, true]) {
    if (mixed) await expect(core!.addRoutine(routine())).rejects.toThrow();
    const result = await core!.cancel('held');
    expect(result).toHaveProperty('drainError');
    const failures = result.drainError instanceof AggregateError ? result.drainError.errors : [result.drainError];
    if (kind === 'job') expect(failures).toContain(jobError);
    else expect(failures[0]).toBeInstanceOf(OutboxFullError);
    if (mixed) expect(failures).toContainEqual(expect.objectContaining({ message: 'schedule unavailable' }));
    expect(core!.intent('held')).toMatchObject({ cancelReason: 'cancelled' });
    const before = handler.mock.calls.length;
    await expect(core!.drain()).rejects.toThrow();
    if (kind === 'job') {
      expect(handler.mock.calls.length).toBeGreaterThan(before);
      expect(Object.values(ledger!.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'host-job' }));
    } else expect(core!.intent('held')?.conclusion).toBeUndefined();
  }
  failJob = false; probe.fail = false;
  await core!.flushProjections(async () => {});
  await core!.drain();
  expect(core!.intent('held')?.conclusion).toBe('cancelled');
  if (kind === 'job') expect(Object.values(ledger!.snapshot().occurrences)[0]).toMatchObject({ conclusion: 'succeeded', job: { summary: 'recovered' } });
  await expect(core!.cancel('missing')).rejects.toThrow('Intent not found');
});

it('retries a failed wake call from its own timer with backoff, then stops at the bound and keeps the row', async () => {
  const probe = await setup();
  await expect(core!.addRoutine(routine())).rejects.toThrow('Wake dispatch failed');
  expect(probe.attempts).toBe(1);
  // No other drain runs. Each timed retry waits 1 s, 2 s, 4 s ... up to 60 s.
  const delays = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000];
  for (const [index, delay] of delays.entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(probe.attempts).toBe(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.attempts).toBe(index + 2);
  }
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(probe.attempts).toBe(delays.length + 1);
  expect(failedWakes()).toEqual([expect.objectContaining({ lastError: 'schedule unavailable' })]);
  // After the bound, a later drain still retries the row.
  probe.fail = false;
  await core!.drain();
  expect(probe.attempts).toBe(delays.length + 2);
  expect(failedWakes()).toEqual([]);
  expect((await server!.wakes.pending()).map(wake => wake.dedupKey)).toEqual([ledger!.snapshot().routines[Object.keys(ledger!.snapshot().routines)[0]!]!.next!.dedupKey]);
});

it('sends a failed wake call from the timer once the SDK recovers, with no other drain', async () => {
  const probe = await setup();
  await expect(core!.addRoutine(routine())).rejects.toThrow('Wake dispatch failed');
  await vi.advanceTimersByTimeAsync(1000);
  expect(probe.attempts).toBe(2);
  probe.fail = false;
  await vi.advanceTimersByTimeAsync(2000);
  expect(probe.attempts).toBe(3);
  expect(failedWakes()).toEqual([]);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(probe.attempts).toBe(3);
});

it('retries a failed wake cancel from the timer with no other drain', async () => {
  const probe = await setup();
  probe.fail = false;
  await core!.addRoutine(routine());
  expect((await server!.wakes.pending()).map(wake => wake.dedupKey)).toHaveLength(1);
  probe.failCancel = true;
  await expect(core!.lifecycle('daily', 'completed')).rejects.toThrow('Wake dispatch failed');
  expect(probe.cancels).toBe(1);
  expect(Object.values(ledger!.snapshot().outbox)).toEqual([expect.objectContaining({ kind: 'cancel-wake', lastError: 'cancel unavailable' })]);
  await vi.advanceTimersByTimeAsync(999);
  expect(probe.cancels).toBe(1);
  probe.failCancel = false;
  await vi.advanceTimersByTimeAsync(1);
  expect(probe.cancels).toBe(2);
  expect(Object.values(ledger!.snapshot().outbox)).toEqual([]);
  expect(await server!.wakes.pending()).toEqual([]);
});
