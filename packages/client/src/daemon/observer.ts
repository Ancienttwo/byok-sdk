import type { RetentionClassId, RetentionTrigger, SweepReport } from './retention/registry';
import type { ToolAuthorizationDecision, ToolFileAccess, ToolReminder } from '../tool-authorization';
import {
  partitionAgentEvents,
  TASK_TRANSITIONS,
  type AgentEvent,
  type BlobRef,
  type Envelope,
  type OfferAdmissionTimings,
  type TaskState,
} from '@byok-sdk/protocol';
import type { DaemonLifecycle } from './daemon-lifecycle';
import type { ExecutionRecord } from './execution-record';
import type { RuntimeObservation } from '../runtime-detection';
import type { ServiceEnvironmentStatus } from '../login-shell-environment';

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
 *   runner?.handleEnvelope(envelope)`, `(state) => setLifecycle(...)`).
 *   `onEnvelope` additionally exposes the raw INBOUND offer variants — the
 *   one event class with no corresponding outbound envelope of its own — see
 *   `handleInboundEnvelope`.
 *
 * Neither seam required adding anything to `TaskRunnerDeps`/`TaskRunner`
 * itself: both were already plain functions `create-daemon.ts` constructs,
 * so wrapping them (call this module first, then the real behavior,
 * unchanged) is the entire integration.
 */

/** Every local event kind this daemon can emit — see {@link DaemonEvent}. */
export type DaemonEventKind = DaemonEvent['kind'];

import type { OutboundRejection } from './outbound-settlement';

export type DaemonEvent =
  | ({ kind: 'outbound-rejected'; ts: string } & OutboundRejection & (
      | { terminal: true; taskState: TaskState }
      | { terminal: false }
    ))
  | ({ kind: 'retention-sweep'; ts: string } & SweepReport)
  | { kind: 'retention-failure'; ts: string; trigger: RetentionTrigger; classId: RetentionClassId; count: number; code: string }
  | { kind: 'offered'; ts: string; taskId: string; runtime?: string }
  /** `admission`: how long this device took to admit the offer (#1014), as the claim carried it. */
  | { kind: 'claimed'; ts: string; taskId: string; claimedRuntime?: string; admission?: OfferAdmissionTimings }
  | { kind: 'started'; ts: string; taskId: string }
  /** One per normalized `AgentEvent` (not one per `task.progress` batch) — matches "a live task feed" better than re-exposing the wire's own batching. */
  | { kind: 'progress'; ts: string; taskId: string; event: AgentEvent }
  | { kind: 'artifact'; ts: string; taskId: string; name: string; contentType: string; inline?: string; blobRef?: BlobRef }
  /**
   * Finding F4: `approvalId` is populated whenever `TaskRunner` dispatched
   * this approval THROUGH the normal `requestApproval`/`onApprovalDispatched`
   * path (see `noteApprovalDispatched`) — `undefined` only for a
   * hypothetical caller of `handleOutboundEnvelope` that never went through
   * that hook (there is no other producer of `task.await_approval` today).
   * This is the one piece of information an operator needs to actually
   * call `approve`/`reject` (or the `approvals` CLI command) against this
   * specific pending decision — before this fix, nothing surfaced it
   * outside the control socket's `approvals.list`/`approvals.request`
   * internals.
   */
  | { kind: 'awaiting-approval'; ts: string; taskId: string; summary: string; approvalId?: string }
  /** An `all` task reported a high-risk tool call; it was not blocked. `auto` asks through `awaiting-approval` instead. */
  | ({ kind: 'tool-reminder'; ts: string } & ToolReminder)
  /** Local auto-gate decision; never a server protocol envelope. */
  | ({ kind: 'tool-authorization'; ts: string } & ToolAuthorizationDecision)
  /**
   * #1061 slice 2 local file-scope audit (D12): one record per denial and one
   * per Attempt adopting a configured scope. Allow is never recorded. The
   * shape carries closed codes and a digest only — no raw or canonical path,
   * command, file content or rule body.
   */
  | {
      kind: 'file-scope';
      ts: string;
      taskId: string;
      decision: 'deny' | 'policy-adoption';
      lane: 'rpc' | 'prepared' | 'durable';
      homeAccess: 'writer' | 'memory-reader';
      scope: { source: 'host'; mode: 'home' | 'workspaces'; digest: string };
      /** Adoption only: every root id the grant covers, home first. */
      rootIds?: readonly string[];
      /** Denial only: the root that failed, when one was identified. */
      rootId?: string;
      /** Denial only: the requested access, when one was identified. */
      access?: ToolFileAccess;
      /** Denial only: the typed failure code. */
      code?: 'file_scope_denied' | 'file_scope_unavailable' | 'file_scope_unsupported';
      /** Denial only: the typed failure reason. */
      reason?: string;
    }
  | { kind: 'completed'; ts: string; taskId: string; summary: string; sessionRef: string }
  /**
   * Covers BOTH a post-claim `task.fail` and a pre-claim `task.decline` —
   * `preClaim` distinguishes the two. This mirrors the protocol's own
   * `Offered -> Failed` convention (docs/protocol.md "Declined vs. Failed";
   * `TASK_TRANSITIONS`, `@byok-sdk/protocol`): a decline and a failure are the
   * same outcome from a dispatcher's point of view, so this module doesn't
   * invent a parallel `declined` kind the wire model itself doesn't have.
   */
  | { kind: 'failed'; ts: string; taskId: string; reason: string; retryable: boolean; preClaim?: boolean; admission?: OfferAdmissionTimings }
  | { kind: 'cancelled'; ts: string; taskId: string; reason?: string }
  /** Issues #391/#394: every `Daemon.status().lifecycle` change, as it happens. */
  | { kind: 'lifecycle'; ts: string; lifecycle: DaemonLifecycle }
  | { kind: 'paired'; ts: string; deviceId: string }
  | { kind: 'unpaired'; ts: string }
  | { kind: 'runtimes-detected'; ts: string; runtimes: RuntimeObservation[] }
  | { kind: 'environment-resolved'; ts: string; status: ServiceEnvironmentStatus }
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
   *
   * Finding F5(b): `undeliveredOutboxCount`, when defined, is the honest
   * post-drain read of `ConnectionManager.outboxLength()` — 0 means the
   * bounded outbox drain (see `ConnectionManager.stop`) genuinely finished
   * before the connection closed; a positive number means that many
   * envelopes (almost certainly including a `task.fail`
   * `shutdownActiveTasks` just enqueued) never actually left the outbox.
   * `undefined` only for a hypothetical caller of `noteShutdownComplete`
   * that didn't pass one — `create-daemon.ts`'s own `performControlShutdown`
   * (the only real producer of this event) always does.
   */
  | { kind: 'shutdown-complete'; ts: string; reason: string; undeliveredOutboxCount?: number }
  /**
   * A wire `task.approve`/`task.reject`, or a local `Daemon.approve`/
   * `reject`, named an approval that is not the one pending for its task:
   * a faster path (a racing local `approvals.resolve`, a timeout) already
   * resolved it, the same decision arrived twice, or it targets another
   * approval. `TaskRunner.handleApprove`/`handleReject` emit this and change
   * nothing. Audit-only: never gates any teardown/task-state decision.
   */
  | { kind: 'stale-approval-decision'; ts: string; taskId: string; decision: 'approve' | 'reject'; reason?: string }
  | { kind: 'runtime-disposal-failed'; ts: string; taskId: string; runtimeId: string; stage: 'signal' | 'quiescence' | 'cleanup'; reason: string }
  /**
   * Octop ③ (#553): whether the SDK saw one started execution's whole event
   * trajectory — counts and closed codes only (`execution-record.ts`).
   * Emitted once, after that task's terminal event (`completed`, `failed`,
   * `cancelled` or a terminal `outbound-rejected`), unless the task registry
   * evicted the task first (`MAX_TRACKED_TASKS`). A record whose terminal
   * never settles in this process is not emitted. A diagnostic only: no task
   * state depends on it.
   */
  | ({ kind: 'execution-record'; ts: string } & ExecutionRecord)
  /**
   * WP2I-S2: the Host's durable readback for a Host-approved Agent memory
   * intent contradicted the device's durable terminal (`disposition`
   * `conflict`, or `host_terminal` against a local terminal). The integrity
   * audit is already in the Agent home's memory audit tail and the notice was
   * acknowledged after the `ackedAt` barrier. Metadata only: the intent id and
   * the Host disposition — never a path, revision, outcome or Host text.
   */
  | { kind: 'agent-memory-intent-integrity'; ts: string; intentId: string; disposition: 'conflict' | 'host_terminal' }
  /**
   * Plan `device-assertion-broker`: one `assertion.issue` control call
   * resolved — either an assertion was minted (`issued`) or one of the six
   * fail-closed gates refused (`denied`, with `reason` naming which one; see
   * `ASSERTION_ISSUE_ERROR_CODES`, `control-protocol.ts`).
   *
   * ONE kind for both outcomes, so an operator reading the feed sees the
   * issuance rate and the refusal rate on the same line shape rather than
   * having to correlate two.
   *
   * The signature and the envelope bytes are NOT fields of this event and
   * never can be. That is structural, not a redaction rule: `bin/audit-log.ts`
   * can only drop what it is handed, and an event type that cannot carry a
   * signature cannot leak one into a durable file no matter how the audit
   * projection is later edited. What IS carried is the metadata an incident
   * needs — which audience, which `jti` (so a suspect assertion presented to
   * the host's cloud can be traced back to the exact local call that minted
   * it), and when it expires.
   *
   * codex round-2 F4 — the union is split by `result` for the same structural
   * reason: on the ISSUED path `audience` came from this daemon's own
   * configured allowlist (operator-authored, safe verbatim), but on the DENIED
   * path it is whatever the CALLER sent — free text that could be a PEM, a
   * signature, or any secret shaped as an audience. So the denied variant has
   * NO raw `audience` field at all; it carries only `audienceSize` (a byte
   * count), computed at event-construction time (`noteDeviceAssertion`). The
   * raw denied audience therefore never reaches the observer feed, `format.ts`,
   * daemon stdout, or the audit file — there is no field to carry it, rather
   * than a redactor that has to remember to strip it.
   *
   * Contract §8.2(1): `task_assertion.issue` resolves onto this SAME event kind
   * with `lane: 'task'`, so an operator reads one issuance/refusal stream rather
   * than correlating two. `lane` is required precisely so the two credential
   * kinds stay distinguishable in the local ledger; `taskId` accompanies the
   * task lane once the daemon has resolved which task the call belongs to.
   *
   * What is NOT a field here, and never can be: the
   * `BYOK_HOST_TOOLSET_CONTEXT` nonce. It is the task lane's entire authority —
   * a value that reaches a log is a value an operator's log shipper can replay
   * — so, exactly like the signature, there is no field to carry it rather than
   * a redactor that must remember to strip it.
   */
  | {
      kind: 'device-assertion';
      ts: string;
      result: 'issued';
      lane: AssertionLane;
      audience: string;
      jti: string;
      expiresAt: string;
      taskId?: string;
    }
  | {
      kind: 'device-assertion';
      ts: string;
      result: 'denied';
      lane: AssertionLane;
      reason: string;
      audienceSize?: number;
      taskId?: string;
    };

/** Which assertion lane a `device-assertion` event belongs to (contract §8.1: the two have zero interchange). */
export type AssertionLane = 'device' | 'task';

export type DaemonEventListener = (event: DaemonEvent) => void;
export type Unsubscribe = () => void;

/** `daemon.tasks()`'s per-task view — current local state + whatever summary/outcome was last reported for it. */
export interface DaemonTaskInfo {
  taskId: string;
  state: TaskState;
  runtime?: string;
  /** Actual runtime selected for this task, as reported by the outbound `task.claim` payload. Distinct from `runtime`, which remains the requested offer runtime. */
  claimedRuntime?: string;
  /** Last known human-readable text for this task's current state: an await-approval summary, a complete summary, or a fail/cancel reason — whichever was most recently reported. */
  summary?: string;
  /** Only set once this task has actually reached `task.complete`. */
  sessionRef?: string;
  /** `true` only when `state === 'Failed'` resulted from a pre-claim `task.decline` rather than a post-claim `task.fail` — see the `DaemonEvent` `failed` variant's doc comment. */
  declined?: boolean;
  delivery?: 'rejected';
  updatedAt: string;
}

type TerminalTaskPatch = Partial<Pick<DaemonTaskInfo, 'summary' | 'sessionRef' | 'declined' | 'delivery'>> & { state: TaskState };

/**
 * One projection of the local terminal envelope, shared by accepted and refused
 * delivery. A sealed payload reaches the observer only when its plaintext was
 * not kept, and has no local view.
 */
function terminalTaskPatch(envelope: Envelope): TerminalTaskPatch | undefined {
  switch (envelope.type) {
    case 'task.complete': return envelope.payload.sealed !== undefined ? undefined : { state: 'Complete', summary: envelope.payload.summary, sessionRef: envelope.payload.sessionRef };
    case 'task.fail': return envelope.payload.sealed !== undefined ? undefined : { state: 'Failed', summary: envelope.payload.reason };
    case 'task.decline': return envelope.payload.sealed !== undefined ? undefined : { state: 'Failed', summary: envelope.payload.reason, declined: true };
    case 'task.cancelled': return envelope.payload.sealed !== undefined ? undefined : { state: 'Cancelled', summary: envelope.payload.reason };
    default: return undefined;
  }
}

/**
 * M3-B parity (see `task-runner/state.ts`'s `MAX_TRACKED_TASK_IDS` doc comment,
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
  /**
   * Finding F4: `approvalId` for a taskId's NEXT `task.await_approval`,
   * stashed by `noteApprovalDispatched` and consumed (read + deleted) the
   * moment `handleOutboundEnvelope`'s `task.await_approval` case actually
   * emits the corresponding `awaiting-approval` event — see that hook's own
   * doc comment for why this is always populated first (both calls happen
   * synchronously, in that order, from `TaskRunner.dispatchApproval`).
   * Read-and-delete keeps this self-bounding: an entry never outlives the
   * one event it was stashed for, so this can never leak across a
   * long-lived daemon's lifetime the way an evict-on-schedule cache would
   * need explicit bookkeeping to avoid.
   */
  private readonly approvalIdByEnvelope = new Map<string, string>();
  private readonly pendingApprovalIdByTask = new Map<string, string>();
  /**
   * Octop ③ (#553): execution records published before the server settled
   * their task's terminal, held so that the `execution-record` event follows
   * the terminal event. Only a task `taskInfo` tracks as nonterminal has an
   * entry, so `MAX_TRACKED_TASKS` bounds it too; see `evictIfNeeded`.
   */
  private readonly heldExecutionRecords = new Map<string, ExecutionRecord>();

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
   * either offer variant produces a local event here — every other inbound type
   * (`task.cancel`/`task.steer`/`task.approve`/`task.reject`) is a
   * best-effort notification whose OWN observable effect already surfaces
   * through the daemon's outbound envelopes (`task.cancelled`, `task.progress`
   * resuming, `task.fail`, ...) — see `handleOutboundEnvelope`, which is
   * where those are actually reported from.
   */
  handleInboundEnvelope(envelope: Envelope): void {
    if (envelope.type !== 'task.offer') return;
    const offer = envelope;
    const taskId = offer.task_id;

    // Redelivery guard (protocol §9, at-least-once delivery): this observer
    // has no visibility into TaskRunner's own private `finishedTaskIds`/
    // `this.tasks` redelivery dedup, so it mirrors the same idempotency
    // independently using its OWN record instead — any taskId this observer
    // already has an entry for was necessarily already offered once before
    // (an entry can only ever be created here or in `handleOutboundEnvelope`,
    // both of which only ever fire for a taskId TaskRunner itself has already
    // seen), so a second offer for it is never "the first time" here
    // either. Without this, a stalled-cursor re-poll redelivering an
    // already-succeeded offer (`task-runner.ts`'s own doc comment on
    // `finishedTaskIds` describes exactly this scenario) would locally
    // regress a finished task back to `Offered`.
    if (this.taskInfo.has(taskId)) return;

    this.upsertTask(taskId, { state: 'Offered', runtime: offer.payload.runtime });
    this.emit({ kind: 'offered', ts: nowIso(), taskId, runtime: offer.payload.runtime });
  }

  /**
   * Feed a raw OUTBOUND (daemon -> server) envelope — this is where every
   * task-lifecycle local event actually comes from: `TaskRunner` already
   * calls `deps.send(...)` for each of these at exactly the moment its own
   * state machine decides the transition happened.
   */
  captureOutboundApproval(envelope: Envelope): void {
    if (envelope.type !== 'task.await_approval') return;
    const approvalId = this.pendingApprovalIdByTask.get(envelope.task_id);
    if (approvalId !== undefined) this.approvalIdByEnvelope.set(envelope.id, approvalId);
    this.pendingApprovalIdByTask.delete(envelope.task_id);
  }

  /**
   * A sealed payload reaches here only when its plaintext was not kept
   * (`SealedTasks.plainOf`); it has no local view.
   */
  handleOutboundEnvelope(envelope: Envelope): void {
    const ts = nowIso();
    switch (envelope.type) {
      case 'task.claim': {
        const taskId = envelope.task_id;
        const { runtime: claimedRuntime, admission } = envelope.payload;
        this.upsertTask(taskId, {
          state: 'Claimed',
          ...(claimedRuntime !== undefined ? { claimedRuntime } : {}),
        });
        this.emit({
          kind: 'claimed', ts, taskId, ...(claimedRuntime !== undefined ? { claimedRuntime } : {}), ...(admission !== undefined ? { admission } : {}),
        });
        return;
      }
      case 'task.started': {
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'Running' });
        this.emit({ kind: 'started', ts, taskId });
        return;
      }
      case 'task.progress': {
        if (envelope.payload.sealed !== undefined) return;
        const taskId = envelope.task_id;
        this.upsertTask(taskId, { state: 'Running' });
        // `known`-only (`partitionAgentEvents`, `@byok-sdk/protocol`): an
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
        if (envelope.payload.sealed !== undefined) return;
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
        if (envelope.payload.sealed !== undefined) return;
        const taskId = envelope.task_id;
        // Finding F4: read-and-delete — see `pendingApprovalIdByTask`'s own
        // doc comment for why this never needs a separate eviction policy.
        const approvalId = this.approvalIdByEnvelope.get(envelope.id);
        this.approvalIdByEnvelope.delete(envelope.id);
        this.upsertTask(taskId, { state: 'AwaitApproval', summary: envelope.payload.summary });
        this.emit({ kind: 'awaiting-approval', ts, taskId, summary: envelope.payload.summary, approvalId });
        return;
      }
      case 'task.complete': {
        if (envelope.payload.sealed !== undefined) return;
        const taskId = envelope.task_id;
        this.upsertTask(taskId, terminalTaskPatch(envelope)!);
        this.emit({
          kind: 'completed',
          ts,
          taskId,
          summary: envelope.payload.summary,
          sessionRef: envelope.payload.sessionRef,
        });
        this.releaseExecutionRecord(taskId);
        return;
      }
      case 'task.fail': {
        if (envelope.payload.sealed !== undefined) return;
        const taskId = envelope.task_id;
        const retryable = envelope.payload.retryable ?? false;
        this.upsertTask(taskId, terminalTaskPatch(envelope)!);
        this.emit({ kind: 'failed', ts, taskId, reason: envelope.payload.reason, retryable });
        this.releaseExecutionRecord(taskId);
        return;
      }
      case 'task.decline': {
        if (envelope.payload.sealed !== undefined) return;
        const taskId = envelope.task_id;
        const retryable = envelope.payload.retryable ?? false;
        this.upsertTask(taskId, terminalTaskPatch(envelope)!);
        const { admission } = envelope.payload;
        this.emit({ kind: 'failed', ts, taskId, reason: envelope.payload.reason, retryable, preClaim: true, ...(admission !== undefined ? { admission } : {}) });
        return;
      }
      case 'task.cancelled': {
        if (envelope.payload.sealed !== undefined) return;
        const taskId = envelope.task_id;
        this.upsertTask(taskId, terminalTaskPatch(envelope)!);
        this.emit({ kind: 'cancelled', ts, taskId, reason: envelope.payload.reason });
        this.releaseExecutionRecord(taskId);
        return;
      }
      default:
        return; // conn.* and every server->daemon-only type never flow through the outbound `send` hook
    }
  }

  noteOutboundRejected(envelope: Envelope, rejection: OutboundRejection): void {
    this.approvalIdByEnvelope.delete(rejection.envelopeId);
    if (rejection.terminal) {
      const patch = terminalTaskPatch(envelope);
      if (patch === undefined || rejection.taskId === undefined) throw new Error('terminal rejection has no local terminal envelope');
      this.upsertTask(rejection.taskId, { ...patch, delivery: 'rejected' });
      this.emit({ kind: 'outbound-rejected', ts: nowIso(), ...rejection, terminal: true, taskState: patch.state });
      this.releaseExecutionRecord(rejection.taskId);
    } else {
      this.emit({ kind: 'outbound-rejected', ts: nowIso(), ...rejection, terminal: false });
    }
  }

  noteLifecycle(lifecycle: DaemonLifecycle): void {
    this.emit({ kind: 'lifecycle', ts: nowIso(), lifecycle });
  }

  notePaired(deviceId: string): void {
    this.emit({ kind: 'paired', ts: nowIso(), deviceId });
  }

  noteUnpaired(): void {
    this.emit({ kind: 'unpaired', ts: nowIso() });
  }

  noteRuntimesDetected(runtimes: RuntimeObservation[]): void {
    this.emit({ kind: 'runtimes-detected', ts: nowIso(), runtimes });
  }

  noteEnvironmentResolved(status: ServiceEnvironmentStatus, ts = nowIso()): void {
    this.emit({ kind: 'environment-resolved', ts, status });
  }

  /** M4 Phase 2: see the `shutdown-requested` `DaemonEvent` variant's own doc comment. */
  noteShutdownRequested(reason: string): void {
    this.emit({ kind: 'shutdown-requested', ts: nowIso(), reason });
  }

  /** M4 Phase 2: see the `shutdown-complete` `DaemonEvent` variant's own doc comment (finding F5(b): `undeliveredOutboxCount`). */
  noteShutdownComplete(reason: string, undeliveredOutboxCount?: number): void {
    this.emit({ kind: 'shutdown-complete', ts: nowIso(), reason, undeliveredOutboxCount });
  }

  /**
   * Plan `device-assertion-broker`: see the `device-assertion` `DaemonEvent`
   * variant's own doc comment. The parameter type is what keeps the signature
   * out — there is no field to pass one through.
   *
   * codex round-2 F4: the DENIED caller can pass its raw `audience` here, but
   * it is converted to a byte SIZE the instant the event is constructed and the
   * raw string is dropped — it is never placed on the emitted `DaemonEvent`, so
   * it cannot reach a subscriber, `format.ts`, stdout, or the audit file. The
   * ISSUED `audience` came from the allowlist and is kept verbatim.
   *
   * Contract §8.2(1): `lane` defaults to `'device'` for the existing caller and
   * is passed explicitly by the task lane, which also passes the `taskId` its
   * nonce registry resolved. There is no parameter for the context token, for
   * the same structural reason there is none for the private key.
   */
  noteDeviceAssertion(
    event:
      | { result: 'issued'; lane?: AssertionLane; taskId?: string; audience: string; jti: string; expiresAt: string }
      | { result: 'denied'; lane?: AssertionLane; taskId?: string; reason: string; audience?: string },
  ): void {
    const lane: AssertionLane = event.lane ?? 'device';
    if (event.result === 'issued') {
      this.emit({
        kind: 'device-assertion',
        ts: nowIso(),
        result: 'issued',
        lane,
        audience: event.audience,
        jti: event.jti,
        expiresAt: event.expiresAt,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      });
      return;
    }
    this.emit({
      kind: 'device-assertion',
      ts: nowIso(),
      result: 'denied',
      lane,
      reason: event.reason,
      audienceSize: event.audience === undefined ? undefined : Buffer.byteLength(event.audience, 'utf8'),
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    });
  }

  /** M4 Phase 3 hardening: see the `stale-approval-decision` `DaemonEvent` variant's own doc comment. */
  noteToolReminder(reminder: ToolReminder): void {
    this.emit({ kind: 'tool-reminder', ts: nowIso(), ...reminder });
  }

  noteToolAuthorizationDecision(decision: ToolAuthorizationDecision): void {
    this.emit({ kind: 'tool-authorization', ts: nowIso(), ...decision });
  }

  /** #1061 slice 2 local file-scope audit (D12); allow is never recorded. */
  noteFileScopeAudit(event: Omit<Extract<DaemonEvent, { kind: 'file-scope' }>, 'kind' | 'ts'>): void {
    this.emit({ kind: 'file-scope', ts: nowIso(), ...event });
  }

  noteStaleApprovalDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): void {
    this.emit({ kind: 'stale-approval-decision', ts: nowIso(), taskId, decision, reason });
  }

  /** WP2I-S2: see the `agent-memory-intent-integrity` `DaemonEvent` variant's own doc comment. */
  noteAgentMemoryIntentIntegrity(event: { intentId: string; disposition: 'conflict' | 'host_terminal' }): void {
    this.emit({ kind: 'agent-memory-intent-integrity', ts: nowIso(), intentId: event.intentId, disposition: event.disposition });
  }

  noteRuntimeDisposalFailure(event: {
    taskId: string;
    runtimeId: string;
    stage: 'signal' | 'quiescence' | 'cleanup';
    reason: string;
  }): void {
    this.emit({ kind: 'runtime-disposal-failed', ts: nowIso(), ...event });
  }

  /**
   * Octop ③ (#553): `TaskRunner` publishes a record after `Session.close()`,
   * which can finish before the server settles the terminal. Such a record
   * waits until its task's terminal event goes out. A task this registry no
   * longer tracks gets its record at once.
   */
  noteExecutionRecord(record: ExecutionRecord): void {
    const state = this.taskInfo.get(record.taskId)?.state;
    if (state === undefined || isTerminalState(state)) {
      this.emit({ kind: 'execution-record', ts: nowIso(), ...record });
      return;
    }
    this.heldExecutionRecords.set(record.taskId, record);
  }

  private releaseExecutionRecord(taskId: string): void {
    const record = this.heldExecutionRecords.get(taskId);
    if (record === undefined) return;
    this.heldExecutionRecords.delete(taskId);
    this.emit({ kind: 'execution-record', ts: nowIso(), ...record });
  }
  /**
   * Finding F4: wired from `TaskRunnerDeps.onApprovalDispatched`, called
   * synchronously by `TaskRunner.dispatchApproval` BEFORE its own
   * `deps.send(createEnvelope('task.await_approval', ...))` — stashes
   * `approvalId` so `handleOutboundEnvelope`'s `task.await_approval` case
   * (triggered by that very `send` call) can attach it to the
   * `awaiting-approval` `DaemonEvent` it emits. Never emits anything
   * itself — purely a handoff, same as `upsertTask`'s bookkeeping role for
   * other events.
   */
  noteApprovalDispatched(taskId: string, approvalId: string): void {
    this.pendingApprovalIdByTask.set(taskId, approvalId);
  }

  private upsertTask(
    taskId: string,
    patch: Partial<Pick<DaemonTaskInfo, 'runtime' | 'claimedRuntime' | 'summary' | 'sessionRef' | 'declined' | 'delivery'>> & { state: TaskState },
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
      // Nothing tracks the terminal its held record waits for any more.
      this.releaseExecutionRecord(oldest);
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
  noteRetentionSweep(report: SweepReport): void { this.emit({ kind: 'retention-sweep', ts: report.at, ...report }); }
  noteRetentionFailure(trigger: RetentionTrigger, classId: RetentionClassId, code: string): void {
    this.emit({ kind: 'retention-failure', ts: nowIso(), trigger, classId, code, count: 1 });
  }

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
