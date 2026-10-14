import type { WakeStore, StoredWake } from './store';
import { WAKE_WAIT_MS, WakeClosedError, WakeHookMissingError, validateWakeInput, validateWakeKey,
  type WakeConsumer, type WakeRecord, type WakeScheduleInput, type WakeScheduleResult } from './types';

interface Delivery { row: StoredWake; controller: AbortController; deliveredAt: number }
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  let result = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 1024) break;
    result += character; bytes += size;
  }
  return result;
}
/** One timer and one current token; hooks never hold either serialization tail. */
export class WakeScheduler {
  #tail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active: Delivery | undefined;
  #closed = false;
  #failure: unknown;
  #failed = false;
  #closePromise: Promise<void> | undefined;
  constructor(readonly store: WakeStore, readonly consumer?: WakeConsumer) {
    if (consumer) this.#background(this.#queue(async () => {
      await store.collectExpired(Date.now(), 100);
      await this.#arm();
    }));
  }
  #assertOpen(): void {
    if (this.#closed) throw new WakeClosedError();
    if (this.#failed) throw this.#failure;
  }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    try { this.#assertOpen(); } catch (error) { return Promise.reject(error); }
    const result = this.#tail.then(async () => { this.#assertOpen(); return operation(); });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
  #background(promise: Promise<unknown>): void {
    void promise.catch(error => {
      if (this.#closed) return;
      this.#failed = true; this.#failure = error;
      this.#clearTimer();
      const active = this.#active; this.#active = undefined;
      active?.controller.abort(new Error('wake_store_failed'));
      console.error(`embedded wake queue stopped: store failure reasonBytes=${Buffer.byteLength(errorText(error), 'utf8')}`);
    });
  }
  #clearTimer(): void { if (this.#timer !== undefined) clearTimeout(this.#timer); this.#timer = undefined; }
  #setTimer(delay: number, callback: () => void): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => { this.#timer = undefined; callback(); }, delay);
    this.#timer.unref?.();
  }
  async #arm(): Promise<void> {
    if (this.#closed || this.#active || !this.consumer) return;
    this.#clearTimer();
    const dueAt = await this.store.nextDueAt();
    if (this.#closed || dueAt === undefined) return;
    this.#setTimer(Math.max(0, Math.min(WAKE_WAIT_MS, dueAt - Date.now())), () => this.#tick());
  }
  #tick(): void {
    // The transaction commits and this control-tail operation finishes BEFORE
    // consume runs. A hook can await schedule/cancel without a tail deadlock.
    const begun = this.#queue(async () => {
      if (this.#active) return undefined;
      const row = await this.store.beginDelivery(Date.now());
      if (this.#closed) return undefined;
      if (!row) { await this.#arm(); return undefined; }
      const token: Delivery = { row, controller: new AbortController(), deliveredAt: Date.now() };
      this.#active = token;
      this.#setTimer(WAKE_WAIT_MS, () => {
        // Invalidate synchronously, BEFORE an abort listener can settle.
        if (!this.#invalidate(token)) return;
        token.controller.abort(new Error('wake_delivery_deadline_exceeded'));
        this.#finish(token, 'wake_delivery_deadline_exceeded');
      });
      return token;
    });
    this.#background(begun.then(token => {
      if (!token || this.#active !== token || this.#closed) return;
      const wake = { wakeId: token.row.wakeId, dedupKey: token.row.dedupKey, availableAt: token.row.availableAt,
        deliveredAt: token.deliveredAt, delivery: token.row.deliveries,
        ...(token.row.payload === undefined ? {} : { payload: token.row.payload }) };
      void Promise.resolve().then(() => {
        if (this.#active !== token || this.#closed) return;
        return this.consumer!.consume(wake, token.controller.signal);
      }).then(() => {
        if (this.#invalidate(token)) this.#finish(token);
      }, error => {
        if (this.#invalidate(token)) this.#finish(token, errorText(error));
      });
    }));
  }
  #invalidate(token: Delivery): boolean {
    if (this.#active !== token || this.#closed) return false;
    this.#active = undefined; this.#clearTimer(); return true;
  }
  #finish(token: Delivery, error?: string): void {
    this.#background(this.#queue(async () => {
      if (error === undefined) await this.store.complete(token.row.wakeId, Date.now());
      else await this.store.reject(token.row.wakeId, Date.now() + WAKE_WAIT_MS, error);
      await this.store.collectExpired(Date.now(), 100);
      // Continue this due batch directly after the settled write commits.
      // tick queues behind this storage operation and never awaits the hook.
      this.#tick();
    }));
  }
  schedule(input: WakeScheduleInput): Promise<WakeScheduleResult> {
    return this.#queue(async () => {
      if (!this.consumer) throw new WakeHookMissingError();
      const value = validateWakeInput(input, Date.now());
      await this.store.collectExpired(Date.now(), 100);
      const result = await this.store.schedule(value, Date.now());
      await this.#arm(); return result;
    });
  }
  cancel(key: string): Promise<boolean> {
    return this.#queue(async () => {
      validateWakeKey(key);
      if (this.#active?.row.dedupKey === key) return false;
      const removed = await this.store.cancel(key); await this.#arm(); return removed;
    });
  }
  pending(): Promise<readonly WakeRecord[]> {
    return this.#queue(async () => (await this.store.pending()).map(row => ({
      wakeId: row.wakeId, dedupKey: row.dedupKey, availableAt: row.availableAt,
      state: this.#active?.row.wakeId === row.wakeId ? 'delivering' as const : 'queued' as const,
      deliveries: row.deliveries, ...(row.retryAt === undefined ? {} : { retryAt: row.retryAt }),
      ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
      ...(row.payload === undefined ? {} : { payload: row.payload }),
    })).sort((a, b) => a.availableAt - b.availableAt || (a.wakeId < b.wakeId ? -1 : a.wakeId > b.wakeId ? 1 : 0)));
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true; this.#clearTimer();
    const active = this.#active; this.#active = undefined;
    active?.controller.abort(new WakeClosedError());
    // No hook promise is in this tail. Only accepted storage operations drain.
    this.#closePromise = this.#tail;
    return this.#closePromise;
  }
}
