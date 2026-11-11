/** The Host side of the activity bridge domain (`src/bridge/domains/activity.ts`). Owned by A4 #1808. */
import { BridgeError } from '../../bridge/protocol.ts';
import type { ActivityMethods } from '../../bridge/domains/activity.ts';
import type { HostDomain, HostContext } from '../domains.ts';
import { activityCard } from './cards.ts';

/** How many tasks `activity.cards` lists; the oldest leaves the list, and stops being followed, first. */
const TRACKED_LIMIT = 50;

const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The renderer's params are the untrusted boundary: validate once here and pass the typed value on. */
function decisionParams(method: string, params: unknown, withReason: boolean): { taskId: string; approvalId: string; reason?: string } {
  const value = params as { taskId?: unknown; approvalId?: unknown; reason?: unknown } | null;
  if (!isId(value?.taskId) || !isId(value.approvalId) || (withReason && value.reason !== undefined && typeof value.reason !== 'string')) {
    throw new BridgeError('invalid_params', `${method} needs { taskId: string, approvalId: string${withReason ? ', reason?: string' : ''} }`);
  }
  return { taskId: value.taskId, approvalId: value.approvalId, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

/**
 * Tracks every task the embedded server creates and follows each one's event feed until it ends at the task's terminal
 * state. Every feed entry is a change of that task's card, so the domain signals `changed` and the renderer pulls the
 * cards again; no card content travels in the hint. A feed that fails stops `activity.cards` with its error.
 */
export async function createActivityDomain(context: HostContext): Promise<HostDomain<ActivityMethods>> {
  const { server, changed } = context;
  const tracked = new Map<string, AbortController>();
  const following = new Set<Promise<void>>();
  let broken: unknown;
  const fail = (error: unknown) => {
    broken ??= error;
    changed();
  };

  const follow = (taskId: string, abort: AbortController) => {
    const feed = (async () => {
      for await (const _entry of server.tasks.events(taskId, { from: 'state', signal: abort.signal })) changed();
    })().catch(error => { if (!abort.signal.aborted) fail(error); });
    following.add(feed);
    void feed.finally(() => following.delete(feed));
  };
  const track = (taskId: string) => {
    if (tracked.has(taskId)) return;
    const abort = new AbortController();
    tracked.set(taskId, abort);
    for (const [oldest, oldestAbort] of tracked) {
      if (tracked.size <= TRACKED_LIMIT) break;
      oldestAbort.abort();
      tracked.delete(oldest);
    }
    follow(taskId, abort);
    changed();
  };

  // The server's event queue replays what it retains, so tasks created before this subscription are tracked too.
  const events = server.events.subscribe()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let next = await events.next(); !next.done; next = await events.next()) {
      if (next.value.kind === 'task.created') track(next.value.taskId);
    }
  })().catch(fail);

  const card = async (taskId: string) => activityCard(taskId, await server.tasks.activity(taskId), await server.tasks.approvalTimeline(taskId));
  return {
    handlers: {
      'activity.cards': async () => {
        if (broken !== undefined) throw broken;
        return Promise.all([...tracked.keys()].reverse().map(card));
      },
      'activity.card': async params => {
        const taskId = (params as { taskId?: unknown } | null)?.taskId;
        if (!isId(taskId)) throw new BridgeError('invalid_params', 'activity.card needs { taskId: string }');
        return card(taskId);
      },
      'activity.approve': async params => {
        const { taskId, approvalId } = decisionParams('activity.approve', params, false);
        await server.tasks.approve(taskId, { approvalId });
        return null;
      },
      'activity.reject': async params => {
        const { taskId, approvalId, reason } = decisionParams('activity.reject', params, true);
        await server.tasks.reject(taskId, reason, { approvalId });
        return null;
      },
    },
    close: async () => {
      await events.return?.();
      for (const abort of tracked.values()) abort.abort();
      await Promise.all([pump, ...following]);
    },
  };
}
