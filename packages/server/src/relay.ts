import type { InboundCommitted, ByokCloudObserver } from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import { AsyncEventQueue, type QueueEntry } from './event-queue';
import type { ByokServerEvent, ServerTaskEvent } from './types';

/** Per-task {@link ServerTaskEvent} retention before drop-oldest engages. */
export const DEFAULT_TASK_EVENT_BUFFER_LIMIT = 1000;
/** How long a terminal task's relay state is retained before reclamation, ms. */
export const DEFAULT_TASK_EVENT_RETENTION_MS = 5 * 60_000;
/** Largest delay `setTimeout` honors; a longer one fires after 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The relay's own truncation marker. A single `error` entry per gap a reader
 * fell into is the whole contract: it says "entries were dropped from this
 * feed", not what they were — a reader that needs the facts reads them back
 * (`ByokServer.tasks.get`, `TaskHandle.result()`).
 */
const TRUNCATION_MARKER: ServerTaskEvent = { kind: 'error', reason: 'events_truncated' };

/**
 * Thrown by the first `next()` of `ByokServer.tasks.events` or
 * {@link TaskHandle.events}, before any entry, when the read cannot continue
 * from where the caller asked. Read the task's current facts with
 * `ByokServer.tasks.get` instead. It lives with the relay, which owns both
 * reasons: the feed a cursor names, and how long a terminal feed is retained.
 *
 * - `cursor_unknown`: `after` names no position in this instance's current
 *   feed of the task (a restart, another task's cursor, or a malformed one).
 * - `feed_expired`: the task is terminal and this instance retains no feed for
 *   it, because retention reclaimed it or the task ended before this instance
 *   started.
 */
export class TaskEventsUnavailableError extends Error {
  readonly taskId: string;
  readonly reason: 'cursor_unknown' | 'feed_expired';

  constructor(taskId: string, reason: 'cursor_unknown' | 'feed_expired') {
    super(`events of task ${taskId} unavailable: ${reason}`);
    this.name = 'TaskEventsUnavailableError';
    this.taskId = taskId;
    this.reason = reason;
  }
}

/**
 * One task's delivery plumbing. A feed is provisional while its dispatch is
 * in flight, dispatched once the offer is accepted, and neither when a host
 * event read attached it to a task this instance did not dispatch (a restart).
 */
export interface TaskFeed {
  /** Random per feed, so a cursor from a previous instance or a reclaimed feed is recognizably unknown. */
  readonly feedId: string;
  readonly queue: AsyncEventQueue<ServerTaskEvent>;
  readonly terminal: Promise<void>;
  settleTerminal: () => void;
  terminalSettled: boolean;
  provisional: boolean;
  dispatched: boolean;
  readonly early: Array<{ readonly envelope: InboundCommitted['envelope']; readonly at: string }>;
  claimedRuntime?: RuntimeId;
  claimedHarnessId?: string;
  reclaimTimer?: ReturnType<typeof setTimeout>;
}

export interface TaskEventRelayOptions {
  readonly taskEventBufferLimit?: number;
  readonly taskEventRetentionMs?: number;
}

/**
 * Post-commit fan-out: cloud kernel envelopes -> `ServerTaskEvent` /
 * `ByokServerEvent`.
 *
 * The invariant this file exists to keep (WP3B §3): **the relay holds
 * notifications, never state**. It never answers "what is this task", "what did
 * it produce" or "who owns it" — every one of those is read back from the
 * kernel's durable stores on demand. What it owns is per-task delivery
 * plumbing: a bounded replayable queue, and one promise that settles when the
 * task reaches a terminal so `TaskHandle.result()` has something to await
 * before it reads the answer back.
 *
 * The two small facts it does carry are delivery bookkeeping, not a read model:
 * `terminalSettled` (so the FIRST terminal is the one that settles the promise,
 * matching the store's own first-terminal-wins rule, and a later stale terminal
 * is not announced as a second one) and `claimedRuntime` (echoed onto the
 * `task.state` event stream because the pre-fold feed carried it there; the
 * authoritative copy is `TaskAttempt.claimedRuntime`).
 *
 * Dispatch first {@link provision}s a known task id, then activates it with
 * {@link noteDispatched} after the kernel has accepted its offer. Envelopes
 * that arrive in that narrow interval are buffered, not dropped. An envelope
 * naming a task with no feed is folded for nobody and allocates nothing —
 * otherwise a device could grow this map without bound by guessing task ids,
 * and the kernel's gate deliberately treats such an envelope as a harmless
 * store no-op rather than a rejection.
 *
 * Host event reads (`readTaskEvents`) use the rest. `feed` returns the task's
 * current feed and never creates one; `stopped` turns true at {@link stop}.
 * `attach` starts delivering a live task this instance did not dispatch (after
 * a restart) from now on, without reconstructing earlier events; only a host
 * read creates such a feed. `detach` drops an attached feed that turned out to
 * have nothing to deliver, and never touches a provisional or dispatched feed,
 * which belong to their dispatch. `provision` keeps an attached feed as it is:
 * the task exists, so nothing needs buffering, and a refused enqueue must not
 * drop it. `entries` reads a feed after a cursor, or from the start of what is
 * retained, and refuses a cursor that names no position of the feed with
 * `cursor_unknown`. Members carry no block docs here because comments on class
 * members ship in the bundle, which has an exact size budget.
 *
 * `onInboundCommitted` runs inline on the kernel's request path and must stay
 * synchronous and cheap.
 */
export class TaskEventRelay implements ByokCloudObserver {
  readonly #draftWakes = new Map<string, Set<() => void>>();
  readonly #tasks = new Map<string, TaskFeed>();
  readonly #serverEvents: AsyncEventQueue<ByokServerEvent>;
  readonly #bufferLimit: number;
  readonly #retentionMs: number;
  #stopped = false;

  constructor(options: TaskEventRelayOptions) {
    this.#bufferLimit = positiveLimit(options.taskEventBufferLimit ?? DEFAULT_TASK_EVENT_BUFFER_LIMIT, 'taskEventBufferLimit');
    // Reclamation is one `setTimeout`; a longer delay fires at 1 ms and would
    // drop retained events immediately, so refuse it instead of clamping.
    this.#retentionMs = positiveLimit(options.taskEventRetentionMs ?? DEFAULT_TASK_EVENT_RETENTION_MS, 'taskEventRetentionMs', MAX_TIMER_DELAY_MS);
    // The cross-task feed is long-lived and never closed, so it is bounded on
    // the same budget. It drops silently: `ByokServerEvent` has no member that
    // could carry a truncation notice, and inventing one would be a wire-shaped
    // event no server action produced.
    this.#serverEvents = new AsyncEventQueue<ByokServerEvent>({ maxBuffered: this.#bufferLimit });
  }

  /** The cross-task embedder feed backing `ByokServer.events.subscribe()`. */
  serverEvents(): AsyncIterable<ByokServerEvent> {
    return this.#serverEvents.subscribe();
  }

  /** Publish one cross-task event (rate-limit episodes, host-side transitions). */
  emitServerEvent(event: ByokServerEvent): void {
    if (this.#stopped) return;
    this.#serverEvents.push(event);
  }

  /** Pre-register a task id before its offer enqueue can become observable. */
  provision(taskId: string): void {
    this.#open(taskId, true);
  }

  /** Forget an enqueue that failed before it produced an offer. */
  abort(taskId: string): void {
    const state = this.#tasks.get(taskId);
    if (state === undefined || !state.provisional) return;
    if (state.reclaimTimer !== undefined) clearTimeout(state.reclaimTimer);
    state.settleTerminal();
    state.queue.close();
    this.#tasks.delete(taskId);
  }

  /**
   * Open the relay for a task this server just dispatched, and publish its
   * `Offered` origin on both feeds. `at` is the offer envelope's own timestamp,
   * so the feed preserves the original delivery time.
   */
  noteDispatched(taskId: string, at: string): void {
    const state = this.#open(taskId);
    if (state.dispatched) return;
    state.provisional = false;
    state.dispatched = true;
    state.queue.push({ kind: 'state', state: 'Offered', at });
    this.emitServerEvent({ kind: 'task.created', taskId, at });
    const early = state.early.splice(0);
    for (const input of early) this.#handleTaskEnvelope(state, taskId, input.envelope, input.at);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  feed(taskId: string): TaskFeed | undefined {
    return this.#tasks.get(taskId);
  }

  attach(taskId: string): TaskFeed | undefined {
    return this.#stopped ? undefined : this.#open(taskId);
  }

  detach(taskId: string, feed: TaskFeed): void {
    if (this.#tasks.get(taskId) !== feed || feed.provisional || feed.dispatched) return;
    feed.queue.close();
    this.#tasks.delete(taskId);
  }

  entries(taskId: string, feed: TaskFeed, after?: string): AsyncIterable<QueueEntry<ServerTaskEvent>> {
    const position = after === undefined ? undefined : cursorPosition(feed, after);
    if (position === null) throw new TaskEventsUnavailableError(taskId, 'cursor_unknown');
    return feed.queue.entries(position);
  }

  /** Settles when this task first reaches a terminal — the barrier `TaskHandle.result()` awaits. */
  terminal(taskId: string): Promise<void> {
    return this.#open(taskId).terminal;
  }

  /**
   * Host-side transitions the wire never carries: an accepted cancellation, and
   * an approval the operator resolved through `TaskHandle.approve`/`reject`.
   * Published here so the two feeds report the same task history whichever side
   * moved it, and (for a terminal) so `result()` is not left waiting on a device
   * message that a cancelled task will never send.
   */
  noteHostTransition(taskId: string, state: TaskState, at: string): void {
    const existing = this.#tasks.get(taskId);
    if (existing === undefined) return;
    this.#transition(existing, taskId, state, at);
  }

  /** A wake carries no content and creates no task event queue. */
  onAgentMessageDraft(taskId: string): void {
    for (const wake of this.#draftWakes.get(taskId) ?? []) wake();
  }

  watchAgentMessageDraft(taskId: string, wake: () => void): () => void {
    const listeners = this.#draftWakes.get(taskId) ?? new Set<() => void>();
    listeners.add(wake);
    this.#draftWakes.set(taskId, listeners);
    return () => {
      listeners.delete(wake);
      if (listeners.size === 0) this.#draftWakes.delete(taskId);
    };
  }

  onInboundCommitted(input: InboundCommitted): void {
    if (this.#stopped) return;
    const { envelope } = input;
    const at = new Date().toISOString();

    const taskId = envelope.task_id;
    if (taskId === undefined) return;
    if (envelope.type === 'agent.message.draft' || envelope.type === 'agent.message.publish'
      || envelope.type === 'task.complete' || envelope.type === 'task.fail'
      || envelope.type === 'task.cancelled' || envelope.type === 'task.decline') this.onAgentMessageDraft(taskId);
    const state = this.#tasks.get(taskId);
    if (state === undefined) return;

    if (state.provisional) {
      state.early.push({ envelope, at });
      return;
    }
    this.#handleTaskEnvelope(state, taskId, envelope, at);
  }

  #handleTaskEnvelope(
    state: TaskFeed,
    taskId: string,
    envelope: InboundCommitted['envelope'],
    at: string,
  ): void {
    switch (envelope.type) {
      case 'task.claim':
        if (envelope.payload.runtime !== undefined) state.claimedRuntime = envelope.payload.runtime;
        if (envelope.payload.harnessId !== undefined) state.claimedHarnessId = envelope.payload.harnessId;
        this.#transition(state, taskId, 'Claimed', at);
        return;
      case 'task.started':
        this.#transition(state, taskId, 'Running', at);
        return;
      case 'task.progress':
        for (const event of envelope.payload.events) state.queue.push({ kind: 'agent', event });
        return;
      case 'task.artifact':
        state.queue.push({ kind: 'artifact', artifact: envelope.payload });
        return;
      case 'task.await_approval':
        state.queue.push({ kind: 'await_approval', summary: envelope.payload.summary, approvalId: envelope.payload.approvalId });
        this.#transition(state, taskId, 'AwaitApproval', at);
        return;
      case 'task.approval_resolved':
        this.emitServerEvent({
          kind: 'task.approval_resolved',
          taskId,
          at,
          approvalId: envelope.payload.approvalId,
          decision: envelope.payload.decision,
          resolvedBy: envelope.payload.resolvedBy,
        });
        this.#transition(state, taskId, 'Running', at);
        return;
      case 'task.decline':
        this.#transition(state, taskId, 'Failed', at);
        return;
      case 'task.complete':
        this.#transition(state, taskId, 'Complete', at);
        return;
      case 'task.fail':
        this.#transition(state, taskId, 'Failed', at);
        return;
      case 'task.cancelled':
        this.#transition(state, taskId, 'Cancelled', at);
        return;
      default:
        return;
    }
  }

  /** Close every feed and drop every timer. Safe to call more than once. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const state of this.#tasks.values()) {
      if (state.reclaimTimer !== undefined) clearTimeout(state.reclaimTimer);
      state.settleTerminal();
      state.queue.close();
    }
    this.#tasks.clear();
    for (const listeners of this.#draftWakes.values()) for (const wake of listeners) wake();
    this.#draftWakes.clear();
    this.#serverEvents.close();
  }

  #transition(state: TaskFeed, taskId: string, next: TaskState, at: string): void {
    // First terminal wins here for the same reason it wins in the receipt
    // store: a later stale terminal changed no durable fact, so announcing it
    // would make the feed disagree with the read model.
    if (state.terminalSettled) return;
    state.queue.push({ kind: 'state', state: next, at });
    this.emitServerEvent({
      kind: 'task.state',
      taskId,
      state: next,
      at,
      ...(state.claimedHarnessId === undefined ? {} : { claimedHarnessId: state.claimedHarnessId }),
      ...(state.claimedRuntime === undefined ? {} : { claimedRuntime: state.claimedRuntime }),
    });
    if (next !== 'Complete' && next !== 'Failed' && next !== 'Cancelled') return;
    state.terminalSettled = true;
    state.settleTerminal();
    this.onAgentMessageDraft(taskId);
    // The feed ENDS at the terminal, right after the terminal event is pushed —
    // that transition is the last thing that will ever happen to this task, so
    // a `for await` over its events completes there instead of hanging. Closing
    // does not empty the buffer (`event-queue.ts`), so a reader that subscribes
    // later still replays what is retained and then ends;
    // `taskEventRetentionMs` below only decides when the buffer is RECLAIMED,
    // and must never be what terminates an iterator.
    state.queue.close();
    this.#scheduleReclaim(taskId, state);
  }

  /**
   * Drop a terminal task's plumbing after the retention window. The queue was
   * already closed at the terminal; this only stops retaining what it buffered,
   * after which the durable read model (`tasks.get`, `result()`) is the only
   * answer — which is where the facts lived all along.
   */
  #scheduleReclaim(taskId: string, state: TaskFeed): void {
    if (state.reclaimTimer !== undefined) return;
    const timer = setTimeout(() => {
      this.#tasks.delete(taskId);
    }, this.#retentionMs);
    timer.unref?.();
    state.reclaimTimer = timer;
  }

  #open(taskId: string, provisional = false): TaskFeed {
    const existing = this.#tasks.get(taskId);
    if (existing !== undefined) return existing;
    let settleTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      settleTerminal = resolve;
    });
    const created: TaskFeed = {
      feedId: globalThis.crypto.randomUUID(),
      queue: new AsyncEventQueue<ServerTaskEvent>({
        maxBuffered: this.#bufferLimit,
        truncationMarker: TRUNCATION_MARKER,
      }),
      terminal,
      settleTerminal,
      terminalSettled: false,
      provisional,
      dispatched: false,
      early: [],
    };
    this.#tasks.set(taskId, created);
    return created;
  }
}

/**
 * The queue position a cursor names in `feed`, or `null` when it names none:
 * malformed, another feed's, or a position this feed never handed out.
 */
function cursorPosition(feed: TaskFeed, cursor: string): number | null {
  const dot = cursor.lastIndexOf('.');
  const digits = cursor.slice(dot + 1);
  if (dot < 0 || cursor.slice(0, dot) !== feed.feedId || !/^\d+$/.test(digits)) return null;
  const sequence = Number(digits);
  return feed.queue.isPosition(sequence) ? sequence : null;
}

function positiveLimit(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`${name} must be a positive safe integer${max === Number.MAX_SAFE_INTEGER ? '' : ` of at most ${max}`}`);
  }
  return value;
}
