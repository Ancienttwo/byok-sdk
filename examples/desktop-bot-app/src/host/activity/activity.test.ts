import { describe, expect, it, vi } from 'vitest';
import type { ByokServer } from '@byok-sdk/server';
import type { HostContext } from '../domains.ts';
import { createActivityDomain } from './domain.ts';

type Tasks = ByokServer['tasks'];
const NOW = '2026-11-12T00:00:00.000Z';

/** A server event feed that yields `task.created` for each id, then waits until `return()`. */
function createdEvents(taskIds: readonly string[]): ByokServer['events'] {
  return {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => {
        const pending = taskIds.map(taskId => ({ kind: 'task.created' as const, taskId, at: NOW }));
        let release: () => void = () => {};
        const released = new Promise<void>(resolve => { release = resolve; });
        return {
          next: async () => {
            const value = pending.shift();
            if (value) return { value, done: false as const };
            await released;
            return { value: undefined, done: true as const };
          },
          return: async () => { release(); return { value: undefined, done: true as const }; },
        };
      },
    }),
  };
}

/** One state entry, then the feed stays open until its signal aborts, or fails with `failure`. */
const feed = (failure?: Error): Tasks['events'] => async function* (_taskId, options) {
  if (failure) throw failure;
  yield { cursor: 'c1', event: { kind: 'state' } } as never;
  await new Promise(resolve => options?.signal?.addEventListener('abort', resolve));
};

const activity = {
  tenantId: 'tenant', taskId: 'task-1', floor: 0, after: 0, sourceDropped: 0, byteCapacity: 1024, retainedBytes: 0, dropped: 0,
  entries: [{
    kind: 'progress', taskId: 'task-1', sourceEnvelopeId: 'env-1', batchSeq: 1, sourceDropped: 0, revision: 1, receivedAt: NOW,
    events: [
      { type: 'tool_use', tool: 'read', toolCallId: 'a', input: {} },
      { type: 'tool_result', tool: 'read', toolCallId: 'a', output: 'boom', isError: true },
      { type: 'tool_use', tool: 'write', toolCallId: 'b', input: {} },
    ],
  }],
} as unknown as Awaited<ReturnType<Tasks['activity']>>;
const approvals = {
  tenantId: 'tenant', taskId: 'task-1', dropped: 0, cursor: 1,
  entries: [{ taskId: 'task-1', sourceEnvelopeId: 'approval-1', revision: 1, receivedAt: NOW, event: { type: 'approval_requested', approvalId: 'ap-1', summary: 'Write?' } }],
} as unknown as Awaited<ReturnType<Tasks['approvalTimeline']>>;

function domain(events: Tasks['events']) {
  const changed = vi.fn();
  const approve = vi.fn<Tasks['approve']>(async () => {});
  const tasks = {
    events, approve, reject: vi.fn(),
    activity: async (taskId: string) => taskId === 'task-1' ? activity : undefined,
    approvalTimeline: async (taskId: string) => taskId === 'task-1' ? approvals : undefined,
  };
  const server = { events: createdEvents(['task-0', 'task-1']), tasks } as unknown as ByokServer;
  return { changed, approve, created: createActivityDomain({ server, changed } as unknown as HostContext) };
}

describe('activity domain', () => {
  it('folds each created task into a card, hints on feed entries and approves the named approval', async () => {
    const { changed, approve, created } = domain(feed());
    const { handlers, close } = await created;
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(4));

    const cards = await handlers['activity.cards'](undefined);
    expect(cards.map(card => card.taskId)).toEqual(['task-1', 'task-0']);
    expect(cards[0]!.summary).toEqual({ tools: 2, activeTool: 'write', failures: 1, pendingApprovals: 1 });
    expect(cards[0]!.approvals!.items[0]).toMatchObject({ approvalId: 'ap-1', status: 'pending' });
    expect(cards[1]).toEqual({ taskId: 'task-0', timeline: null, approvals: null, summary: { tools: 0, failures: 0, pendingApprovals: 0 } });

    await expect(handlers['activity.approve']({ taskId: 'task-1' })).rejects.toMatchObject({ code: 'invalid_params' });
    await handlers['activity.approve']({ taskId: 'task-1', approvalId: 'ap-1' });
    expect(approve).toHaveBeenCalledWith('task-1', { approvalId: 'ap-1' });
    await close!();
  });

  it('refuses the card list once a task feed failed', async () => {
    const { changed, created } = domain(feed(new Error('feed broke')));
    const { handlers, close } = await created;
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await vi.waitFor(() => expect(handlers['activity.cards'](undefined)).rejects.toThrow('feed broke'));
    await close!();
  });
});
