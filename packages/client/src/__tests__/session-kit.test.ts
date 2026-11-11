import { afterEach, describe, expect, it, vi } from 'vitest';
import { haltGate, oarCancelSettled, raceDeadline, RetainedRecordBudget, RetryableOnce, SettleWaiters } from '../adapters/session-kit';
import { RuntimeExecutionFailure } from '../runtime-failure';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('session kit', () => {
  it('shares a deferred attempt and retries a failure', async () => {
    const once = new RetryableOnce();
    const error = new Error('disposal failed');
    const work = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const first = once.run(work);
    expect(once.run(work)).toBe(first);
    expect(work).not.toHaveBeenCalled();
    await expect(first).rejects.toBe(error);
    await once.run(work);
    await once.run(work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('clears the deadline when work finishes or times out', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await expect(raceDeadline(Promise.resolve(42), 10, () => new Error('timeout'))).resolves.toBe(42);
    const error = new Error('timeout');
    const timed = raceDeadline(new Promise<never>(() => {}), 10, () => error);
    const rejected = expect(timed).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(clear).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for accepted cancels and handles both refusal paths', async () => {
    const waiters = new SettleWaiters();
    const waiter = waiters.wait();
    let done = false;
    const accepted = oarCancelSettled(Promise.resolve({ response: { body: { kind: 'accepted' } } }), waiter.settled, 'grok').then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    waiters.settleAll();
    await accepted;
    waiter.release();
    await expect(oarCancelSettled(Promise.resolve({ response: { body: { kind: 'rejected', code: 'no_active_turn' } } }), Promise.resolve(), 'grok')).resolves.toBeUndefined();
    await expect(oarCancelSettled(Promise.resolve({ response: { body: { kind: 'rejected', code: 'denied', reason: 'no' } } }), Promise.resolve(), 'grok')).rejects.toMatchObject({ message: 'grok interrupt refused: no', phase: 'run', retry: 'non-retryable' });
  });

  it('counts UTF-8 bytes and fails on the record exceeding the budget', () => {
    const budget = new RetainedRecordBudget(8, 'grok');
    budget.add('é');
    budget.add('ab');
    expect(() => budget.add('x')).toThrow(RuntimeExecutionFailure);
    expect(() => budget.add('x')).toThrow('grok retained record byte budget exceeded');
  });

  it('drops lines after halt and releases individual waiters', async () => {
    let receive!: (line: string) => void;
    let halted = false;
    const lines: string[] = [];
    haltGate({ onLine(handler: (line: string) => void) { receive = handler; } }, () => halted).onLine((line) => lines.push(line));
    receive('before');
    halted = true;
    receive('after');
    expect(lines).toEqual(['before']);
    const waiters = new SettleWaiters();
    const released = waiters.wait();
    const active = waiters.wait();
    let resolved = false;
    void released.settled.then(() => { resolved = true; });
    released.release();
    waiters.settleAll();
    await active.settled;
    expect(resolved).toBe(false);
    active.release();
  });
});
