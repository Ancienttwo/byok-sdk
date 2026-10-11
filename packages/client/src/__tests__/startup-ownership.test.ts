import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupOwnership, type StartupOwner, type StartupOwnershipHooks } from '../daemon/startup-ownership';
import { RuntimeDisposalFailure } from '../runtime-failure';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup(overrides: Partial<StartupOwnershipHooks> = {}) {
  const log: string[] = [];
  const hooks = {
    awaitTerminalCommit: vi.fn(async (taskId: string) => { log.push(`commit:${taskId}`); }),
    onDisposalFailure: vi.fn(),
    onDisposed: vi.fn((taskId: string) => { log.push(`disposed:${taskId}`); }),
    retryEligible: vi.fn(() => true),
    ...overrides,
  };
  return { log, hooks, ownership: new StartupOwnership(hooks) };
}

function owner(log: string[], taskId: string, extra: Partial<StartupOwner> = {}): StartupOwner {
  return {
    runtimeId: 'claude-code',
    dispose: vi.fn(async () => { log.push(`dispose:${taskId}`); }),
    release: vi.fn(async () => { log.push(`release:${taskId}`); }),
    ...extra,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('StartupOwnership', () => {
  it('runs settle, the running check, dispose, the commit barrier, release, then cleanup', async () => {
    const { log, hooks, ownership } = setup();
    ownership.adopt('t', owner(log, 't', {
      settle: async () => { log.push('settle:t'); },
      abortedStart: { running: () => { log.push('running:t'); return false; }, settled: Promise.resolve() },
    }));
    expect(ownership.count).toBe(1);
    await expect(ownership.dispose('t')).resolves.toBe(true);
    expect(log).toEqual(['settle:t', 'running:t', 'dispose:t', 'commit:t', 'release:t', 'disposed:t']);
    expect(ownership.has('t')).toBe(false);
    expect(ownership.count).toBe(0);
    expect(hooks.onDisposalFailure).not.toHaveBeenCalled();
  });

  it('coalesces concurrent disposals of one owner into one attempt', async () => {
    const { log, ownership } = setup();
    let finish!: () => void;
    const dispose = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    ownership.adopt('t', owner(log, 't', { dispose }));
    const first = ownership.dispose('t');
    const second = ownership.dispose('t');
    expect(second).toBe(first);
    await flush();
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(log.filter(entry => entry === 'disposed:t')).toHaveLength(1);
  });

  it('retains the owner and reports when disposal is not confirmed', async () => {
    vi.useFakeTimers();
    const { log, hooks, ownership } = setup();
    const release = vi.fn(async () => {});
    ownership.adopt('t', owner(log, 't', { dispose: async () => { throw new Error('not quiescent'); }, release }));
    await expect(ownership.dispose('t')).resolves.toBe(false);
    expect(ownership.has('t')).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(hooks.awaitTerminalCommit).not.toHaveBeenCalled();
    expect(hooks.onDisposed).not.toHaveBeenCalled();
    expect(hooks.onDisposalFailure).toHaveBeenCalledTimes(1);
    const [taskId, runtimeId, failure] = vi.mocked(hooks.onDisposalFailure).mock.calls[0]!;
    expect([taskId, runtimeId]).toEqual(['t', 'claude-code']);
    expect(failure).toBeInstanceOf(RuntimeDisposalFailure);
    expect(failure.stage).toBe('quiescence');
    expect((failure.cause as Error).message).toBe('not quiescent');
    ownership.stop();
  });

  it('passes a typed disposal failure through and keeps the owner when the commit barrier fails', async () => {
    vi.useFakeTimers();
    const typed = new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'journal unavailable' });
    const { log, hooks, ownership } = setup({ awaitTerminalCommit: vi.fn(async () => { throw typed; }) });
    const release = vi.fn(async () => {});
    ownership.adopt('t', owner(log, 't', { release }));
    await expect(ownership.dispose('t')).resolves.toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(ownership.has('t')).toBe(true);
    expect(hooks.onDisposalFailure).toHaveBeenCalledWith('t', 'claude-code', typed);
    ownership.stop();
  });

  it('an aborted start that still runs is retained without a failure report', async () => {
    vi.useFakeTimers();
    const { log, hooks, ownership } = setup();
    const dispose = vi.fn(async () => {});
    ownership.adopt('t', owner(log, 't', { dispose, abortedStart: { running: () => true, settled: new Promise(() => {}) } }));
    await expect(ownership.dispose('t')).resolves.toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(hooks.onDisposalFailure).not.toHaveBeenCalled();
    expect(ownership.has('t')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    ownership.stop();
  });

  it('deletes only the same owner object after a confirmed disposal', async () => {
    const { log, ownership } = setup();
    let finish!: () => void;
    ownership.adopt('t', owner(log, 't', { dispose: () => new Promise<void>(resolve => { finish = resolve; }) }));
    const attempt = ownership.dispose('t');
    await flush();
    ownership.transferToActive('t');
    const replacement = owner(log, 't');
    ownership.adopt('t', replacement);
    finish();
    await expect(attempt).resolves.toBe(true);
    expect(ownership.has('t')).toBe(true);
    expect(ownership.count).toBe(1);
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it('transferToActive removes the owner without disposing it', () => {
    const { log, hooks, ownership } = setup();
    const startup = owner(log, 't');
    ownership.adopt('t', startup);
    expect(ownership.transferToActive('t')).toBeUndefined();
    expect(ownership.has('t')).toBe(false);
    expect(startup.dispose).not.toHaveBeenCalled();
    expect(startup.release).not.toHaveBeenCalled();
    expect(hooks.onDisposed).not.toHaveBeenCalled();
  });

  it('the retry timer disposes only eligible owners after 1000 ms', async () => {
    vi.useFakeTimers();
    const { log, hooks, ownership } = setup({ retryEligible: vi.fn((taskId: string) => taskId === 'settled') });
    let available = false;
    const dispose = (taskId: string) => vi.fn(async () => {
      if (!available) throw new Error('busy');
      log.push(`dispose:${taskId}`);
    });
    const settled = owner(log, 'settled', { dispose: dispose('settled') });
    const inFlight = owner(log, 'in-flight', { dispose: dispose('in-flight') });
    ownership.adopt('settled', settled);
    ownership.adopt('in-flight', inFlight);
    await expect(ownership.dispose('settled')).resolves.toBe(false);
    await expect(ownership.dispose('in-flight')).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    available = true;
    await vi.advanceTimersByTimeAsync(999);
    expect(settled.dispose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(hooks.retryEligible).toHaveBeenCalledWith('settled');
    expect(hooks.retryEligible).toHaveBeenCalledWith('in-flight');
    expect(settled.dispose).toHaveBeenCalledTimes(2);
    expect(inFlight.dispose).toHaveBeenCalledTimes(1);
    expect(ownership.has('settled')).toBe(false);
    expect(ownership.has('in-flight')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop cancels the retry timer and no timer is armed afterwards', async () => {
    vi.useFakeTimers();
    const { log, ownership } = setup();
    const dispose = vi.fn(async () => { throw new Error('busy'); });
    ownership.adopt('t', owner(log, 't', { dispose }));
    await expect(ownership.dispose('t')).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    ownership.stop();
    expect(vi.getTimerCount()).toBe(0);
    await expect(ownership.dispose('t')).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('drain waits for an aborted start to settle before it disposes', async () => {
    const { log, ownership } = setup();
    let running = true;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const dispose = vi.fn(async () => { log.push('dispose:t'); });
    ownership.adopt('t', owner(log, 't', { dispose, abortedStart: { running: () => running, settled } }));
    let drained = false;
    const drain = ownership.drain().then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    running = false;
    settle();
    await drain;
    expect(log).toEqual(['dispose:t', 'commit:t', 'release:t', 'disposed:t']);
    expect(ownership.count).toBe(0);
  });

  it('drain throws while a disposal is not confirmed and keeps the owner', async () => {
    const { log, ownership } = setup();
    ownership.stop();
    ownership.adopt('t', owner(log, 't', { dispose: async () => { throw new Error('not quiescent'); } }));
    const error = await ownership.drain().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeDisposalFailure);
    expect((error as RuntimeDisposalFailure).stage).toBe('quiescence');
    expect((error as Error).message).toBe('startup runtime ownership remains quarantined');
    expect(ownership.has('t')).toBe(true);
  });

  it('adopt refuses a second owner for one task', () => {
    const { log, ownership } = setup();
    const first = owner(log, 't');
    ownership.adopt('t', first);
    expect(() => ownership.adopt('t', owner(log, 't'))).toThrow('already has an owner');
    expect(ownership.count).toBe(1);
  });
});
