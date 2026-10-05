import type { ActivityTail, TimelineEvent } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { createTimelineState, foldTimelineEvent, projectTimeline, replayTimeline } from '../index';

function observation(batchSeq: number, eventIndex: number, event: TimelineEvent['event']): TimelineEvent {
  return {
    taskId: 'task-1', sourceEnvelopeId: `env-${batchSeq}`, batchSeq, eventIndex,
    receivedAt: '2026-08-16T12:00:00.000Z', event,
  };
}

function tail(entries: readonly TimelineEvent[]): ActivityTail {
  return {
    tenantId: 'tenant-1' as ActivityTail['tenantId'], taskId: 'task-1', entries,
    dropped: 0, capacity: 50, expiresAt: '2026-08-16T13:00:00.000Z',
  };
}

const key = (event: TimelineEvent) => ({ sourceEnvelopeId: event.sourceEnvelopeId, eventIndex: event.eventIndex });
const order = (event: TimelineEvent) => ({ taskId: event.taskId, batchSeq: event.batchSeq, eventIndex: event.eventIndex });

const toolUse = { type: 'tool_use', tool: 'shell', toolCallId: 'call-1', input: 'pwd' } as const;
const toolResult = { type: 'tool_result', tool: 'shell', toolCallId: 'call-1', output: 'ok', isError: false } as const;

describe('F01: progress grouping follows source adjacency', () => {
  for (const resultFirst of [false, true]) {
    for (const missing of [0, 2]) {
      it(`separates progress around correlated ${resultFirst ? 'use' : 'result'} with ${missing} missing events`, () => {
        const events = [
          observation(0, 0, resultFirst ? toolResult : toolUse),
          observation(0, 1, { type: 'progress', text: 'before' }),
          observation(0, 2 + missing, resultFirst ? toolUse : toolResult),
          observation(0, 3 + missing, { type: 'progress', text: 'after' }),
        ] as const;
        const snapshot = replayTimeline(tail(events));
        expect(snapshot.items).toEqual([
          {
            kind: 'tool', eventKeys: [key(events[0]), key(events[2])], orderKey: order(events[0]),
            tool: 'shell', toolCallId: 'call-1', state: 'output-available', input: 'pwd', output: 'ok',
          },
          {
            kind: 'text-activity', eventKeys: [key(events[1])], orderKey: order(events[1]),
            fragments: [{ eventKey: key(events[1]), text: 'before' }],
          },
          {
            kind: 'text-activity', eventKeys: [key(events[3])], orderKey: order(events[3]),
            fragments: [{ eventKey: key(events[3]), text: 'after' }],
          },
        ]);
        expect(snapshot.gaps).toEqual(missing === 0 ? [] : [{
          kind: 'event', after: order(events[1]), before: order(events[2]), missing,
        }]);

        const source = tail(events);
        let state = createTimelineState(source.taskId, source);
        for (const event of [events[3], events[1], events[0], events[2]]) {
          state = foldTimelineEvent(state, event);
        }
        expect(state.events).toEqual(events);
        expect(foldTimelineEvent(state, events[2])).toBe(state);
        expect(projectTimeline(state)).toEqual(snapshot);
        expect(replayTimeline(tail([...events].reverse()))).toEqual(snapshot);
      });
    }
  }

  it.each([false, true])('groups genuinely adjacent progress after a tool pair (batch boundary: %s)', (crossBatch) => {
    const events = [
      observation(0, 0, toolUse),
      observation(0, 1, toolResult),
      observation(0, 2, { type: 'progress', text: 'first' }),
      observation(crossBatch ? 1 : 0, crossBatch ? 0 : 3, { type: 'progress', text: 'second' }),
    ] as const;
    const snapshot = replayTimeline(tail(events));
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[1]).toEqual({
      kind: 'text-activity', eventKeys: [key(events[2]), key(events[3])], orderKey: order(events[2]),
      fragments: [
        { eventKey: key(events[2]), text: 'first' },
        { eventKey: key(events[3]), text: 'second' },
      ],
    });
    expect(snapshot.gaps).toEqual([]);
  });
});
