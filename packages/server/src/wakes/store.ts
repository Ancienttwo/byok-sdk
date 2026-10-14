import { randomUUID } from 'node:crypto';
import { WAKE_RETENTION_MS, WakeConflictError, type WakeScheduleInput, type WakeScheduleResult, type WakeRecord } from './types';

export interface StoredWake extends Omit<WakeRecord, 'state'> {
  state: 'queued' | 'done';
  dueAt: number;
  doneAt?: number;
}
/** Server-local port. It never enters the hosted cloud kernel. */
export interface WakeStore {
  schedule(input: WakeScheduleInput, now: number): Promise<WakeScheduleResult>;
  cancel(dedupKey: string): Promise<boolean>;
  pending(): Promise<readonly StoredWake[]>;
  nextDueAt(): Promise<number | undefined>;
  beginDelivery(now: number): Promise<StoredWake | undefined>;
  complete(wakeId: string, now: number): Promise<void>;
  reject(wakeId: string, retryAt: number, lastError: string): Promise<void>;
  collectExpired(now: number, limit: number): Promise<number>;
}
export function assertWakeContent(existing: Pick<StoredWake, 'availableAt' | 'payload'>, input: WakeScheduleInput): void {
  if (existing.availableAt !== input.availableAt || existing.payload !== input.payload) throw new WakeConflictError();
}
export function dueOrder(a: StoredWake, b: StoredWake): number {
  return a.dueAt - b.dueAt || (a.wakeId < b.wakeId ? -1 : a.wakeId > b.wakeId ? 1 : 0);
}
export function assertCollectLimit(now: number, limit: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid wake collection bounds');
}
export class MemoryWakeStore implements WakeStore {
  readonly #rows = new Map<string, StoredWake>();
  async schedule(input: WakeScheduleInput, _now: number): Promise<WakeScheduleResult> {
    const existing = this.#rows.get(input.dedupKey);
    if (existing) { assertWakeContent(existing, input); return { wakeId: existing.wakeId, accepted: false }; }
    const row: StoredWake = { ...input, wakeId: randomUUID(), state: 'queued', deliveries: 0, dueAt: input.availableAt };
    this.#rows.set(input.dedupKey, row);
    return { wakeId: row.wakeId, accepted: true };
  }
  async cancel(key: string): Promise<boolean> {
    return this.#rows.get(key)?.state === 'queued' && this.#rows.delete(key);
  }
  async pending(): Promise<readonly StoredWake[]> {
    return [...this.#rows.values()].filter(row => row.state === 'queued').sort(dueOrder).map(row => ({ ...row }));
  }
  async nextDueAt(): Promise<number | undefined> { return (await this.pending())[0]?.dueAt; }
  async beginDelivery(now: number): Promise<StoredWake | undefined> {
    const next = (await this.pending())[0];
    if (!next || next.dueAt > now) return undefined;
    const row = this.#rows.get(next.dedupKey)!;
    row.deliveries += 1;
    return { ...row };
  }
  async complete(id: string, now: number): Promise<void> {
    const row = [...this.#rows.values()].find(row => row.wakeId === id);
    if (row) { row.state = 'done'; row.doneAt = now; }
  }
  async reject(id: string, retryAt: number, lastError: string): Promise<void> {
    const row = [...this.#rows.values()].find(row => row.wakeId === id);
    if (row && row.state === 'queued') { row.retryAt = retryAt; row.dueAt = retryAt; row.lastError = lastError; }
  }
  async collectExpired(now: number, limit: number): Promise<number> {
    assertCollectLimit(now, limit);
    const expired = [...this.#rows.values()].filter(row => row.state === 'done' && row.doneAt! < now - WAKE_RETENTION_MS)
      .sort((a, b) => a.doneAt! - b.doneAt! || dueOrder(a, b)).slice(0, limit);
    for (const row of expired) this.#rows.delete(row.dedupKey);
    return expired.length;
  }
}
