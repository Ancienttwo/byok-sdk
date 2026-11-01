// The SSE route's own decisions: 404 before streaming, cursors as SSE ids,
// `Last-Event-ID` passed back as `after`, and `from: 'state'` for a new stream
// or an unknown cursor.
// The feed itself is covered by @byok-sdk/server's tests.
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
  const calls: Array<{ after?: string; from?: 'state' }> = [];
  const tasks: Tasks = {
    get: async () => snapshot,
    events(_taskId, options) {
      calls.push({ ...(options?.after === undefined ? {} : { after: options.after }), ...(options?.from === undefined ? {} : { from: options.from }) });
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

  it('starts a new stream at the current state, each entry with its cursor as the SSE id', async () => {
    const { tasks, calls } = scripted(SNAPSHOT, [[RUNNING, PROGRESS]]);
    const response = await app(tasks).request('/api/tasks/task-1/events');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await messages(response)).toEqual([
      { id: 'feed-a.2', event: RUNNING.event },
      { id: 'feed-a.3', event: PROGRESS.event },
    ]);
    expect(calls).toEqual([{ from: 'state' }]);
  });

  it('resumes after the Last-Event-ID a reconnecting browser sends', async () => {
    const { tasks, calls } = scripted(SNAPSHOT, [[PROGRESS]]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.2' } });
    expect(await messages(response)).toEqual([{ id: 'feed-a.3', event: PROGRESS.event }]);
    expect(calls).toEqual([{ after: 'feed-a.2' }]);
  });

  it('starts at the current state when the cursor is unknown', async () => {
    const live: TaskEventEntry = { cursor: 'feed-b.0', event: { kind: 'state', state: 'Running', at: '2026-10-27T00:00:06.000Z' } };
    const { tasks, calls } = scripted(SNAPSHOT, [new TaskEventsUnavailableError('task-1', 'cursor_unknown'), [live]]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.3' } });
    expect(await messages(response)).toEqual([{ id: 'feed-b.0', event: live.event }]);
    expect(calls).toEqual([{ after: 'feed-a.3' }, { from: 'state' }]);
  });

  it('sends the pending approval with the current state when the fallback finds the task waiting', async () => {
    const request: TaskEventEntry = { cursor: 'feed-b.4', event: { kind: 'await_approval', summary: 'ok to write?', approvalId: 'appr-7' } };
    const waiting: TaskEventEntry = { cursor: 'feed-b.5', event: { kind: 'state', state: 'AwaitApproval', at: '2026-10-27T00:00:06.000Z' } };
    const { tasks, calls } = scripted(SNAPSHOT, [new TaskEventsUnavailableError('task-1', 'cursor_unknown'), [request, waiting]]);
    const response = await app(tasks).request('/api/tasks/task-1/events', { headers: { 'Last-Event-ID': 'feed-a.3' } });
    expect(await messages(response)).toEqual([
      { id: 'feed-b.4', event: request.event },
      { id: 'feed-b.5', event: waiting.event },
    ]);
    expect(calls).toEqual([{ after: 'feed-a.3' }, { from: 'state' }]);
  });
});
