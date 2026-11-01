// `GET /api/tasks/:taskId/events`: one task's event feed as server-sent events.
// Each entry's cursor is the SSE `id`, so a browser `EventSource` that
// reconnects sends it back as `Last-Event-ID` and the feed resumes after it,
// also across a server restart over the same storage. A new stream, or one
// whose cursor this server did not hand out, starts at the task's current
// state: the pending approval request while it awaits one, then its state.
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { TaskEventsUnavailableError, type ByokServer } from '@byok-sdk/server';

export function taskEventsRoute(byok: { tasks: Pick<ByokServer['tasks'], 'get' | 'events'> }) {
  return async (c: Context) => {
    const taskId = c.req.param('taskId');
    if (taskId === undefined || (await byok.tasks.get(taskId)) === undefined) return c.json({ error: 'unknown taskId' }, 404);
    const lastEventId = c.req.header('Last-Event-ID') || undefined;
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const follow = async (start: { after: string } | { from: 'state' }) => {
        for await (const { cursor, event } of byok.tasks.events(taskId, { ...start, signal: abort.signal })) {
          await stream.writeSSE({ id: cursor, data: JSON.stringify(event) });
        }
      };
      try {
        await follow(lastEventId === undefined ? { from: 'state' } : { after: lastEventId });
      } catch (error) {
        if (!(error instanceof TaskEventsUnavailableError)) throw error;
        await follow({ from: 'state' });
      }
    });
  };
}
