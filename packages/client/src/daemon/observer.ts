import {
  partitionAgentEvents,
  TASK_TRANSITIONS,
  type AgentEvent,
  type BlobRef,
  type Envelope,
  type RuntimeInfo,
  type TaskState,
} from '@byok/protocol';
import type { ConnectionState } from './ws-transport';

/**
 * M3-2a: local observability for the daemon — the seam a CLI (M3-2b) drives a
 * live task feed, a task list, and approve/reject/unpair from, all LOCALLY
 * against a running daemon (no SaaS-side polling required).
 *
 * Sourcing, without editing `task-runner.ts`: `TaskRunner` never calls
 * anything in this file directly and has no notion it exists. Every
 * task-lifecycle transition it makes is already observable from OUTSIDE the
 * class through two seams `create-daemon.ts` itself owns and constructs:
 *
 * - `TaskRunnerDeps.send` (the callback `TaskRunner` calls for every
 *   `task.claim` / `task.started` / `task.progress` / `task.artifact` /
 *   `task.await_approval` / `task.complete` / `task.fail` / `task.decline` /
 *   `task.cancelled` it ever emits) — `create-daemon.ts` already builds this
 *   closure itself (`send: (envelope) => connection?.send(envelope)`); this
 *   module just gets a chance to look at the same envelope before it goes
 *   out. See `handleOutboundEnvelope`.
 * - `ConnectionManagerOptions.onEnvelope`/`onStateChange` — likewise already
 *   `create-daemon.ts`'s own closures (`(envelope) =>
 *   runner?.handleEnvelope(envelope)`, `(state) => { connectionState = state;
 *   }`). `onEnvelope` additionally exposes the raw INBOUND `task.offer` — the
 *   one event with no corresponding outbound envelope of its own — see
 *   `handleInboundEnvelope`.
 *
 * Neither seam required adding anything to `TaskRunnerDeps`/`TaskRunner`
 * itself: both were already plain functions `create-daemon.ts` constructs,
 * so wrapping them (call this module first, then the real behavior,
 * unchanged) is the entire integration.
 */

/** Every local event kind this daemon can emit — see {@link DaemonEvent}. */
export type DaemonEventKind = DaemonEvent['kind'];

export type DaemonEvent =
  | { kind: 'offered'; ts: string; taskId: string; runtime?: string }
  | { kind: 'claimed'; ts: string; taskId: string }
  | { kind: 'started'; ts: string; taskId: string }
  /** One per normalized `AgentEvent` (not one per `task.progress` batch) — matches "a live task feed" better than re-exposing the wire's own batching. */
  | { kind: 'progress'; ts: string; taskId: string; event: AgentEvent }
  | { kind: 'artifact'; ts: string; taskId: string; name: string; contentType: string; inline?: string; blobRef?: BlobRef }
  | { kind: 'awaiting-approval'; ts: string; taskId: string; summary: string }
  | { kind: 'completed'; ts: string; taskId: string; summary: string; sessionRef: string }
  /**
   * Covers BOTH a post-claim `task.fail` and a pre-claim `task.decline` —
   * `preClaim` distinguishes the two. This mirrors the protocol's own
   * `Offered -> Failed` convention (docs/protocol.md "Declined vs. Failed";
   * `TASK_TRANSITIONS`, `@byok/protocol`): a decline and a failure are the
   * same outcome from a dispatcher's point of view, so this module doesn't
   * invent a parallel `declined` kind the wire model itself doesn't have.
   */
  | { kind: 'failed'; ts: string; taskId: string; reason: string; retryable: boolean; preClaim?: boolean }
  | { kind: 'cancelled'; ts: string; taskId: string; reason?: string }
  | { kind: 'connection'; ts: string; state: ConnectionState }
  | { kind: 'paired'; ts: string; deviceId: string }
  | { kind: 'unpaired'; ts: string }
  | { kind: 'runtimes-detected'; ts: string; runtimes: RuntimeInfo[] }
  /** M4 Phase 2: the control socket's `shutdown` RPC was invoked — emitted once, before this daemon starts tearing itself down, so it lands in the audit log via the exact same subscribe->append plumbing every other event already uses (see `bin/commands/start.ts`). Informational only — do NOT gate any teardown decision on this event; see `shutdown-complete`. */
  | { kind: 'shutdown-requested'; ts: string; reason: string }
  /**
   * M4 Phase 2: emitted once, AFTER the control-socket-driven shutdown
   * sequence has fully finished — active tasks reported failed over the
   * (at that point still-open) connection, then the connection/control
   * socket actually closed (see `create-daemon.ts`'s `performControlShutdown`,
   * which calls this last). This is the event `bin/commands/start.ts` must
   * wait for before treating the daemon as done: reacting to
   * `shutdown-requested` instead would race `daemon.stop()` against the
   * still-in-flight `task.fail` send and silently drop it (confirmed via a
   * real regression — see `daemon-control-socket.test.ts`).
   */
  | { kind: 'shutdown-complete'; ts: string; reason: string }
  /**
   * M4 Phase 3 hardening: a wire `task.approve`/`task.reject` (or this
   * device's own redelivered copy of one) arrived for an out-of-band
   * approval a DIFFERENT, faster path (a racing local `approvals.resolve`
   * over the control socket, or this exact decision arriving twice) had
   * already resolved — `TaskRunner.handleApprove`/`handleReject`
   * (`task-runner.ts`) emit this instead of failing the task a second time.
   * Audit-only: never gates any teardown/task-state decision, purely a
   * record that a stale message was seen and correctly ignored — see
   * `NoPendingApprovalError`'s own doc comment (`task-runner.ts`) for the
   * full race this closes.
   */
  | { kind: 'stale-approval-decision'; ts: string; taskId: string; decision: 'approve' | 'reject'; reason?: string };

export type DaemonEventListener = (event: DaemonEvent) => void;
export type Unsubscribe = () => void;

/** `daemon.tasks()`'s per-task view — current local state + whatever summary/outcome was last reported for it. */
export interface DaemonTaskInfo {
  taskId: string;
  state: TaskState;
  runtime?: string;
  /** Last known human-readable text for this task's current state: an await-approval summary, a complete summary, or a fail/cancel reason — whichever was most recently reported. */
  summary?: string;
  /** Only set once this task has actually reached `task.complete`. */
  sessionRef?: string;
  /** `true` only when `state === 'Failed'` resulted from a pre-claim `task.decline` rather than a post-claim `task.fail` — see the `DaemonEvent` `failed` variant's doc comment. */
  declined?: boolean;
  updatedAt: string;
}

/**
 * M3-B parity (see `task-runner.ts`'s `MAX_TRACKED_TASK_IDS` doc comment,
 * same rationale): this daemon is meant to run as a long-lived background
 * service, so a per-task registry that only ever grows is a slow memory
 * leak. Only TERMINAL entries (`Complete`/`Failed`/`Cancelled`) are ever
 * evicted, oldest first — active entries are never removed here, the same
 * way `TaskRunner.tasks` itself is bounded by real concurrency rather than
 * an explicit cap.
 */
export const MAX_TRACKED_TASKS = 2000;

function isTerminalState(state: TaskState): boolean {
  // Derived from TASK_TRANSITIONS (single authority — docs/protocol.md,
  // `task-state.ts`'s own doc comment: "Complete / Failed / Cancelled are
  // terminal (no outgoing edges)") rather than a hand-maintained list that
  // could drift from it.
  return TASK_TRANSITIONS[state].length === 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Owns both halves of the local observability surface: the pub/sub
 * (`subscribe`/`emit`) and the derived per-task registry (`tasks`). A plain
 * `Set<listener>` with `subscribe` returning its own removal closure — not
 * `node:events`' `EventEmitter` — keeps unsubscribe trivially leak-free
 * (delete-by-reference, no string event names, no listener-count footguns)
 * and keeps `DaemonEvent` a single typed union instead of a per-event-name
 * overload table.
 */
export class DaemonObserver {
  private readonly listeners = new Set<DaemonEventListener>();
  private readonly taskInfo = new Map<string, DaemonTaskInfo>();

  subscribe(listener: DaemonEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current locally-known tasks, in first-seen order. */
  tasks(): DaemonTaskInfo[] {
    return [...this.taskInfo.values()];
  }

  /**
   * Feed a raw INBOUND (server -> daemon) envelope. Deliberately narrow: only
   * `task.offer` produces a local event here — every other inbound type
   * (`task.cancel`/`task.steer`/`task.approve`/`task.reject`) is a
   * best-effort notification whose OWN observable effect already surfaces
   * through the daemon's outbound envelopes (`task.cancelled`, `task.progress`
   * resuming, `task.fail`, ...) — see `handleOutboundEnvelope`, which is
   * where those are actually reported from.
   */
  handleInboundEnvelope(envelope: Envelope): void {
    if (envelope.type !== 'task.offer') return;
    const taskId = envelope.task_id;

    // Redelivery guard (protocol §9, at-least-once delivery): this observer
    // has no visibility into TaskRunner's own private `finishedTaskIds`/
    // `this.tasks` redelivery dedup, so it mirrors the same idempotency
    // independently using its OWN record instead — any taskId this observer
    // already has an entry for was necessarily already offered once before
    // (an entry can only ever be created here or in `handleOutboundEnvelope`,
    // both of which only ever fire for a taskId TaskRunner itself has already
    // seen), so a second `task.offer` for it is never "the first time" here
    // either. Without this, a stalled-cursor re-poll redelivering an
    // already-succeeded offer (`task-runner.ts`'s own doc comment on
    // `finishedTaskIds` describes exactly this scenario) would locally
    // regress a finished task back to `Offered`.
    if (this.taskInfo.has(taskId)) return;

    this.upsertTask(taskId, { state: 'Offered', runtime: envelope.payload.runtime });
    this.emit({ kind: 'offered', ts: nowIso(), taskId, runtime: envelope.payload.runtime });
  }

  /**
   * Feed a raw OUTBOUND (daemon -> server) envelope — this is where every
   * task-lifecycle local event actually comes from: `TaskRunner` already
   * calls `deps.send(...)` for each of these at exactly the moment its own
   * state machine decides the transition happened.
   */
  handleOutboundEnvelope(envelope: Envelope): void {
    const ts = nowIso();
    switch (envelope.type) {
      case 'task.claim': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'Claimed' });
        this.emit({ kind: 'claimed', ts, taskId });
        return;
      }
      case 'task.started': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'Running' });
        this.emit({ kind: 'started', ts, taskId });
        return;
      }
      case 'task.progress': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'Running' });
        // `known`-only (`partitionAgentEvents`, `@byok/protocol`): an
        // unrecognized-type event is an opaque forward-compat placeholder
        // (agent-event.ts) this daemon can't meaningfully normalize locally
        // either — skip it here the same way `TaskRunner`'s own consumers
        // are told to.
        const { known } = partitionAgentEvents(envelope.payload.events);
        for (const event of known) {
          this.emit({ kind: 'progress', ts, taskId, event });
        }
        return;
      }
      case 'task.artifact': {
        const taskId = envelope.task_id;
        this.emit({
          kind: 'artifact',
          ts,
          taskId,
          name: envelope.payload.name,
          contentType: envelope.payload.contentType,
          inline: envelope.payload.inline,
          blobRef: envelope.payload.blobRef,
        });
        return;
      }
      case 'task.await_approval': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'AwaitApproval', summary: envelope.payload.summary });
        this.emit({ kind: 'awaiting-approval', ts, taskId, summary: envelope.payload.summary });
        return;
      }
      case 'task.complete': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, {
          state: 'Complete',
          summary: envelope.payload.summary,
          sessionRef: envelope.payload.sessionRef,
        });
        this.emit({
          kind: 'completed',
          ts,
          taskId,
          summary: envelope.payload.summary,
          sessionRef: envelope.payload.sessionRef,
        });
        return;
      }
      case 'task.fail': {
        const taskId = envelope.task_id;
        const retryable = envelope.payload.retryable ?? false;
        this.upsertTask(taskId, { state: 'Failed', summary: envelope.payload.reason });
        this.emit({ kind: 'failed', ts, taskId, reason: envelope.payload.reason, retryable });
        return;
      }
      case 'task.decline': {
        const taskId = envelope.task_id;
        const retryable = envelope.payload.retryable ?? false;
        this.upsertTask(taskId, { state: 'Failed', summary: envelope.payload.reason, declined: true });
        this.emit({ kind: 'failed', ts, taskId, reason: envelope.payload.reason, retryable, preClaim: true });
        return;
      }
      case 'task.cancelled': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'Cancelled', summary: envelope.payload.reason });
        this.emit({ kind: 'cancelled', ts, taskId, reason: envelope.payload.reason });
        return;
      }
      default:
        return; // conn.* and every server->daemon-only type never flow through the outbound `send` hook
    }
  }

  noteConnectionState(state: ConnectionState): void {
    this.emit({ kind: 'connection', ts: nowIso(), state });
  }

  notePaired(deviceId: string): void {
    this.emit({ kind: 'paired', ts: nowIso(), deviceId });
  }

  noteUnpaired(): void {
    this.emit({ kind: 'unpaired', ts: nowIso() });
  }

  noteRuntimesDetected(runtimes: RuntimeInfo[]): void {
    this.emit({ kind: 'runtimes-detected', ts: nowIso(), runtimes });
  }

  /** M4 Phase 2: see the `shutdown-requested` `DaemonEvent` variant's own doc comment. */
  noteShutdownRequested(reason: string): void {
    this.emit({ kind: 'shutdown-requested', ts: nowIso(), reason });
  }

  /** M4 Phase 2: see the `shutdown-complete` `DaemonEvent` variant's own doc comment. */
  noteShutdownComplete(reason: string): void {
    this.emit({ kind: 'shutdown-complete', ts: nowIso(), reason });
  }

  /** M4 Phase 3 hardening: see the `stale-approval-decision` `DaemonEvent` variant's own doc comment. */
  noteStaleApprovalDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): void {
    this.emit({ kind: 'stale-approval-decision', ts: nowIso(), taskId, decision, reason });
  }

  private upsertTask(
    taskId: string,
    patch: Partial<Pick<DaemonTaskInfo, 'runtime' | 'summary' | 'sessionRef' | 'declined'>> & { state: TaskState },
  ): void {
    const existing = this.taskInfo.get(taskId);
    const next: DaemonTaskInfo = {
      ...existing,
      ...patch,
      taskId,
      updatedAt: nowIso(),
    };
    this.taskInfo.set(taskId, next);
    this.evictIfNeeded();
  }

  /**
   * Finding P2/#11 (observer half): the "no terminal entry to evict" branch
   * used to just give up and leave the registry unbounded for as long as
   * every tracked task stayed nonterminal (many concurrent/stuck offers that
   * never reach Complete/Failed/Cancelled — the exact case this cap exists
   * for, since a normal quickly-resolving workload always has terminal
   * entries to evict well before this). Falling back to "never evict" here
   * defeats the whole point of `MAX_TRACKED_TASKS`. Fix: fall back to
   * evicting the OLDEST entry regardless of state (same insertion-order
   * idiom as everywhere else this file/`task-runner.ts` bound a collection),
   * logged since it's a real, if rare, observability loss — this registry is
   * a local READ-MODEL only (see the module doc comment), never consulted by
   * `TaskRunner`'s own state machine, so evicting a still-active task's
   * entry here can't affect that task's actual execution — it only means
   * `tasks()`/a CLI's task list can no longer show it until it reports
   * another transition (which re-inserts it via `upsertTask`).
   */
  private evictIfNeeded(): void {
    if (this.taskInfo.size <= MAX_TRACKED_TASKS) return;
    for (const [taskId, info] of this.taskInfo) {
      if (isTerminalState(info.state)) {
        this.taskInfo.delete(taskId);
        return;
      }
    }
    const oldest = this.taskInfo.keys().next().value;
    if (oldest !== undefined) {
      console.warn(
        `[byok/client] daemon task registry exceeded ${MAX_TRACKED_TASKS} entries with none terminal — evicting the oldest nonterminal task (${oldest}) from local observability only (its actual execution is unaffected)`,
      );
      this.taskInfo.delete(oldest);
    }
  }

  /**
   * Listener errors are caught here so a broken subscriber (e.g. a CLI's
   * rendering bug) can never propagate back into the real send/onEnvelope
   * path this module wraps — see this file's own module doc comment.
   *
   * Finding #6: `DaemonEventListener` is typed `(event: DaemonEvent) =>
   * void`, but TypeScript's structural typing does not stop a caller from
   * subscribing an `async` function (or anything else returning a promise)
   * where a void-returning callback is expected — nothing here ever
   * validates that at runtime. The `try`/`catch` below only ever catches a
   * SYNCHRONOUS throw; an async listener doesn't throw synchronously, it
   * RETURNS an already-rejected (or later-rejecting) promise, which sails
   * straight past that catch. Left unhandled, that promise's rejection
   * becomes an `unhandledRejection` on the process — which, depending on
   * the host's Node version/flags, can crash the entire daemon over one
   * subscriber's bug (e.g. a CLI's own progress renderer awaiting something
   * that throws). Fix: treat the listener's return value as "possibly a
   * promise" regardless of its declared type, and attach a `.catch` so a
   * later rejection is caught and logged exactly like a synchronous throw,
   * never left to become unhandled. This call stays synchronous itself
   * (never `await`s a listener) — `emit` is invoked from the send/cursor
   * path (`handleOutboundEnvelope`/`handleInboundEnvelope`, wired in
   * directly from `create-daemon.ts`'s `send`/`onEnvelope` closures) and
   * must never make a subscriber's own async work a precondition for
   * cursor advancement or the next envelope being processed.
   */
  private emit(event: DaemonEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(event) as unknown;
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            console.error('[byok/client] daemon event listener rejected (async)', err);
          });
        }
      } catch (err) {
        console.error('[byok/client] daemon event listener threw', err);
      }
    }
  }
}
