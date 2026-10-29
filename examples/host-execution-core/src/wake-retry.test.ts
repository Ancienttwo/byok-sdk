import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import { HostExecutionCore, HostLedger, type RoutineDefinition } from '@byok-sdk/server/execution-core';
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
async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 19, 8));
  root = await mkdtemp(path.join(tmpdir(), 'hc-wake-retry-'));
  ledger = new HostLedger(path.join(root, 'host.sqlite'), 'wake-retry');
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
  } } }, ledger);
  return probe;
}
const routine = (): RoutineDefinition => ({ id: 'daily', version: 1, timeZone: 'UTC', rule: { anchorMs: Date.now() + 3_600_000, everyMs: 86_400_000 },
  execution: template('device'), waitMs: 60_000, lateAfterMs: 1000 });
const failedWakes = () => Object.values(ledger!.snapshot().outbox).filter(row => row.kind === 'schedule' && row.lastError !== undefined);

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
