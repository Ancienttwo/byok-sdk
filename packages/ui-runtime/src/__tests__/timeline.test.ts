import { InMemoryActivityStore, tenantId } from '@byok-sdk/cloud';
import type { ActivityTail, TimelineEvent } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import {
  TimelineFoldError,
  type ToolTimelineItem,
  createTimelineState,
  foldTimelineEvent,
  projectTimeline,
  replayTimeline,
  withTimelineMetadata,
} from '../index';

const receivedAt = '2026-08-16T12:00:00.000Z';

/** A schema-valid inline `task-output` sealed member (#654). Only its outer fields are read. */
const SEALED_MEMBER = {
  v: 1 as const,
  suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm' as const,
  category: 'task-output' as const,
  scope: { id: 'scope-1', epoch: 1, keyId: 'K'.repeat(22) },
  chainHead: { seq: 1, hash: `sha256:${'b'.repeat(64)}` },
  sender: 'S'.repeat(43),
  salt: Buffer.alloc(32, 1).toString('base64url'),
  nonce: Buffer.alloc(12, 1).toString('base64url'),
  paddedLength: 256,
  contentMac: `hmac-sha256:${'a'.repeat(64)}`,
  ciphertext: Buffer.alloc(256 + 16, 1).toString('base64url'),
};

function timelineEvent(
  batchSeq: number,
  eventIndex: number,
  event: TimelineEvent['event'],
  sourceEnvelopeId = `env-${batchSeq}`,
): TimelineEvent {
  return { taskId: 'task-1', sourceEnvelopeId, batchSeq, eventIndex, revision: batchSeq + 1, offset: eventIndex, receivedAt, event };
}

function tail(events: readonly TimelineEvent[]): ActivityTail {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) groups.set(event.sourceEnvelopeId, [...(groups.get(event.sourceEnvelopeId) ?? []), event]);
  const entries = [...groups.values()].map((group, index) => ({
    kind: 'progress' as const, taskId: 'task-1', sourceEnvelopeId: group[0]!.sourceEnvelopeId,
    batchSeq: group[0]!.batchSeq, sourceDropped: group[0]!.sourceDropped ?? 0,
    revision: group[0]!.revision, receivedAt: group[0]!.receivedAt,
    events: [...group].sort((a, b) => a.eventIndex - b.eventIndex).map(event => event.event),
  }));
  return {
    tenantId: 'tenant-1' as ActivityTail['tenantId'], taskId: 'task-1', entries,
    cursor: { version: 1, tenantId: 'tenant-1' as ActivityTail['tenantId'], taskId: 'task-1', generation: 'test', revision: entries.length },
    floor: 0, sourceDropped: 0, byteCapacity: 4 * 1024 * 1024, retainedBytes: 0,
    dropped: 4, capacity: 50, expiresAt: '2026-08-16T13:00:00.000Z',
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
  it('refuses a sealed activity batch, which a reader must open before replay (#654 12e)', () => {
    const sealedBatch = { kind: 'sealed-progress' as const, revision: 1, sourceDropped: 0, taskId: 'task-1', sourceEnvelopeId: 'env-sealed', batchSeq: 1, eventIndex: 0 as const, receivedAt, sealed: SEALED_MEMBER };
    expectCode(() => replayTimeline({ ...tail([]), entries: [sealedBatch] }), 'timeline_input_invalid');
  });

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
      cursor: tail(events).cursor,
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

  it('preserves unknown events, including the removed needs_approval, at their original positions', () => {
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
    expect(snapshot.items[1]).toEqual(expect.objectContaining({ eventType: 'needs_approval', classification: 'unknown-event' }));
    expect(snapshot.items[1]).not.toHaveProperty('summary');
  });

  it('projects gaps and store-owned loss, capacity, cursor and expiry separately', () => {
    const events = [
      timelineEvent(4, 0, { type: 'progress', text: 'first observed' }),
      timelineEvent(4, 2, { type: 'progress', text: 'event gap' }),
      timelineEvent(7, 3, { type: 'turn_end' }),
    ];
    const source = tail(events);
    let state = createTimelineState('task-1', source);
    for (const event of events) state = foldTimelineEvent(state, event);
    const snapshot = projectTimeline(state);
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

  it('passes both spill descriptors through a paired tool item', () => {
    const inputSpill = {
      field: 'input' as const,
      totalBytes: 4096,
      omittedBytes: 3800,
      contentType: 'application/json' as const,
      blob: {
        blobId: 'blob-1',
        contentHash: `sha256:${'a'.repeat(64)}`,
        size: 4096,
        contentType: 'application/json',
      },
    };
    const outputSpill = {
      field: 'output' as const,
      totalBytes: 8192,
      omittedBytes: 7900,
      contentType: 'application/json' as const,
      unstoredReason: 'blob upload failed',
    };
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, {
        type: 'tool_use', tool: 'shell', toolCallId: 'spilled', input: { preview: { head: 'a', tail: 'z' } }, spill: inputSpill,
      }),
      timelineEvent(0, 1, {
        type: 'tool_result', tool: 'shell', toolCallId: 'spilled', output: { preview: { head: 'o', tail: 'k' } }, isError: false, spill: outputSpill,
      }),
    ]));
    const item = snapshot.items[0]!;
    expect(item.kind).toBe('tool');
    expect(item).toMatchObject({ state: 'output-available', inputSpill, outputSpill });
    expect((item as ToolTimelineItem).inputSpill).toEqual(inputSpill);
    expect((item as ToolTimelineItem).outputSpill).toEqual(outputSpill);
  });

  it('passes a spill through an unpaired tool result without inventing the other side', () => {
    const outputSpill = {
      field: 'output' as const,
      totalBytes: 2048,
      omittedBytes: 1900,
      contentType: 'application/json' as const,
      unstoredReason: 'locator exceeded the inline cap',
    };
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, { type: 'tool_result', tool: 'custom', output: { preview: { head: 'h', tail: 't' } }, spill: outputSpill }),
    ]));
    const item = snapshot.items[0]!;
    expect(item).toMatchObject({ kind: 'tool', state: 'unpaired-result' });
    expect((item as ToolTimelineItem).outputSpill).toEqual(outputSpill);
    expect(Object.hasOwn(item, 'inputSpill')).toBe(false);
  });

  it('omits both spill keys when neither source event was spilled', () => {
    const snapshot = replayTimeline(tail([
      timelineEvent(0, 0, { type: 'tool_use', tool: 'shell', toolCallId: 'plain', input: 'pwd' }),
      timelineEvent(0, 1, { type: 'tool_result', tool: 'shell', toolCallId: 'plain', output: 'ok', isError: false }),
    ]));
    const item = snapshot.items[0]!;
    expect(item).toMatchObject({ kind: 'tool', state: 'output-available' });
    expect(Object.hasOwn(item, 'inputSpill')).toBe(false);
    expect(Object.hasOwn(item, 'outputSpill')).toBe(false);
  });
});

it('reviewer: replay accepts distinct log revisions with the same producer coordinates', async () => {
  const store = new InMemoryActivityStore({ now: () => new Date('2026-10-30T00:00:00.000Z') });
  const tenant = tenantId('review');
  for (const sourceEnvelopeId of ['first', 'second']) {
    await store.append(tenant, { taskId: 'task', sourceEnvelopeId, batchSeq: 1, events: [{ type: 'progress', text: sourceEnvelopeId }], dropped: 0, ttlMs: 600_000 });
  }
  const tail = (await store.read(tenant, 'task'))!;
  expect(tail.entries.map(entry => entry.revision)).toEqual([1, 2]);
  expect(() => replayTimeline(tail)).not.toThrow();
});
