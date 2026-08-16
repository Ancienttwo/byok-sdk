import type { ActivityTail, TimelineEvent } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import {
  TimelineFoldError,
  createTimelineState,
  foldTimelineEvent,
  projectTimeline,
  replayTimeline,
  withTimelineMetadata,
} from '../index';

const receivedAt = '2026-08-16T12:00:00.000Z';

function timelineEvent(
  batchSeq: number,
  eventIndex: number,
  event: TimelineEvent['event'],
  sourceEnvelopeId = `env-${batchSeq}`,
): TimelineEvent {
  return { taskId: 'task-1', sourceEnvelopeId, batchSeq, eventIndex, receivedAt, event };
}

function tail(entries: readonly TimelineEvent[]): ActivityTail {
  return {
    tenantId: 'tenant-1' as ActivityTail['tenantId'],
    taskId: 'task-1',
    entries,
    cursor: { batchSeq: 9, eventIndex: 1 },
    dropped: 4,
    capacity: 50,
    expiresAt: '2026-08-16T13:00:00.000Z',
  };
}

function expectCode(run: () => unknown, code: TimelineFoldError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TimelineFoldError);
    expect((error as TimelineFoldError).code).toBe(code);
    return;
  }
  throw new Error(`Expected TimelineFoldError(${code}).`);
}

describe('Live Activity Timeline fold', () => {
  it('makes replay and out-of-order incremental folding identical and overlap idempotent', () => {
    const events = [
      timelineEvent(0, 0, { type: 'progress', text: 'A' }),
      timelineEvent(0, 1, { type: 'progress', text: 'B' }),
      timelineEvent(1, 0, { type: 'tool_use', tool: 'shell', toolCallId: 'call-1', input: { command: 'pwd' } }),
      timelineEvent(2, 0, { type: 'tool_result', tool: 'shell', toolCallId: 'call-1', output: 'ok', isError: false }),
      timelineEvent(3, 0, { type: 'turn_end' }),
    ];
    const replayed = replayTimeline(tail(events));
    let state = createTimelineState('task-1');
    for (const event of [events[3]!, events[1]!, events[0]!, events[4]!, events[2]!]) {
      state = foldTimelineEvent(state, event);
    }
    const beforeOverlap = state;
    state = foldTimelineEvent(state, events[3]!);
    expect(state).toBe(beforeOverlap);
    state = withTimelineMetadata(state, {
      dropped: 4,
      capacity: 50,
      expiresAt: '2026-08-16T13:00:00.000Z',
      cursor: { batchSeq: 9, eventIndex: 1 },
    });
    expect(projectTimeline(state)).toEqual(replayed);
    expect(replayed.items[0]).toMatchObject({
      kind: 'text-activity',
      fragments: [{ text: 'A' }, { text: 'B' }],
    });
    expect(replayed.items[1]).toMatchObject({ kind: 'tool', state: 'output-available', toolCallId: 'call-1' });
  });

  it('pairs same-name concurrent tools only by native call ID', () => {
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, { type: 'tool_use', tool: 'shell', toolCallId: 'a', input: 'first' }),
      timelineEvent(0, 1, { type: 'tool_use', tool: 'shell', toolCallId: 'b', input: 'second' }),
      timelineEvent(1, 0, { type: 'tool_result', tool: 'shell', toolCallId: 'b', output: 'B', isError: false }),
      timelineEvent(1, 1, { type: 'tool_result', tool: 'shell', toolCallId: 'a', output: 'A', isError: false }),
    ]));
    const tools = snapshot.items.filter((item) => item.kind === 'tool');
    expect(tools).toMatchObject([
      { toolCallId: 'a', input: 'first', output: 'A' },
      { toolCallId: 'b', input: 'second', output: 'B' },
    ]);
  });

  it('converges when a result is ordered before its matching use', () => {
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, { type: 'tool_result', tool: 'shell', toolCallId: 'early', output: 'done', isError: false }),
      timelineEvent(1, 0, { type: 'tool_use', tool: 'shell', toolCallId: 'early', input: 'command' }),
    ]));
    expect(snapshot.items).toMatchObject([{
      kind: 'tool', toolCallId: 'early', state: 'output-available', input: 'command', output: 'done',
      eventKeys: [{ sourceEnvelopeId: 'env-0', eventIndex: 0 }, { sourceEnvelopeId: 'env-1', eventIndex: 0 }],
    }]);
  });

  it('keeps missing IDs explicitly unpaired and maps only native error authority', () => {
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, { type: 'tool_use', tool: 'custom', input: 'same' }),
      timelineEvent(0, 1, { type: 'tool_result', tool: 'custom', output: 'same' }),
      timelineEvent(1, 0, { type: 'tool_use', tool: 'x', toolCallId: 'ok' }),
      timelineEvent(1, 1, { type: 'tool_result', tool: 'x', toolCallId: 'ok', output: { error: true }, isError: false }),
      timelineEvent(2, 0, { type: 'tool_use', tool: 'x', toolCallId: 'bad' }),
      timelineEvent(2, 1, { type: 'tool_result', tool: 'x', toolCallId: 'bad', output: 'looks fine', isError: true }),
      timelineEvent(3, 0, { type: 'tool_use', tool: 'x', toolCallId: 'unknown' }),
      timelineEvent(3, 1, { type: 'tool_result', tool: 'x', toolCallId: 'unknown', output: 'ok' }),
    ]));
    expect(snapshot.items.filter((item) => item.kind === 'tool').map((item) => item.state)).toEqual([
      'unpaired-use', 'unpaired-result', 'output-available', 'output-error', 'output-unknown',
    ]);
  });

  it('preserves unknown and unsupported known events at their original positions', () => {
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, { type: 'future.observation', secret: 'not projected' }),
      timelineEvent(0, 1, { type: 'needs_approval', summary: 'host-only approval' }),
      timelineEvent(0, 2, { type: 'artifact', name: 'a.txt', contentType: 'text/plain' }),
      timelineEvent(0, 3, { type: 'usage', inputTokens: 3, totalTokens: 5 }),
      timelineEvent(0, 4, { type: 'error', message: 'failed' }),
    ]));
    expect(snapshot.items.map((item) => item.kind)).toEqual(['unknown', 'unknown', 'artifact', 'usage', 'error']);
    expect(snapshot.items[0]).toEqual(expect.objectContaining({ eventType: 'future.observation', classification: 'unknown-event' }));
    expect(snapshot.items[0]).not.toHaveProperty('secret');
    expect(snapshot.items[1]).toEqual(expect.objectContaining({ eventType: 'needs_approval', classification: 'unsupported-known-event' }));
  });

  it('projects gaps and store-owned loss, capacity, cursor and expiry separately', () => {
    const snapshot = replayTimeline(tail([
      timelineEvent(4, 0, { type: 'progress', text: 'first observed' }),
      timelineEvent(4, 2, { type: 'progress', text: 'event gap' }),
      timelineEvent(7, 3, { type: 'turn_end' }),
    ]));
    expect(snapshot).toMatchObject({ dropped: 4, capacity: 50, expiresAt: '2026-08-16T13:00:00.000Z' });
    expect(snapshot.gaps.map(({ kind, missing }) => ({ kind, missing }))).toEqual([
      { kind: 'event', missing: 1 },
      { kind: 'batch', missing: 2 },
      { kind: 'event', missing: 3 },
    ]);
    expect(snapshot.items.filter((item) => item.kind === 'text-activity')).toHaveLength(2);
  });

  it('fails closed on malformed authority and every ambiguous collision', () => {
    const base = timelineEvent(0, 0, { type: 'progress', text: 'valid' }, 'identity');
    const state = foldTimelineEvent(createTimelineState('task-1'), base);
    expectCode(() => foldTimelineEvent(state, { ...base, batchSeq: 1 } as TimelineEvent), 'identity_collision');
    expectCode(() => foldTimelineEvent(state, { ...base, sourceEnvelopeId: 'other' }), 'order_collision');
    expectCode(() => foldTimelineEvent(state, { ...base, taskId: 'task-2', sourceEnvelopeId: 'other', batchSeq: 2 }), 'task_mismatch');
    expectCode(() => foldTimelineEvent(state, {
      ...base, sourceEnvelopeId: 'bad', batchSeq: 2, event: { type: 'progress' },
    } as unknown as TimelineEvent), 'timeline_input_invalid');
    expectCode(() => foldTimelineEvent(state, timelineEvent(2, 0, {
      type: 'tool_use', tool: 'shell', input: new Map([['not', 'wire-json']]),
    })), 'timeline_input_invalid');

    const useState = foldTimelineEvent(createTimelineState('task-1'),
      timelineEvent(0, 0, { type: 'tool_use', tool: 'shell', toolCallId: 'reused' }));
    expectCode(() => projectTimeline(foldTimelineEvent(useState,
      timelineEvent(1, 0, { type: 'tool_use', tool: 'shell', toolCallId: 'reused' }))), 'tool_collision');
    expectCode(() => projectTimeline(foldTimelineEvent(useState,
      timelineEvent(1, 0, { type: 'tool_result', tool: 'other', toolCallId: 'reused' }))), 'tool_collision');
  });
});
