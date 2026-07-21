import type { AgentEvent } from '@byok/protocol';

export type ProgressEmitter = (seq: number, events: AgentEvent[]) => void;

export interface ProgressBatcherOptions {
  /** Flush immediately once this many events are buffered. Default 10. */
  maxBatchSize?: number;
  /** Otherwise flush at most this often (ms) while events are pending. Default 250 (~4/sec). */
  flushIntervalMs?: number;
}

/**
 * Coalesces a task's `AgentEvent`s into seq-ordered `task.progress` batches:
 * flush immediately at `maxBatchSize` events, otherwise at most every
 * `flushIntervalMs` while anything is buffered. One instance per task —
 * `seq` is a per-task monotonic counter starting at 1.
 */
export class ProgressBatcher {
  private buffer: AgentEvent[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly emit: ProgressEmitter,
    options: ProgressBatcherOptions = {},
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
  }

  push(event: AgentEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.ensureTimer();
  }

  /** M4 Phase 4 (part B.3, observability): events buffered right now, not yet flushed as a `task.progress` batch — a cheap per-task queue-depth watermark for the daemon's control-socket `status` result (see `task-runner.ts`'s `getQueueWatermarks`). */
  get pendingCount(): number {
    return this.buffer.length;
  }

  flush(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.seq += 1;
    this.emit(this.seq, batch);
  }

  /** Stop the pending flush timer without flushing (used on teardown). */
  stop(): void {
    this.clearTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
