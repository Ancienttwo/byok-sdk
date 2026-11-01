/**
 * M4 Phase 3: default wait for `requestApproval` (see its own doc comment)
 * before force-resolving an unanswered out-of-band approval as a fail-closed
 * rejection — generous enough for a real human to actually notice and act on
 * an approval prompt, short enough that a genuinely abandoned task doesn't
 * tie up daemon/task bookkeeping forever. Overridable via
 * `TaskRunnerDeps.approvalTimeoutMs` (ultimately `DaemonConfig`-configurable —
 * see `create-daemon.ts`).
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Finding F5(a) (cross-model adversarial review): bound on how long
 * `shutdownTask` waits for a single task's OWN `session.interrupt()` before
 * giving up on it specifically and reporting `task.fail` anyway. Without an
 * INNER bound here, a hung `interrupt()` (a misbehaving runtime adapter
 * whose promise never settles) meant `task.fail` for THAT task was never
 * sent at all — not eventually, not ever — because the send was sequenced
 * strictly AFTER the `await`. The OUTER deadline
 * `create-daemon.ts`'s `performControlShutdown` races `shutdownActiveTasks`
 * against (`SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS`) does not help: racing at
 * that layer only unblocks the CALLER to proceed to `stop()`/closing the
 * connection — it does nothing to unstick THIS function's own
 * still-suspended `await`, which just keeps running (harmlessly, since
 * nothing awaits it anymore) in the background forever after, its
 * `deps.send` line never reached. Deliberately shorter than the outer
 * 10s deadline so one hung task's own interrupt can't itself consume the
 * whole outer budget and starve however many OTHER tasks
 * `shutdownActiveTasks` awaits concurrently via `Promise.all`. Overridable
 * via `TaskRunnerDeps.shutdownInterruptTimeoutMs` (ultimately
 * `DaemonOverrides.shutdown.taskInterruptTimeoutMs` — see `create-daemon.ts`).
 */
export const DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS = 5_000;

/** Bounded retry before terminal publication degrades observably. */
export const AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS = 3;

/**
 * M4 Phase 4 (fold-in from the P3 gate): bound on how many `requestApproval`
 * calls may sit QUEUED (not yet dispatched — see that method's own doc
 * comment) for the same task at once. Claude's parallel tool use can fire
 * more than one concurrent approval request for the same taskId; this is a
 * defensive ceiling on that fan-out, mirroring `approvals.ts`'s own
 * `MAX_PENDING_APPROVALS` (a whole-daemon cap) one level down (a per-task
 * cap) — not a realistic workload limit. A request arriving once a task's
 * queue is already at this size is rejected fail-closed immediately, the
 * same shape `requestApproval` already uses for an unknown/inactive taskId.
 */
export const MAX_PENDING_APPROVALS_PER_TASK = 16;

/**
 * M3-B: cap for both `finishedTaskIds` and `pendingCancelled` below (each
 * gains one entry per finished/cancelled task and was never pruned) — fine
 * for the short-lived CLI invocations M0-M2 ran as, but M3 turns the daemon
 * into a background service meant to stay up for weeks, so unbounded growth
 * here is a real, if slow, memory leak. Each collection evicts its OLDEST
 * (first-inserted) entry once over this cap — the bounded-ring idiom the old
 * reference server's per-device dedup window used, applied here to task ids
 * (server-side dedup is now the cloud kernel's dedup store). `Map`/`Set` iterate in insertion order (ECMA-262), so "oldest"
 * always means "finished/cancelled longest ago" — neither collection is
 * touched on a read, only on insert, so eviction order depends purely on
 * insertion time. See `finishedTaskIds` and `pendingCancelled`'s own doc
 * comments below for why a cap this size can't remove an entry either
 * invariant still needs.
 */
export const MAX_TRACKED_TASK_IDS = 2000;

/**
 * M5 batch-3 (workstream 2): stable, documented reason PREFIX a `task.fail`
 * carries when `payload.limits.maxDurationMs` (daemon-authoritative
 * wall-clock enforcement — see `armMaxDurationTimer`) is exceeded. Only the
 * prefix itself is the contract an embedder can match against
 * (`reason.startsWith(...)`); everything after it is human-readable detail,
 * not part of the stable shape.
 */
export const MAX_DURATION_EXCEEDED_REASON_PREFIX = 'resource limit exceeded: maxDurationMs';

/** M5 batch-3 (workstream 2): same contract as {@link MAX_DURATION_EXCEEDED_REASON_PREFIX}, for `DaemonConfig.maxTaskOutputBytes` — see `TaskRunner.pump`'s own per-event byte counting. */
export const MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX = 'resource limit exceeded: maxTaskOutputBytes';

/** Stable fail-closed reason for one normalized event that cannot fit the configured activity batch budget. */
export const ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX =
  'resource limit exceeded: activity ingress budget';

/**
 * Wire v3 result channel: the stable reason PREFIX of the `task.fail` a
 * `terminalProjection.mode: 'result-document'` task gets when its runtime
 * ended the turn without a staged `submit_result` outcome. Same
 * stable-prefix contract as {@link MAX_DURATION_EXCEEDED_REASON_PREFIX};
 * `retryable: false`, because the same offer on the same runtime has no
 * reason to submit on a second attempt. The SDK never derives the outcome
 * from the runtime's text.
 */
export const RESULT_NOT_SUBMITTED_REASON_PREFIX = 'result_not_submitted';

/**
 * Stable reason PREFIX of the `task.fail` a result-document task gets when
 * its staged outcome cannot be read back at `turn_end` (an unreadable or
 * mismatched record in the Agent home). `retryable: false`; the record is
 * preserved for repair.
 */
export const RESULT_UNREADABLE_REASON_PREFIX = 'result_unreadable';

/**
 * Bounded admission: the stable reason PREFIX a prepared Execution's
 * `task.fail` carries when any one of its provider calls reported prompt
 * tokens AT OR ABOVE the context window of the model its frozen request D was
 * compiled for (`RuntimePreparedLaunchV1.expected.model.contextWindow`).
 *
 * A purely numeric classification over the runtime's own usage observation:
 * no provider error text is read, no pattern is matched, and the upstream
 * runtime's heuristic overflow detector is deliberately not consulted. The
 * execution is torn down and fails closed (`retryable: false`) — the same D
 * re-sent against the same window would overflow again. Everything after the
 * prefix is human-readable detail.
 */
export const PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX = 'context_overflow';

/**
 * Bounded admission: the stable reason PREFIX a prepared Execution's
 * `task.fail` carries when it cannot produce the prepared observation — it
 * settled with no provider usage observed at all, or one of its provider calls
 * reported no positive, representable prompt token count. A prepared result
 * without that observation cannot be checked against the byte bound it was
 * admitted under, so it is never accepted as success (`retryable: false`).
 *
 * A reported prompt of zero is "unavailable", not "zero": D is never empty, and
 * the Pi runtime initialises a call's usage to zeros and leaves them there when
 * the provider streams no usage.
 */
export const PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX = 'usage_unavailable';

/**
 * The SDK-owned environment variable that carries one host toolset server's
 * `BYOK_HOST_TOOLSET_CONTEXT` nonce (contract §8.1).
 *
 * Injected by the daemon beside `BYOK_STORE_DIR`/`BYOK_PRODUCT_ID` — the two a
 * child already needs to dial this daemon's control socket. A host's own
 * `mcpToolsets` registry still cannot supply an `env` block at all
 * (`toolset-registry.ts`), so this name can only ever hold a value the daemon
 * minted.
 */
export const HOST_TOOLSET_CONTEXT_ENV = 'BYOK_HOST_TOOLSET_CONTEXT';

/* ------------------------------------------------------------------------- *
 * #1099 S1 — pure TaskRunner reducer core.
 *
 * This section is deliberately pure: no fs, timers, process, network,
 * Promise, Session, lease, outbox or clock. Every timestamp / id / generation
 * arrives on the event; the reducer only decides the next frozen snapshot and
 * an ordered list of effect descriptions for the IO host (S3+) to execute.
 * See https://github.com/Ancienttwo/byok-sdk/pull/1215 §4–§8.
 * ------------------------------------------------------------------------- */

/** Internal task lifecycle phase. Not the wire TaskState (protocol/task-state.ts). */
export type TaskPhase =
  | 'received'
  | 'admitting'
  | 'claiming'
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'terminalizing'
  | 'retiring'
  | 'finished'
  | 'declined';

/** Ordered effect classes (§6.1): atomic groups cannot be interleaved. */
export type EffectMode = 'atomic' | 'barrier' | 'bestEffort';

export type TerminalKind = 'complete' | 'failed' | 'cancelled' | 'declined';
export type TerminalCause = 'complete' | 'failed' | 'cancelled' | 'declined' | 'rejected' | 'shutdown';
export type TerminalStage = 'selected' | 'evidence' | 'envelope' | 'sent' | 'closed' | 'committed';
export type ApprovalKind = 'tool-authorization' | 'task-terminal';
export type ApprovalDecision = 'approve' | 'reject';
export type ApprovalOrigin =
  | 'wire'
  | 'in-process'
  | 'control-socket'
  | 'timeout'
  | 'withdraw'
  | 'eviction'
  | 'fail-closed';

/** Every effect the host executor knows, in one vocabulary (§6.2). */
export type EffectKind =
  | 'open.sealed'
  | 'journal.admission'
  | 'open.preparation'
  | 'reserve.home'
  | 'admission.limits'
  | 'prepare.runtime'
  | 'bind.workspace'
  | 'seal.manifest'
  | 'pin.preparation'
  | 'clear.sealedOpening'
  | 'track.inflight'
  | 'consume.pendingCancelled'
  | 'send.decline'
  | 'send.claim'
  | 'send.terminal'
  | 'send.started'
  | 'send.cancelled'
  | 'send.fail'
  | 'send.approval_request'
  | 'send.approval_resolved'
  | 'flush.batcher'
  | 'stop.batcher'
  | 'stop.draft'
  | 'mark.finished'
  | 'abort.blob'
  | 'abort.inflightBlob'
  | 'abort.inflightBlobs'
  | 'revoke.contexts'
  | 'revoke.host_contexts'
  | 'revoke.allHostContexts'
  | 'revoke.message_context'
  | 'delete.contexts'
  | 'delete.host_contexts'
  | 'register.startup_owner'
  | 'dispose.startup'
  | 'dispose.startup_all'
  | 'transfer.startup'
  | 'startup.stopRetry'
  | 'start.runtime'
  | 'bind.session'
  | 'persist.handoff'
  | 'activate.message'
  | 'register.active'
  | 'arm.max_duration'
  | 'start.pump'
  | 'register.approval'
  | 'arm.approval_timeout'
  | 'clear.timeout'
  | 'resolve.approval'
  | 'resolve.approval_promise'
  | 'dispatch.next_approval'
  | 'drain.approval_queue'
  | 'persist.evidence'
  | 'prepare.envelope'
  | 'interrupt.session'
  | 'await.close'
  | 'await.terminal_commit'
  | 'retry.close'
  | 'retry.commit'
  | 'publish.record'
  | 'snapshot.memory'
  | 'release.lease'
  | 'release.pin'
  | 'release.scratch'
  | 'release.home_reservation'
  | 'release.deviceSlot'
  | 'finish'
  | 'finish.declined'
  | 'failClaimedAgent'
  | 'steer.session'
  | 'await.offerSettlements'
  | 'shutdown.fail_active_tasks'
  | 'report.disposalFailure'
  | 'log'
  | 'audit';

/** Pure effect description; never a handle or a closure. */
export interface Effect {
  readonly kind: EffectKind;
  readonly taskId?: string;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly token?: string;
  readonly requestId?: string;
  readonly approvalId?: string;
  readonly decision?: ApprovalDecision;
  readonly approved?: boolean;
  readonly origin?: ApprovalOrigin;
  readonly stage?: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** Pre-execution predicate (§6.1). */
export interface EffectRequires {
  readonly phase?: readonly TaskPhase[];
  readonly claim?: 'required' | 'forbidden';
  readonly terminal?: 'none' | 'selected';
  readonly generation?: number;
  readonly alwaysRun?: boolean;
}

/** A completion event the host enqueues after a synchronous atomic effect. */
export type ReducerEventTemplate = Omit<ReducerEvent, 'type' | 'taskId' | 'atMs'> & {
  readonly type: ReducerEventType;
};

export interface EffectEnvelope {
  readonly id: string;
  readonly effect: Effect;
  readonly asOfRevision: number;
  readonly mode: EffectMode;
  readonly requires?: EffectRequires;
  /** Present only for atomic effects that produce their own completion synchronously. */
  readonly completion?: ReducerEventTemplate;
}

/** Intermediate effect produced by a transition row, before envelope ids. */
export interface EffectSpec {
  readonly effect: Effect;
  readonly mode: EffectMode;
  readonly requires?: EffectRequires;
  readonly completion?: ReducerEventTemplate;
}

/* -------------------------------- State -------------------------------- */

export interface OfferMessageFactsV1 {
  readonly required: boolean;
  readonly contentType?: string;
  readonly maxBytes?: number;
}

export interface OfferTerminalProjectionV1 {
  readonly mode: string;
  readonly contract?: string;
}

export interface OfferPreparationV1 {
  readonly reference: string;
  readonly memoryMode: string;
}

/** Decision-relevant offer facts only; no instruction/schema/payload bytes. */
export interface OfferFactsV1 {
  readonly digest: string;
  readonly readerAttempt: boolean;
  readonly homeAccess: 'writer' | 'memory-reader';
  readonly egressEnabled: boolean;
  readonly requiredToolsets: readonly string[];
  readonly strict: boolean;
  readonly sealed: boolean;
  readonly requestedRuntime?: string;
  readonly dispatchRuntime?: string;
  readonly harnessId?: string;
  readonly agentRef?: string;
  readonly sessionRef?: string;
  readonly maxDurationMs?: number;
  readonly message?: OfferMessageFactsV1;
  readonly terminalProjection?: OfferTerminalProjectionV1;
  readonly preparation?: OfferPreparationV1;
}

export interface AdmissionDeclineV1 {
  readonly stage: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly code?: string;
}

export interface AdmissionStateV1 {
  readonly stage: string;
  readonly deviceSlot: boolean;
  readonly scratch: boolean;
  readonly lease: boolean;
  readonly homeReservation?: string;
  readonly pin?: string;
  readonly decline?: AdmissionDeclineV1;
}

export interface StartupStateV1 {
  readonly owner?: 'startup' | 'active';
  readonly registered: boolean;
  readonly dispose: 'none' | 'pending' | 'settled';
}

export interface ClaimStateV1 {
  readonly journaled: boolean;
  readonly sent: boolean;
}

export interface ExecutionFactsV1 {
  readonly sessionRef: string;
  readonly runtimeId: string;
  readonly harnessId?: string;
  readonly home: string;
  readonly cwd: string;
  readonly leaseId: string;
  readonly startedAtMs: number;
}

export interface PendingApprovalV1 {
  readonly approvalId: string;
  readonly requestId: string;
  readonly kind: ApprovalKind;
}

export interface ApprovalQueueEntryV1 {
  readonly requestId: string;
  readonly kind: ApprovalKind;
}

export interface ApprovalStateV1 {
  readonly pending?: PendingApprovalV1;
  readonly queue: readonly ApprovalQueueEntryV1[];
}

export interface MessageStateV1 {
  readonly accepted: boolean;
  readonly sendAttempted: boolean;
}

export interface CompletionStateV1 {
  readonly token: string;
  readonly kind: 'complete';
  readonly atMs: number;
}

export interface TerminalStateV1 {
  readonly token: string;
  readonly kind: TerminalKind;
  readonly cause: TerminalCause;
  readonly stage: TerminalStage;
  readonly evidence: 'none' | 'ok' | 'degraded';
  readonly envelope: 'none' | 'ready';
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly failureClass?: string;
}

export interface CancelStateV1 {
  readonly requested: boolean;
  readonly reason?: string;
  readonly source?: 'wire' | 'in-process' | 'shutdown' | 'timeout' | 'local';
  readonly atMs?: number;
}

export interface TeardownStateV1 {
  readonly hostContexts: 'live' | 'revoked' | 'deleted';
  readonly batcher: 'stopped' | 'running';
  readonly blob: 'live' | 'aborted';
  readonly interrupt: 'none' | 'pending' | 'settled';
  readonly close: 'none' | 'pending' | 'settled' | 'failed';
  readonly commit: 'none' | 'pending' | 'ok' | 'failed';
  readonly lease: 'none' | 'held' | 'released';
  readonly pin: 'none' | 'held' | 'released';
  readonly scratch: 'none' | 'held' | 'released';
}

/** Per-task state: JSON-serializable, deep frozen, O(1) sized. */
export interface TaskStateV1 {
  readonly v: 1;
  readonly taskId: string;
  readonly generation: number;
  readonly revision: number;
  readonly phase: TaskPhase;
  readonly offer: OfferFactsV1;
  readonly admission: AdmissionStateV1;
  readonly startup: StartupStateV1;
  readonly claim: ClaimStateV1;
  readonly execution?: ExecutionFactsV1;
  readonly approval: ApprovalStateV1;
  readonly message: MessageStateV1;
  readonly completion?: CompletionStateV1;
  readonly terminal?: TerminalStateV1;
  readonly cancel: CancelStateV1;
  readonly teardown: TeardownStateV1;
}

export interface PendingCancelV1 {
  readonly taskId: string;
  readonly reason?: string;
  readonly atMs: number;
}

export interface ShutdownStateV1 {
  readonly reason: string;
  readonly atMs: number;
  readonly phase: 'stopping' | 'draining' | 'complete';
}

/** Runner-wide state: bounded collections and global gates. */
export interface RunnerStateV1 {
  readonly v: 1;
  readonly revision: number;
  readonly acceptingOffers: boolean;
  readonly shutdown?: ShutdownStateV1;
  readonly pendingCancelled: readonly PendingCancelV1[];
  readonly finished: readonly string[];
  readonly strictDeclined: readonly string[];
  readonly sealedOpening: readonly string[];
  readonly homeReservations: Readonly<Record<string, number>>;
}

export interface ReducerSnapshot {
  readonly runner: RunnerStateV1;
  readonly task?: TaskStateV1;
}

/* -------------------------------- Events ------------------------------- */

export type ReducerEventType =
  | 'offer.sealed_opening'
  | 'offer.received'
  | 'offer.sealed_opened'
  | 'offer.sealed_declined'
  | 'admission.begin'
  | 'admission.stage'
  | 'admission.declined'
  | 'admission.claimable'
  | 'claim.journaled'
  | 'claim.journal_failed'
  | 'claim.sent'
  | 'startup.registered'
  | 'startup.transferred'
  | 'startup.disposed'
  | 'runtime.session_bound'
  | 'runtime.started'
  | 'runtime.activation_failed'
  | 'runtime.start_failed'
  | 'runtime.run_failed'
  | 'turn.ended'
  | 'stream.ended'
  | 'resource.exceeded'
  | 'approval.requested'
  | 'approval.dispatch_next'
  | 'approval.decided'
  | 'approval.withdrawn'
  | 'approval.stale'
  | 'terminal.requested'
  | 'terminal.evidence'
  | 'terminal.envelope_ready'
  | 'terminal.envelope_failed'
  | 'terminal.sent'
  | 'terminal.close'
  | 'terminal.commit'
  | 'finish.completed'
  | 'retry.finalization'
  | 'cancel.received'
  | 'steer.received'
  | 'steer.failed'
  | 'message.accepted'
  | 'message.refused'
  | 'message.send_attempted'
  | 'shutdown.stop_accepting'
  | 'shutdown.drain'
  | 'shutdown.completed';

/**
 * One internal event. Payloads are deliberately flat: a transition row names
 * exactly the fields it reads, and every field stays JSON-serializable. Ids and
 * timestamps are injected by the host; the reducer never mints them.
 */
export interface ReducerEvent {
  readonly type: ReducerEventType;
  readonly atMs: number;
  readonly taskId?: string;
  readonly generation?: number;
  readonly offer?: OfferFactsV1;
  readonly strict?: boolean;
  readonly sealed?: boolean;
  readonly stage?: string;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly code?: string;
  readonly kind?: TerminalKind | ApprovalKind;
  readonly decision?: ApprovalDecision;
  readonly origin?: ApprovalOrigin;
  readonly approvalId?: string;
  readonly requestId?: string;
  readonly token?: string;
  readonly ok?: boolean;
  readonly source?: 'wire' | 'in-process' | 'shutdown' | 'timeout' | 'local';
  readonly execution?: ExecutionFactsV1;
  readonly completionToken?: string;
}

/* ------------------------------ Row model ------------------------------ */

export type Disposition = 'applied' | 'dropped' | 'rejected' | 'threw';

export interface RowOutcome {
  readonly runner: RunnerStateV1;
  readonly task?: TaskStateV1;
  readonly effects: readonly EffectSpec[];
  readonly disposition?: Disposition;
  readonly threw?: boolean;
}

export interface TransitionRow {
  readonly id: string;
  readonly events: readonly ReducerEventType[];
  /** Task phases this row accepts; `none` = task absent, `*` = any. */
  readonly phase: readonly TaskPhase[] | 'none' | '*';
  readonly when?: (snapshot: ReducerSnapshot, event: ReducerEvent) => boolean;
  readonly apply: (snapshot: ReducerSnapshot, event: ReducerEvent) => RowOutcome;
  /** Contract sentence: rejection / race semantics for this row. */
  readonly rejection: string;
  readonly disposition?: Disposition;
}

export interface ReduceResult {
  readonly runner: RunnerStateV1;
  readonly task?: TaskStateV1;
  readonly effects: readonly EffectEnvelope[];
  readonly disposition: Disposition;
  /** Stable transition row id, or a cross-cutting guard id. */
  readonly rowId: string;
  readonly reason?: string;
}

/* ------------------------------- Helpers ------------------------------- */

export function terminalTokenFor(taskId: string, revision: number): string {
  return taskId + ':' + String(revision);
}

export function createRunnerState(): RunnerStateV1 {
  return taskRunnerReducerDeepFreeze({
    v: 1 as const,
    revision: 0,
    acceptingOffers: true,
    pendingCancelled: [] as readonly PendingCancelV1[],
    finished: [] as readonly string[],
    strictDeclined: [] as readonly string[],
    sealedOpening: [] as readonly string[],
    homeReservations: {} as Readonly<Record<string, number>>,
  });
}

export function createOfferFacts(overrides: Partial<OfferFactsV1> = {}): OfferFactsV1 {
  return taskRunnerReducerDeepFreeze({
    digest: 'digest',
    readerAttempt: false,
    homeAccess: 'writer' as const,
    egressEnabled: false,
    requiredToolsets: [] as readonly string[],
    strict: false,
    sealed: false,
    ...overrides,
  });
}

export interface CreateTaskStateInput {
  readonly taskId: string;
  readonly generation?: number;
  readonly revision?: number;
  readonly phase?: TaskPhase;
  readonly offer?: OfferFactsV1;
}

export function createTaskState(input: CreateTaskStateInput): TaskStateV1 {
  return taskRunnerReducerDeepFreeze({
    v: 1 as const,
    taskId: input.taskId,
    generation: input.generation ?? 1,
    revision: input.revision ?? 1,
    phase: input.phase ?? 'received',
    offer: input.offer ?? createOfferFacts(),
    admission: {
      stage: 'received',
      deviceSlot: false,
      scratch: false,
      lease: false,
    },
    startup: { registered: false, dispose: 'none' as const },
    claim: { journaled: false, sent: false },
    approval: { queue: [] as readonly ApprovalQueueEntryV1[] },
    message: { accepted: false, sendAttempted: false },
    cancel: { requested: false },
    teardown: {
      hostContexts: 'live' as const,
      batcher: 'stopped' as const,
      blob: 'live' as const,
      interrupt: 'none' as const,
      close: 'none' as const,
      commit: 'none' as const,
      lease: 'none' as const,
      pin: 'none' as const,
      scratch: 'none' as const,
    },
  });
}

// Prefixed for the same bundle-symbol reason as taskRunnerReducerSpec.
function taskRunnerReducerDeepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      taskRunnerReducerDeepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonical(entry);
    }
    return out;
  }
  return value;
}

/** Canonical JSON for goldens/tests only — not a production API. */
export function serialize(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** UTF-8 byte size of the canonical serialization. */
export function stateBytes(value: unknown): number {
  return new TextEncoder().encode(serialize(value)).length;
}

function taskOf(snapshot: ReducerSnapshot): TaskStateV1 {
  if (snapshot.task === undefined) throw new Error('transition row requires a task');
  return snapshot.task;
}

function runnerWith(runner: RunnerStateV1, patch: Partial<RunnerStateV1>): RunnerStateV1 {
  return { ...runner, ...patch };
}

function taskWith(task: TaskStateV1, patch: Partial<TaskStateV1>): TaskStateV1 {
  return { ...task, ...patch };
}

function effect(kind: EffectKind, extra: Omit<Effect, 'kind'> = {}): Effect {
  return { kind, ...extra };
}

interface SpecOptions {
  readonly requires?: EffectRequires;
  readonly completion?: ReducerEventTemplate;
}

// The taskRunnerReducer prefixes on module-scope helpers keep them from
// colliding with bundle-scope symbols in the client entry. With an exact
// closure budget, a collision renames an unrelated symbol in the built entry
// and changes the bundle size even though this module is tree-shaken in S1.
function taskRunnerReducerSpec(mode: EffectMode, kind: EffectKind, extra: Omit<Effect, 'kind'> = {}, options: SpecOptions = {}): EffectSpec {
  return {
    effect: effect(kind, extra),
    mode,
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.completion === undefined ? {} : { completion: options.completion }),
  };
}

function atom(kind: EffectKind, extra: Omit<Effect, 'kind'> = {}, options: SpecOptions = {}): EffectSpec {
  return taskRunnerReducerSpec('atomic', kind, extra, options);
}

function barrier(kind: EffectKind, extra: Omit<Effect, 'kind'> = {}, options: SpecOptions = {}): EffectSpec {
  return taskRunnerReducerSpec('barrier', kind, extra, options);
}

function bestEffort(kind: EffectKind, extra: Omit<Effect, 'kind'> = {}, options: SpecOptions = {}): EffectSpec {
  return taskRunnerReducerSpec('bestEffort', kind, extra, options);
}

const NEVER: EffectRequires = { claim: 'forbidden', terminal: 'none' };
const CLAIMED: EffectRequires = { claim: 'required' };
const CLEANUP: EffectRequires = { alwaysRun: true };

function pushBounded<T>(values: readonly T[], value: T, cap = MAX_TRACKED_TASK_IDS): readonly T[] {
  const next = [...values, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function addUniqueBounded(values: readonly string[], value: string, cap = MAX_TRACKED_TASK_IDS): readonly string[] {
  if (values.includes(value)) return values;
  return pushBounded(values, value, cap);
}

function removeValue<T>(values: readonly T[], predicate: (value: T) => boolean): readonly T[] {
  const index = values.findIndex(predicate);
  if (index === -1) return values;
  return [...values.slice(0, index), ...values.slice(index + 1)];
}

function upsertPendingCancel(
  values: readonly PendingCancelV1[], entry: PendingCancelV1,
): readonly PendingCancelV1[] {
  const index = values.findIndex(value => value.taskId === entry.taskId);
  if (index !== -1) {
    const next = [...values];
    next[index] = entry;
    return next;
  }
  return pushBounded(values, entry);
}

function terminalReasonForCancel(reason: string | undefined): string {
  return reason === undefined || reason.length === 0 ? 'cancelled before claim' : 'cancelled before claim: ' + reason;
}

function selectTerminal(
  task: TaskStateV1,
  input: {
    readonly kind: TerminalKind;
    readonly cause: TerminalCause;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly failureClass?: string;
    readonly token?: string;
  },
): TerminalStateV1 {
  return {
    token: input.token ?? terminalTokenFor(task.taskId, task.revision + 1),
    kind: input.kind,
    cause: input.cause,
    stage: 'selected',
    evidence: 'none',
    envelope: 'none',
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
  };
}

function declineFacts(
  snapshot: ReducerSnapshot, event: ReducerEvent, stage: string,
): { readonly reason: string; readonly retryable: boolean; readonly code?: string } {
  const task = taskOf(snapshot);
  if (task.cancel.requested) {
    return { reason: terminalReasonForCancel(task.cancel.reason), retryable: false };
  }
  // Shutdown only owns the limits-stage verdict: an offer already parked on a
  // busy Agent home still reports that concrete, machine-readable cause first.
  if (stage === 'limits'
    && (snapshot.runner.shutdown !== undefined || !snapshot.runner.acceptingOffers)) {
    return { reason: 'daemon is shutting down', retryable: true };
  }
  return {
    reason: event.reason ?? 'declined',
    retryable: event.retryable ?? false,
    ...(event.code === undefined ? {} : { code: event.code }),
  };
}

function declinedTask(
  snapshot: ReducerSnapshot, event: ReducerEvent,
  stage: string,
  forced?: { readonly reason: string; readonly retryable: boolean; readonly code?: string },
): { readonly task: TaskStateV1; readonly reason: string } {
  const task = taskOf(snapshot);
  const facts = forced ?? declineFacts(snapshot, event, stage);
  const terminal = selectTerminal(task, {
    kind: 'declined',
    cause: 'declined',
    reason: facts.reason,
    retryable: facts.retryable,
  });
  return {
    reason: facts.reason,
    task: taskWith(task, {
      phase: 'declined',
      admission: {
        ...task.admission,
        stage,
        decline: {
          stage,
          reason: facts.reason,
          retryable: facts.retryable,
          ...(facts.code === undefined ? {} : { code: facts.code }),
        },
      },
      terminal,
      teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
    }),
  };
}

function claimedCleanupEffects(): readonly EffectSpec[] {
  return [
    bestEffort('release.home_reservation', {}, { requires: CLEANUP }),
    bestEffort('release.deviceSlot', {}, { requires: CLEANUP }),
    bestEffort('release.scratch', {}, { requires: CLEANUP }),
    bestEffort('release.lease', {}, { requires: CLEANUP }),
    bestEffort('release.pin', {}, { requires: CLEANUP }),
    atom('revoke.contexts', {}, { requires: CLEANUP }),
  ];
}

function declineCleanupEffects(): readonly EffectSpec[] {
  return [
    ...claimedCleanupEffects(),
    atom('finish.declined', {}, { requires: CLEANUP }),
  ];
}

function clearCompletion(task: TaskStateV1): TaskStateV1 {
  const { completion: _completion, ...withoutCompletion } = task;
  void _completion;
  return withoutCompletion;
}

function terminalizeEffects(options: {
  readonly token: string;
  readonly aborted: boolean;
}): readonly EffectSpec[] {
  return [
    atom('revoke.host_contexts', {}, { requires: CLEANUP }),
    atom('stop.batcher'),
    atom('stop.draft'),
    ...(options.aborted ? [atom('abort.blob')] : []),
    barrier('interrupt.session', { token: options.token }),
    barrier('persist.evidence', { token: options.token }),
    barrier('prepare.envelope', { token: options.token }),
  ];
}

function terminalCompleteEffects(token: string, aborted: boolean): readonly EffectSpec[] {
  return [
    atom('revoke.host_contexts', {}, { requires: CLEANUP }),
    atom('stop.batcher'),
    atom('stop.draft'),
    ...(aborted ? [atom('abort.blob')] : []),
    barrier('persist.evidence', { token }),
    barrier('prepare.envelope', { token }),
  ];
}

function dispatchApprovalEffects(pending: {
  readonly approvalId: string;
  readonly requestId: string;
}): readonly EffectSpec[] {
  return [
    atom('audit', { detail: { step: 'approval.dispatch' } }),
    atom('flush.batcher'),
    atom('send.approval_request', pending),
    atom('register.approval', pending),
    atom('arm.approval_timeout', pending),
  ];
}

function approvalResolvedEffects(event: ReducerEvent, approved: boolean): readonly EffectSpec[] {
  const effects: EffectSpec[] = [
    atom('clear.timeout', { ...(event.approvalId === undefined ? {} : { approvalId: event.approvalId }) }),
    ...(event.origin === 'wire'
      ? []
      : [atom('send.approval_resolved', {
          ...(event.approvalId === undefined ? {} : { approvalId: event.approvalId }),
          decision: approved ? 'approve' : 'reject',
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        })]),
    atom('resolve.approval_promise', {
      approved,
      ...(event.approvalId === undefined ? {} : { approvalId: event.approvalId }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    }),
    atom('dispatch.next_approval', {}, {
      completion: { type: 'approval.dispatch_next' },
    }),
  ];
  return effects;
}

function nextAdmissionEffect(stage: string | undefined): EffectSpec | undefined {
  switch (stage) {
    case 'home':
      return barrier('admission.limits', {}, { requires: NEVER });
    case 'limits':
      return barrier('prepare.runtime', {}, { requires: NEVER });
    case 'runtime':
      return barrier('bind.workspace', {}, { requires: NEVER });
    case 'workspace':
      return barrier('seal.manifest', {}, { requires: NEVER });
    case 'manifest':
      return barrier('pin.preparation', {}, { requires: NEVER });
    default:
      return undefined;
  }
}


/* --------------------------- Transition rows --------------------------- */

const WITHDRAWN_REASON = 'approval request was withdrawn by its requester';

function taskIdOf(event: ReducerEvent): string {
  if (event.taskId === undefined) throw new Error(event.type + ' requires a taskId');
  return event.taskId;
}

/** Offer / admission / claim / startup / runtime rows (§7.2–7.3). */
const OFFER_CLAIM_ROWS: readonly TransitionRow[] = [
  {
    id: 'O0',
    events: ['offer.sealed_opening'],
    phase: 'none',
    when: (snapshot, event) =>
      event.taskId !== undefined && !snapshot.runner.sealedOpening.includes(event.taskId),
    apply: (snapshot, event) => ({
      runner: runnerWith(snapshot.runner, {
        sealedOpening: addUniqueBounded(snapshot.runner.sealedOpening, taskIdOf(event)),
      }),
      effects: [barrier('open.sealed', { taskId: taskIdOf(event) })],
    }),
    rejection:
      'Already opening → drop. Success continues as O1, failure as O2; both clear sealedOpening.',
  },
  {
    id: 'O1',
    events: ['offer.received'],
    phase: 'none',
    when: (snapshot, event) => {
      const taskId = event.taskId;
      if (taskId === undefined) return false;
      if (snapshot.runner.finished.includes(taskId)) return false;
      if (snapshot.runner.strictDeclined.includes(taskId)) return false;
      if (snapshot.runner.sealedOpening.includes(taskId)) return false;
      return event.offer !== undefined && event.offer.digest.length > 0;
    },
    apply: (snapshot, event) => {
      const taskId = taskIdOf(event);
      const created = createTaskState({
        taskId,
        generation: event.generation ?? 1,
        offer: event.offer ?? createOfferFacts({ strict: event.strict ?? false, sealed: event.sealed ?? false }),
      });
      const task: TaskStateV1 = {
        ...created,
        admission: { ...created.admission, stage: 'dedup' },
      };
      return {
        runner: runnerWith(snapshot.runner, {
          sealedOpening: removeValue(snapshot.runner.sealedOpening, value => value === taskId),
        }),
        task,
        effects: [
          atom('clear.sealedOpening'),
          atom('track.inflight'),
          ...(task.offer.preparation === undefined
            ? []
            : [barrier('open.preparation', { stage: 'preparation' }, { requires: NEVER })]),
        ],
      };
    },
    rejection:
      'Duplicate / finished / strict-declined / still-sealing → drop with no effects. An ordinary decline is not a dedup entry, so a redelivery is processed again (current behavior).',
  },
  {
    id: 'O2',
    events: ['offer.sealed_declined'],
    phase: 'none',
    when: (_snapshot, event) => event.taskId !== undefined,
    apply: (snapshot, event) => {
      const taskId = taskIdOf(event);
      return {
        runner: runnerWith(snapshot.runner, {
          sealedOpening: removeValue(snapshot.runner.sealedOpening, value => value === taskId),
        }),
        effects: [
          atom('clear.sealedOpening'),
          atom('send.decline', {
            taskId,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.code === undefined ? {} : { detail: { code: event.code } }),
          }),
        ],
      };
    },
    rejection: 'Unseal failure declines with the closed code and never creates a task entry.',
  },
  {
    id: 'O3',
    events: ['admission.begin'],
    phase: ['received'],
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const pending = snapshot.runner.pendingCancelled.find(value => value.taskId === task.taskId);
      if (pending !== undefined) {
        const declined = declinedTask(snapshot, event, 'checkpoint1', {
          reason: terminalReasonForCancel(pending.reason),
          retryable: false,
        });
        return {
          runner: runnerWith(snapshot.runner, {
            pendingCancelled: removeValue(
              snapshot.runner.pendingCancelled,
              value => value.taskId === task.taskId,
            ),
          }),
          task: declined.task,
          effects: [
            atom('send.decline', { reason: declined.reason, retryable: false }),
            atom('consume.pendingCancelled'),
          ],
          reason: declined.reason,
        };
      }
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'admitting',
          admission: { ...task.admission, stage: 'checkpoint1' },
        }),
        effects: [barrier('reserve.home', { stage: 'home' }, { requires: NEVER })],
      };
    },
    rejection:
      'Checkpoint 1 (pre-claim cancel) wins ahead of home/limits and consumes the pendingCancelled marker; otherwise admission proceeds to the home reservation.',
  },
  {
    id: 'O4',
    events: ['admission.stage'],
    phase: ['admitting'],
    when: (snapshot, event) => snapshot.task?.terminal === undefined && event.stage !== undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const stage = event.stage ?? 'unknown';
      const next = nextAdmissionEffect(stage);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          admission: {
            ...task.admission,
            stage,
            ...(stage === 'limits' ? { deviceSlot: true } : {}),
            ...(stage === 'runtime' ? { scratch: true } : {}),
            ...(stage === 'workspace' ? { lease: true } : {}),
            ...(stage === 'manifest' ? { pin: 'preparation' } : {}),
          },
        }),
        effects: next === undefined ? [] : [next],
      };
    },
    rejection:
      'A stage result that arrives after cancel/terminalizing is stale and drops on the fallback row; failures use O5, never this row.',
  },
  {
    id: 'O5',
    events: ['admission.declined'],
    phase: ['received', 'admitting', 'claiming'],
    when: (snapshot, event) =>
      snapshot.task !== undefined && !snapshot.task.claim.sent && !snapshot.task.claim.journaled
      && event.taskId !== undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const declined = declinedTask(snapshot, event, event.stage ?? task.admission.stage);
      const strict = event.strict ?? task.offer.strict;
      return {
        runner: strict
          ? runnerWith(snapshot.runner, {
              strictDeclined: addUniqueBounded(snapshot.runner.strictDeclined, task.taskId),
            })
          : snapshot.runner,
        task: declined.task,
        effects: [
          atom('send.decline', {
            reason: declined.reason,
            retryable: declined.task.terminal?.retryable ?? event.retryable ?? false,
            ...(declined.task.admission.decline?.code === undefined
              ? {}
              : { detail: { code: declined.task.admission.decline.code } }),
          }),
          ...declineCleanupEffects(),
        ],
        reason: declined.reason,
      };
    },
    rejection:
      'First decline wins; later declines audit only. Cancel rewrites the reason to cancelled before claim (false); shutdown to daemon is shutting down (true).',
  },
  {
    id: 'C1',
    events: ['admission.claimable'],
    phase: ['admitting'],
    when: (snapshot) =>
      snapshot.task !== undefined && !snapshot.task.cancel.requested && snapshot.task.terminal === undefined
      && snapshot.runner.shutdown === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'claiming',
          admission: { ...task.admission, stage: 'claimable' },
          claim: { journaled: false, sent: false },
        }),
        effects: [barrier('journal.admission', { stage: 'claim' }, { requires: CLAIMED })],
      };
    },
    rejection:
      'A cancel/shutdown before the journal is admitted falls to O5 (decline). A journal failure is C9: retryable decline per #1217/#1221.',
  },
  {
    id: 'C2',
    events: ['claim.journaled'],
    phase: ['claiming'],
    when: (snapshot) =>
      snapshot.task !== undefined && !snapshot.task.claim.journaled && !snapshot.task.claim.sent
      && snapshot.task.terminal === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, { claim: { journaled: true, sent: false } }),
        effects: [
          atom('send.claim', { stage: 'claim' }, {
            // The claim is not sent yet: it requires journaled, not CLAIMED.
            requires: NEVER,
            completion: { type: 'claim.sent' },
          }),
        ],
      };
    },
    rejection:
      'After this row a cancel no longer declines (X2b). A terminal selected by a racing event makes this row stale: no claim is sent.',
  },
  {
    id: 'C9',
    events: ['claim.journal_failed'],
    phase: ['claiming'],
    when: (snapshot) =>
      snapshot.task !== undefined && !snapshot.task.claim.sent && !snapshot.task.claim.journaled
      && snapshot.task.terminal === undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const declined = declinedTask(snapshot, event, 'claiming');
      return {
        runner: runnerWith(snapshot.runner, {
          pendingCancelled: removeValue(
            snapshot.runner.pendingCancelled,
            value => value.taskId === task.taskId,
          ),
        }),
        task: declined.task,
        effects: [
          atom('send.decline', {
            reason: declined.reason,
            retryable: declined.task.terminal?.retryable ?? true,
          }),
          atom('consume.pendingCancelled'),
          ...declineCleanupEffects(),
        ],
        reason: declined.reason,
      };
    },
    rejection:
      '#1217/#1221: a beforeClaim failure is a retryable decline; claim never sends and task.started can never follow. A cancel/shutdown during the await keeps its own decline reason.',
  },
  {
    id: 'C3',
    events: ['claim.sent'],
    phase: ['claiming'],
    when: (snapshot) =>
      snapshot.task !== undefined && snapshot.task.claim.journaled && !snapshot.task.claim.sent
      && snapshot.task.terminal === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'claimed',
          claim: { journaled: true, sent: true },
          admission: { ...task.admission, deviceSlot: false },
        }),
        effects: [barrier('start.runtime', { stage: 'start' }, { requires: CLAIMED })],
      };
    },
    rejection:
      'Duplicate claim.sent drops. A cancel during start selects X3/X3b and is settled by the start result (C6/C7), never by a second claim.',
  },
  {
    id: 'C0',
    events: ['startup.registered'],
    phase: ['claimed', 'terminalizing'],
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          startup: { ...task.startup, registered: true, owner: 'startup' },
        }),
        effects: [],
      };
    },
    rejection: 'Startup ownership is retained on start failure / cancel until disposal settles.',
  },
  {
    id: 'C0b',
    events: ['startup.transferred'],
    phase: '*',
    when: (snapshot) => snapshot.task?.startup.owner === 'startup',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, { startup: { ...task.startup, owner: 'active' } }),
        effects: [],
      };
    },
    rejection: 'Transfer happens only after registration; finish releases lease/pin afterwards.',
  },
  {
    id: 'C4',
    events: ['runtime.session_bound'],
    phase: ['claimed'],
    when: (snapshot) => snapshot.task?.terminal === undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const execution = event.execution ?? task.execution;
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          ...(execution === undefined ? {} : { execution }),
          admission: { ...task.admission, lease: true, scratch: true },
        }),
        effects: [
          barrier('bind.session', { stage: 'bind' }, { requires: CLAIMED }),
          barrier('persist.handoff', { stage: 'handoff' }, { requires: CLAIMED }),
          barrier('activate.message', { stage: 'message' }, { requires: CLAIMED }),
        ],
      };
    },
    rejection:
      'Any bind/handoff/message failure becomes C8 activation_failed. A cancel in flight is recorded and handled at checkpoint 2 (C6), not here.',
  },
  {
    id: 'C5',
    events: ['runtime.started'],
    phase: ['claimed'],
    when: (snapshot) =>
      snapshot.task !== undefined && !snapshot.task.cancel.requested && snapshot.task.terminal === undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const execution = event.execution ?? task.execution;
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'running',
          ...(execution === undefined ? {} : { execution }),
          admission: { ...task.admission, deviceSlot: false },
          startup: { ...task.startup, owner: 'active', registered: true },
          teardown: { ...task.teardown, batcher: 'running' },
        }),
        effects: [
          atom('send.started', {}, { requires: CLAIMED }),
          atom('register.active', {}, { requires: CLAIMED }),
          atom('arm.max_duration', {
            ...(task.offer.maxDurationMs === undefined
              ? {}
              : { detail: { maxDurationMs: task.offer.maxDurationMs } }),
          }, { requires: CLAIMED }),
          atom('start.pump', {}, { requires: CLAIMED }),
        ],
      };
    },
    rejection:
      'The whole group is atomic: no cancel/steer/approve may be reduced between send.started and register.active/arm/pump.',
  },
  {
    id: 'C6',
    events: ['runtime.started'],
    phase: ['claimed'],
    when: (snapshot) =>
      snapshot.task !== undefined && snapshot.task.cancel.requested && snapshot.task.terminal === undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'cancelled',
        cause: 'cancelled',
        reason: task.cancel.reason ?? event.reason,
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          terminal,
          startup: { ...task.startup, owner: 'active', registered: true },
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked', blob: 'aborted' },
        }),
        effects: [
          atom('revoke.contexts', { token: terminal.token }, { requires: CLEANUP }),
          atom('transfer.startup', { token: terminal.token }, { requires: CLAIMED }),
          atom('register.active', { token: terminal.token }, { requires: CLAIMED }),
          atom('stop.batcher', { token: terminal.token }),
          atom('abort.blob', { token: terminal.token }),
          atom('start.pump', { token: terminal.token }, { requires: CLAIMED }),
          barrier('interrupt.session', { token: terminal.token }, { requires: CLAIMED }),
          barrier('persist.evidence', { token: terminal.token }, { requires: CLAIMED }),
          barrier('prepare.envelope', { token: terminal.token }, { requires: CLAIMED }),
        ],
      };
    },
    rejection:
      'Checkpoint 2: a cancel already reduced before this event always sends task.cancelled and never task.started (#1218).',
  },
  {
    id: 'C7',
    events: ['runtime.start_failed'],
    phase: ['claiming', 'claimed'],
    when: (snapshot) => snapshot.task?.terminal === undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      if (task.cancel.requested) {
        const terminal = selectTerminal(task, {
          kind: 'cancelled',
          cause: 'cancelled',
          reason: task.cancel.reason ?? event.reason,
          retryable: false,
        });
        return {
          runner: snapshot.runner,
          task: taskWith(task, {
            phase: 'terminalizing',
            terminal,
            startup: { ...task.startup, registered: true, owner: 'startup' },
            teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked', blob: 'aborted' },
          }),
          effects: [
            atom('revoke.contexts', { token: terminal.token }, { requires: CLEANUP }),
            barrier('register.startup_owner', { token: terminal.token }, { requires: CLAIMED }),
            barrier('dispose.startup', { token: terminal.token }, { requires: CLEANUP }),
            atom('send.cancelled', {
              token: terminal.token,
              ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
            }, { requires: CLAIMED }),
            ...claimedCleanupEffects(),
          ],
        };
      }
      const terminal = selectTerminal(task, {
        kind: 'failed',
        cause: 'failed',
        reason: event.reason ?? 'runtime start failed',
        retryable: event.retryable ?? false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          terminal,
          startup: { ...task.startup, registered: true, owner: 'startup' },
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked', blob: 'aborted' },
        }),
        effects: [
          atom('revoke.contexts', { token: terminal.token }, { requires: CLEANUP }),
          barrier('register.startup_owner', { token: terminal.token }, { requires: CLAIMED }),
          barrier('dispose.startup', { token: terminal.token }, { requires: CLEANUP }),
          barrier('failClaimedAgent', {
            token: terminal.token,
            ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
            retryable: terminal.retryable ?? false,
          }, { requires: CLAIMED }),
          ...claimedCleanupEffects(),
        ],
      };
    },
    rejection:
      'With a cancel: send task.cancelled, never task.fail. Without one: failClaimedAgent with retryable from the failure/stoppingOffers state.',
  },
  {
    id: 'C8',
    events: ['runtime.activation_failed'],
    phase: ['claimed'],
    when: (snapshot) => snapshot.task?.terminal === undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'failed',
        cause: 'failed',
        reason: event.reason ?? 'runtime activation failed',
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: [
          atom('revoke.contexts', { token: terminal.token }, { requires: CLEANUP }),
          barrier('persist.evidence', { token: terminal.token }, { requires: CLAIMED }),
          barrier('failClaimedAgent', {
            token: terminal.token,
            ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
            retryable: false,
          }, { requires: CLAIMED }),
          ...claimedCleanupEffects(),
        ],
      };
    },
    rejection:
      'bind/handoff/message failures are always retryable:false; startup ownership is retained until cleanup.',
  },
];

/** Approval rows (§7.4). */
const APPROVAL_ROWS: readonly TransitionRow[] = [
  {
    id: 'A1',
    events: ['approval.requested'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && snapshot.task.teardown.batcher === 'running'
      && snapshot.task.approval.pending === undefined
      && snapshot.task.approval.queue.length === 0
      && event.approvalId !== undefined
      && event.requestId !== undefined
      && event.kind !== undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'awaiting_approval',
          approval: {
            pending: {
              approvalId: event.approvalId ?? '',
              requestId: event.requestId ?? '',
              kind: event.kind === 'task-terminal' ? 'task-terminal' : 'tool-authorization',
            },
            queue: [],
          },
        }),
        effects: dispatchApprovalEffects({
          approvalId: event.approvalId ?? '',
          requestId: event.requestId ?? '',
        }),
      };
    },
    rejection:
      'Non-active / terminalizing -> A3 fail-closed reject. onApprovalDispatched (audit) precedes deps.send; a non-empty queue uses A2 and never jumps ahead.',
  },
  {
    id: 'A2',
    events: ['approval.requested'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && snapshot.task.approval.pending !== undefined
      && snapshot.task.approval.queue.length < MAX_PENDING_APPROVALS_PER_TASK
      && event.requestId !== undefined
      && event.kind !== undefined,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          approval: {
            ...task.approval,
            queue: [
              ...task.approval.queue,
              {
                requestId: event.requestId ?? '',
                kind: event.kind === 'task-terminal' ? 'task-terminal' : 'tool-authorization',
              },
            ],
          },
        }),
        effects: [],
      };
    },
    rejection:
      'At the per-task ceiling the next request is A3. A withdrawn queued request is A9 and is removed without ever being dispatched.',
  },
  {
    id: 'A3',
    events: ['approval.requested'],
    phase: '*',
    when: (snapshot) => {
      const task = snapshot.task;
      if (task === undefined) return true;
      if (task.phase !== 'running' && task.phase !== 'awaiting_approval') return true;
      if (task.approval.pending !== undefined
        && task.approval.queue.length >= MAX_PENDING_APPROVALS_PER_TASK) return true;
      if (task.approval.pending === undefined && task.approval.queue.length > 0) return true;
      return false;
    },
    apply: (snapshot, event) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [
        atom('resolve.approval_promise', {
          requestId: event.requestId,
          approved: false,
          reason: 'approval request rejected fail-closed',
        }),
      ],
      disposition: 'rejected',
    }),
    rejection:
      'Queue overflow or inactive task: resolve the request false immediately, register nothing and send no task.await_approval.',
  },
  {
    id: 'A4',
    events: ['approval.dispatch_next'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.approval.pending === undefined
      && snapshot.task.approval.queue.length > 0,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const head = task.approval.queue[0];
      if (head === undefined) throw new Error('approval queue head missing');
      const approvalId = event.approvalId ?? terminalTokenFor(task.taskId, task.revision + 1);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'awaiting_approval',
          approval: {
            pending: {
              approvalId,
              requestId: head.requestId,
              kind: head.kind,
            },
            queue: task.approval.queue.slice(1),
          },
        }),
        effects: dispatchApprovalEffects({ approvalId, requestId: head.requestId }),
      };
    },
    rejection: 'Only the FIFO head dispatches; an empty queue drops on the fallback row.',
  },
  {
    id: 'A5',
    events: ['approval.decided'],
    phase: ['running', 'awaiting_approval', 'terminalizing'],
    when: (snapshot, event) =>
      snapshot.task?.approval.pending !== undefined
      && event.approvalId === snapshot.task.approval.pending.approvalId
      && event.decision === 'approve',
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: task.terminal === undefined ? 'running' : task.phase,
          approval: { queue: task.approval.queue },
        }),
        effects: approvalResolvedEffects(event, true),
      };
    },
    rejection:
      'Mismatched approvalId -> audit only (A11). The registry already resolved; this row only updates state and queues the next request.',
  },
  {
    id: 'A6',
    events: ['approval.decided'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task?.approval.pending !== undefined
      && event.approvalId === snapshot.task.approval.pending.approvalId
      && event.decision === 'reject'
      && snapshot.task.approval.pending.kind === 'tool-authorization',
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'running',
          approval: { queue: task.approval.queue },
        }),
        effects: approvalResolvedEffects(event, false),
      };
    },
    rejection: 'A tool-authorization rejection denies that call only; the turn continues.',
  },
  {
    id: 'A8',
    events: ['approval.decided'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task?.approval.pending !== undefined
      && event.approvalId === snapshot.task.approval.pending.approvalId
      && event.decision === 'reject'
      && snapshot.task.approval.pending.kind === 'task-terminal'
      && (event.origin === 'eviction'
        || (event.origin === 'fail-closed'
          && !(event.reason ?? '').startsWith('approval timed out'))),
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'running',
          approval: { queue: task.approval.queue },
        }),
        effects: approvalResolvedEffects(event, false),
      };
    },
    rejection:
      'A system resolution that never selected a terminal (unsendable sealed frame, withdrawal, registry eviction) denies the approval, clears pending and lets the turn continue. A deliberate reject and a timeout (which registers its plan) are A7 and terminalize.'
  },
  {
    id: 'A7',
    events: ['approval.decided'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task?.approval.pending !== undefined
      && event.approvalId === snapshot.task.approval.pending.approvalId
      && event.decision === 'reject'
      && snapshot.task.approval.pending.kind === 'task-terminal',
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'failed',
        cause: 'rejected',
        reason: event.reason ?? 'rejected',
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          approval: { queue: task.approval.queue },
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: [
          ...approvalResolvedEffects(event, false),
          ...terminalizeEffects({ token: terminal.token, aborted: true }),
        ],
      };
    },
    rejection:
      'Resolve promise/next before the terminal (current handleReject order). Already terminal/finalizing -> retry the existing attempt only, never a second terminal.',
  },
  {
    id: 'A9',
    events: ['approval.withdrawn'],
    phase: '*',
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && event.requestId !== undefined
      && snapshot.task.approval.queue.some(entry => entry.requestId === event.requestId),
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          approval: {
            ...task.approval,
            queue: removeValue(task.approval.queue, entry => entry.requestId === event.requestId),
          },
        }),
        effects: [
          atom('resolve.approval_promise', {
            requestId: event.requestId,
            approved: false,
            reason: event.reason ?? WITHDRAWN_REASON,
          }),
        ],
      };
    },
    rejection: 'A queued withdrawal never dispatches and never sends a wire message.',
  },
  {
    id: 'A10',
    events: ['approval.withdrawn'],
    phase: '*',
    when: (snapshot, event) =>
      snapshot.task?.approval.pending !== undefined
      && event.requestId === snapshot.task.approval.pending.requestId,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const pending = task.approval.pending;
      if (pending === undefined) throw new Error('approval pending missing');
      const reason = event.reason ?? WITHDRAWN_REASON;
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: task.terminal === undefined ? 'running' : task.phase,
          approval: { queue: task.approval.queue },
        }),
        // A dispatched withdrawal settles the caller and the registry here.
        // The registry's own onResolve still dispatches `approval.decided`,
        // which now drops as stale: a withdrawal never selects a terminal (the
        // requesting runtime alone decides whether the turn ends), and a
        // finish() drain never re-selects one either.
        effects: [
          atom('resolve.approval', {
            approvalId: pending.approvalId,
            decision: 'reject',
            origin: 'fail-closed',
            approved: false,
            reason,
          }),
          atom('clear.timeout', { approvalId: pending.approvalId }),
          atom('send.approval_resolved', {
            approvalId: pending.approvalId,
            decision: 'reject',
            reason,
          }),
          atom('resolve.approval_promise', {
            approvalId: pending.approvalId,
            approved: false,
            reason,
          }),
          atom('dispatch.next_approval', {}, {
            completion: { type: 'approval.dispatch_next' },
          }),
        ],
      };
    },
    rejection:
      'Dispatched withdrawal settles the registry, the timeout and the caller fail-closed, then lets the FIFO head dispatch. It never revives the request or selects a terminal.',
  },
  {
    id: 'A11',
    events: ['approval.stale'],
    phase: '*',
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [atom('audit', { detail: { stale: 'approval' } })],
      disposition: 'dropped',
    }),
    rejection: 'Stale or mistargeted decisions only audit; never revive or re-send.',
  },
];

/** Terminal / finish rows (§7.5). */
const TERMINAL_ROWS: readonly TransitionRow[] = [
  {
    id: 'T1',
    events: ['turn.ended'],
    phase: ['running'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.terminal === undefined
      && snapshot.task.completion === undefined
      && snapshot.task.offer.message?.required === true
      && !snapshot.task.message.accepted,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          completion: {
            token: event.completionToken ?? terminalTokenFor(task.taskId, task.revision + 1),
            kind: 'complete',
            atMs: event.atMs,
          },
        }),
        effects: [],
      };
    },
    rejection:
      'A required Agent message not yet accepted gates completion: no terminal is selected until M1/M2 resolves it.',
  },
  {
    id: 'T1b',
    events: ['turn.ended'],
    phase: ['running'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.terminal === undefined
      && snapshot.task.completion === undefined
      && !(snapshot.task.offer.message?.required === true && !snapshot.task.message.accepted),
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'complete',
        cause: 'complete',
        reason: event.reason,
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalCompleteEffects(terminal.token, false),
      };
    },
    rejection: 'A turn_end after cancel only audits (T5); the first terminal wins.',
  },
  {
    id: 'T2',
    events: ['terminal.requested'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && snapshot.task.claim.sent
      && snapshot.task.terminal === undefined
      && snapshot.task.completion === undefined
      && event.kind === 'complete',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'complete',
        cause: 'complete',
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalCompleteEffects(terminal.token, false),
      };
    },
    rejection:
      'An existing terminal drops on T5. A completion gate that is still open must be resolved through M1/M2 first.',
  },
  {
    id: 'T3',
    events: ['terminal.requested', 'runtime.run_failed', 'stream.ended', 'resource.exceeded'],
    phase: ['claimed', 'running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && snapshot.task.claim.sent
      && snapshot.task.terminal === undefined
      && event.kind !== 'complete'
      && event.kind !== 'declined',
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const kind: TerminalKind = event.kind === 'cancelled' ? 'cancelled' : 'failed';
      const terminal = selectTerminal(task, {
        kind,
        cause: kind,
        reason: event.reason,
        retryable: event.retryable ?? false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalizeEffects({ token: terminal.token, aborted: true }),
      };
    },
    rejection:
      'Complete vs failed/cancelled: the first event wins; the loser audits. A cancel reason may be empty (task.cancelled schema).',
  },
  {
    id: 'T4',
    events: ['terminal.requested'],
    phase: ['received', 'admitting', 'claiming'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && !snapshot.task.claim.sent
      && event.kind !== 'complete',
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const declined = declinedTask(snapshot, event, task.admission.stage);
      return {
        runner: runnerWith(snapshot.runner, {
          pendingCancelled: removeValue(
            snapshot.runner.pendingCancelled,
            value => value.taskId === task.taskId,
          ),
        }),
        task: declined.task,
        effects: [
          atom('send.decline', {
            reason: declined.reason,
            retryable: declined.task.terminal?.retryable ?? event.retryable ?? false,
          }),
          atom('consume.pendingCancelled'),
          ...declineCleanupEffects(),
        ],
        reason: declined.reason,
      };
    },
    rejection:
      'Pre-claim terminal requests must decline (Offered -> Failed); task.fail/task.cancelled are invalid before the claim boundary.',
  },
  {
    id: 'T5',
    events: ['terminal.requested', 'turn.ended', 'runtime.run_failed', 'stream.ended', 'resource.exceeded'],
    phase: '*',
    when: (snapshot) => snapshot.task?.terminal !== undefined,
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [atom('audit', { detail: { stale: 'terminal' } })],
      disposition: 'dropped',
    }),
    rejection:
      'first-terminal-wins: token/kind/reason/retryable never change; no second terminal is sent.',
  },
  {
    id: 'T6',
    events: ['terminal.evidence'],
    phase: ['terminalizing'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && snapshot.task.terminal.evidence === 'none',
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = task.terminal;
      if (terminal === undefined) throw new Error('terminal missing');
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          terminal: {
            ...terminal,
            evidence: event.ok === true ? 'ok' : 'degraded',
            stage: 'evidence',
          },
        }),
        effects: [barrier('prepare.envelope', { token: terminal.token })],
      };
    },
    rejection:
      'Degraded evidence still continues the terminal. Retries stay inside the evidence effect (bounded 3 attempts).',
  },
  {
    id: 'T7',
    events: ['terminal.envelope_ready'],
    phase: ['terminalizing'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && snapshot.task.terminal.evidence !== 'none'
      && snapshot.task.terminal.envelope === 'none',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = task.terminal;
      if (terminal === undefined) throw new Error('terminal missing');
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          terminal: { ...terminal, envelope: 'ready', stage: 'envelope' },
        }),
        effects: [
          atom('send.terminal', { token: terminal.token }, {
            completion: { type: 'terminal.sent' },
          }),
        ],
      };
    },
    rejection: 'Envelope bytes are built once; a failed build is T8 and never reselects the terminal.',
  },
  {
    id: 'T8',
    events: ['terminal.envelope_failed'],
    phase: ['terminalizing'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token,
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [atom('log', { detail: { stage: 'envelope' } })],
      threw: true,
    }),
    rejection:
      'Keep the current throw and do not decline: terminal envelope build failures stay outside #1217 scope; the selected terminal is never replaced.',
  },
  {
    id: 'T9',
    events: ['terminal.sent'],
    phase: ['terminalizing'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && snapshot.task.terminal.envelope === 'ready',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = task.terminal;
      if (terminal === undefined) throw new Error('terminal missing');
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'retiring',
          terminal: { ...terminal, stage: 'sent' },
          teardown: { ...task.teardown, close: 'pending' },
        }),
        effects: [
          atom('mark.finished', { token: terminal.token }),
          barrier('await.close', { token: terminal.token, stage: 'close' }),
        ],
      };
    },
    rejection:
      'Terminal is sent before close; a duplicate terminal.sent drops. mark.finished mirrors finishOnce top.',
  },
  {
    id: 'T10',
    events: ['terminal.close'],
    phase: ['retiring'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && snapshot.task.terminal.stage === 'sent'
      && event.ok === true,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = task.terminal;
      if (terminal === undefined) throw new Error('terminal missing');
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          terminal: { ...terminal, stage: 'closed' },
          teardown: { ...task.teardown, close: 'settled', commit: 'pending' },
        }),
        effects: [barrier('await.terminal_commit', { token: terminal.token, stage: 'commit' })],
      };
    },
    rejection: 'A failed close is T11: report, retain ownership, retry via T14; never reselect.',
  },
  {
    id: 'T11',
    events: ['terminal.close'],
    phase: ['retiring'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && event.ok === false,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          teardown: { ...task.teardown, close: 'failed' },
        }),
        effects: [
          atom('report.disposalFailure', { stage: 'close' }),
          atom('audit', { detail: { close: 'failed' } }),
        ],
      };
    },
    rejection:
      'Retain active/lease ownership and stay retiring; retry.finalization retries close only, never re-sends the terminal.',
  },
  {
    id: 'T12',
    events: ['terminal.commit'],
    phase: ['retiring'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && snapshot.task.teardown.close === 'settled'
      && event.ok === true,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = task.terminal;
      if (terminal === undefined) throw new Error('terminal missing');
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          terminal: { ...terminal, stage: 'committed' },
          teardown: { ...task.teardown, commit: 'ok' },
        }),
        effects: [
          bestEffort('publish.record'),
          bestEffort('snapshot.memory'),
          bestEffort('persist.handoff'),
          barrier('release.lease', { token: terminal.token }, { requires: CLEANUP }),
          barrier('release.pin', { token: terminal.token }, { requires: CLEANUP }),
          atom('delete.contexts', {}, { requires: CLEANUP }),
          atom('finish', { token: terminal.token }, {
            requires: CLEANUP,
            completion: { type: 'finish.completed' },
          }),
        ],
      };
    },
    rejection:
      'Commit failure is T13 and retains ownership. Scratch is released by close (session.close + scratch.release).',
  },
  {
    id: 'T13',
    events: ['terminal.commit'],
    phase: ['retiring'],
    when: (snapshot, event) =>
      snapshot.task?.terminal !== undefined
      && event.token === snapshot.task.terminal.token
      && event.ok === false,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          teardown: { ...task.teardown, commit: 'failed' },
        }),
        effects: [
          atom('report.disposalFailure', { stage: 'commit' }),
          atom('audit', { detail: { commit: 'failed' } }),
        ],
      };
    },
    rejection: 'Retain ownership until shutdown/retry; a retry reuses the same committed bytes and token.',
  },
  {
    id: 'T14',
    events: ['retry.finalization'],
    phase: ['retiring'],
    when: (snapshot) =>
      snapshot.task?.teardown.close === 'failed' || snapshot.task?.teardown.commit === 'failed',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const token = task.terminal?.token;
      const closeFailed = task.teardown.close === 'failed';
      return {
        runner: snapshot.runner,
        task: snapshot.task,
        effects: [
          barrier(closeFailed ? 'retry.close' : 'retry.commit', {
            ...(token === undefined ? {} : { token }),
            stage: closeFailed ? 'close' : 'commit',
          }),
        ],
      };
    },
    rejection:
      'Only the failed barrier is retried; the token and terminal selection stay unchanged.',
  },
  {
    id: 'T14a',
    events: ['retry.finalization'],
    phase: ['terminalizing'],
    when: (snapshot) =>
      snapshot.task?.terminal !== undefined
      && snapshot.task.terminal.evidence === 'none'
      && snapshot.task.terminal.stage === 'selected',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const token = task.terminal?.token;
      return {
        runner: snapshot.runner,
        task: snapshot.task,
        effects: [
          barrier('persist.evidence', {
            ...(token === undefined ? {} : { token }),
            stage: 'evidence',
          }),
        ],
      };
    },
    rejection:
      'A terminal whose prepare barrier failed retries that same barrier; the token and selection never change.',
  },
  {
    id: 'T14b',
    events: ['retry.finalization'],
    phase: ['terminalizing'],
    when: (snapshot) =>
      snapshot.task?.terminal !== undefined
      && snapshot.task.terminal.evidence !== 'none'
      && snapshot.task.terminal.envelope === 'none',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const token = task.terminal?.token;
      return {
        runner: snapshot.runner,
        task: snapshot.task,
        effects: [
          barrier('prepare.envelope', {
            ...(token === undefined ? {} : { token }),
            stage: 'envelope',
          }),
        ],
      };
    },
    rejection:
      'Already-persisted evidence is not rewritten; only the envelope build is re-emitted from the cached bytes.',
  },
  {
    id: 'T14c',
    events: ['retry.finalization'],
    phase: ['terminalizing'],
    when: (snapshot) =>
      snapshot.task?.terminal !== undefined
      && snapshot.task.terminal.envelope === 'ready'
      && snapshot.task.terminal.stage === 'envelope',
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const token = task.terminal?.token;
      return {
        runner: snapshot.runner,
        task: snapshot.task,
        effects: [
          atom('send.terminal', {
            ...(token === undefined ? {} : { token }),
          }, { completion: { type: 'terminal.sent' as const } }),
        ],
      };
    },
    rejection:
      'A synchronous sender failure retains the exact envelope; retry re-sends the same bytes, never rebuilding or reselecting.',
  },
  {
    id: 'T15',
    events: ['finish.completed'],
    phase: '*',
    when: (snapshot) => snapshot.task !== undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: runnerWith(snapshot.runner, {
          finished: addUniqueBounded(snapshot.runner.finished, task.taskId),
        }),
        effects: [atom('audit', { detail: { finish: 'completed' } })],
      };
    },
    rejection:
      'Task entry is removed; later events for this id drop as finished and no further wire message may be sent.',
  },
];

/** Cancel / steer / shutdown / message rows (§7.5–7.9). */
const LIFECYCLE_ROWS: readonly TransitionRow[] = [
  {
    id: 'X1',
    events: ['cancel.received'],
    phase: 'none',
    when: (_snapshot, event) => event.taskId !== undefined,
    apply: (snapshot, event) => {
      const taskId = taskIdOf(event);
      return {
        runner: runnerWith(snapshot.runner, {
          pendingCancelled: upsertPendingCancel(snapshot.runner.pendingCancelled, {
            taskId,
            atMs: event.atMs,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          }),
        }),
        effects: [
          atom('revoke.host_contexts', { taskId }, { requires: CLEANUP }),
          atom('abort.inflightBlob', { taskId }),
          barrier('dispose.startup', { taskId }, { requires: CLEANUP }),
        ],
      };
    },
    rejection:
      'Unknown/not-yet-offered id: record a bounded pendingCancelled marker and dispose a startup owner if one exists. No terminal.',
  },
  {
    id: 'X7',
    events: ['cancel.received'],
    phase: '*',
    when: (snapshot) => snapshot.task?.cancel.requested === true,
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [],
      disposition: 'dropped',
    }),
    rejection: 'Duplicate cancel is idempotent and keeps the first reason; the attempt is shared.',
  },
  {
    id: 'X2',
    events: ['cancel.received'],
    phase: ['received', 'admitting'],
    when: (snapshot) =>
      snapshot.task !== undefined && !snapshot.task.claim.sent && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const reason = terminalReasonForCancel(event.reason);
      const declined = declinedTask(snapshot, event, task.admission.stage, { reason, retryable: false });
      return {
        runner: runnerWith(snapshot.runner, {
          pendingCancelled: removeValue(
            snapshot.runner.pendingCancelled,
            value => value.taskId === task.taskId,
          ),
        }),
        task: {
          ...declined.task,
          cancel: {
            requested: true,
            reason,
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
        },
        effects: [
          atom('revoke.host_contexts', { reason }, { requires: CLEANUP }),
          atom('send.decline', { reason, retryable: false }),
          atom('consume.pendingCancelled'),
          ...declineCleanupEffects(),
        ],
        reason,
      };
    },
    rejection:
      'Pre-claim cancel declines (cancelled before claim, false), consumes the pending marker and releases every reservation.',
  },
  {
    id: 'X2a',
    events: ['cancel.received'],
    phase: ['claiming'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && !snapshot.task.claim.journaled
      && !snapshot.task.claim.sent
      && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const reason = terminalReasonForCancel(event.reason);
      const declined = declinedTask(snapshot, event, 'claiming', { reason, retryable: false });
      return {
        runner: runnerWith(snapshot.runner, {
          pendingCancelled: removeValue(
            snapshot.runner.pendingCancelled,
            value => value.taskId === task.taskId,
          ),
        }),
        task: {
          ...declined.task,
          cancel: {
            requested: true,
            reason,
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
        },
        effects: [
          atom('revoke.host_contexts', { reason }, { requires: CLEANUP }),
          atom('send.decline', { reason, retryable: false }),
          atom('consume.pendingCancelled'),
          ...declineCleanupEffects(),
        ],
        reason,
      };
    },
    rejection:
      '#1218: a cancel reduced while claim.journaled is still in flight declines with the current claimOffer/beforeClaim behavior and never sends task.claim; the later journal completion drops as stale.',
  },
  {
    id: 'X2b',
    events: ['cancel.received'],
    phase: ['claiming'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.claim.journaled
      && !snapshot.task.claim.sent
      && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          cancel: {
            requested: true,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
        }),
        effects: [atom('audit', { detail: { claim: 'journaled' } })],
      };
    },
    rejection:
      'After claim.journaled a cancel can no longer decline: the atomic journaled -> send.claim group commits the claim and C6/C7 picks the outcome.',
  },
  {
    id: 'X3',
    events: ['cancel.received'],
    phase: ['claimed'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.startup.owner === 'startup'
      && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          cancel: {
            requested: true,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
        }),
        effects: [
          atom('revoke.host_contexts', {}, { requires: CLEANUP }),
          barrier('dispose.startup', { stage: 'cancel' }, { requires: CLEANUP }),
        ],
      };
    },
    rejection:
      'Startup-owned task: dispose and let the start path (C6/C7) send exactly one cancelled/fail; never send task.cancelled directly here.',
  },
  {
    id: 'X3b',
    events: ['cancel.received'],
    phase: ['claimed'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.startup.owner !== 'startup'
      && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          cancel: {
            requested: true,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
        }),
        effects: [
          atom('revoke.host_contexts', {}, { requires: CLEANUP }),
          atom('abort.inflightBlob'),
        ],
      };
    },
    rejection:
      'Claimed but no startup owner registered yet: record only cx; the start path observes it at checkpoint 2 (the bounded offer-window marker stays with the legacy adapter).',
  },
  {
    id: 'X4',
    events: ['cancel.received'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && snapshot.task.terminal === undefined
      && event.source !== 'shutdown'
      && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'cancelled',
        cause: 'cancelled',
        reason: event.reason,
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          cancel: {
            requested: true,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalizeEffects({ token: terminal.token, aborted: true }),
      };
    },
    rejection:
      'First terminal wins; cancel before/after complete is decided by arrival order. revoke.host_contexts precedes abort/interrupt.',
  },
  {
    id: 'X8',
    events: ['cancel.received'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task !== undefined
      && snapshot.task.terminal === undefined
      && event.source === 'shutdown'
      && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'failed',
        cause: 'shutdown',
        reason: 'daemon shutting down: ' + (event.reason ?? 'shutdown'),
        retryable: true,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          phase: 'terminalizing',
          cancel: {
            requested: true,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            source: 'shutdown',
            atMs: event.atMs,
          },
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalizeEffects({ token: terminal.token, aborted: true }),
      };
    },
    rejection:
      'Shutdown terminal semantics are task.fail (retryable true), never task.cancelled (lifecycle.ts shutdownTask).',
  },
  {
    id: 'X5',
    events: ['cancel.received'],
    phase: ['running', 'awaiting_approval', 'terminalizing', 'retiring'],
    when: (snapshot) => snapshot.task !== undefined && !snapshot.task.cancel.requested,
    apply: (snapshot, event) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          cancel: {
            requested: true,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.source === undefined ? {} : { source: event.source }),
            atMs: event.atMs,
          },
        }),
        effects: [
          atom('revoke.host_contexts', {}, { requires: CLEANUP }),
          atom('audit', { detail: { terminal: 'in-flight' } }),
        ],
      };
    },
    rejection:
      'Shares the selected attempt; if the terminal is already sent nothing is re-sent. Never a second terminal.',
  },
  {
    id: 'X6',
    events: ['cancel.received'],
    phase: ['finished', 'declined'],
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [atom('audit', { detail: { terminal: 'settled' } })],
      disposition: 'dropped',
    }),
    rejection: 'Idempotent no-op; a finished/declined task is never revived.',
  },
  {
    id: 'ST1',
    events: ['steer.received'],
    phase: ['running', 'awaiting_approval'],
    when: (_snapshot, event) => event.sealed !== true,
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [barrier('steer.session')],
    }),
    rejection: 'Forwards the text; never changes task state. Sealed input uses ST4.',
  },
  {
    id: 'ST4',
    events: ['steer.received'],
    phase: ['running', 'awaiting_approval'],
    when: (_snapshot, event) => event.sealed === true,
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [barrier('steer.session', { detail: { sealed: true } })],
    }),
    rejection:
      'The sealed adapter applies its own steer first; sealed tasks reject plaintext steering (drop).',
  },
  {
    id: 'ST2',
    events: ['steer.received'],
    phase: '*',
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [],
      disposition: 'dropped',
    }),
    rejection: 'No active task / terminalizing / finished: ack and drop (current handleSteer returns).',
  },
  {
    id: 'ST3',
    events: ['steer.failed'],
    phase: '*',
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [atom('log', { detail: { stage: 'steer' } })],
    }),
    rejection:
      'SteerUnsupported: drop + log. Any other error is rethrown by the host to keep the cursor stalled.',
  },
  {
    id: 'SH1',
    events: ['shutdown.stop_accepting'],
    phase: '*',
    when: (snapshot) => snapshot.runner.acceptingOffers,
    apply: (snapshot, event) => ({
      runner: runnerWith(snapshot.runner, {
        acceptingOffers: false,
        shutdown: {
          reason: event.reason ?? 'shutdown',
          atMs: event.atMs,
          phase: 'stopping',
        },
      }),
      effects: [
        atom('revoke.allHostContexts', {}, { requires: CLEANUP }),
        atom('startup.stopRetry'),
        atom('abort.inflightBlobs'),
      ],
    }),
    rejection:
      'Idempotent (SH2 audits). Already-claimed tasks keep running; new offers are declined at the limits stage.',
  },
  {
    id: 'SH2',
    events: ['shutdown.stop_accepting'],
    phase: '*',
    when: (snapshot) => !snapshot.runner.acceptingOffers,
    apply: (snapshot) => ({
      runner: snapshot.runner,
      effects: [atom('audit', { detail: { shutdown: 'already-stopping' } })],
      disposition: 'dropped',
    }),
    rejection: 'Repeated stop_accepting only audits.',
  },
  {
    id: 'SH3',
    events: ['shutdown.drain'],
    phase: '*',
    when: (snapshot) =>
      snapshot.runner.shutdown === undefined || snapshot.runner.shutdown.phase === 'stopping',
    apply: (snapshot, event) => ({
      runner: runnerWith(snapshot.runner, {
        shutdown: {
          reason: snapshot.runner.shutdown?.reason ?? event.reason ?? 'shutdown',
          atMs: snapshot.runner.shutdown?.atMs ?? event.atMs,
          phase: 'draining',
        },
      }),
      effects: [
        barrier('await.offerSettlements'),
        atom('shutdown.fail_active_tasks', {
          detail: {
            reason: 'daemon shutting down: ' + (snapshot.runner.shutdown?.reason ?? event.reason ?? 'shutdown'),
            retryable: true,
          },
        }),
        barrier('dispose.startup_all'),
      ],
    }),
    rejection:
      'Wait for in-flight offer settlements, then fail every active task (never cancel), then dispose startup. A repeat is SH4.',
  },
  {
    id: 'SH4',
    events: ['shutdown.drain'],
    phase: '*',
    when: (snapshot) => snapshot.runner.shutdown?.phase === 'draining',
    apply: (snapshot) => ({
      runner: snapshot.runner,
      effects: [atom('shutdown.fail_active_tasks', { detail: { retry: true } })],
    }),
    rejection: 'Only tasks without a terminal get a retried fail; the same token/terminal is never replaced.',
  },
  {
    id: 'SH5',
    events: ['startup.disposed'],
    phase: '*',
    when: (snapshot) => snapshot.task === undefined || snapshot.task.startup.owner === 'startup',
    apply: (snapshot, event) => {
      if (snapshot.task === undefined) {
        return { runner: snapshot.runner, effects: [] };
      }
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          startup: { ...task.startup, dispose: event.ok === false ? 'pending' : 'settled' },
        }),
        effects: [],
      };
    },
    rejection:
      'A failed disposal keeps startup ownership so shutdown can retry (shutdown-startup oracle).',
  },
  {
    id: 'SH6',
    events: ['shutdown.completed'],
    phase: '*',
    when: (snapshot) => snapshot.runner.shutdown?.phase === 'draining',
    apply: (snapshot) => ({
      runner: runnerWith(snapshot.runner, {
        shutdown: {
          ...(snapshot.runner.shutdown ?? { reason: 'shutdown', atMs: 0 }),
          phase: 'complete',
        },
      }),
      effects: [atom('audit', { detail: { shutdown: 'complete' } })],
    }),
    rejection: 'After completion, new events only audit; no wire messages are sent.',
  },
  {
    id: 'M0',
    events: ['message.accepted'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot) =>
      snapshot.task !== undefined
      && snapshot.task.completion === undefined
      && snapshot.task.terminal === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          message: { ...task.message, accepted: true },
        }),
        effects: [atom('revoke.message_context', {}, { requires: CLEANUP })],
      };
    },
    rejection:
      'Accepted before turn_end only sets the flag; the turn keeps running and T1 will not wait.',
  },
  {
    id: 'M1',
    events: ['message.accepted'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task?.completion !== undefined
      && event.completionToken === snapshot.task.completion.token
      && snapshot.task.terminal === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'complete',
        cause: 'complete',
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(clearCompletion(task), {
          phase: 'terminalizing',
          message: { ...task.message, accepted: true },
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalCompleteEffects(terminal.token, false),
      };
    },
    rejection:
      'Accepted first selects complete; if cancel already selected a terminal this row is stale and audits.',
  },
  {
    id: 'M2',
    events: ['message.refused'],
    phase: ['running', 'awaiting_approval'],
    when: (snapshot, event) =>
      snapshot.task?.completion !== undefined
      && event.completionToken === snapshot.task.completion.token
      && snapshot.task.terminal === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      const terminal = selectTerminal(task, {
        kind: 'failed',
        cause: 'failed',
        reason: 'required Agent message was refused',
        retryable: false,
      });
      return {
        runner: snapshot.runner,
        task: taskWith(clearCompletion(task), {
          phase: 'terminalizing',
          terminal,
          teardown: { ...task.teardown, batcher: 'stopped', hostContexts: 'revoked' },
        }),
        effects: terminalizeEffects({ token: terminal.token, aborted: true }),
      };
    },
    rejection:
      'Refused never completes; an already accepted message is never re-judged failed (first event wins).',
  },
  {
    id: 'M3',
    events: ['message.send_attempted'],
    phase: '*',
    when: (snapshot) => snapshot.task !== undefined && snapshot.task.terminal === undefined,
    apply: (snapshot) => {
      const task = taskOf(snapshot);
      return {
        runner: snapshot.runner,
        task: taskWith(task, {
          message: { ...task.message, sendAttempted: true },
        }),
        effects: [],
      };
    },
    rejection: 'Only influences outbox revoke for a failed terminal; never selects a terminal.',
  },
  {
    id: 'M4',
    events: ['message.accepted', 'message.refused'],
    phase: '*',
    apply: (snapshot) => ({
      runner: snapshot.runner,
      task: snapshot.task,
      effects: [atom('audit', { detail: { stale: 'message' } })],
      disposition: 'dropped',
    }),
    rejection:
      'Terminalizing/retiring/finished/declined (or no task) only audits; no revival.',
  },
];

/** Explicit per-event fallbacks: every (event, phase) pair has a row. */
function fallbackRow(id: string, events: readonly ReducerEventType[]): TransitionRow {
  return {
    id,
    events,
    phase: '*',
    apply: snapshot => ({
      runner: snapshot.runner,
      ...(snapshot.task === undefined ? {} : { task: snapshot.task }),
      effects: [atom('audit', { detail: { drop: 'stale' } })],
      disposition: 'dropped',
    }),
    rejection: 'Explicit drop/audit: no state change, no wire effect.',
  };
}

const FALLBACK_ROWS: readonly TransitionRow[] = [
  /* @__PURE__ */ fallbackRow('F-OFFER', ['offer.sealed_opening', 'offer.received', 'offer.sealed_opened', 'offer.sealed_declined']),
  /* @__PURE__ */ fallbackRow('F-ADMISSION', ['admission.begin', 'admission.stage', 'admission.declined', 'admission.claimable']),
  /* @__PURE__ */ fallbackRow('F-CLAIM', ['claim.journaled', 'claim.journal_failed', 'claim.sent']),
  /* @__PURE__ */ fallbackRow('F-STARTUP', ['startup.registered', 'startup.transferred', 'startup.disposed']),
  /* @__PURE__ */ fallbackRow('F-RUNTIME', ['runtime.session_bound', 'runtime.started', 'runtime.activation_failed', 'runtime.start_failed', 'runtime.run_failed']),
  /* @__PURE__ */ fallbackRow('F-TURN', ['turn.ended', 'stream.ended', 'resource.exceeded']),
  /* @__PURE__ */ fallbackRow('F-APPROVAL', ['approval.requested', 'approval.dispatch_next', 'approval.decided', 'approval.withdrawn', 'approval.stale']),
  /* @__PURE__ */ fallbackRow('F-TERMINAL', ['terminal.requested', 'terminal.evidence', 'terminal.envelope_ready', 'terminal.envelope_failed', 'terminal.sent', 'terminal.close', 'terminal.commit', 'retry.finalization', 'finish.completed']),
  /* @__PURE__ */ fallbackRow('F-MESSAGE', ['message.send_attempted']),
  /* @__PURE__ */ fallbackRow('F-SHUTDOWN', ['shutdown.stop_accepting', 'shutdown.drain', 'shutdown.completed']),
];

/** The single data source for reducer behavior (§7). Order is priority. */
export const TRANSITIONS: readonly TransitionRow[] = [
  ...OFFER_CLAIM_ROWS,
  ...APPROVAL_ROWS,
  ...TERMINAL_ROWS,
  ...LIFECYCLE_ROWS,
  ...FALLBACK_ROWS,
];

let taskRunnerReducerTableFrozen = false;

/**
 * The table is frozen on first use, not at module evaluation: S1 keeps the
 * reducer out of the client entry bundle (the closure budget is exact), and a
 * top-level freeze call defeats tree shaking.
 */
export function transitionTable(): readonly TransitionRow[] {
  if (!taskRunnerReducerTableFrozen) {
    taskRunnerReducerDeepFreeze(TRANSITIONS);
    taskRunnerReducerTableFrozen = true;
  }
  return TRANSITIONS;
}

function phaseMatches(phase: TransitionRow['phase'], snapshot: ReducerSnapshot): boolean {
  if (phase === '*') return true;
  if (phase === 'none') return snapshot.task === undefined;
  return snapshot.task !== undefined && phase.includes(snapshot.task.phase);
}

function auditResult(snapshot: ReducerSnapshot, rowId: string, detail: string): ReduceResult {
  const asOfRevision = snapshot.task?.revision ?? snapshot.runner.revision;
  const envelope: EffectEnvelope = {
    id: rowId + '#0',
    effect: { kind: 'audit', detail: { drop: detail } },
    asOfRevision,
    mode: 'atomic',
  };
  return {
    runner: snapshot.runner,
    ...(snapshot.task === undefined ? {} : { task: snapshot.task }),
    effects: [envelope],
    disposition: 'dropped',
    rowId,
    reason: detail,
  };
}

/**
 * Applies one event to a frozen runner/task snapshot and returns the next
 * frozen snapshot plus ordered effect descriptions. Pure: no clock, no ids,
 * no IO, no mutation of the input. Stale generation / wrong task / already
 * finished task ids drop before the table is consulted.
 */
export function reduce(snapshot: ReducerSnapshot, event: ReducerEvent): ReduceResult {
  if (event.taskId !== undefined && snapshot.task !== undefined
    && event.taskId !== snapshot.task.taskId) {
    return auditResult(snapshot, 'WRONG-TASK', 'drop:wrong-task');
  }
  if (event.taskId !== undefined && snapshot.task === undefined
    && snapshot.runner.finished.includes(event.taskId)) {
    return auditResult(snapshot, 'FINISHED-TASK', 'drop:finished');
  }
  if (snapshot.task !== undefined && event.taskId === snapshot.task.taskId
    && event.generation !== undefined && event.generation !== snapshot.task.generation) {
    return auditResult(snapshot, 'STALE-GENERATION', 'drop:stale-generation');
  }

  const row = transitionTable().find(candidate =>
    candidate.events.includes(event.type)
    && phaseMatches(candidate.phase, snapshot)
    && (candidate.when === undefined || candidate.when(snapshot, event)));
  if (row === undefined) {
    throw new Error('no transition row for ' + event.type + ' in phase ' + (snapshot.task?.phase ?? 'none'));
  }

  const outcome = row.apply(snapshot, event);
  let nextTask = outcome.task;
  if (nextTask !== undefined && snapshot.task !== undefined && nextTask !== snapshot.task) {
    nextTask = { ...nextTask, revision: snapshot.task.revision + 1 };
  }
  const nextRunner = outcome.runner === snapshot.runner
    ? snapshot.runner
    : { ...outcome.runner, revision: snapshot.runner.revision + 1 };
  const asOfRevision = nextTask?.revision ?? nextRunner.revision;
  const effects: EffectEnvelope[] = outcome.effects.map((entry, index) => ({
    id: row.id + '#' + String(index),
    effect: {
      ...entry.effect,
      ...(entry.effect.taskId === undefined && event.taskId !== undefined
        ? { taskId: event.taskId }
        : {}),
    },
    asOfRevision,
    mode: entry.mode,
    ...(entry.requires === undefined ? {} : { requires: entry.requires }),
    ...(entry.completion === undefined ? {} : { completion: entry.completion }),
  }));
  const disposition: Disposition = outcome.threw === true
    ? 'threw'
    : outcome.disposition ?? row.disposition ?? 'applied';

  return taskRunnerReducerDeepFreeze({
    runner: nextRunner,
    ...(nextTask === undefined ? {} : { task: nextTask }),
    effects,
    disposition,
    rowId: row.id,
  });
}
