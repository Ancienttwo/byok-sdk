import { ByokCloudError, isCloudError, type ActivityTail, type TaskEventsWake, type TenantId } from '@byok-sdk/cloud';
import { TASK_STATES, type TaskState } from '@byok-sdk/protocol';
import type { TaskEventRelay } from './relay';
import { TaskEventsUnavailableError, type ServerTaskEvent, type TaskEventEntry } from './types';

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['Complete', 'Failed', 'Cancelled']);
const TRUNCATED: ServerTaskEvent = { kind: 'error', reason: 'events_truncated' };
const CURSOR_PREFIX = 'te1.';

/** One task's current facts, from the same reads `tasks.get` answers with. */
export interface TaskEventFacts {
  readonly state: TaskState;
  readonly at: string;
  /** The unresolved approval, with its request as an `await_approval` event when it is a plaintext one. */
  readonly approval?: { readonly revision: number; readonly request?: ServerTaskEvent };
}

/** A position in one generation of a task's activity log. */
export interface ActivityLogPosition {
  readonly generation: string;
  readonly revision: number;
}

/** The durable sources a task event read projects. */
export interface TaskEventSources {
  /** Undefined when the task's attempt does not exist. */
  readFacts(taskId: string): Promise<TaskEventFacts | undefined>;
  /** `ByokCloud.readActivity`, after `after` when given. */
  readActivity(taskId: string, after?: ActivityLogPosition): Promise<ActivityTail | undefined>;
}

export interface TaskEventDeps {
  readonly relay: TaskEventRelay;
  readonly tenant: TenantId;
  readonly sources: TaskEventSources;
  /**
   * The stores' own commit hints (#1113 A4). Every writer of a task's state,
   * activity log or approval timeline signals it, retirement and maintenance
   * included; a reader no hint reaches re-reads within its fallback.
   */
  readonly wake: TaskEventsWake;
  /** Ends every read when the server closes. */
  readonly shutdown: AbortSignal;
}

/** Where a task event read starts, and what stops it; see `ByokServer.tasks.events`. */
export interface TaskEventReadOptions {
  readonly after?: string;
  readonly from?: 'state';
  readonly signal?: AbortSignal;
}

/**
 * What a reader has consumed of each source. `log` names the last activity
 * revision read in full and `offset` how many events of the next revision were
 * already yielded, so a reader stopped inside a batch resumes inside it.
 * `approval` is the revision of the last approval request yielded and `state`
 * the last state yielded. Each entry's cursor advances only the source that
 * entry came from.
 */
interface Position {
  readonly log?: ActivityLogPosition;
  readonly offset: number;
  readonly approval: number;
  readonly state?: TaskState;
}

const START: Position = { offset: 0, approval: 0 };

function encodeCursor(taskId: string, position: Position): string {
  const body = [taskId, position.log?.generation ?? null, position.log?.revision ?? 0, position.offset, position.approval, position.state ?? null];
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url');
}

/** The position `cursor` names for `taskId`, or `cursor_unknown` for anything this server did not hand out for that task. */
function decodeCursor(taskId: string, cursor: string): Position {
  const unknown = () => new TaskEventsUnavailableError(taskId, 'cursor_unknown');
  if (!cursor.startsWith(CURSOR_PREFIX)) throw unknown();
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw unknown();
  }
  if (!Array.isArray(body) || body.length !== 6) throw unknown();
  const [task, generation, revision, offset, approval, state] = body as unknown[];
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (task !== taskId || !count(revision) || !count(offset) || !count(approval)) throw unknown();
  if (generation === null ? revision !== 0 || offset !== 0 : typeof generation !== 'string' || generation.length === 0) throw unknown();
  if (state !== null && !TASK_STATES.includes(state as TaskState)) throw unknown();
  return {
    ...(generation === null ? {} : { log: { generation: generation as string, revision } }),
    offset, approval, ...(state === null ? {} : { state: state as TaskState }),
  };
}

/**
 * One task's event feed, shared by `ByokServer.tasks.events` and
 * `TaskHandle.events()`. Every refusal is thrown by the first `next()`, before
 * any entry. `return()` also releases a pending `next()`: an async generator
 * would queue it behind the outstanding `next()`, so a reader stopping an idle
 * feed would hang. `project` shapes each entry.
 */
export function readTaskEvents<T = TaskEventEntry>(
  deps: TaskEventDeps,
  taskId: string,
  options: TaskEventReadOptions = {},
  project: (entry: TaskEventEntry) => T = (entry) => entry as T,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const stop = new AbortController();
      const signal = AbortSignal.any([stop.signal, deps.shutdown, ...(options.signal === undefined ? [] : [options.signal])]);
      const entries = followTaskEvents(deps, taskId, options, signal);
      return {
        async next(): Promise<IteratorResult<T>> {
          const next = await entries.next();
          return next.done ? next : { value: project(next.value), done: false };
        },
        return(): Promise<IteratorResult<T>> {
          stop.abort();
          return entries.return() as Promise<IteratorReturnResult<void>>;
        },
      };
    },
  };
}

/**
 * The read-time projection of three authorities (#1113): canonical task state
 * and the approval timeline, read the way `tasks.get` reads them, and the
 * durable activity log. Each read window yields, in this order: the pending
 * approval request when it is new, the state when it changed, then the log
 * entries in revision order. A terminal state comes after the log was read
 * once more past it, and ends the feed. The window order is not a causal order
 * across the three sources, which never shared one.
 *
 * Facts are read before the log, so the log read that follows a terminal
 * state holds every entry admitted before that terminal.
 */
async function* followTaskEvents(
  deps: TaskEventDeps,
  taskId: string,
  { after, from }: TaskEventReadOptions,
  signal: AbortSignal,
): AsyncGenerator<TaskEventEntry, void, undefined> {
  if (after !== undefined && from !== undefined) throw new TypeError('tasks.events takes after or from, not both');
  const { relay, sources } = deps;
  if (relay.stopped || signal.aborted) return;
  let position = after === undefined ? undefined : decodeCursor(taskId, after);
  // Subscribed before the first read, so a commit during any read is kept.
  const changes = deps.wake.subscribe(deps.tenant, taskId, signal);
  const entry = (event: ServerTaskEvent): TaskEventEntry => ({ cursor: encodeCursor(taskId, position!), event });
  try {
    for (let window = 0; ; window += 1) {
      const facts = await sources.readFacts(taskId);
      if (signal.aborted || relay.stopped) return;
      if (facts === undefined) {
        if (window === 0) throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
        return;
      }
      position ??= from === 'state' ? await logHead(sources, taskId) : START;
      const terminal = TERMINAL_STATES.has(facts.state);
      if (!terminal) {
        if (facts.approval !== undefined && facts.approval.revision > position.approval) {
          position = { ...position, approval: facts.approval.revision };
          if (facts.approval.request !== undefined) yield entry(facts.approval.request);
        }
        if (facts.state !== position.state) {
          position = { ...position, state: facts.state };
          yield entry({ kind: 'state', state: facts.state, at: facts.at });
        }
      }
      const log = readLog(sources, taskId, position, window === 0);
      try {
        for (let item = await log.next(); ; item = await log.next()) {
          if (signal.aborted) return;
          if (item.done) {
            position = item.value;
            break;
          }
          position = item.value.position;
          yield entry(item.value.event);
        }
      } finally {
        await log.return(position);
      }
      if (terminal) {
        if (facts.state !== position.state) {
          position = { ...position, state: facts.state };
          yield entry({ kind: 'state', state: facts.state, at: facts.at });
        }
        return;
      }
      await changes.next(Number.MAX_SAFE_INTEGER);
      if (signal.aborted) return;
    }
  } finally {
    changes.close();
  }
}

/** `from: 'state'`: nothing of the log that is already written. */
async function logHead(sources: TaskEventSources, taskId: string): Promise<Position> {
  const tail = await sources.readActivity(taskId);
  return tail === undefined ? START : { ...START, log: { generation: tail.cursor.generation, revision: tail.cursor.revision } };
}

/**
 * The log entries after `position`, each with the position just past it, then
 * the position past everything read. A position whose history is gone (evicted
 * below the retained floor, expired, removed, another generation) yields one
 * `events_truncated` marker, whose cursor stands at the start of what is
 * retained, then the retained entries.
 */
async function* readLog(
  sources: TaskEventSources,
  taskId: string,
  start: Position,
  firstRead: boolean,
): AsyncGenerator<{ readonly event: ServerTaskEvent; readonly position: Position }, Position, undefined> {
  let position = start;
  let tail: ActivityTail | undefined;
  try {
    tail = await sources.readActivity(taskId, position.log);
  } catch (caught) {
    if (isCloudError(caught, 'activity_cursor_invalid') && firstRead) throw new TaskEventsUnavailableError(taskId, 'cursor_unknown');
    if (!isCloudError(caught, 'activity_history_gap')) throw caught;
    tail = await sources.readActivity(taskId);
    position = withLog(position, tail === undefined ? undefined : { generation: tail.cursor.generation, revision: tail.floor });
    yield { event: TRUNCATED, position };
  }
  if (tail === undefined) return position;
  const generation = tail.cursor.generation;
  // A fresh read starts at what is retained; an evicted prefix it never saw is not a gap.
  let revision = position.log?.revision ?? tail.floor;
  let read = false;
  for (const logged of tail.entries) {
    switch (logged.kind) {
      case 'progress': {
        const skip = logged.revision === revision + 1 ? position.offset : 0;
        for (let index = skip; index < logged.events.length; index += 1) {
          const last = index + 1 === logged.events.length;
          position = withLog(position, { generation, revision: last ? logged.revision : logged.revision - 1 }, last ? 0 : index + 1);
          yield { event: { kind: 'agent', event: logged.events[index]! }, position };
        }
        break;
      }
      case 'artifact':
        position = withLog(position, { generation, revision: logged.revision });
        yield { event: { kind: 'artifact', artifact: logged.artifact }, position };
        break;
      case 'sealed-progress':
        // The embedded server refuses sealed dispatch, so its gate admits no sealed output.
        throw new Error(`task ${taskId} has sealed activity, which this server cannot serve`);
    }
    revision = logged.revision;
    read = true;
  }
  // An entry that yields nothing (an empty batch) still advances the read.
  return read || position.log === undefined ? withLog(position, { generation, revision }) : position;
}

function withLog(position: Position, log: ActivityLogPosition | undefined, offset = 0): Position {
  const { log: _previous, ...rest } = position;
  return log === undefined ? { ...rest, offset } : { ...rest, log, offset };
}
