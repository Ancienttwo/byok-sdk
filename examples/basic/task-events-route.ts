// `GET /api/tasks/:taskId/events`: one task's event feed as server-sent events.
// Each entry's cursor is the SSE `id`, so a browser `EventSource` that
// reconnects sends it back as `Last-Event-ID` and the feed resumes after it.
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
      const follow = async (after?: string) => {
        const options = after === undefined ? { signal: abort.signal } : { after, signal: abort.signal };
        for await (const { cursor, event } of byok.tasks.events(taskId, options)) {
          await stream.writeSSE({ id: cursor, data: JSON.stringify(event) });
        }
      };
      try {
        await follow(lastEventId);
      } catch (error) {
        if (!(error instanceof TaskEventsUnavailableError)) throw error;
        // The feed cannot resume where the browser left off (a server restart,
        // or a finished task whose feed was reclaimed): send the current state,
        // then follow from now while the task is still live.
        const snapshot = await byok.tasks.get(taskId);
        if (snapshot !== undefined) {
          await stream.writeSSE({ data: JSON.stringify({ kind: 'state', state: snapshot.state, at: snapshot.updatedAt }) });
        }
        if (error.reason === 'cursor_unknown') await follow();
      }
    });
  };
}
