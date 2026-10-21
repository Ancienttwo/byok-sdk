import { expect, it, vi } from 'vitest';
import type { AgentHomeProjectionReadback } from '@byok-sdk/protocol';
import { ProjectionWaiters } from '../projection-waiters';

const pending: AgentHomeProjectionReadback = {
  tenantId: 'tenant', deviceId: 'device', agentRef: { agentId: 'agent', profileRevision: '1' },
  requestId: 'request', projectionHash: `sha256:${'a'.repeat(64)}`, status: 'pending',
};
const complete: AgentHomeProjectionReadback = { ...pending, status: 'applied', completedAt: new Date(0).toISOString() };

it('closes the read-to-wait race and returns readback rather than the notification', async () => {
  const waits = new ProjectionWaiters();
  const read = vi.fn().mockImplementationOnce(async () => {
    waits.notify('exact'); // Completion while an earlier pending read is in flight.
    return pending;
  }).mockResolvedValue(complete);
  expect(await waits.wait('exact', read)).toEqual(complete);
  expect(read).toHaveBeenCalledTimes(2);
  waits.notify('exact');
  expect(read).toHaveBeenCalledTimes(2);
});

it('does not reread on unrelated notifications or a timer; abort removes subscriptions', async () => {
  vi.useFakeTimers();
  const waits = new ProjectionWaiters();
  const abort = new AbortController();
  const read = vi.fn().mockResolvedValue(pending);
  try {
    const result = waits.wait('exact', read, abort.signal);
    const rejected = expect(result).rejects.toThrow('cancel');
    await vi.advanceTimersByTimeAsync(60_000);
    waits.notify('other');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    abort.abort(new Error('cancel'));
    await rejected;
    waits.notify('exact');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(waits['listeners'].size).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('aborts promptly during a read but drains it before storage shutdown', async () => {
  const waits = new ProjectionWaiters();
  let finish!: (value: AgentHomeProjectionReadback) => void;
  const read = () => new Promise<AgentHomeProjectionReadback>(resolve => { finish = resolve; });
  const result = waits.wait('exact', read);
  const rejected = expect(result).rejects.toThrow('ByokServer closed');
  await Promise.resolve();
  waits.stop();
  await rejected;
  expect(waits['listeners'].size).toBe(0);
  let drained = false;
  const draining = waits.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish(complete);
  await draining;
  expect(drained).toBe(true);
});

it('pre-abort performs no read and read failures release subscriptions', async () => {
  const waits = new ProjectionWaiters();
  const read = vi.fn().mockRejectedValue(new Error('storage failed'));
  await expect(waits.wait('exact', read, AbortSignal.abort(new Error('before')))).rejects.toThrow('before');
  expect(read).not.toHaveBeenCalled();
  await expect(waits.wait('exact', read)).rejects.toThrow('storage failed');
  expect(waits['listeners'].size).toBe(0);
});

it('isolates keys and lets one same-key waiter abort without removing another', async () => {
  const waits = new ProjectionWaiters();
  const abort = new AbortController();
  let state = pending;
  const read = vi.fn(async () => state);
  const first = waits.wait('exact', read, abort.signal);
  const rejected = expect(first).rejects.toThrow('one cancelled');
  const second = waits.wait('exact', read);
  const otherAbort = new AbortController();
  const otherRead = vi.fn(async () => pending);
  const other = waits.wait('different-device', otherRead, otherAbort.signal);
  const otherRejected = expect(other).rejects.toThrow('other cancelled');
  await Promise.resolve();
  abort.abort(new Error('one cancelled'));
  await rejected;
  state = complete;
  waits.notify('exact');
  expect(await second).toEqual(complete);
  expect(otherRead).toHaveBeenCalledTimes(1);
  otherAbort.abort(new Error('other cancelled'));
  await otherRejected;
  expect(waits['listeners'].size).toBe(0);
});
