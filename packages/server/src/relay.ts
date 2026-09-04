import type { InboundCommitted, ByokCloudObserver } from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import { AsyncEventQueue } from './event-queue';
import type { DeviceConnections } from './connections';
import type { ByokServerEvent, ServerTaskEvent } from './types';

/** Per-task {@link ServerTaskEvent} retention before drop-oldest engages. */
export const DEFAULT_TASK_EVENT_BUFFER_LIMIT = 1000;
/** How long a terminal task's relay state is retained before reclamation, ms. */
export const DEFAULT_TASK_EVENT_RETENTION_MS = 5 * 60_000;

/**
 * The relay's own truncation marker. A single `error` entry, appended once, is
 * the whole contract: it says "entries were dropped from this feed", not what
 * they were — a reader that needs the facts reads them back
 * (`ByokServer.tasks.get`, `TaskHandle.result()`).
 */
const TRUNCATION_MARKER: ServerTaskEvent = { kind: 'error', reason: 'events_truncated' };

interface TaskRelayState {
  readonly queue: AsyncEventQueue<ServerTaskEvent>;
  readonly terminal: Promise<void>;
  settleTerminal: () => void;
  terminalSettled: boolean;
  provisional: boolean;
  readonly early: Array<{ readonly envelope: InboundCommitted['envelope']; readonly at: string }>;
  latestApprovalRequestSourceEnvelopeId?: string;
  claimedRuntime?: RuntimeId;
  reclaimTimer?: ReturnType<typeof setTimeout>;
}

export interface TaskEventRelayOptions {
  readonly connections: DeviceConnections;
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
 * naming a task this server never dispatched is folded for nobody and allocates nothing —
 * otherwise a device could grow this map without bound by guessing task ids,
 * and the kernel's gate deliberately treats such an envelope as a harmless
 * store no-op rather than a rejection.
 *
 * `onInboundCommitted` runs inline on the kernel's request path and must stay
 * synchronous and cheap; anything needing a store read goes through
 * {@link onTaskActivity}, which the composition sets and which owns its own
 * failure handling.
 */
export class TaskEventRelay implements ByokCloudObserver {
  readonly #tasks = new Map<string, TaskRelayState>();
  readonly #serverEvents: AsyncEventQueue<ByokServerEvent>;
  readonly #connections: DeviceConnections;
  readonly #bufferLimit: number;
  readonly #retentionMs: number;
  #stopped = false;

  /**
   * Called once per committed task-progress observation for a dispatched task.
   * The composition uses it to run the implicit-approval-resume check, which
   * needs a store read and therefore cannot happen inline here.
   */
  onTaskActivity: ((
    taskId: string,
    pendingRequestSourceEnvelopeId: string | undefined,
    activitySourceEnvelopeId: string,
    activityAt: string,
  ) => void) | undefined;

  constructor(options: TaskEventRelayOptions) {
    this.#connections = options.connections;
    this.#bufferLimit = positiveLimit(options.taskEventBufferLimit ?? DEFAULT_TASK_EVENT_BUFFER_LIMIT, 'taskEventBufferLimit');
    this.#retentionMs = positiveLimit(options.taskEventRetentionMs ?? DEFAULT_TASK_EVENT_RETENTION_MS, 'taskEventRetentionMs');
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
   * so the feed and the snapshot agree on when the task began.
   */
  noteDispatched(taskId: string, at: string): void {
    const existing = this.#tasks.get(taskId);
    const state = existing ?? this.#open(taskId);
    if (existing !== undefined && !state.provisional) return;
    state.provisional = false;
    state.queue.push({ kind: 'state', state: 'Offered', at });
    this.emitServerEvent({ kind: 'task.created', taskId, at });
    const early = state.early.splice(0);
    for (const input of early) this.#handleTaskEnvelope(state, taskId, input.envelope, input.at);
  }

  /** The per-task feed backing `TaskHandle.events()`, replayed from the start of what is retained. */
  events(taskId: string): AsyncIterable<ServerTaskEvent> {
    return this.#open(taskId).queue.subscribe();
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

  onInboundCommitted(input: InboundCommitted): void {
    if (this.#stopped) return;
    const { deviceId, envelope } = input;
    const at = new Date().toISOString();

    if (envelope.type === 'conn.hello') {
      this.#connections.announce(
        deviceId,
        {
          ...(envelope.payload.clientVersion === undefined ? {} : { clientVersion: envelope.payload.clientVersion }),
          ...(envelope.payload.runtimes === undefined ? {} : { runtimes: envelope.payload.runtimes }),
          ...(envelope.payload.configuredToolsets === undefined
            ? {}
            : { configuredToolsets: envelope.payload.configuredToolsets }),
        },
        at,
      );
      return;
    }
    // Any committed envelope is a sign of life from an authenticated device.
    this.#connections.touch(deviceId, at);

    const taskId = envelope.task_id;
    if (taskId === undefined) return;
    const state = this.#tasks.get(taskId);
    if (state === undefined) return;

    if (state.provisional) {
      state.early.push({ envelope, at });
      return;
    }
    this.#handleTaskEnvelope(state, taskId, envelope, at);
  }

  #handleTaskEnvelope(
    state: TaskRelayState,
    taskId: string,
    envelope: InboundCommitted['envelope'],
    at: string,
  ): void {
    switch (envelope.type) {
      case 'task.claim':
        if (envelope.payload.runtime !== undefined) state.claimedRuntime = envelope.payload.runtime;
        this.#transition(state, taskId, 'Claimed', at);
        return;
      case 'task.started':
        this.#transition(state, taskId, 'Running', at);
        return;
      case 'task.progress':
        for (const event of envelope.payload.events) state.queue.push({ kind: 'agent', event });
        this.onTaskActivity?.(
          taskId,
          state.latestApprovalRequestSourceEnvelopeId,
          envelope.id,
          envelope.ts,
        );
        return;
      case 'task.artifact':
        state.queue.push({ kind: 'artifact', artifact: envelope.payload });
        this.onTaskActivity?.(
          taskId,
          state.latestApprovalRequestSourceEnvelopeId,
          envelope.id,
          envelope.ts,
        );
        return;
      case 'task.await_approval':
        state.latestApprovalRequestSourceEnvelopeId = envelope.id;
        state.queue.push({ kind: 'await_approval', summary: envelope.payload.summary });
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
          // Whether the reporting daemon advertised `approval-targeting` was a
          // property of its live WS registration, which no longer exists. The
          // durable capability list is a device-build fact rather than a
          // per-report one, so this reports the honest answer for the transport
          // that remains: not targeted.
          targeted: false,
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

  /** Publish an implicit resolution the composition inferred from later task traffic. */
  emitImplicitApprovalResolved(taskId: string, at: string): void {
    this.emitServerEvent({ kind: 'task.approval_resolved_implicit', taskId, at });
    this.noteHostTransition(taskId, 'Running', at);
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
    this.#serverEvents.close();
    this.#connections.clear();
  }

  #transition(state: TaskRelayState, taskId: string, next: TaskState, at: string): void {
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
      ...(state.claimedRuntime === undefined ? {} : { claimedRuntime: state.claimedRuntime }),
    });
    if (next !== 'Complete' && next !== 'Failed' && next !== 'Cancelled') return;
    state.terminalSettled = true;
    state.settleTerminal();
    // The feed ENDS at the terminal, right after the terminal event is pushed —
    // that transition is the last thing that will ever happen to this task, so
    // a `for await` over `events()` completes there instead of hanging. Closing
    // does not empty the buffer (`event-queue.ts`), so a reader that subscribes
    // later still replays the whole history from the start and then ends;
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
  #scheduleReclaim(taskId: string, state: TaskRelayState): void {
    if (state.reclaimTimer !== undefined) return;
    const timer = setTimeout(() => {
      this.#tasks.delete(taskId);
    }, this.#retentionMs);
    timer.unref?.();
    state.reclaimTimer = timer;
  }

  #open(taskId: string, provisional = false): TaskRelayState {
    const existing = this.#tasks.get(taskId);
    if (existing !== undefined) return existing;
    let settleTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      settleTerminal = resolve;
    });
    const created: TaskRelayState = {
      queue: new AsyncEventQueue<ServerTaskEvent>({
        maxBuffered: this.#bufferLimit,
        truncationMarker: TRUNCATION_MARKER,
      }),
      terminal,
      settleTerminal,
      terminalSettled: false,
      provisional,
      early: [],
    };
    this.#tasks.set(taskId, created);
    return created;
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
