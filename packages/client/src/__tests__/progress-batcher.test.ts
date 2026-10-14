import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import {
  ProgressBatcher,
  ProgressEventTooLargeError,
} from '../daemon/progress-batcher';

const encoder = new TextEncoder();

function eventsBytes(events: readonly AgentEvent[]): number {
  return encoder.encode(JSON.stringify(events)).length;
}

describe('ProgressBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediately once maxBatchSize events accumulate', () => {
    const emitted: Array<{ seq: number; events: AgentEvent[] }> = [];
    const batcher = new ProgressBatcher((seq, events) => emitted.push({ seq, events }), {
      maxBatchSize: 3,
      flushIntervalMs: 1000,
    });

    batcher.push({ type: 'progress', text: 'a' });
    batcher.push({ type: 'progress', text: 'b' });
    expect(emitted).toHaveLength(0);
    batcher.push({ type: 'progress', text: 'c' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      seq: 1,
      events: [
        { type: 'progress', text: 'a' },
        { type: 'progress', text: 'b' },
        { type: 'progress', text: 'c' },
      ],
    });
  });

  it('otherwise flushes on the interval timer', () => {
    const emitted: Array<{ seq: number; events: AgentEvent[] }> = [];
    const batcher = new ProgressBatcher((seq, events) => emitted.push({ seq, events }), {
      maxBatchSize: 10,
      flushIntervalMs: 250,
    });

    batcher.push({ type: 'progress', text: 'a' });
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.events).toEqual([{ type: 'progress', text: 'a' }]);
  });

  it('seq is monotonic per task across multiple flushes', () => {
    const emitted: Array<{ seq: number; events: AgentEvent[] }> = [];
    const batcher = new ProgressBatcher((seq, events) => emitted.push({ seq, events }), {
      maxBatchSize: 1,
      flushIntervalMs: 250,
    });

    batcher.push({ type: 'progress', text: 'a' });
    batcher.push({ type: 'progress', text: 'b' });
    batcher.push({ type: 'progress', text: 'c' });

    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('does not flush an empty buffer on timer tick', () => {
    const emitted: unknown[] = [];
    const batcher = new ProgressBatcher((seq, events) => emitted.push({ seq, events }), {
      flushIntervalMs: 100,
    });
    vi.advanceTimersByTime(500);
    expect(emitted).toHaveLength(0);
    batcher.stop();
  });

  it('manual flush() is idempotent when nothing is buffered', () => {
    const emitted: unknown[] = [];
    const batcher = new ProgressBatcher((seq, events) => emitted.push({ seq, events }));
    batcher.flush();
    batcher.flush();
    expect(emitted).toHaveLength(0);
  });

  describe('server activity ingress', () => {
    it('batches two 40 KiB results separately under the default budget', () => {
      const emitted: AgentEvent[][] = [];
      const batcher = new ProgressBatcher((_seq, events) => emitted.push(events));
      const event: AgentEvent = { type: 'tool_result', tool: 'read', output: 'x'.repeat(40 * 1024) };
      batcher.push(event); batcher.push(event); batcher.flush();
      expect(emitted).toEqual([[event], [event]]);
      expect(emitted.every((batch) => eventsBytes(batch) <= 65536)).toBe(true);
    });

    it.each(['x'.repeat(100 * 1024), '😀中文'.repeat(10000), '\"\\\n\u0000'.repeat(10000), '\ud800'.repeat(10000)])('splits oversize text losslessly (%#)', (text) => {
      const emitted: AgentEvent[][] = [];
      const batcher = new ProgressBatcher((_seq, events) => emitted.push(events), {}, () => ({ activityMaxEvents: 2, activityMaxBytes: 1024 }));
      batcher.push({ type: 'progress', text }); batcher.flush();
      expect(emitted.length).toBeGreaterThan(1);
      expect(emitted.every((batch) => batch.length <= 2 && eventsBytes(batch) <= 1024)).toBe(true);
      expect(emitted.flat().map((event) => event.type === 'progress' ? event.text : '').join('')).toBe(text);
    });

    it('reads changes in the advertised event count and byte ceiling', () => {
      let budget = { activityMaxEvents: 2, activityMaxBytes: 100 };
      const emitted: AgentEvent[][] = [];
      const batcher = new ProgressBatcher((_seq, events) => emitted.push(events), { maxBatchSize: 10 }, () => budget);
      batcher.push({ type: 'progress', text: 'a' }); batcher.push({ type: 'progress', text: 'b' });
      expect(emitted).toHaveLength(1);
      budget = { activityMaxEvents: 1, activityMaxBytes: 50 };
      batcher.push({ type: 'progress', text: 'c' });
      expect(emitted).toHaveLength(2);
      expect(eventsBytes(emitted[1]!)).toBeLessThanOrEqual(50);
    });

    it('rejects an unsplittable event and rejects the removed Host option', () => {
      const batcher = new ProgressBatcher(() => {}, {}, () => ({ activityMaxEvents: 1, activityMaxBytes: 50 }));
      expect(() => batcher.push({ type: 'error', message: 'x'.repeat(100) })).toThrow(ProgressEventTooLargeError);
      expect(() => new ProgressBatcher(() => {}, { maxBatchBytes: 50 } as never)).toThrow(/Unknown progressBatch option/);
    });
  });

  describe('pendingCount (M4 Phase 4, part B.3: observability watermark)', () => {
    it('starts at 0 and grows with each buffered (not-yet-flushed) push', () => {
      const batcher = new ProgressBatcher(() => {}, { maxBatchSize: 5, flushIntervalMs: 1000 });
      expect(batcher.pendingCount).toBe(0);

      batcher.push({ type: 'progress', text: 'a' });
      expect(batcher.pendingCount).toBe(1);
      batcher.push({ type: 'progress', text: 'b' });
      expect(batcher.pendingCount).toBe(2);
    });

    it('drops back to 0 once flushed manually', () => {
      const batcher = new ProgressBatcher(() => {}, { maxBatchSize: 5, flushIntervalMs: 1000 });
      batcher.push({ type: 'progress', text: 'a' });
      batcher.flush();
      expect(batcher.pendingCount).toBe(0);
    });

    it('drops back to 0 once maxBatchSize triggers an automatic flush', () => {
      const batcher = new ProgressBatcher(() => {}, { maxBatchSize: 2, flushIntervalMs: 1000 });
      batcher.push({ type: 'progress', text: 'a' });
      expect(batcher.pendingCount).toBe(1);
      batcher.push({ type: 'progress', text: 'b' });
      expect(batcher.pendingCount).toBe(0);
    });

    it('drops back to 0 once the interval timer flushes', () => {
      const batcher = new ProgressBatcher(() => {}, { maxBatchSize: 10, flushIntervalMs: 250 });
      batcher.push({ type: 'progress', text: 'a' });
      expect(batcher.pendingCount).toBe(1);
      vi.advanceTimersByTime(250);
      expect(batcher.pendingCount).toBe(0);
    });
  });
});
