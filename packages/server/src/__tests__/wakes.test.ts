import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, WakeClosedError, WakeConflictError, WakeHookMissingError, MAX_FUTURE_MS, type ByokServer, type DueWake } from '../index';
import { MemoryWakeStore, type WakeStore } from '../wakes/store';
import { createSqliteEmbeddedStores } from '../stores/sqlite';
import { createWebCrypto } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { WAKE_RETENTION_MS } from '../wakes/types';

const NOW = Date.UTC(2026, 0, 1);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
describe.each(['memory', 'sqlite'] as const)('embedded wakes (%s)', kind => {
  const servers: ByokServer[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(async () => { for (const server of servers.splice(0)) await server.close(); vi.useRealTimers(); });
  const open = (consume?: (wake: DueWake, signal: AbortSignal) => Promise<void>) => {
    const server = createByokServer({ productId: 'wakes', storage: kind === 'sqlite' ? { kind, path: ':memory:' } : { kind }, ...(consume ? { wake: { consume } } : {}) });
    servers.push(server); return server;
  };
  const flush = async (server: ByokServer) => { await server.wakes.pending(); await vi.advanceTimersByTimeAsync(0); await server.wakes.pending(); };

  it('deduplicates exact content, conflicts on changed time/payload, and retains done keys for seven days', async () => {
    const consume = vi.fn().mockResolvedValue(undefined); const server = open(consume);
    const input = { dedupKey: 'one', availableAt: NOW, payload: 'opaque' };
    const first = await server.wakes.schedule(input);
    expect(first.accepted).toBe(true);
    expect(await server.wakes.schedule(input)).toEqual({ ...first, accepted: false });
    await expect(server.wakes.schedule({ ...input, availableAt: NOW + 1 })).rejects.toBeInstanceOf(WakeConflictError);
    await expect(server.wakes.schedule({ ...input, payload: '' })).rejects.toBeInstanceOf(WakeConflictError);
    expect(await server.wakes.pending()).toHaveLength(1);
    await flush(server);
    expect(consume).toHaveBeenCalledTimes(1); expect(await server.wakes.pending()).toEqual([]);
    vi.setSystemTime(NOW + WAKE_RETENTION_MS);
    expect(await server.wakes.schedule(input)).toEqual({ ...first, accepted: false });
    await flush(server); expect(consume).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + WAKE_RETENTION_MS + 1);
    expect((await server.wakes.schedule(input)).accepted).toBe(true);
    await flush(server); expect(consume).toHaveBeenCalledTimes(2);
  });
  it('refuses scheduling without a hook and never writes a row or arms an idle timer', async () => {
    const server = open();
    await expect(server.wakes.schedule({ dedupKey: 'none', availableAt: NOW })).rejects.toBeInstanceOf(WakeHookMissingError);
    expect(await server.wakes.pending()).toEqual([]); expect(vi.getTimerCount()).toBe(1);
  });
  it.each([
    [{ dedupKey: '', availableAt: NOW }, 'WAKE_DEDUP_KEY_INVALID'],
    [{ dedupKey: 'x'.repeat(257), availableAt: NOW }, 'WAKE_DEDUP_KEY_INVALID'],
    [{ dedupKey: 'x', availableAt: -1 }, 'WAKE_AVAILABLE_AT_INVALID'],
    [{ dedupKey: 'x', availableAt: NOW + 368 * 86400000 + 1 }, 'WAKE_AVAILABLE_AT_INVALID'],
    [{ dedupKey: 'x', availableAt: NOW + 0.5 }, 'WAKE_AVAILABLE_AT_INVALID'],
    [{ dedupKey: 'x', availableAt: NOW, payload: '界'.repeat(1366) }, 'WAKE_PAYLOAD_TOO_LARGE'],
  ] as const)('rejects invalid input %# without writing', async (input, code) => {
    const server = open(async () => {});
    await expect(server.wakes.schedule(input)).rejects.toEqual(expect.objectContaining({ name: 'WakeInputError', code }));
    expect(await server.wakes.pending()).toEqual([]);
  });
  it('allows exact input boundaries, including Unicode character and UTF-8 byte bounds', async () => {
    const server = open(async () => {});
    expect(MAX_FUTURE_MS).toBe(368 * 86400000);
    expect((await server.wakes.schedule({ dedupKey: '😀'.repeat(256), availableAt: NOW + 368 * 86400000, payload: 'x'.repeat(4096) })).accepted).toBe(true);
    expect((await server.wakes.pending())[0]?.deliveries).toBe(0);
  });
  it.each([366, 367])('allows scheduling %i days in the future', async days => {
    const server = open(async () => {});
    expect((await server.wakes.schedule({ dedupKey: 'future', availableAt: NOW + days * 86400000 })).accepted).toBe(true);
  });
  it('delivers serially by due time then wakeId, while pending uses availableAt order', async () => {
    const seen: DueWake[] = []; const gates = [deferred(), deferred(), deferred()];
    const server = open(wake => { seen.push(wake); return gates[seen.length - 1]!.promise; });
    const a = await server.wakes.schedule({ dedupKey: 'a', availableAt: NOW + 2000 });
    const b = await server.wakes.schedule({ dedupKey: 'b', availableAt: NOW + 1000 });
    const c = await server.wakes.schedule({ dedupKey: 'c', availableAt: NOW + 1000 });
    const equalDue = [b.wakeId, c.wakeId].sort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.map(w => w.wakeId)).toEqual([equalDue[0]]);
    expect((await server.wakes.pending()).map(w => w.wakeId)).toEqual([...equalDue, a.wakeId]);
    for (let i = 0; i < 3; i++) { gates[i]!.resolve(); await flush(server); }
    expect(seen.map(w => w.wakeId)).toEqual([...equalDue, a.wakeId]);
    expect(seen.every(w => w.delivery === 1)).toBe(true); expect(vi.getTimerCount()).toBe(1);
  });
  it('retries rejection after 60s without changing availableAt; limits lastError to 1KiB UTF-8', async () => {
    const seen: DueWake[] = []; const reason = '界'.repeat(500);
    const server = open(async wake => { seen.push(wake); if (seen.length === 1) throw new Error(reason); });
    await server.wakes.schedule({ dedupKey: 'retry', availableAt: NOW - 1 }); await flush(server);
    const [row] = await server.wakes.pending();
    expect(row).toMatchObject({ availableAt: NOW - 1, state: 'queued', deliveries: 1, retryAt: NOW + 60000 });
    expect(Buffer.byteLength(row!.lastError!)).toBe(1023); expect(reason.startsWith(row!.lastError!)).toBe(true);
    await vi.advanceTimersByTimeAsync(59999); expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await flush(server);
    expect(seen).toMatchObject([{ availableAt: NOW - 1, delivery: 1 }, { availableAt: NOW - 1, delivery: 2 }]);
    expect(await server.wakes.pending()).toEqual([]);
  });
  it('invalidates deadline token before abort listeners resolve, continues next wake, and ignores old settlement', async () => {
    const seen: DueWake[] = []; const old = deferred(); let signal!: AbortSignal;
    const server = open((wake, current) => {
      seen.push(wake);
      if (wake.dedupKey === 'stuck' && wake.delivery === 1) {
        signal = current; current.addEventListener('abort', () => old.resolve(), { once: true }); return old.promise;
      }
      return Promise.resolve();
    });
    await server.wakes.schedule({ dedupKey: 'stuck', availableAt: NOW - 2 });
    await server.wakes.schedule({ dedupKey: 'next', availableAt: NOW - 1 }); await flush(server);
    expect(seen.map(w => w.dedupKey)).toEqual(['stuck']);
    await vi.advanceTimersByTimeAsync(60000); await flush(server);
    expect(signal.aborted).toBe(true); expect(seen.map(w => w.dedupKey)).toEqual(['stuck', 'next']);
    expect(await server.wakes.pending()).toEqual([expect.objectContaining({ dedupKey: 'stuck', state: 'queued', deliveries: 1,
      availableAt: NOW - 2, retryAt: NOW + 120000, lastError: 'wake_delivery_deadline_exceeded' })]);
    old.resolve(); await flush(server); expect(await server.wakes.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000); await flush(server);
    expect(seen.at(-1)).toMatchObject({ dedupKey: 'stuck', delivery: 2 }); expect(await server.wakes.pending()).toEqual([]);
  });
  it('allows overlapping redelivery after an uncooperative old hook times out, and ignores its later resolve', async () => {
    const old = deferred(), current = deferred(); const seen: DueWake[] = [];
    const server = open(wake => { seen.push(wake); return seen.length === 1 ? old.promise : current.promise; });
    await server.wakes.schedule({ dedupKey: 'overlap', availableAt: NOW }); await flush(server);
    await vi.advanceTimersByTimeAsync(120000); await flush(server); expect(seen.map(w => w.delivery)).toEqual([1, 2]);
    old.resolve(); await flush(server); expect((await server.wakes.pending())[0]).toMatchObject({ state: 'delivering', deliveries: 2 });
    current.resolve(); await flush(server); expect(await server.wakes.pending()).toEqual([]);
  });
  it('uses capped waits and wall clock after a three-day forward jump; idle has no timer', async () => {
    const seen: DueWake[] = []; const server = open(async wake => { seen.push(wake); });
    const availableAt = NOW + 86400000;
    await server.wakes.schedule({ dedupKey: 'sleep', availableAt }); expect(vi.getTimerCount()).toBe(2);
    vi.setSystemTime(NOW + 3 * 86400000); expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(60000); await flush(server);
    expect(seen).toEqual([expect.objectContaining({ availableAt, deliveredAt: NOW + 3 * 86400000 + 60000 })]);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('supports hook reentrancy: await schedule(next), cancel(other), same-key dedup and self-cancel without deadlock', async () => {
    const decisions: unknown[] = []; let server!: ByokServer;
    server = open(async wake => {
      decisions.push(await server.wakes.schedule({ dedupKey: 'next', availableAt: NOW + 1000 }));
      decisions.push(await server.wakes.cancel('other'));
      decisions.push(await server.wakes.schedule({ dedupKey: wake.dedupKey, availableAt: wake.availableAt }));
      decisions.push(await server.wakes.cancel(wake.dedupKey));
      await expect(server.wakes.schedule({ dedupKey: wake.dedupKey, availableAt: wake.availableAt + 1 })).rejects.toBeInstanceOf(WakeConflictError);
    });
    await server.wakes.schedule({ dedupKey: 'other', availableAt: NOW + 2000 });
    await server.wakes.schedule({ dedupKey: 'active', availableAt: NOW }); await flush(server);
    expect(decisions).toEqual([expect.objectContaining({ accepted: true }), true, expect.objectContaining({ accepted: false }), false]);
    expect(await server.wakes.pending()).toEqual([expect.objectContaining({ dedupKey: 'next' })]);
  });
  it('only cancels queued wakes; a failed in-flight cancellation still retries after rejection', async () => {
    let reject!: (error: Error) => void;
    const server = open(() => new Promise<void>((_, r) => { reject = r; }));
    await server.wakes.schedule({ dedupKey: 'cancel', availableAt: NOW }); await flush(server);
    expect(await server.wakes.cancel('cancel')).toBe(false); expect(await server.wakes.cancel('absent')).toBe(false);
    reject(new Error('retry')); await flush(server);
    expect((await server.wakes.pending())[0]).toMatchObject({ state: 'queued', retryAt: NOW + 60000 });
    expect(await server.wakes.cancel('cancel')).toBe(true); expect(await server.wakes.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('close invalidates before abort, drains storage but never awaits the hook, and rejects late public calls', async () => {
    const held = deferred(); let signal!: AbortSignal; let late: Promise<unknown> | undefined;
    const server = open((_, current) => {
      signal = current; current.addEventListener('abort', () => {
        held.resolve(); late = server.wakes.schedule({ dedupKey: 'late', availableAt: NOW }).catch(error => error);
      }); return held.promise;
    });
    await server.wakes.schedule({ dedupKey: 'close', availableAt: NOW }); await flush(server);
    await server.close(); expect(signal.aborted).toBe(true); expect(await late).toBeInstanceOf(WakeClosedError);
    await expect(server.wakes.pending()).rejects.toBeInstanceOf(WakeClosedError);
    await expect(server.wakes.cancel('close')).rejects.toBeInstanceOf(WakeClosedError);
    expect(vi.getTimerCount()).toBe(0); await server.close();
  });
});

describe.each(['memory', 'sqlite'] as const)('bounded wake collection (%s)', kind => {
  it('deletes only done rows strictly older than seven days, bounded by limit', async () => {
    const sqlite = kind === 'sqlite' ? createSqliteEmbeddedStores({ path: ':memory:' }, { clock: { now: () => new Date(NOW) }, crypto: createWebCrypto(), wake: { consume: async () => {} } }) : undefined;
    const store: WakeStore = sqlite?.wakes(tenantId('collection')) ?? new MemoryWakeStore();
    try {
      for (let i = 0; i < 3; i++) { const row = await store.schedule({ dedupKey: `done-${i}`, availableAt: NOW }, NOW); await store.complete(row.wakeId, NOW); }
      await store.schedule({ dedupKey: 'queued', availableAt: 0 }, NOW);
      expect(await store.collectExpired(NOW + WAKE_RETENTION_MS, 10)).toBe(0);
      expect(await store.collectExpired(NOW + WAKE_RETENTION_MS + 1, 2)).toBe(2);
      expect(await store.collectExpired(NOW + WAKE_RETENTION_MS + 1, 2)).toBe(1);
      expect(await store.collectExpired(NOW + WAKE_RETENTION_MS + 1, 2)).toBe(0);
      expect(await store.pending()).toEqual([expect.objectContaining({ dedupKey: 'queued' })]);
      await expect(store.collectExpired(NOW, 0)).rejects.toThrow('Invalid wake collection bounds');
    } finally { await sqlite?.close(); }
  });
});
