import { backoffCeilingMs } from './deterministic-jitter';

/** First automatic retry delay; later ones double up to `backoffCeilingMs`'s ceiling. */
export const TERMINAL_COMMIT_RETRY_BASE_MS = 1_000;

/** Volatile ownership of exact terminal bytes until the journal accepts them.
 * The journal remains the sole durable authority. Failed receipts stay rejected;
 * only the internal scheduling tail recovers so another task can make progress.
 * Automatic retries back off exponentially (capped) while commits keep failing
 * and restart from the base after any commit succeeds. No fleet jitter: the
 * first failure of each device follows its own task timing, not a shared
 * server clock.
 */
export class TerminalCommitQueue {
  private readonly pending = new Map<string, {
    commit: () => Promise<void>;
    prepare: (() => Promise<void>) | undefined;
    receipt: Promise<void>;
    running: boolean;
  }>();
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Consecutive automatic retry rounds since the last successful commit. */
  private retryAttempt = 0;

  constructor(private readonly committed: (taskId: string) => void) {}

  get pendingCount(): number { return this.pending.size; }

  hasPending(taskId: string): boolean { return this.pending.has(taskId); }

  /**
   * `prepare` runs before the commit joins the scheduling tail, so a slow
   * step of one task (a ciphertext upload) holds no other task's commit. A
   * failed `prepare` is retried like a failed commit.
   */
  enqueue(taskId: string, commit: () => Promise<void>, prepare?: () => Promise<void>): void {
    if (!this.pending.has(taskId)) this.pending.set(taskId, { commit, prepare, receipt: Promise.resolve(), running: false });
    void this.attempt(taskId).catch(() => undefined);
  }

  receipt(taskId: string): Promise<void> {
    return this.pending.get(taskId)?.receipt ?? Promise.resolve();
  }

  retry(taskId: string): Promise<void> { return this.attempt(taskId); }

  /** A new run starts a fresh retry schedule; the backoff only spans one run's consecutive failures. */
  resume(): void {
    this.stopped = false;
    this.retryAttempt = 0;
    if (this.pending.size > 0) this.armRetry();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all([...this.pending.keys()].map(taskId => this.attempt(taskId)));
  }

  private attempt(taskId: string): Promise<void> {
    const entry = this.pending.get(taskId);
    if (!entry) return Promise.resolve();
    if (entry.running) return entry.receipt;
    entry.running = true;
    const failed = (error: unknown): never => {
      entry.running = false;
      this.armRetry();
      throw error;
    };
    const join = (): Promise<void> => {
      const receipt = this.tail.catch(() => undefined).then(entry.commit).then(() => {
        if (this.pending.get(taskId) === entry) this.pending.delete(taskId);
        this.retryAttempt = 0;
        this.committed(taskId);
      }, failed);
      this.tail = receipt;
      return receipt;
    };
    entry.receipt = entry.prepare === undefined ? join() : entry.prepare().then(join, failed);
    // Observe background rejection without converting the caller's receipt.
    void entry.receipt.catch(() => undefined);
    return entry.receipt;
  }

  private armRetry(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const taskId of this.pending.keys()) void this.attempt(taskId).catch(() => undefined);
    }, backoffCeilingMs(this.retryAttempt++, TERMINAL_COMMIT_RETRY_BASE_MS));
    this.timer.unref?.();
  }
}
