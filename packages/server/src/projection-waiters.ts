import type { AgentHomeProjectionReadback } from '@byok-sdk/protocol';

/** In-process wake hints only. Every result comes from a durable read. */
export class ProjectionWaiters {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly shutdown = new AbortController();
  private readonly reads = new Set<Promise<unknown>>();

  notify(key: string): void {
    for (const wake of this.listeners.get(key) ?? []) wake();
  }

  stop(): void {
    this.shutdown.abort(new Error('ByokServer closed while awaiting Agent-home projection'));
  }

  async drain(): Promise<void> { await Promise.allSettled(this.reads); }

  async wait(key: string, read: () => Promise<AgentHomeProjectionReadback | undefined>, inputSignal?: AbortSignal): Promise<AgentHomeProjectionReadback | undefined> {
    const signal = inputSignal === undefined ? this.shutdown.signal : AbortSignal.any([inputSignal, this.shutdown.signal]);
    for (;;) {
      signal.throwIfAborted();
      let wake!: () => void;
      const changed = new Promise<void>(resolve => { wake = resolve; });
      const listeners = this.listeners.get(key) ?? new Set<() => void>();
      this.listeners.set(key, listeners);
      listeners.add(wake); // Subscribe BEFORE reading, including already-completed requests.
      let abort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        signal.throwIfAborted();
        const reading = Promise.resolve().then(read);
        this.reads.add(reading);
        void reading.then(() => this.reads.delete(reading), () => this.reads.delete(reading));
        const result = await Promise.race([reading, aborted]);
        signal.throwIfAborted();
        if (result === undefined || result.status !== 'pending') return result;
        await Promise.race([changed, aborted]);
      } finally {
        signal.removeEventListener('abort', abort);
        listeners.delete(wake);
        if (listeners.size === 0) this.listeners.delete(key);
      }
    }
  }
}
