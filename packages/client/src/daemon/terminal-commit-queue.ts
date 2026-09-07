/** Volatile ownership of exact terminal bytes until the journal accepts them.
 * The journal remains the sole durable authority. Failed receipts stay rejected;
 * only the internal scheduling tail recovers so another task can make progress.
 */
export class TerminalCommitQueue {
  private readonly pending = new Map<string, {
    commit: () => Promise<void>;
    receipt: Promise<void>;
    running: boolean;
  }>();
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly committed: (taskId: string) => void) {}

  get pendingCount(): number { return this.pending.size; }

  enqueue(taskId: string, commit: () => Promise<void>): void {
    if (!this.pending.has(taskId)) this.pending.set(taskId, { commit, receipt: Promise.resolve(), running: false });
    void this.attempt(taskId).catch(() => undefined);
  }

  receipt(taskId: string): Promise<void> {
    return this.pending.get(taskId)?.receipt ?? Promise.resolve();
  }

  retry(taskId: string): Promise<void> { return this.attempt(taskId); }

  resume(): void {
    this.stopped = false;
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
    const receipt = this.tail.catch(() => undefined).then(entry.commit);
    entry.receipt = receipt.then(() => {
      if (this.pending.get(taskId) === entry) this.pending.delete(taskId);
      this.committed(taskId);
    }, error => {
      entry.running = false;
      this.armRetry();
      throw error;
    });
    this.tail = entry.receipt;
    // Observe background rejection without converting the caller's receipt.
    void entry.receipt.catch(() => undefined);
    return entry.receipt;
  }

  private armRetry(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const taskId of this.pending.keys()) void this.attempt(taskId).catch(() => undefined);
    }, 1_000);
    this.timer.unref?.();
  }
}
