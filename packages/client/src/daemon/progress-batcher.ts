import type { AgentEvent } from '@byok-sdk/protocol';

export type ProgressEmitter = (seq: number, events: AgentEvent[]) => void;

export interface ProgressBatcherOptions {
  /** Flush immediately once this many events are buffered. Default 10. */
  maxBatchSize?: number;
  /** Otherwise flush at most this often (ms) while events are pending. Default 250 (~4/sec). */
  flushIntervalMs?: number;
  /**
   * Optional deployment-owned ceiling for the UTF-8 bytes in the serialized
   * `events[]` array. Unset means no byte ceiling; hosts should inject the
   * same value their activity ingress enforces.
   */
  maxBatchBytes?: number;
}

export class ProgressEventTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBatchBytes: number,
  ) {
    super(`Progress event requires ${actualBytes} UTF-8 bytes, exceeding maxBatchBytes ${maxBatchBytes}.`);
    this.name = 'ProgressEventTooLargeError';
  }
}

const encoder = new TextEncoder();

function assertPositiveSafeInteger(value: number | undefined, name: keyof ProgressBatcherOptions): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive safe integer when configured.`);
  }
}

export function validateProgressBatcherOptions(options: ProgressBatcherOptions = {}): void {
  assertPositiveSafeInteger(options.maxBatchSize, 'maxBatchSize');
  assertPositiveSafeInteger(options.flushIntervalMs, 'flushIntervalMs');
  assertPositiveSafeInteger(options.maxBatchBytes, 'maxBatchBytes');
}

function encodedEventsBytes(events: readonly AgentEvent[]): number {
  return encoder.encode(JSON.stringify(events)).length;
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
  private readonly maxBatchBytes: number | undefined;

  constructor(
    private readonly emit: ProgressEmitter,
    options: ProgressBatcherOptions = {},
  ) {
    validateProgressBatcherOptions(options);
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maxBatchBytes = options.maxBatchBytes;
  }

  push(event: AgentEvent): void {
    if (this.maxBatchBytes !== undefined) {
      const eventBytes = encodedEventsBytes([event]);
      if (eventBytes > this.maxBatchBytes) {
        throw new ProgressEventTooLargeError(eventBytes, this.maxBatchBytes);
      }
      if (
        this.buffer.length > 0 &&
        encodedEventsBytes([...this.buffer, event]) > this.maxBatchBytes
      ) {
        this.flush();
      }
    }
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
