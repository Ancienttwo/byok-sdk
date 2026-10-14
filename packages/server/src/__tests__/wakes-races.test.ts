import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebCrypto } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createSqliteEmbeddedStores, type SqliteEmbeddedStores } from '../stores/sqlite';
import { WakeScheduler } from '../wakes/scheduler';
import { MemoryWakeStore, type WakeStore } from '../wakes/store';
import { WakeClosedError, type WakeConsumer } from '../wakes/types';

const NOW = Date.UTC(2026, 0, 1);

describe.each(['memory', 'sqlite'] as const)('wake coordination (%s)', kind => {
  const schedulers: WakeScheduler[] = [];
  const compositions: SqliteEmbeddedStores[] = [];
  const releases: (() => void)[] = [];

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(release => { resolve = release; });
    releases.push(resolve);
    return { promise, resolve };
  }

  function open(consume: WakeConsumer['consume']) {
    const sqlite = kind === 'sqlite' ? createSqliteEmbeddedStores(
      { path: ':memory:' },
      { clock: { now: () => new Date(NOW) }, crypto: createWebCrypto(), wake: { consume } },
    ) : undefined;
    if (sqlite) compositions.push(sqlite);
    const store: WakeStore = sqlite ? sqlite.wakes(tenantId('wake-races')) : new MemoryWakeStore();
    const scheduler = new WakeScheduler(store, { consume });
    schedulers.push(scheduler);
    return { scheduler, store };
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const scheduler of schedulers.splice(0)) await scheduler.close();
    for (const composition of compositions.splice(0)) await composition.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('never calls the hook when cancellation wins before a queued delivery starts', async () => {
    const consume = vi.fn().mockResolvedValue(undefined);
    const { scheduler, store } = open(consume);
    const entered = deferred(), release = deferred();
    const cancel = store.cancel.bind(store);
    vi.spyOn(store, 'cancel').mockImplementation(async key => {
      entered.resolve();
      await release.promise;
      return cancel(key);
    });
    await scheduler.schedule({ dedupKey: 'race', availableAt: NOW });
    const cancelled = scheduler.cancel('race');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(0);
    release.resolve();
    expect(await cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await scheduler.pending()).toEqual([]);
    expect(consume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes the delivery token before a cancellation queued during the committed claim', async () => {
    const held = deferred(), entered = deferred(), release = deferred();
    const consume = vi.fn(() => held.promise);
    const { scheduler, store } = open(consume);
    const begin = store.beginDelivery.bind(store);
    vi.spyOn(store, 'beginDelivery').mockImplementation(async now => {
      const row = await begin(now);
      entered.resolve();
      await release.promise;
      return row;
    });
    await scheduler.schedule({ dedupKey: 'race', availableAt: NOW });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    expect((await store.pending())[0]).toMatchObject({ state: 'queued', deliveries: 1 });
    const cancelled = scheduler.cancel('race');
    release.resolve();
    expect(await cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(await scheduler.pending()).toEqual([
      expect.objectContaining({ dedupKey: 'race', state: 'delivering', deliveries: 1 }),
    ]);
  });

  it('close during an awaited committed claim starts no hook and leaves the delivery recoverable', async () => {
    const entered = deferred(), release = deferred();
    const consume = vi.fn().mockResolvedValue(undefined);
    const { scheduler, store } = open(consume);
    const begin = store.beginDelivery.bind(store);
    vi.spyOn(store, 'beginDelivery').mockImplementation(async now => {
      const row = await begin(now);
      entered.resolve();
      await release.promise;
      return row;
    });
    await scheduler.schedule({ dedupKey: 'close-race', availableAt: NOW });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    const closed = scheduler.close();
    await expect(scheduler.pending()).rejects.toBeInstanceOf(WakeClosedError);
    release.resolve();
    await closed;
    await vi.advanceTimersByTimeAsync(0);
    expect(consume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await store.pending()).toEqual([
      expect.objectContaining({ dedupKey: 'close-race', state: 'queued', deliveries: 1 }),
    ]);
  });

  it('ignores old settlement while the deadline retry write is still awaiting its store', async () => {
    const old = deferred(), entered = deferred(), release = deferred();
    const { scheduler, store } = open(() => old.promise);
    const reject = store.reject.bind(store);
    const complete = vi.spyOn(store, 'complete');
    vi.spyOn(store, 'reject').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return reject(...args);
    });
    await scheduler.schedule({ dedupKey: 'deadline-race', availableAt: NOW });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await entered.promise;
    old.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).not.toHaveBeenCalled();
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await scheduler.pending()).toEqual([
      expect.objectContaining({ dedupKey: 'deadline-race', state: 'queued', deliveries: 1,
        retryAt: NOW + 120_000, lastError: 'wake_delivery_deadline_exceeded' }),
    ]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('projects pending by original availableAt when retries change the internal due order', async () => {
    const { scheduler, store } = open(async () => { throw new Error('retry'); });
    const first = await scheduler.schedule({ dedupKey: 'first', availableAt: NOW });
    await scheduler.schedule({ dedupKey: 'later', availableAt: NOW + 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    const pending = await scheduler.pending();
    expect(pending.map(row => row.dedupKey)).toEqual(['first', 'later']);
    expect(pending[0]).toMatchObject({ wakeId: first.wakeId, availableAt: NOW, retryAt: NOW + 60_000 });
    expect((await store.pending()).map(row => row.dedupKey)).toEqual(['later', 'first']);
  });
});
