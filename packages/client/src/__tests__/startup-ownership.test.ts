import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { StartupOwnership, type StartupOwner } from '../daemon/startup-ownership';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(options: {
  inFlight?: () => boolean;
  allowRetry?: () => boolean;
  commit?: () => Promise<void>;
} = {}) {
  const events: string[] = [];
  const failures: RuntimeDisposalFailure[] = [];
  const ownership = new StartupOwnership({
    isOfferInFlight: () => options.inFlight?.() ?? false,
    allowRetry: () => options.allowRetry?.() ?? true,
    awaitTerminalCommit: async () => {
      events.push('commit');
      await options.commit?.();
    },
    onDisposed: () => { events.push('contexts'); },
    onDisposalFailure: (_taskId, _runtimeId, failure) => { failures.push(failure); },
  });
  const owner: StartupOwner = {
    runtimeId: 'codex',
    settle: async () => { events.push('settle'); },
    dispose: async () => { events.push('dispose'); },
    release: async () => { events.push('release'); },
  };
  return { ownership, owner, events, failures };
}

describe('startup resource ownership', () => {
  it('shares a close attempt and releases only after the close and terminal receipts', async () => {
    const { ownership, owner, events } = setup();
    let close!: () => void;
    const receipt = new Promise<void>(resolve => { close = resolve; });
    owner.dispose = async () => { events.push('dispose'); await receipt; };
    ownership.register('task', owner);

    const first = ownership.dispose('task');
    const concurrent = ownership.dispose('task');
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(events).toEqual(['settle', 'dispose']));
    expect(ownership.count).toBe(1);

    close();
    await expect(first).resolves.toBe(true);
    expect(events).toEqual(['settle', 'dispose', 'commit', 'release', 'contexts']);
    expect(ownership.has('task')).toBe(false);
    await expect(ownership.dispose('task')).resolves.toBe(true);
    expect(events.filter(event => event === 'dispose')).toHaveLength(1);
  });

  it('retains a failed terminal commit and does not retry an in-flight offer', async () => {
    vi.useFakeTimers();
    let inFlight = true;
    let commits = 0;
    const { ownership, owner, events, failures } = setup({
      inFlight: () => inFlight,
      commit: async () => { if (++commits === 1) throw new Error('journal unavailable'); },
    });
    ownership.register('task', owner);
    await expect(ownership.dispose('task')).resolves.toBe(false);
    expect(events).toEqual(['settle', 'dispose', 'commit']);
    expect(ownership.count).toBe(1);
    expect(failures[0]).toMatchObject({ stage: 'quiescence' });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(commits).toBe(1);
    inFlight = false;
    await expect(ownership.dispose('task')).resolves.toBe(true);
    expect(events.slice(-2)).toEqual(['release', 'contexts']);
    expect(ownership.count).toBe(0);
  });

  it('keeps a late startup until disposal supplies a real cleanup receipt', async () => {
    vi.useFakeTimers();
    let running = true;
    let receiptAvailable = false;
    const { ownership, owner, events } = setup();
    owner.abortedStart = { running: () => running, settled: Promise.resolve() };
    owner.dispose = async () => {
      events.push('dispose');
      if (!receiptAvailable) throw new RuntimeDisposalFailure({
        stage: 'quiescence', reason: 'startup has not returned a cleanup receipt',
      });
    };
    ownership.register('task', owner);
    await expect(ownership.dispose('task')).resolves.toBe(false);
    expect(events).toEqual(['settle']);

    // The grace can end while start still has no authoritative cleanup receipt.
    running = false;
    await expect(ownership.disposeAll()).rejects.toMatchObject({ name: 'RuntimeDisposalFailure' });
    expect(ownership.count).toBe(1);
    expect(events).not.toContain('release');
    receiptAvailable = true;
    await ownership.disposeAll();
    expect(events.slice(-3)).toEqual(['commit', 'release', 'contexts']);
    expect(ownership.count).toBe(0);
    ownership.stopRetry();
  });

  it('stops background retry without dropping a resource that failed disposal', async () => {
    vi.useFakeTimers();
    let allowRetry = true;
    let attempts = 0;
    const { ownership, owner } = setup({ allowRetry: () => allowRetry });
    owner.dispose = async () => { attempts++; throw new Error('close failed'); };
    ownership.register('task', owner);
    await ownership.dispose('task');
    allowRetry = false;
    ownership.stopRetry();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(1);
    expect(ownership.count).toBe(1);
    await ownership.dispose('task');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);
    expect(ownership.count).toBe(1);
  });

  it('transfers ownership synchronously and leaves cleanup to the active execution', async () => {
    const { ownership, owner, events } = setup();
    ownership.register('task', owner);
    expect(ownership.transferToActive('task')).toBeUndefined();
    expect(ownership.count).toBe(0);
    await ownership.disposeAll();
    expect(events).toEqual([]);
  });
});
