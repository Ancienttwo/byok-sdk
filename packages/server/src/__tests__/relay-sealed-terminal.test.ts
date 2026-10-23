/**
 * #654 E3b-2: a sealed terminal settles the relay task the same as its
 * plaintext type. The relay reads no field of the sealed terminal.
 */
import { describe, expect, it } from 'vitest';
import { TaskEventRelay } from '../relay';
import type { ServerTaskEvent } from '../index';

const AT = '2026-10-24T00:00:00.000Z';

async function collect(events: AsyncIterable<ServerTaskEvent>): Promise<ServerTaskEvent[]> {
  const result: ServerTaskEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('the relay on a sealed terminal (#654 E3b-2)', () => {
  it.each([
    ['task.complete_sealed', 'Complete'],
    ['task.fail_sealed', 'Failed'],
    ['task.decline_sealed', 'Failed'],
    ['task.cancelled_sealed', 'Cancelled'],
  ] as const)('%s settles the task as %s, ends its feed and wakes the draft reader', async (type, state) => {
    const relay = new TaskEventRelay({});
    try {
      relay.noteDispatched('task-sealed', AT);
      let wakes = 0;
      relay.watchAgentMessageDraft('task-sealed', () => { wakes += 1; });

      relay.onInboundCommitted({
        tenantId: 'tenant-a',
        deviceId: 'device-1',
        envelope: { v: 3, id: 'envelope-1', ts: AT, type, task_id: 'task-sealed', payload: {} },
        outcome: 'accepted',
      } as never);

      await relay.terminal('task-sealed');
      expect(await collect(relay.events('task-sealed'))).toMatchObject([
        { kind: 'state', state: 'Offered' },
        { kind: 'state', state },
      ]);
      expect(wakes).toBeGreaterThan(0);
    } finally {
      relay.stop();
    }
  });
});
