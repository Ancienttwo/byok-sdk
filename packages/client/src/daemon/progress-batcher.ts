import { DEFAULT_ACTIVITY_INGRESS, type ActivityIngress, type AgentEvent } from '@byok-sdk/protocol';

export type ProgressEmitter = (seq: number, events: AgentEvent[]) => void;

export interface ProgressBatcherOptions {
  /** Flush immediately once this many events are buffered. Default 10. */
  maxBatchSize?: number;
  /** Otherwise flush at most this often (ms) while events are pending. Default 250 (~4/sec). */
  flushIntervalMs?: number;

}

export class ProgressEventTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`Progress event requires ${actualBytes} UTF-8 bytes, exceeding activity ingress ${maxBytes}.`);
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
  for (const key of Object.keys(options)) {
    if (key !== 'maxBatchSize' && key !== 'flushIntervalMs') throw new TypeError(`Unknown progressBatch option: ${key}`);
  }
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
  private bufferBytes = 2;

  constructor(
    private readonly emit: ProgressEmitter,
    options: ProgressBatcherOptions = {},
    private readonly ingress: () => Readonly<ActivityIngress> = () => ({ activityMaxEvents: DEFAULT_ACTIVITY_INGRESS.maxEvents, activityMaxBytes: DEFAULT_ACTIVITY_INGRESS.maxBytes }),
  ) {
    validateProgressBatcherOptions(options);
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;

  }

  push(event: AgentEvent): void {
    const budget = this.ingress();
    const maxEvents = Math.min(this.maxBatchSize, budget.activityMaxEvents);
    const maxBytes = budget.activityMaxBytes;
    const events = event.type === 'progress' && encodedEventsBytes([event]) > maxBytes
      ? splitProgressText(event, maxBytes) : [event];
    for (const part of events) {
      const bytes = encoder.encode(JSON.stringify(part)).length;
      if (bytes + 2 > maxBytes) throw new ProgressEventTooLargeError(bytes + 2, maxBytes);
      if (this.buffer.length > 0 && (this.buffer.length >= maxEvents || this.bufferBytes + 1 + bytes > maxBytes)) this.flush();
      this.bufferBytes += (this.buffer.length > 0 ? 1 : 0) + bytes;
      this.buffer.push(part);
      if (this.buffer.length >= maxEvents) this.flush();
      else this.ensureTimer();
    }
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
    this.bufferBytes = 2;
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

/** JSON escaping is additive per code point, including lone surrogates. */
function splitProgressText(event: Extract<AgentEvent, { type: 'progress' }>, maxBytes: number): AgentEvent[] {
  const room = maxBytes - encodedEventsBytes([{ ...event, text: '' }]);
  const parts: AgentEvent[] = [];
  let text = '';
  let bytes = 0;
  for (const point of event.text) {
    const width = encoder.encode(JSON.stringify(point)).length - 2;
    if (width > room) throw new ProgressEventTooLargeError(encodedEventsBytes([event]), maxBytes);
    if (bytes + width > room) {
      parts.push({ ...event, text });
      text = '';
      bytes = 0;
    }
    text += point;
    bytes += width;
  }
  if (text.length > 0) parts.push({ ...event, text });
  if (parts.length === 0) throw new ProgressEventTooLargeError(encodedEventsBytes([event]), maxBytes);
  return parts;
}
