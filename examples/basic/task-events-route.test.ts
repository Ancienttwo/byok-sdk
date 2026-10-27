// The SSE route's own decisions: 404 before streaming, cursors as SSE ids,
// `Last-Event-ID` passed back as `after`, and the snapshot fallback when the
// feed cannot resume. The feed itself is covered by @byok-sdk/server's tests.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  TaskEventsUnavailableError,
  type ByokServer,
  type ServerTaskEvent,
  type TaskEventEntry,
  type TaskSnapshot,
} from '@byok-sdk/server';
import { taskEventsRoute } from './task-events-route';

type Tasks = Pick<ByokServer['tasks'], 'get' | 'events'>;

const SNAPSHOT = { taskId: 'task-1', state: 'Running', updatedAt: '2026-10-27T00:00:05.000Z' } as TaskSnapshot;

function app(tasks: Tasks) {
  const hono = new Hono();
  hono.get('/api/tasks/:taskId/events', taskEventsRoute({ tasks }));
  return hono;
}

/** Each SSE message as its fields. */
async function messages(response: Response): Promise<Array<{ id?: string; event: ServerTaskEvent }>> {
  const text = await response.text();
  return text.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const fields = new Map(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    const id = fields.get('id');
    return { ...(id === undefined ? {} : { id }), event: JSON.parse(fields.get('data')!) as ServerTaskEvent };
  });
}

/** A scripted `tasks`: `get` answers `snapshot`; each `events` call takes the next script, a list of entries or an error to throw. */
function scripted(snapshot: TaskSnapshot | undefined, scripts: Array<TaskEventEntry[] | Error>) {
  const calls: Array<string | undefined> = [];
  const tasks: Tasks = {
    get: async () => snapshot,
    events(_taskId, options) {
      calls.push(options?.after);
      const script = scripts.shift();
      return (async function* () {
        if (script instanceof Error) throw script;
        yield* script ?? [];
      })();
    },
  };
  return { tasks, calls };
}

const RUNNING: TaskEventEntry = { cursor: 'feed-a.2', event: { kind: 'state', state: 'Running', at: '2026-10-27T00:00:02.000Z' } };
const PROGRESS: TaskEventEntry = { cursor: 'feed-a.3', event: { kind: 'agent', event: { type: 'progress', text: 'working' } } };

describe('GET /api/tasks/:taskId/events', () => {
  it('answers 404 for an unknown task without opening a stream', async () => {
    const { tasks, calls } = scripted(undefined, []);
    const response = await app(tasks).request('/api/tasks/nope/events');
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('streams each entry with its cursor as the SSE id', async () => {
    const { tasks, calls } = scripted(SNAPSHOT, [[RUNNING, PROGRESS]]);
    const response = await app(tasks).request('/api/tasks/task-1/events');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await messages(response)).toEqual([
      { id: 'feed-a.2', event: RUNNING.event },
      { id: 'feed-a.3', event: PROGRESS.event },
    ]);
    expect(calls).toEqual([undefined]);
  });

  it('resumes after the Last-Event-ID a reconnecting browser sends', async () => {
    const { tasks, calls } = scripted(SNAPSHOT, [[PROGRESS]]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.2' } });
    expect(await messages(response)).toEqual([{ id: 'feed-a.3', event: PROGRESS.event }]);
    expect(calls).toEqual(['feed-a.2']);
  });

  it('sends the current state and follows from now when the cursor is unknown', async () => {
    const live: TaskEventEntry = { cursor: 'feed-b.0', event: { kind: 'agent', event: { type: 'progress', text: 'after restart' } } };
    const { tasks, calls } = scripted(SNAPSHOT, [new TaskEventsUnavailableError('task-1', 'cursor_unknown'), [live]]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.3' } });
    expect(await messages(response)).toEqual([
      { event: { kind: 'state', state: 'Running', at: SNAPSHOT.updatedAt } },
      { id: 'feed-b.0', event: live.event },
    ]);
    expect(calls).toEqual(['feed-a.3', undefined]);
  });

  it('drops replayed states stamped before the snapshot when the fallback follows a feed with history', async () => {
    const history: TaskEventEntry[] = [
      { cursor: 'feed-b.0', event: { kind: 'state', state: 'Offered', at: '2026-10-27T00:00:00.000Z' } },
      { cursor: 'feed-b.1', event: { kind: 'state', state: 'AwaitApproval', at: '2026-10-27T00:00:03.000Z' } },
      { cursor: 'feed-b.2', event: { kind: 'agent', event: { type: 'progress', text: 'earlier line' } } },
      { cursor: 'feed-b.3', event: { kind: 'state', state: 'Running', at: SNAPSHOT.updatedAt } },
      { cursor: 'feed-b.4', event: { kind: 'state', state: 'Complete', at: '2026-10-27T00:00:09.000Z' } },
    ];
    const { tasks } = scripted(SNAPSHOT, [new TaskEventsUnavailableError('task-1', 'cursor_unknown'), history]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.3' } });
    expect(await messages(response)).toEqual([
      { event: { kind: 'state', state: 'Running', at: SNAPSHOT.updatedAt } },
      { id: 'feed-b.2', event: history[2]!.event },
      { id: 'feed-b.3', event: history[3]!.event },
      { id: 'feed-b.4', event: history[4]!.event },
    ]);
  });

  it('keeps every state when the browser resumes from a known cursor', async () => {
    const old: TaskEventEntry = { cursor: 'feed-a.1', event: { kind: 'state', state: 'Offered', at: '2026-10-27T00:00:00.000Z' } };
    const { tasks } = scripted(SNAPSHOT, [[old]]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.0' } });
    expect(await messages(response)).toEqual([{ id: 'feed-a.1', event: old.event }]);
  });

  it('sends the pending approval with the current state when the fallback finds the task waiting', async () => {
    const waiting = { ...SNAPSHOT, state: 'AwaitApproval', pendingApprovalId: 'appr-7' } as TaskSnapshot;
    const { tasks } = scripted(waiting, [new TaskEventsUnavailableError('task-1', 'cursor_unknown'), []]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.3' } });
    expect(await messages(response)).toEqual([
      { event: { kind: 'state', state: 'AwaitApproval', at: SNAPSHOT.updatedAt } },
      { event: { kind: 'await_approval', summary: 'approval appr-7 is pending', approvalId: 'appr-7' } },
    ]);
  });

  it('sends only the current state when a finished task has no feed left', async () => {
    const complete = { ...SNAPSHOT, state: 'Complete' } as TaskSnapshot;
    const { tasks, calls } = scripted(complete, [new TaskEventsUnavailableError('task-1', 'feed_expired')]);
    const response = await app(tasks).request('/api/tasks/task-1/events');
    expect(await messages(response)).toEqual([{ event: { kind: 'state', state: 'Complete', at: SNAPSHOT.updatedAt } }]);
    expect(calls).toEqual([undefined]);
  });
});
