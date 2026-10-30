import { type ResultReplyFailure } from './result-reply-failure';
import type { RuntimeTaskInput } from '../types';
import type { ActivityIngress } from '@byok-sdk/protocol';
import type { ScratchRoot } from './retention/scratch';
import { StartupOwnership } from './startup-ownership';
import {
  createEnvelope,
  type AgentMessageContentType,
  type AgentMessageDispositionPayload,
  type AgentMessageEgressRequirement,
  type AgentEgressPolicy,
  type Envelope,
  type SealedDeclineCode,
  type RuntimeId,
  type TerminalInferenceUsage,
  type TerminalPreparedObservation,
  type TerminalAgentHomeProjection,
  type TerminalAgentHomeMemoryChange,
  type TerminalProjectionSelection,
  type TaskDeclinePayload,
  type TaskFailure,
  type TaskOfferPlainPayload,
  requiredReceiverCapabilities,
} from '@byok-sdk/protocol';
import {
  type McpStdioServerConfig,
  type McpToolsetConfig,
  type RuntimeAdapter,
} from '../types';
import type { InputPreparationStore } from './input-preparation-store';
import {
  type InputPreparationRuntimeIdentityV1,
  type InputPreparationBindingV1,
} from '../input-preparation';
import {
  AgentHomeManager,
  type AgentRef,
} from '../agent-home';
import {
  type AgentHomeAccessMode,
} from '../agent-home-readers';
import {
  AgentSessionHandoffStore,
  type AgentTerminalCause,
} from './agent-session-handoff-store';
import {
  type RuntimeDisposalStage,
} from '../runtime-failure';
import { type ApprovalDecision, type ApprovalKind, type ApprovalOrigin, type ApprovalRegistry } from './approvals';
import type { BlobResolver } from './blob-client';
import type { SealedTasks } from './sealed-task';
import { taskFailureField } from './task-failure';
import type {
  AgentResultDescribeParams,
  AgentResultDescribeResult,
  AgentResultSubmitParams,
  AgentResultSubmitResult,
  TaskQueueWatermark,
} from './control-protocol';
import { DEFAULT_MAX_INLINE_EVENT_BYTES } from './event-spill';
import { type ExecutionRecord } from './execution-record';
import type { LocalAgentReleaseIdentity } from '../release-identity';
import {
  type ProgressBatcherOptions,
} from './progress-batcher';
import type { AgentEgressController } from './agent-egress-controller';
import { AgentMessageOutbox, type AgentMessageOutboxRecord } from './agent-message-outbox';
import { AgentResultStore } from './agent-result-store';
import {
  type McpToolsProbeOptions,
} from './mcp-tools-probe';
import {
  type McpServerObservation,
} from '../mcp/observation';
import type { ResolvedAgentMessageMcpBin } from './resolve-agent-message-mcp-bin';
import type { ResolvedAgentMemoryMcpBin } from './resolve-agent-memory-mcp-bin';
import {
  AgentMemoryService,
  isAgentMemorySecureFilesystemAvailable,
  type AgentMemoryAuditWarning,
  type AgentMemoryHostedProjection,
  type AgentMemoryTaskContext,
} from './agent-memory';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
import type { ActiveTask, AgentResultContext, PendingMessageTask, ClaimedAgentFailureContext, PickResult, OfferPhaseContext, OfferRuntimeInput, HostToolsetContextEntry } from './task-runner/support';
import { offerSettlements, trackOffer } from './task-runner/support';
import { publishAgentMessage, describeAgentResult, submitAgentResult, recoverAgentMessageOutboxes, agentMessageOutbox, cancelRecoveredAgentMessage, activateAgentMessage, sendAgentMessageRecord, handleAgentMessageDisposition, agentResultStore } from './task-runner/agent-message';
import { withAgentMessageMcp, withAgentResultMcp, withAgentMemoryMcp, withHostToolsetContext, resolveMcpServers } from './task-runner/mcp-contexts';
import { activeMemoryContext, runMemoryOperation, quiesceAndSnapshotAgentMemory, bindAgentMemoryFilesystem } from './task-runner/agent-memory';
import { stopAcceptingOffers, closeActiveSession, awaitActiveSessionClose, interruptBounded, teardownActiveTask, shutdownTask, armMaxDurationTimer, handleCancel, evictPendingCancelled, handleSteer } from './task-runner/lifecycle';
import { admitOffer, reserveOfferHome, admitOfferLimits, handleSealedOffer, declineSealedOffer, declineOfferMissingCapabilities } from './task-runner/offer-admission';
import { prepareOfferRuntime, pickAdapter } from './task-runner/offer-runtime';
import { requestApproval, dispatchApproval, handleApprove, handleReject } from './task-runner/approvals';
import { terminalInferenceUsagePayload, preparedObservationPayload, agentTerminalPayload, resolveStagedResult, persistAgentTerminalEvidence, measureReaderMemoryChange, retryAgentTerminalEvidence, reportAgentTerminalEvidenceFailure } from './task-runner/terminal-evidence';
import { fail, failClaimedAgent, homeFinalizations, finishOnce, publishExecutionRecord, settleSemanticTerminal, releasePreparationPin } from './task-runner/finish';
import { pump, publishSuccessfulCompletion, sendArtifact, reportArtifactError } from './task-runner/event-pump';
import { handleOffer } from './task-runner/offer';
import { OfferAdmissionTiming } from './task-runner/offer-admission-timing';
import type { ToolAuthorizationResolver, ToolReminder } from '../tool-authorization';

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
 * M5 batch-3 (workstream 2): default cap (64 MiB) on accumulated
 * (approximate) agent-event output bytes this daemon tolerates for a single
 * task before tearing it down as a resource-limit violation — see
 * `TaskRunnerDeps.maxTaskOutputBytes` and `DaemonConfig.maxTaskOutputBytes`
 * (`create-daemon.ts`) for the full contract, including the
 * zero/negative-is-a-config-error / `Number.POSITIVE_INFINITY`-is-the-real-
 * opt-out pin.
 */
export const DEFAULT_MAX_TASK_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Default number of `memory-reader` Attempts that may run concurrently in one
 * canonical Agent home. Readers are counted apart from the writer. A home has
 * at most one writer Attempt, fixed: the writer runs in the home itself, so a
 * second writer would co-write `MEMORY.md`, `notes/` and `.git`.
 */
export const DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME = 4;

/**
 * Default number of tasks one daemon runs at once, across every Agent home and
 * runtime: active tasks plus offers already admitted past this cap.
 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 8;

export interface TaskRunnerDeps {
  adapters: RuntimeAdapter[];
  runtimeAllowlist?: string[];
  /**
   * M5 batch-3 (workstream 1): auto-select priority order for `pickAdapter`'s
   * no-explicit-runtime branch — see `DaemonConfig.runtimePreference`'s own
   * doc comment (`create-daemon.ts`) for the full rationale behind this
   * existing at all. Unset defaults to {@link DEFAULT_RUNTIME_PREFERENCE}
   * (pi LAST, deliberately — product decision: pi is this SDK's fallback
   * runtime, not its default). Independent of `runtimeAllowlist` above
   * (which restricts WHICH runtimes are eligible at all) — this only orders
   * the attempt sequence among whatever that allowlist, if set, already let
   * through.
   */
  runtimePreference?: RuntimeId[];
  /** Reads the daemon's current validated device-local registry once per offer. */
  getMcpToolsets?: () => ReadonlyMap<string, McpToolsetConfig>;
  /**
   * The prepared-Execution lane. Absent on a daemon with no `inputPreparation`
   * section, and a prepared `task.offer` arriving there is declined by name
   * rather than reinterpreted as an ordinary offer.
   *
   * It carries the durable store plus the three device facts a prepared
   * admission compares against, resolved by the daemon that already owns them —
   * never re-derived here, because a second derivation of the installed runtime
   * identity or the operator's policy revision is a second opinion about the
   * same configuration.
   */
  inputPreparationLane?: {
    readonly store: InputPreparationStore;
    readonly authorizeAgentMemory: (binding: InputPreparationBindingV1) => Promise<void>;
    /**
     * Await the store's open before the first record read.
     *
     * The prepared offer path is reachable on a freshly restarted daemon that
     * has served no prepare/lookup/cancel call yet, and a store that was never
     * opened holds an EMPTY map — which would make a perfectly good durable
     * record answer `preparation_not_found`. This is the preparation service's
     * own once-only `ensureOpen` latch, passed in rather than re-implemented:
     * the replay that recovers the log stays the service's, so this lane adds
     * no second open authority and no second replay path.
     */
    readonly open: () => Promise<void>;
    /** The VERIFIED installed runtime/compiler identity every artifact is bound to. */
    readonly runtime: InputPreparationRuntimeIdentityV1;
    /** The operator's configured limits-policy revision currently in force. */
    readonly policyRevision: string;
    /** `toolsetId` -> definition revision, from one registry read per call. */
    readonly toolsetDefinitionRevisions: () => ReadonlyMap<string, string>;
  };
  /** Agent offer authority. Absent, every offer is declined. */
  agentHome?: AgentHomeManager;
  /**
   * How many `memory-reader` Attempts may run concurrently in ONE canonical
   * Agent home — see `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`'s
   * own doc comment (`create-daemon.ts`) for the validated contract. Unset
   * defaults to {@link DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME}.
   * The writer limit is fixed at one.
   */
  maxConcurrentReaderAttemptsPerAgentHome?: number;
  /**
   * Device-wide task cap — see `DaemonConfig.maxConcurrentTasks`. Unset
   * defaults to {@link DEFAULT_MAX_CONCURRENT_TASKS}.
   */
  maxConcurrentTasks?: number;
  /** Wall-clock limit for an offer without `limits.maxDurationMs` — see `DaemonConfig.defaultMaxDurationMs`. */
  defaultMaxDurationMs?: number;
  /** Exact host-selected policy accepted by a `task.offer` that carries `egressPolicy`. */
  agentEgressPolicy?: Readonly<AgentEgressPolicy>;
  /** Latest-value activity lane and reliable spool for Agent egress offers. */
  agentEgress?: AgentEgressController;
  /** Durable exact-match Agent session handoff authority. */
  agentSessionHandoffs?: AgentSessionHandoffStore;
  deviceId: string;
  send: (envelope: Envelope) => void;
  awaitTerminalCommit?: (taskId: string) => Promise<void>;
  /** Fsync the execution commitment before claim/runtime side effects. */
  beforeClaim?: (taskId: string, runtime: string) => Promise<void>;
  blobClient: BlobResolver;
  batcherOptions?: ProgressBatcherOptions;
  /** Local-only evidence that a semantic terminal outcome could not yet release its runtime ownership. */
  onRuntimeDisposalFailure?: (event: {
    taskId: string;
    runtimeId: string;
    stage: RuntimeDisposalStage;
    reason: string;
  }) => void;
  /**
   * Local-only diagnostic: one {@link ExecutionRecord} per started execution,
   * after `Session.close()` and the terminal commit. It never changes the
   * terminal, its retryability or any retry decision. A throwing callback is
   * logged and ignored.
   */
  onExecutionRecord?: (record: ExecutionRecord) => void;
  /**
   * Local audit signal emitted only after bounded Agent-home terminal
   * evidence retries are exhausted. The wire terminal still proceeds so a
   * cloud task cannot remain Claimed/Running forever behind auxiliary local
   * storage failure.
   */
  onAgentTerminalEvidenceFailure?: (event: {
    taskId: string;
    agentRef: AgentRef;
    runtimeId: string;
    cwd: string;
    cause: AgentTerminalCause;
    reason?: string;
    attempts: number;
    error: string;
  }) => void;
  /**
   * M4 Phase 3: this daemon's control-socket identity + the shared registry
   * backing the control socket's own `approvals.list`/`approvals.resolve`
   * methods (`create-daemon.ts` constructs ONE `ApprovalRegistry` and passes
   * the SAME instance here) — see `requestApproval`'s own doc comment for
   * why `TaskRunner` needs a handle on all three. `storeDir`/`productId` are
   * copied verbatim into every prepared operation's approval channel.
   */
  approvalRegistry: ApprovalRegistry;
  storeDir: string;
  scratchRoot: ScratchRoot;
  productId: string;
  /** Authenticated enrollment tenant projection; required by Agent message durability/recovery. */
  tenantId?: string;
  /**
   * The already-resolved, process-immutable U4a Local Agent release identity.
   * `TaskRunner` only consumes this value; it never creates, normalizes, or
   * revalidates a second version authority. It remains optional for direct
   * internal harnesses and old embedders: absence omits terminal usage rather
   * than fabricating a client version.
   */
  localAgentRelease?: Readonly<LocalAgentReleaseIdentity>;
  /** Default `requestApproval` timeout — see {@link DEFAULT_APPROVAL_TIMEOUT_MS}. */
  approvalTimeoutMs?: number;
  /**
   * Called by `handleApprove`/`handleReject` when a decision names an
   * approval that is not the one pending for its task (late, repeated or
   * mistargeted) — an audit-only signal, never gating any task-state
   * decision. `create-daemon.ts` wires this to
   * `DaemonObserver.noteStaleApprovalDecision`, the same way every other
   * locally-observable daemon event reaches the audit log/`tasks --follow`.
   * Optional so a caller that doesn't care about this audit trail (e.g. a
   * minimal test harness) isn't forced to supply one.
   */
  onStaleApprovalDecision?: (taskId: string, decision: ApprovalDecision, reason?: string) => void;
  /**
   * Finding F4 (cross-model adversarial review): operators had no way to
   * ever learn a pending approval's `approvalId` short of reading raw
   * audit-log JSON — `approve`/`reject` require one, but nothing surfaced
   * it. Called synchronously from `dispatchApproval`, BEFORE `deps.send`'s
   * own `task.await_approval` — `create-daemon.ts` wires this to
   * `DaemonObserver.noteApprovalDispatched`, which stashes `approvalId`
   * keyed by `taskId` so the observer's `task.await_approval` handling
   * (triggered by that very `deps.send` call, synchronously, right after
   * this) can attach it to the `awaiting-approval` `DaemonEvent` it emits
   * (see `observer.ts`'s own doc comment). Optional so a minimal test
   * harness that doesn't care about this audit-trail detail isn't forced
   * to supply one — mirrors `onStaleApprovalDecision`'s own contract.
   */
  onApprovalDispatched?: (taskId: string, approvalId: string) => void;
  /** `DaemonConfig.toolAuthorization`; absent means every task runs in `all`. */
  toolAuthorization?: ToolAuthorizationResolver;
  /** One high-risk tool call observed in an `all` task; local observability only. */
  onToolReminder?: (reminder: ToolReminder) => void;
  /** Overrides the bounded soft-interrupt window before authoritative `Session.close()` disposal begins. */
  shutdownInterruptTimeoutMs?: number;
  startupTimeoutMs?: number;
  /**
   * M5 batch-3 (workstream 2): overrides {@link DEFAULT_MAX_TASK_OUTPUT_BYTES}
   * — see that constant's own doc comment and `DaemonConfig.maxTaskOutputBytes`
   * (`create-daemon.ts`) for the full contract. Validated (rejecting
   * zero/negative) at the `DaemonConfig` layer, not here — this seam trusts
   * its caller, same as every other optional numeric override on this
   * interface (`shutdownInterruptTimeoutMs`, `approvalTimeoutMs`).
   */
  maxTaskOutputBytes?: number;
  artifactLimits?: { maxFileBytes: number; maxTaskBytes: number };
  /**
   * Per-event inline ceiling for `tool_use.input` / `tool_result.output` —
   * see `DaemonConfig.maxInlineEventBytes` (`create-daemon.ts`) for the full
   * contract and {@link DEFAULT_MAX_INLINE_EVENT_BYTES} for the default.
   * Validated (positive safe integer, at least
   * `MIN_MAX_INLINE_EVENT_BYTES`) at the `DaemonConfig` layer, not here —
   * this seam trusts its caller, same as `maxTaskOutputBytes` above.
   */
  maxInlineEventBytes?: number;
  /**
   * The capabilities advertised by the server on the latest successful
   * long-poll events response — read fresh at call time (mirrors
   * `getCursor`/`getToken`'s own
   * "read fresh, not captured once" convention elsewhere in this codebase),
   * since the capability is learned asynchronously, after this `TaskRunner`
   * is already constructed (`create-daemon.ts`'s `start()` builds `deps`
   * before `connection` exists). `create-daemon.ts` wires this to
   * `ConnectionManager.getServerCapabilities`. Optional, and treated as "no
   * capabilities" when absent, so a minimal test harness that doesn't care
   * about these gates isn't forced to supply one.
   */
  getServerCapabilities?: () => readonly string[];
  /**
   * The flags this daemon's current `conn.hello` advertises. Every `task.offer`
   * is checked against them before it is opened or run: an offer that needs a
   * flag missing here is declined non-retryably, whatever the sender admitted
   * (`requiredReceiverCapabilities`). Read fresh at offer time, because a
   * presence change or a capability declaration edits the advertisement.
   */
  advertisedCapabilities: () => readonly string[];
  /**
   * #654: opens sealed task input and seals sealed task output. Absent on a
   * daemon that holds no scope key, which declines every sealed offer.
   */
  sealedTasks?: SealedTasks;
  /**
   * The server-advertised activity ingress (protocol v3), read fresh at each
   * progress push. `create-daemon.ts` wires it to
   * `ConnectionManager.getIngressBudget`. There is no default: a task only
   * runs after an accepted handshake, which always carries one.
   */
  getIngressBudget: () => Readonly<ActivityIngress>;
  /**
   * Contract §8.1 / §8.3: is the task lane's capability gate in place right
   * now — this daemon can sign, AND it has read a deployment declaration naming
   * `host-mcp-task-context`?
   *
   * Read fresh at offer time for the same reason `getServerCapabilities` is:
   * `create-daemon.ts` builds these deps before the declaration has been read.
   *
   * ABSENT MEANS UNAVAILABLE, not "assume yes". A runner with no way to ask
   * whether the gate is open has not been told that it is, and §8.1 gives this
   * lane zero fallback — so it injects no nonce, an MCP child gets no
   * `BYOK_HOST_TOOLSET_CONTEXT`, and a standalone run fails explicitly
   * (§8.2(1)) instead of quietly reaching for some other identity.
   */
  hostTaskContextAvailable?: () => boolean;
  /** Wait for the current deployment declaration before freezing host toolset env. */
  prepareHostTaskContext?: (taskId: string, signal: AbortSignal) => Promise<void>;
  /**
   * S3b (L-002): a pre-claim veto on new offers, consulted once per offer
   * immediately after the redelivery-dedup check and ahead of every other
   * admission check in `handleOffer`.
   *
   * It exists for local storage pressure (architecture §12.7.2.1's hard
   * watermark: "停止接收新的普通 task；仍允许 terminal/truth flush、删除、导出、
   * doctor 与恢复操作"). Placing it here rather than deeper in `handleOffer`
   * is what makes that split real: an offer never reaches adapter selection,
   * workspace creation, or `task.claim`, so declining costs nothing on disk —
   * while every path that FINISHES existing work runs through code this seam
   * is not on, and keeps working.
   *
   * Synchronous, matching every other single-purpose callback on this
   * interface. A decline is `retryable` by the guard's own decision — pressure
   * is a property of THIS device at THIS moment, so a dispatcher re-routing
   * the task elsewhere genuinely helps; a guard declining for a reason that
   * will not change says so.
   *
   * Optional and absent by default: with no guard supplied, `handleOffer`
   * behaves exactly as it did before this seam existed.
   */
  admissionGuard?: (offer: { readonly taskId: string; readonly payload: AcceptedOfferPayload }) => AdmissionGuardDecision;
  /** Durable normal-turn result failure intent, before handing off a required reply. */
  recordResultReplyFailure?(taskId: string, failure: ResultReplyFailure): Promise<void>;
  recordAgentMessageAccepted?(taskId: string): Promise<void>;
  durablePi?: boolean;
  recordDurableTransition?(taskId: string, leaseId: string, kind: string, ordinal: number): Promise<void>;
  /** SDK-owned, task-scoped MCP helper. Required only for offers declaring messageEgress. */
  agentMessageMcpBin?: Readonly<ResolvedAgentMessageMcpBin>;
  /** SDK-owned, task-scoped `submit_result` helper. Required only for result-document offers. */
  agentResultMcpBin?: Readonly<ResolvedAgentMessageMcpBin>;
  /** Pre-runtime handshake gate for the exact result helper config; same contract as `agentMessageMcpPreflight`. */
  agentResultMcpPreflight?: (
    server: Readonly<McpStdioServerConfig>,
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;
  /**
   * Production pre-runtime executability/handshake gate for the exact message
   * helper config. `env` is the same child environment the runtime
   * gets (`buildRuntimeEnv`), so the helper is proved under the environment
   * it will actually run in.
   */
  agentMessageMcpPreflight?: (
    server: Readonly<McpStdioServerConfig>,
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;
  /**
   * Override the `initialize` + `tools/list` observation of a projected
   * toolset MCP server. Defaults to the real handshake
   * (`mcp-tools-probe.ts`); tests substitute a stub. It is deliberately NOT
   * optional-with-no-default the way `agentMessageMcpPreflight` is: an adapter
   * may only bind tools that were observed, so a runner with no observation at
   * all would silently project toolsets the model can list and never call.
   */
  mcpToolsetToolsProbe?: (
    serverName: string,
    server: Readonly<McpStdioServerConfig>,
    options: McpToolsProbeOptions,
  ) => Promise<McpServerObservation>;
  /** SDK-owned MCP helper injected only into strict Agent tasks. */
  agentMemoryMcpBin?: Readonly<ResolvedAgentMemoryMcpBin>;
  /**
   * `DaemonConfig.agentMemoryMcp`. `off` also drops the Agent memory guidance
   * from the instruction, so the model gets no request to change `MEMORY.md`
   * or `notes/`. Absent is `auto`.
   */
  agentMemoryMcp?: 'auto' | 'off';
  /** SDK-owned task-free Agent-memory descriptor helper a preparation observes. */
  agentMemoryDescribeBin?: Readonly<ResolvedAgentMemoryMcpBin>;
  /** Resolve the verified SDK helper only when memory needs filesystem authority. */
  resolveAgentMemoryFilesystemHelperBin?: () => string;
  agentMemoryHelperAssetRoot?: string;
  /** Optional local-to-hosted redacted projection port. Omission is zero-network. */
  agentMemoryHostedProjection?: AgentMemoryHostedProjection;
}

/** See {@link TaskRunnerDeps.admissionGuard}. */
export type AdmissionGuardDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string; readonly retryable: boolean };

















type AcceptedOfferPayload = TaskOfferPlainPayload;

















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



/**
 * What the daemon's `task_assertion.issue` handler learns about one token.
 *
 * Three outcomes, not a nullable entry: the handler must answer
 * `context_revoked` and `context_token_invalid` differently, and neither may
 * ever be reachable by a caller reading fields off an entry it should not see.
 * Only the `active` case carries claims, and it carries exactly the three the
 * envelope binds.
 */
export type HostToolsetContextLookup =
  | { readonly status: 'active'; readonly taskId: string; readonly agentRef: AgentRef; readonly toolsetId: string }
  | { readonly status: 'revoked' }
  | { readonly status: 'unknown' };




/**
 * Per-connection task orchestration: offer -> (decline | prepare -> seal ->
 * claim -> prepared operation -> started) -> seq-ordered progress batches -> complete/fail/
 * cancelled, plus approve/reject/cancel/steer handling.
 *
 * M1 rework (docs/protocol.md §3, §5, §10 — `packages/protocol` is frozen,
 * not editable here): pre-claim rejections (unknown/disallowed runtime)
 * now send `task.decline` and never
 * claim at all — `TASK_TRANSITIONS.Offered` gained a direct `-> Failed` edge
 * precisely so this no longer has to claim-then-fail. A successful claim is
 * followed by `task.started` only once the adapter session has actually
 * started (`task.claim` alone no longer implies `Running`). Cancellation
 * reports the explicit `task.cancelled` message instead of the old
 * `task.fail({reason:'cancelled'})` convention.
 */
export class TaskRunner {
  private readonly tasks = new Map<string, ActiveTask>();
  private readonly pendingMessageTasks = new Map<string, PendingMessageTask>();
  private readonly messageOutboxesByHome = new Map<string, Promise<AgentMessageOutbox>>();
  private readonly messageContextByToken = new Map<string, string>();
  private readonly messageContextByTask = new Map<string, string>();
  /** Per-task `submit_result` authority, minted at injection and revoked at `turn_end` or teardown. */
  private readonly resultContextByToken = new Map<string, AgentResultContext>();
  private readonly resultContextByTask = new Map<string, AgentResultContext>();
  private readonly resultStoresByHome = new Map<string, Promise<AgentResultStore>>();
  private readonly memoryContextByToken = new Map<string, { readonly taskId: string; readonly agentRef: AgentRef; readonly mode: 'read' | 'read-write' }>();
  private readonly memoryContextByTask = new Map<string, string>();
  private readonly memoryInFlightByTask = new Map<string, Set<Promise<unknown>>>();
  private readonly memoryClosingTasks = new Set<string>();
  private readonly memoryFilesystemByTask = new Map<string, Promise<AgentMemoryFilesystem>>();
  /**
   * Contract §8.1: the `BYOK_HOST_TOOLSET_CONTEXT` nonce registry — one entry
   * per `(task, host toolset server)`, keyed by the opaque nonce the daemon
   * injected into that ONE child's environment and nowhere else.
   *
   * This map is the whole reason the task lane has authority at all. A device
   * assertion deliberately carries no caller identity (see
   * `device-assertion.ts`): under one UID every process can reach the control
   * socket, so a "who asked" field would be synthesized. The nonce is different
   * in kind — it is evidence, because the only way to hold one is to be the
   * process the daemon spawned for this exact task and server. Every claim the
   * task signer writes is read out of the entry here, never out of RPC params.
   *
   * Entries are RETAINED after revocation (`state: 'revoked'`) until the task's
   * resources are cleaned up, so the refusal can be the precise
   * `context_revoked` rather than collapsing into `context_token_invalid` the
   * instant a task is cancelled. After cleanup the entry is deleted and the two
   * refusals become indistinguishable on purpose — "this token is gone" must
   * not be a probe for which tasks this device has run.
   */
  private readonly hostToolsetContextByToken = new Map<string, HostToolsetContextEntry>();
  /** Per-task index over {@link hostToolsetContextByToken}, so one cancel revokes every server's nonce at once. */
  private readonly hostToolsetContextTokensByTask = new Map<string, Set<string>>();
  private readonly recoveredMessageOutboxes = new Map<string, AgentMessageOutbox>();
  private readonly cancelledRecoveredMessages = new Set<string>();
  private readonly recoveredMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Retries resend one envelope id per record (#693); the cloud replays the disposition per arrival. */
  private readonly agentMessageEnvelopes = new WeakMap<AgentMessageOutboxRecord, Envelope>();
  /**
   * Finding F4 (cancel lost during the offer-processing window): a
   * `task.cancel` for a taskId that hasn't finished `handleOffer` yet (still
   * awaiting adapter detection / instruction resolution / workspace setup /
   * prepared operation `start()`) has no `this.tasks` entry to land on — it used to be
   * silently dropped, and the runtime session `handleOffer` was about to
   * register would then run an unsupervised ("zombie") turn nobody asked
   * for anymore. Recording the taskId here lets `handleOffer` consult it at
   * the two points where it can still safely react (see its body): before
   * claiming at all (decline instead of ever starting a session), and right
   * after the prepared operation resolves but before this task is registered as
   * active (tear the just-started session down immediately, before its
   * event loop ever pumps a single event). Consumed (deleted) at whichever
   * checkpoint handles it; a cancel for a taskId that's already active,
   * already finished, or never offered at all leaves a harmless entry that
   * nothing will ever consult.
   *
   * M3-B: that last sentence is exactly the unbounded-growth vector this
   * needed closed for long-lived operation — a cancel for a taskId nobody
   * ever claims (unknown, already active, or already finished) leaves a
   * permanent entry with nothing left to consume it. Bounded to
   * `MAX_TRACKED_TASK_IDS` via `setPendingCancelled` below, oldest evicted
   * first: safe because every entry this field's correctness actually
   * depends on is consumed (deleted) by one of `handleOffer`'s two
   * checkpoints within that SAME task's own offer-processing window — one
   * in-flight task's startup latency, nowhere near enough churn for eviction
   * to remove an entry still inside its consuming window before it's read.
   */
  private readonly pendingCancelled = new Map<string, string | undefined>();
  /**
   * Finding #5 (Codex counterexample): taskIds currently INSIDE `handleOffer`
   * — from the moment it decides an offer is worth processing until it
   * reaches one of its own resolution points (decline, fail, the
   * checkpoint-2 cancel-teardown, or successful registration into
   * `this.tasks`). Bounded eviction on `pendingCancelled` (below) must never
   * remove an entry for a taskId in this set: doing so is exactly the bug —
   * block task A in prepared-operation `start()`, deliver A's own `task.cancel` (so
   * `pendingCancelled` gets an entry for A while A is still in-flight),
   * then deliver `MAX_TRACKED_TASK_IDS` more cancels for unrelated taskIds
   * nobody ever offered — under naive oldest-wins eviction, A's entry (the
   * single oldest) gets evicted purely because of unrelated churn, so when
   * the prepared operation finally resolves, checkpoint 2 finds no cancel marker
   * and the already-cancelled task starts a real session. See
   * `evictPendingCancelled` below for the fix, and
   * `task-runner-bounded-collections.test.ts` for a test mirroring this
   * exact scenario. Membership here is naturally tiny (bounded by this
   * device's real concurrent-offer-processing count, nowhere near
   * `MAX_TRACKED_TASK_IDS`), so scanning past it to find an evictable entry
   * costs nothing.
   */
  /**
   * `taskId` -> the preparation record this Execution pinned.
   *
   * The pin is a durable single-consumer claim on already-counted tokens, so it
   * is held for exactly as long as the Execution that took it can still be
   * running — and released at ONE moment, the Execution's terminal. Not at
   * claim, not at start, not when the session closes: GC must not collect a
   * record whose bytes a live process may still be sending.
   */
  private readonly preparationPinsByTask = new Map<string, string>();
  private readonly inFlightOffers = new Set<string>();
  /** Sealed offers being opened, so a redelivery during the open is not opened twice. */
  private readonly sealedOpening = new Set<string>();
  private readonly claimedHarnesses = new Map<string, string>();
  private readonly homeReservations = new Map<string, number>();
  /** Offers admitted past the device-wide task cap that are not yet active; cleared when `handleOffer` returns. */
  private readonly deviceTaskReservations = new Set<string>();
  private readonly startupOwnership: StartupOwnership;
  /** Blob I/O before an offer becomes an active task still belongs to that offer's cancellation authority. */
  private readonly inFlightBlobAborts = new Map<string, AbortController>();
  /**
   * Finding P2 (Fix 2c): taskIds that have reached a terminal outcome
   * (Complete/Failed/Cancelled) this session — populated in `finish()`.
   * While `ConnectionManager`'s stalled-cursor long-poll re-pull is frozen
   * behind an unrelated failing seq, it can legitimately redeliver an
   * ALREADY-succeeded `task.offer` — the client's own cursor hasn't advanced
   * past it yet (docs/protocol.md §9's "cursor advance timing" rule
   * explicitly relies on redelivered handlers being idempotent for exactly
   * this reason). `handleOffer` must treat a redelivered offer for a taskId
   * that's already active (`this.tasks`) or already finished (this set) as
   * a no-op — never a second prepared-operation `start()` call, which would orphan the
   * first session.
   *
   * M3-B: unbounded otherwise — a long-lived daemon that's finished many
   * thousands of tasks over its uptime would keep every single taskId
   * forever. Bounded to `MAX_TRACKED_TASK_IDS` via `addFinishedTaskId`
   * below, oldest evicted first. Safe for the redelivery-idempotency
   * invariant above because the stalled-cursor scenario above redelivers
   * this device's own recent backlog for one connection, not an arbitrary
   * point in this daemon's whole history — this device would have to claim
   * and finish `MAX_TRACKED_TASK_IDS` more tasks before a genuinely-still-
   * pending redelivery for an older taskId even arrives, let alone gets
   * processed, for eviction to ever remove an entry that redelivery still
   * needed.
   *
   * Finding #5 (honesty follow-up): unlike `pendingCancelled`, plain
   * oldest-first eviction IS correct here — every entry in this set is
   * already fully resolved (finish() only adds a taskId after it reached a
   * terminal outcome), so there is no "in-flight" entry an eviction could
   * corrupt out from under a running `handleOffer()`. The assumption above
   * is a HEURISTIC bound, not a proof: it holds as long as no single
   * connection's genuinely-still-pending redelivery backlog ever exceeds
   * `MAX_TRACKED_TASK_IDS` finished tasks, which is a real (if distant)
   * possibility for an extremely long-stalled connection, not a
   * mathematical impossibility. Should it ever be violated, the failure
   * mode is strictly milder than `pendingCancelled`'s own pre-fix bug: a
   * redelivered `task.offer` for an evicted, already-finished taskId would
   * re-run `handleOffer` from scratch — at worst a duplicate
   * claim/start/complete for a task that already succeeded once — never a
   * task that should be dead starting a brand-new session against explicit
   * cancellation intent.
   */
  private readonly finishedTaskIds = new Set<string>();
  /**
   * Bounded local receive dedup for strict legacy declines. A decline is not a
   * task terminal receipt, so it must never enter `finishedTaskIds`; retaining
   * it separately keeps replay idempotent without claiming or finishing work.
   */
  private readonly strictDeclinedTaskIds = new Set<string>();
  /**
   * M4 Phase 2 (daemon control socket `shutdown` RPC): set once by
   * {@link stopAcceptingOffers}, checked at the very top of `handleOffer` —
   * see that method's own doc comment for why offers must stop being
   * claimed BEFORE currently-active tasks are reported failed in
   * {@link shutdownActiveTasks}, not after. Irreversible for this
   * `TaskRunner` instance; a fresh one is constructed on the daemon's next
   * `start()`.
   */
  private stoppingOffers = false;

  constructor(private readonly deps: TaskRunnerDeps) {
    this.startupOwnership = new StartupOwnership({
      isOfferInFlight: taskId => this.inFlightOffers.has(taskId),
      allowRetry: () => !this.stoppingOffers,
      awaitTerminalCommit: taskId => this.deps.awaitTerminalCommit?.(taskId),
      onDisposed: taskId => {
        this.pendingMessageTasks.delete(taskId);
        this.revokeAgentMessageContext(taskId);
        this.revokeAgentResultContext(taskId);
        this.revokeAgentMemoryContext(taskId);
        this.deleteHostToolsetContexts(taskId);
      },
      onDisposalFailure: (taskId, runtimeId, failure) => this.deps.onRuntimeDisposalFailure?.({
        taskId, runtimeId, stage: failure.stage, reason: failure.message,
      }),
    });
  }

  get activeTaskCount(): number {
    return this.tasks.size + this.startupOwnership.count;
  }

  /** M5 batch-3 (workstream 2): effective `maxTaskOutputBytes` cap for this daemon — see {@link DEFAULT_MAX_TASK_OUTPUT_BYTES}'s own doc comment. */
  private get maxTaskOutputBytes(): number {
    return this.deps.maxTaskOutputBytes ?? DEFAULT_MAX_TASK_OUTPUT_BYTES;
  }

  private get ingressBudget(): Readonly<ActivityIngress> {
    return this.deps.getIngressBudget();
  }

  /** Effective per-event inline ceiling for this daemon — see `DaemonConfig.maxInlineEventBytes`. */
  private get maxInlineEventBytes(): number {
    return Math.min(this.deps.maxInlineEventBytes ?? DEFAULT_MAX_INLINE_EVENT_BYTES, this.ingressBudget.activityMaxBytes - 2);
  }

  /** Effective per-canonical-Agent-home reader cap — see {@link DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME}. */
  private get maxConcurrentReaderAttemptsPerAgentHome(): number {
    return this.deps.maxConcurrentReaderAttemptsPerAgentHome
      ?? DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME;
  }

  /** Effective device-wide task cap — see {@link DEFAULT_MAX_CONCURRENT_TASKS}. */
  private get maxConcurrentTasks(): number {
    return this.deps.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  }

  /**
   * M4 Phase 4 (part B.3, observability): per-active-task queue watermarks
   * for the control socket's `status` result — see
   * `control-protocol.ts`'s `TaskQueueWatermark` doc comment for why this
   * reflects the daemon's own progress-batcher backlog and in-flight
   * approval count, not the adapter's own event-queue depth.
   */
  getQueueWatermarks(): TaskQueueWatermark[] {
    return [...this.tasks.values()].map((active) => ({
      taskId: active.taskId,
      progressBatcherPending: active.batcher.pendingCount,
      pendingApprovals: (active.pendingApproval !== undefined ? 1 : 0) + active.approvalQueue.length,
    }));
  }

  /** Authenticated control-socket entry used only by the SDK-owned task MCP helper. */
  publishAgentMessage(input: {
    readonly contextToken: string;
    readonly contentType: AgentMessageContentType;
    readonly body: string;
  }): Promise<{ messageId: string; state: 'staged' | 'pending' }> {
    return publishAgentMessage.call(this, input);
  }

  /**
   * Authenticated control-socket entry used only by the SDK result helper:
   * the one tool it advertises, whose `inputSchema` is the offer's frozen
   * result schema. Valid from injection (the helper preflight lists tools
   * before the runtime starts) until `turn_end` or teardown revokes it.
   */
  describeAgentResult(input: AgentResultDescribeParams): AgentResultDescribeResult {
    return describeAgentResult.call(this, input);
  }

  /**
   * Authenticated control-socket entry used only by the SDK result helper.
   * Validates the raw outcome against the frozen schema, then stages the
   * canonical snapshot durably before answering. `staged` is the only ack;
   * delivery happens at `turn_end`. A rejected outcome stores nothing.
   */
  submitAgentResult(input: AgentResultSubmitParams): Promise<AgentResultSubmitResult> {
    return submitAgentResult.call(this, input);
  }

  /** Authenticated control-socket entry used only by the SDK-owned memory MCP helper. */
  async recallAgentMemory(input: { readonly contextToken: string; readonly path: string; readonly ifRevision?: string }): Promise<{ path: string; revision: string; content: string; auditWarning?: AgentMemoryAuditWarning }> {
    return this.runMemoryOperation(input.contextToken, 'read', (context) => new AgentMemoryService(context).recall(input));
  }

  /** Authenticated control-socket entry used only by the SDK-owned memory MCP helper. */
  async saveAgentMemory(input: { readonly contextToken: string; readonly op: 'replace' | 'delete'; readonly path: string; readonly expectedRevision: string; readonly content?: string }): Promise<{ path: string; revision?: string; deleted: boolean }> {
    return this.runMemoryOperation(input.contextToken, 'write', (context) => new AgentMemoryService(context).save(input));
  }

  /** Restore activated, unaccepted message drafts before transport admission on daemon restart. */
  recoverAgentMessageOutboxes(agentsRoot: string, resultFailureTasks?: ReadonlyMap<string, { agentRef: AgentRef; contract: string }>, isCancelled?: (taskId: string) => Promise<boolean>): Promise<void> {
    return recoverAgentMessageOutboxes.call(this, agentsRoot, resultFailureTasks, isCancelled);
  }

  private agentMessageOutbox(homeDir: string): Promise<AgentMessageOutbox> {
    return agentMessageOutbox.call(this, homeDir);
  }

  /** A recovery terminal must not close first-message admission before this durable draft has a disposition. */
  hasPendingRecoveredAgentMessage(taskId: string): boolean {
    if (this.cancelledRecoveredMessages.has(taskId)) return false;
    return this.recoveredMessageOutboxes.get(taskId)?.retryableRecords()
      .some((record) => record.taskId === taskId && record.sessionRef !== undefined) === true;
  }

  cancelRecoveredAgentMessage(taskId: string, persist: () => Promise<void>): Promise<void> {
    return cancelRecoveredAgentMessage.call(this, taskId, persist);
  }

  recoveredAgentMessageState(taskId: string): 'pending' | 'held' | 'refused' | 'missing' {
    return this.recoveredMessageOutboxes.get(taskId)?.recoveryState(taskId) ?? 'missing';
  }

  /** Retry stable recovered records after a transport handshake/re-handshake. */
  retryRecoveredAgentMessages(): void {
    for (const [taskId, outbox] of this.recoveredMessageOutboxes) {
      const record = outbox.get(taskId);
      if (record?.sessionRef !== undefined && this.hasPendingRecoveredAgentMessage(taskId)) this.sendAgentMessageRecord(outbox, record);
    }
  }

  private canPublishAgentMessage(active: ActiveTask): boolean {
    return this.tasks.get(active.taskId) === active && !active.beingTornDown;
  }

  /** All authors and startup use the same queue-time and post-I/O authority check. */
  private activateAgentMessage(
    outbox: AgentMessageOutbox, taskId: string, sessionRef: string, isCurrent: () => boolean,
    wasSendAttempted?: () => boolean,
  ): Promise<AgentMessageOutboxRecord | undefined> {
    return activateAgentMessage.call(this, outbox, taskId, sessionRef, isCurrent, wasSendAttempted);
  }

  private sendAgentMessageRecord(outbox: AgentMessageOutbox, record: AgentMessageOutboxRecord): void {
    return sendAgentMessageRecord.call(this, outbox, record);
  }

  private handleAgentMessageDisposition(taskId: string, disposition: AgentMessageDispositionPayload): Promise<void> {
    return handleAgentMessageDisposition.call(this, taskId, disposition);
  }

  /** M4 Phase 2: stop claiming any FUTURE `task.offer` — see `stoppingOffers`'s own doc comment. Idempotent. */
  stopAcceptingOffers(): void {
    return stopAcceptingOffers.call(this);
  }

  /**
   * Shutdown of every currently ACTIVE task for the control socket's
   * `shutdown` RPC. Soft interrupt remains bounded, but each task's
   * authoritative close receipt must settle successfully. Reports `task.fail` rather than
   * `task.cancelled` — these tasks aren't ending because the SERVER
   * cancelled them, they're ending because this device is shutting down.
   * `retryable: true` throughout: nothing about the task/policy itself was
   * ever at fault, only this device's own availability right now.
   *
   * Snapshots `this.tasks` into a plain array up front rather than iterating
   * the live `Map` — `finish()` (called per task below) deletes from that
   * same map as each shutdown settles, and a snapshot avoids relying on
   * "mutate while iterating" semantics being followed correctly here.
   *
   * Must be called AFTER {@link stopAcceptingOffers} and BEFORE the
   * connection is closed: the caller (`create-daemon.ts`'s
   * `performControlShutdown`) awaits this method to fully settle — every
   * `task.fail` actually enqueued via `deps.send` — before it ever calls
   * `stop()` (which closes the connection). Stopping offers first (rather
   * than closing the connection first) is what prevents a new
   * `task.offer` from being claimed in the window while these are being
   * torn down.
   *
   * This ordering invariant is NOT just about `performControlShutdown`'s
   * own internal statement order — it also depends on nothing ELSE
   * closing the connection first. A real regression (gatekeeper-caught,
   * fixed in `create-daemon.ts`/`bin/commands/start.ts`) had exactly that
   * happen: `start.ts` used to wake up on the EARLIER `shutdown-requested`
   * event (fired synchronously, before this method even calls
   * `session.interrupt()`) and call `daemon.stop()` itself, racing ahead
   * and closing the connection before this method's `task.fail` send ever
   * reached the outbox drain. `start.ts` now waits for the LATER
   * `shutdown-complete` event (emitted only after `performControlShutdown`'s
   * own `stop()` call has already resolved), so it can no longer race
   * ahead of this method — see `daemon-control-socket.test.ts`'s dedicated
   * regression test for the exact scenario.
   *
   * `interruptTimeoutMs` caps each soft interrupt below the configured
   * bound: a halted run passes its shutdown grace, so its tasks reach close
   * and their `task.fail` is journaled within that grace (#1119).
   */
  async shutdownActiveTasks(reason: string, interruptTimeoutMs?: number): Promise<void> {
    const offers = offerSettlements.get(this);
    if (offers?.size) await Promise.all(offers);
    const active = [...this.tasks.values()];
    await Promise.all(active.map((task) => this.shutdownTask(task, reason, interruptTimeoutMs)));
    await this.startupOwnership.disposeAll();
  }

  private closeActiveSession(active: ActiveTask): Promise<void> {
    return closeActiveSession.call(this, active);
  }

  private awaitActiveSessionClose(active: ActiveTask): Promise<boolean> {
    return awaitActiveSessionClose.call(this, active);
  }

  /**
   * M5 batch-3 (workstream 2): the ONE shared per-task teardown sequence —
   * "reuse the exact interrupt/teardown machinery `shutdownActiveTasks`
   * uses, do not invent a second teardown path" applies to BOTH callers:
   * graceful daemon shutdown ({@link shutdownTask}, `retryable: true`) and
   * resource-limit enforcement ({@link failActiveTaskForResourceLimit},
   * `retryable: false`, wall-clock `maxDurationMs` / output-cap
   * `maxTaskOutputBytes`).
   *
   * Finding F5(a) (pre-existing, unchanged by this refactor):
   * `session.interrupt()` is raced against `timeoutMs`
   * ({@link DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS}, overridable via
   * `TaskRunnerDeps.shutdownInterruptTimeoutMs`) rather than awaited
   * unconditionally, so a hung `interrupt()` (a misbehaving adapter) can
   * never block `task.fail` from being sent at all.
   *
   * After the bounded soft interrupt, `finish()` always awaits the authoritative
   * `Session.close()` receipt. A failed receipt retains active/Git ownership;
   * shutdown surfaces the rejection while resource enforcement leaves local
   * evidence for a later retry.
   *
   * Re-checks task identity (`this.tasks.get(...) === active`) immediately
   * before sending `task.fail`: the interrupt race above has await
   * points during which a DIFFERENT path (a racing `task.cancel`/
   * `task.reject`, or the session completing normally on its own) may have
   * already finished this exact task and sent its own terminal message.
   * Sending a SECOND terminal message for an already-finished task would be
   * a genuine protocol bug, not a benign race — mirrors `pump()`'s own
   * identity-check guard for the same class of race.
   */
  private interruptBounded(active: ActiveTask, drainEvents?: boolean, interruptTimeoutMs?: number): Promise<void> {
    return interruptBounded.call(this, active, drainEvents, interruptTimeoutMs);
  }

  private teardownActiveTask(
    active: ActiveTask, reason: string, retryable: boolean, drainEvents?: boolean, interruptTimeoutMs?: number,
  ): Promise<boolean> {
    return teardownActiveTask.call(this, active, reason, retryable, drainEvents, interruptTimeoutMs);
  }

  /** Graceful-shutdown caller of {@link teardownActiveTask} — see `shutdownActiveTasks`'s own doc comment. `retryable: true`: nothing about the task/policy itself was ever at fault, only this device's own availability right now. */
  private shutdownTask(active: ActiveTask, reason: string, interruptTimeoutMs?: number): Promise<void> {
    return shutdownTask.call(this, active, reason, interruptTimeoutMs);
  }

  /**
   * M5 batch-3 (workstream 2): shared entry point for both resource-limit
   * enforcers (wall-clock `maxDurationMs` — {@link armMaxDurationTimer} —
   * and output-cap `maxTaskOutputBytes` — see `pump`). Looks the task up
   * FRESH by id and no-ops if it's already gone — finished via any other
   * path (normal completion, cancel, reject, daemon shutdown, or a
   * DIFFERENT resource-limit trip already caught it first). `retryable:
   * false` unconditionally: hitting a configured resource ceiling is never a
   * transient/environmental failure a retry could fix — the same task under
   * the same limits would just hit it again.
   */
  private async failActiveTaskForResourceLimit(taskId: string, reason: string, drainEvents = true): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    await this.teardownActiveTask(active, reason, false, drainEvents);
  }

  /**
   * M5 batch-3 (workstream 2): daemon-authoritative wall-clock enforcement
   * for `payload.limits.maxDurationMs` — previously accepted and silently
   * ignored (see `handleOffer`'s own doc comment on the `limits.maxTokens`
   * gate for the historical context this superseded). Armed once, at the
   * moment this task is registered as active (`handleOffer`, still inside
   * the synchronous construct -> register -> arm -> pump handoff — arming a
   * timer is synchronous, `setTimeout` never invokes its callback in the
   * same tick, so this doesn't reopen the race that handoff's own doc
   * comment guards against). Cleared unconditionally in `finish()` so every
   * terminal outcome leaves no dangling timer and can never double-fail an
   * already-finished task — the fresh `this.tasks.get` lookup in
   * `failActiveTaskForResourceLimit`/`teardownActiveTask`'s own identity
   * re-check is the second, belt-and-suspenders layer of that same guarantee
   * for the rare case the timer's callback was already scheduled before
   * `finish()` had a chance to clear it.
   */
  private armMaxDurationTimer(active: ActiveTask, maxDurationMs: number): void {
    return armMaxDurationTimer.call(this, active, maxDurationMs);
  }

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'task.offer': {
        const admission = new OfferAdmissionTiming();
        // The receiver half of the gates: checked on the wire payload, before
        // a sealed offer is opened. #654: a sealed offer that cannot be opened
        // is declined, not dropped, so the task does not wait for a timeout.
        if (this.declineOfferMissingCapabilities(envelope, admission)) return;
        await trackOffer(this, envelope.payload.sealing === undefined
          ? this.handleOffer(envelope.task_id, envelope.payload, admission)
          : this.handleSealedOffer(envelope, admission));
        return;
      }
      case 'task.cancel':
        await this.handleCancel(envelope.task_id, envelope.payload.reason);
        return;
      case 'task.steer': {
        const taskId = envelope.task_id;
        if (envelope.payload.sealed !== undefined) {
          // #654: a sealed steer that cannot be opened is dropped.
          if (this.deps.sealedTasks === undefined) {
            console.error(
              `[byok/client] inbound sealed task.steer for task ${taskId} rejected: this daemon does not open sealed task input — acked without retry; this envelope should have been gated server-side`,
            );
            return;
          }
          if (!this.tasks.has(taskId)) return;
          await this.deps.sealedTasks.applySteer(envelope, (text) => this.handleSteer(taskId, text));
          return;
        }
        // #654 §6.2: a task that seals its input takes no plaintext steer.
        if (this.deps.sealedTasks?.sealsInput(taskId)) {
          console.error(`[byok/client] plaintext task.steer for task ${taskId} dropped: the task seals its input`);
          return;
        }
        await this.handleSteer(taskId, envelope.payload.text);
        return;
      }
      case 'task.approve':
        await this.handleApprove(envelope.task_id, envelope.payload.approvalId);
        return;
      case 'task.reject':
        await this.handleReject(envelope.task_id, envelope.payload.reason, envelope.payload.approvalId);
        return;
      case 'agent.message.disposition':
        await this.handleAgentMessageDisposition(envelope.task_id, envelope.payload);
        return;
      default:
        return; // conn.* and daemon->server-only types are handled elsewhere / not applicable
    }
  }

  private handleOffer(taskId: string, payload: AcceptedOfferPayload, admission: OfferAdmissionTiming): Promise<void> {
    return handleOffer.call(this, taskId, payload, admission);
  }

  private admitOffer(phase: OfferPhaseContext): true | undefined {
    return admitOffer.call(this, phase);
  }

  private reserveOfferHome(
    phase: OfferPhaseContext,
    agentRef: AgentRef,
    readerAttempt: boolean,
    sessionRef: string | undefined,
    homeAccess: AgentHomeAccessMode,
  ): Promise<true | undefined> {
    return reserveOfferHome.call(this, phase, agentRef, readerAttempt, sessionRef, homeAccess);
  }

  private admitOfferLimits(phase: OfferPhaseContext, payload: AcceptedOfferPayload) {
    return admitOfferLimits.call(this, phase, payload);
  }

  private prepareOfferRuntime(phase: OfferPhaseContext, input: OfferRuntimeInput) {
    return prepareOfferRuntime.call(this, phase, input);
  }

  private withAgentMessageMcp(
    existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
    taskId: string,
    requirement: Readonly<AgentMessageEgressRequirement> | undefined,
  ): Readonly<Record<string, McpStdioServerConfig>> | undefined {
    return withAgentMessageMcp.call(this, existing, taskId, requirement);
  }

  private withAgentResultMcp(
    existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
    taskId: string,
    selection: Readonly<TerminalProjectionSelection> | undefined,
  ): Readonly<Record<string, McpStdioServerConfig>> | undefined {
    return withAgentResultMcp.call(this, existing, taskId, selection);
  }

  private revokeAgentResultContext(taskId: string): void {
    const context = this.resultContextByTask.get(taskId);
    if (context !== undefined) this.resultContextByToken.delete(context.token);
    this.resultContextByTask.delete(taskId);
  }

  private agentResultStore(homeDir: string): Promise<AgentResultStore> {
    return agentResultStore.call(this, homeDir);
  }

  private revokeAgentMessageContext(taskId: string): void {
    const token = this.messageContextByTask.get(taskId);
    if (token !== undefined) this.messageContextByToken.delete(token);
    this.messageContextByTask.delete(taskId);
  }

  /** What `status().agentMemoryMcp` reports as `admitted`. */
  private agentMemoryMcpAdmitted(): boolean {
    return this.deps.agentMemoryMcpBin !== undefined
      && isAgentMemorySecureFilesystemAvailable(this.deps.resolveAgentMemoryFilesystemHelperBin !== undefined);
  }

  /**
   * Injected only after strict Agent admission; a host registry may never replace this reserved name.
   * `toolList` `granted` makes the helper list only the tools `mode` grants. The prepared lane needs
   * `complete`: its launch compares the helper's listing with the complete sealed descriptor.
   */
  private withAgentMemoryMcp(
    existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
    taskId: string,
    agentRef: AgentRef,
    mode: 'read' | 'read-write',
    bin: {command: string; args: readonly string[]},
    toolList: 'granted' | 'complete',
  ): Readonly<Record<string, McpStdioServerConfig>> {
    return withAgentMemoryMcp.call(this, existing, taskId, agentRef, mode, bin, toolList);
  }

  /** Reconstruct all sensitive context from the active sealed task, never from MCP/model arguments. */
  private activeMemoryContext(contextToken: string): AgentMemoryTaskContext {
    return activeMemoryContext.call(this, contextToken);
  }

  private runMemoryOperation<T>(contextToken: string, required: 'read'|'write', operation: (context: AgentMemoryTaskContext) => Promise<T>): Promise<T> {
    return (runMemoryOperation<T>).call(this, contextToken, required, operation);
  }

  private quiesceAndSnapshotAgentMemory(active: ActiveTask): Promise<void> {
    return quiesceAndSnapshotAgentMemory.call(this, active);
  }

  private bindAgentMemoryFilesystem(context: AgentMemoryTaskContext): Promise<AgentMemoryTaskContext> {
    return bindAgentMemoryFilesystem.call(this, context);
  }

  private async closeAgentMemoryFilesystem(taskId: string): Promise<void> {
    const filesystem = this.memoryFilesystemByTask.get(taskId);
    this.memoryFilesystemByTask.delete(taskId);
    if (filesystem === undefined) return;
    await filesystem.then((authority) => authority.close()).catch(() => {});
  }

  private revokeAgentMemoryContext(taskId: string): void {
    const token = this.memoryContextByTask.get(taskId);
    if (token !== undefined) this.memoryContextByToken.delete(token);
    this.memoryContextByTask.delete(taskId);
    this.memoryInFlightByTask.delete(taskId);
    this.memoryClosingTasks.delete(taskId);
    void this.closeAgentMemoryFilesystem(taskId);
  }

  /**
   * Contract §8.1: mint one `BYOK_HOST_TOOLSET_CONTEXT` nonce per host toolset
   * server of this task and inject it into that server's child environment.
   *
   * Only the SDK injects here. `toolset-registry.ts` still rejects an `env`
   * block on a host-configured server outright, which is what makes this
   * variable un-forgeable from configuration: the name can only ever hold a
   * value this method minted.
   *
   * No `agentRef` means no nonce, and therefore no task lane at all for this
   * task. That is not a degradation to a device-only path — it is the envelope
   * schema being honest: `byok-task-assertion-v1` REQUIRES the frozen offer's
   * AgentRef, and a non-Agent offer has none to bind. Signing something weaker
   * and calling it a task assertion is exactly the fallback §8.1 forbids.
   */
  private withHostToolsetContext(
    servers: Readonly<Record<string, McpStdioServerConfig>>,
    taskId: string,
    agentRef: AgentRef,
    toolsetIdByServer: ReadonlyMap<string, string>,
  ): Readonly<Record<string, McpStdioServerConfig>> {
    return withHostToolsetContext.call(this, servers, taskId, agentRef, toolsetIdByServer);
  }

  /**
   * Contract §8.2(1) / I12: the daemon's SECOND fail-closed layer — stop
   * signing for this task, now.
   *
   * Called synchronously, before any `await`, from every point at which this
   * device learns the task's authority is over: an accepted cancel, any
   * semantic terminal, and shutdown. Entries are kept (not deleted) so the
   * refusal stays the precise `context_revoked` until the task's resources are
   * actually cleaned up.
   *
   * The honest limit, which belongs here as much as in the contract: the
   * AUTHORITATIVE revocation point is the host's own cancel/End commit. This
   * stops the daemon minting promptly; it does not recall an assertion already
   * in a caller's hands, and the host's admission check remains the layer that
   * refuses one.
   */
  private revokeHostToolsetContexts(taskId: string): void {
    const tokens = this.hostToolsetContextTokensByTask.get(taskId);
    if (tokens === undefined) return;
    for (const token of tokens) {
      const entry = this.hostToolsetContextByToken.get(token);
      if (entry !== undefined) entry.state = 'revoked';
    }
  }

  /** Shutdown (contract §8.2(1)): no task on this device keeps a mintable context across it. */
  private revokeAllHostToolsetContexts(): void {
    for (const entry of this.hostToolsetContextByToken.values()) entry.state = 'revoked';
  }

  /** Task resource cleanup: drop the entries entirely, after which the refusal is `context_token_invalid`. */
  private deleteHostToolsetContexts(taskId: string): void {
    const tokens = this.hostToolsetContextTokensByTask.get(taskId);
    if (tokens === undefined) return;
    for (const token of tokens) this.hostToolsetContextByToken.delete(token);
    this.hostToolsetContextTokensByTask.delete(taskId);
  }

  /**
   * The daemon's only view of the nonce registry (contract §8.2(1)).
   *
   * Returns the three claims the task envelope binds, or a refusal status —
   * never the entry itself, and never the token back. The caller (the
   * `task_assertion.issue` handler) may not add to, narrow, or substitute any
   * of these values: they ARE the assertion's task/Agent/toolset identity.
   */
  hostToolsetContext(contextToken: string): HostToolsetContextLookup {
    const entry = this.hostToolsetContextByToken.get(contextToken);
    if (entry === undefined) return { status: 'unknown' };
    if (entry.state !== 'active') return { status: 'revoked' };
    return { status: 'active', taskId: entry.taskId, agentRef: entry.agentRef, toolsetId: entry.toolsetId };
  }

  /** Protocol §7: an instruction too large to inline arrives as a `blobRef` — resolve it via the blob client rather than failing closed. */
  private async resolveInstruction(instruction: RuntimeTaskInput['instruction'], signal: AbortSignal): Promise<string> {
    if (typeof instruction === 'string') return instruction;
    return this.deps.blobClient.resolveInstruction(instruction.blobRef, { signal });
  }

  /**
   * Resolve every requested logical id locally and reject missing/colliding
   * server authority before claim.
   *
   * `toolsetIdByServer` preserves the one fact the flattened `servers` map
   * loses: which frozen-offer toolset each server belongs to. Contract §8.2's
   * AR-2 fixes `toolsetId` as the wire's `toolset` field — a logical id from
   * `requiredToolsets`, which is what the Host checks a task assertion's claim
   * against. The server NAME is device-local configuration and would not match
   * anything in the frozen offer, so the mapping has to survive this step.
   */
  private resolveMcpServers(
    requiredToolsets: readonly string[],
  ):
    | {
        ok: true;
        servers: Readonly<Record<string, McpStdioServerConfig>>;
        toolsetIdByServer: ReadonlyMap<string, string>;
        mcpToolApprovals?: Readonly<Record<string, readonly string[]>>;
      }
    | { ok: false; reason: string } {
    return resolveMcpServers.call(this, requiredToolsets);
  }

  private pump(active: ActiveTask): Promise<void> {
    return pump.call(this, active);
  }

  private publishSuccessfulCompletion(active: ActiveTask, finalOutput: string, document?: unknown): Promise<void> {
    return publishSuccessfulCompletion.call(this, active, finalOutput, document);
  }

  /**
   * Protocol §7: an `artifact` `AgentEvent` only names a file the runtime
   * wrote into the task workspace (`name`/`contentType` — it carries no
   * content of its own); this reads it from disk and sends the actual
   * `task.artifact` wire message — inline (base64) under 64KB, or via blob
   * upload above that, with a sha-256 `contentHash`.
   *
   * Finding F7/N5: `name` is untrusted (it's whatever the runtime/agent
   * reported — ultimately model-influenced) and used to be `path.join`'d
   * onto `workspaceDir` with no check that the result stayed inside it, so
   * `../../<anything>` (or an absolute `name`, which `path.resolve` accepts
   * verbatim as the whole path) could read and exfiltrate an arbitrary file
   * on the host as a task artifact. A later fix (`resolveArtifactPath`)
   * closed the traversal case by realpath-checking containment, but still
   * returned a path string that was reopened by pathname afterward — a
   * check-then-use TOCTOU race letting the final component be swapped for
   * an out-of-workspace symlink between the check and the read.
   * `openArtifact` now opens the file (with `O_NOFOLLOW`) and verifies the
   * resulting file descriptor directly; this reads from that same handle,
   * never re-opening by pathname. Read/upload failures (including a
   * rejected name or a blocked symlink swap) are also not silent: they
   * surface as a loud `error` `AgentEvent` batched into `task.progress`,
   * and are logged — the task itself can still reach `task.complete`
   * normally, but the dropped artifact is now visible in the event stream
   * rather than swallowed.
   */
  private sendArtifact(active: ActiveTask, name: string, contentType: string): Promise<void> {
    return sendArtifact.call(this, active, name, contentType);
  }

  /** Loud, non-silent artifact failure (finding F7): logged, and folded into this task's own progress stream as an `error` AgentEvent rather than swallowed — the task itself can still complete normally, but the omission is now visible. */
  private reportArtifactError(active: ActiveTask, name: string, reason: string): void {
    return reportArtifactError.call(this, active, name, reason);
  }

  private handleCancel(taskId: string, reason: string | undefined): Promise<void> {
    return handleCancel.call(this, taskId, reason);
  }

  /** M3-B: bounded insert for `pendingCancelled` — see its class-level doc comment and `MAX_TRACKED_TASK_IDS`. Evicts the oldest SAFE-TO-EVICT entry once over cap — see `evictPendingCancelled` (finding #5: not simply "the oldest entry", which could be an in-flight offer's own cancel marker). */
  private setPendingCancelled(taskId: string, reason: string | undefined): void {
    this.pendingCancelled.set(taskId, reason);
    if (this.pendingCancelled.size > MAX_TRACKED_TASK_IDS) {
      this.evictPendingCancelled();
    }
  }

  /**
   * Finding #5 (Codex counterexample — see `inFlightOffers`'s class-level
   * doc comment for the exact scenario): evicts the OLDEST entry that is
   * NOT a taskId currently inside `handleOffer`'s in-flight window, rather
   * than unconditionally the single oldest entry. `Map` iterates in
   * insertion order, so this is "oldest entry that's safe to drop," which
   * only differs from "the oldest entry, period" when that oldest entry
   * happens to belong to a task still being processed — exactly the case
   * that must never be evicted, since `handleOffer`'s own checkpoint 2
   * still needs to observe it.
   *
   * `inFlightOffers` is naturally tiny (bounded by this device's real
   * concurrent-offer-processing count — normally single digits, driven by
   * how many `task.offer`s are simultaneously mid-prepared-operation start() — nowhere
   * near `MAX_TRACKED_TASK_IDS`), so this scan is cheap in practice: it
   * finds a safe entry at or near the front almost always. The only case
   * where NO entry is safe to evict is every single tracked cancel
   * belonging to a currently in-flight offer, which would require this
   * device to have `MAX_TRACKED_TASK_IDS` offers mid-processing
   * simultaneously — implausible, but handled without corrupting anything:
   * this insert is simply allowed to leave the map one entry over cap
   * rather than evict something still needed, and it shrinks back under cap
   * as those in-flight offers resolve and their entries get CONSUMED
   * (deleted by `handleOffer` itself) rather than evicted.
   */
  private evictPendingCancelled(): void {
    return evictPendingCancelled.call(this);
  }

  /**
   * S0/H-006: an inbound `task.steer` is normally impossible for a runtime
   * that cannot steer — the hub gates it at claim-time capability
   * (`steer_unsupported_runtime`) and never sends the envelope. If one
   * arrives anyway (a forged sender, a pre-gate server, a device whose
   * adapter set changed), the session throws {@link SteerUnsupportedError},
   * which is a PERMANENT property of that runtime, not a transient failure.
   *
   * Rethrowing it would hand it to `ConnectionManager.process()`
   * (`connection-manager.ts` `stalledAtSeq`), which freezes the cursor at
   * that seq and redelivers the same envelope forever — every retry
   * guaranteed to fail identically, and every later envelope for every
   * other task blocked behind it. So this is classified as a
   * non-retryable protocol/authority error: record it and return normally,
   * which acks the envelope and lets the cursor advance. Nothing is
   * swallowed — the steer simply has no reachable success state, and the
   * honest terminal action is to log it and move on.
   *
   * Every OTHER error stays transient and is rethrown untouched, preserving
   * the existing stall/redelivery semantics exactly.
   */
  private handleSteer(taskId: string, text: string): Promise<void> {
    return handleSteer.call(this, taskId, text);
  }

  /**
   * The one approval entry point: `RuntimeOperationStartInput.approvalChannel`
   * is this method bound to its task, and the control socket's
   * `approvals.request` calls it for custom adapters.
   *
   * Sends `task.await_approval` (protocol §5), registers a fresh entry in
   * `deps.approvalRegistry`, and races it against `deps.approvalTimeoutMs`
   * (default {@link DEFAULT_APPROVAL_TIMEOUT_MS}) — an unanswered request
   * force-resolves as a fail-closed rejection once the deadline passes. The
   * timeout and every decision (a wire `task.approve`/`task.reject` or a
   * local `Daemon.approve`/`reject` via `handleApprove`/`handleReject`, the
   * CLI's `approvals.resolve`, `finish()`'s cleanup, registry eviction)
   * converge on `ApprovalRegistry.resolve()`: the first resolution wins.
   *
   * Fails closed immediately (no registry entry ever created) for a `taskId`
   * that isn't currently active on this device — a stale/unknown/
   * already-finished task has nothing to pause.
   *
   * Only ONE approval per task is DISPATCHED (registered +
   * `task.await_approval` sent + its own timeout window running) at a time,
   * so a decision always names exactly one pending id. A further concurrent
   * call queues (FIFO, `active.approvalQueue`) and is dispatched — with its
   * OWN approvalId and timeout window — once the dispatched one resolves
   * (`dispatchNextQueuedApproval`). Bounded by
   * {@link MAX_PENDING_APPROVALS_PER_TASK}: a request arriving once this
   * task's queue is full is rejected fail-closed immediately.
   *
   * Aborting `signal` withdraws the request wherever it is: a queued one
   * leaves the queue undispatched, a dispatched one resolves as a rejection.
   * Either way a later decision for it is stale.
   */
  requestApproval(taskId: string, summary: string, signal?: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    return requestApproval.call(this, taskId, summary, signal, 'task-terminal');
  }

  /**
   * Actually dispatch one approval request for `active`'s task: register it
   * in `deps.approvalRegistry`, send its `task.await_approval`, and start its
   * own `deps.approvalTimeoutMs` window — see `requestApproval`'s own doc
   * comment for why this is split out (only ever ONE dispatched per task at
   * a time; everything else queues). Called either immediately
   * (`requestApproval`, nothing else pending for this task) or from
   * `dispatchNextQueuedApproval` once the previously-dispatched request for
   * this same task resolves.
   */
  private dispatchApproval(active: ActiveTask, summary: string, signal: AbortSignal | undefined, kind: ApprovalKind): Promise<{ approved: boolean; reason?: string }> {
    return dispatchApproval.call(this, active, summary, signal, kind);
  }

  /**
   * Report a LOCALLY-resolved approval to the server immediately (see
   * `messages.ts`'s doc comment on `TaskApprovalResolvedPayloadSchema`).
   * Baseline since wire v4: every server reads it, and it is the server's
   * only source for a local resolution.
   *
   * Ordering (verified by `task-runner-approval-resolved.test.ts`): this is
   * called, and therefore `deps.send` pushes this envelope onto the outbox,
   * SYNCHRONOUSLY from the `onResolve` callback above — strictly BEFORE the
   * `resolve(...)` call on the very next line that unblocks whatever was
   * awaiting `requestApproval()`'s promise (ultimately the custom adapter's
   * paused runtime turn). Any further progress from the resumed session
   * can only be produced AFTER that unblock, which needs at least one more
   * microtask/event-loop turn — so `task.approval_resolved` is always queued
   * ahead of it with no extra bookkeeping needed here.
   */
  private sendApprovalResolved(taskId: string, approvalId: string, decision: ApprovalDecision): void {
    const payload = { approvalId, decision, resolvedBy: 'local', at: new Date().toISOString() } as const;
    this.deps.send(createEnvelope('task.approval_resolved', payload, { taskId }));
  }

  /**
   * FIFO: once a task's currently-dispatched approval resolves (real
   * decision or timeout), dispatch the next queued request for that SAME
   * task, if any — see `requestApproval`'s own doc comment. A no-op when
   * nothing is queued.
   */
  private dispatchNextQueuedApproval(active: ActiveTask): void {
    const next = active.approvalQueue.shift();
    if (!next) return;
    void this.dispatchApproval(active, next.summary, next.signal, next.kind).then(next.resolve);
  }

  /**
   * Protocol §5: the server's own state already moved
   * `AwaitApproval -> Running` before this best-effort notification arrives
   * (§4). Resolving the registry entry hands the decision to the session
   * that requested it.
   */
  private handleApprove(taskId: string, approvalId: string, decidedBy: ApprovalOrigin = 'wire'): Promise<void> {
    return handleApprove.call(this, taskId, approvalId, decidedBy);
  }

  /**
   * Resolves the named approval. Its local kind decides whether rejection
   * terminates the task or denies one tool call while the turn continues.
   */
  private handleReject(taskId: string, reason: string | undefined, approvalId: string, decidedBy: ApprovalOrigin = 'wire'): Promise<void> {
    return handleReject.call(this, taskId, reason, approvalId, decidedBy);
  }

  /**
   * `Daemon.approve`/`reject`: decide the pending approval on this device
   * through the same path as a wire decision, then report it to the server
   * as `task.approval_resolved`, which is how a v4 server learns of a local
   * decision. A stale `approvalId` changes and reports nothing.
   */
  resolveApprovalLocally(taskId: string, approvalId: string, decision: ApprovalDecision, reason?: string): Promise<void> {
    return decision === 'approve'
      ? this.handleApprove(taskId, approvalId, 'in-process')
      : this.handleReject(taskId, reason, approvalId, 'in-process');
  }

  /**
   * Opens a sealed offer, then runs the plaintext offer through every check of
   * {@link handleOffer}. A server without `sealed-payload-v1` gets a plaintext
   * decline before the open: the task's output could not be sent to it.
   */
  private handleSealedOffer(envelope: Envelope, admission: OfferAdmissionTiming): Promise<void> {
    return handleSealedOffer.call(this, envelope, admission);
  }

  private declineOfferMissingCapabilities(envelope: Extract<Envelope, { type: 'task.offer' }>, admission: OfferAdmissionTiming): boolean {
    return declineOfferMissingCapabilities.call(this, envelope, admission);
  }

  private failurePayload(failure: TaskFailure): { failure?: TaskFailure } {
    return taskFailureField(failure, this.deps.getServerCapabilities?.() ?? []);
  }

  private sealedCodesAllowed(): boolean {
    const capabilities = this.deps.getServerCapabilities?.() ?? [];
    return requiredReceiverCapabilities('task.decline', { reason: 'sealed_open_failed', code: 'sealed_open_failed' })
      .every((flag) => capabilities.includes(flag));
  }

  /**
   * Declines a sealed offer once, non-retryably, before any claim. To a server
   * with `sealed-payload-v1` it sends the closed code as both `reason` and
   * `code` (#654 decisions 12c and 12d). The code is a value gate on that
   * flag, so without it the decline has a plaintext reason and no code.
   */
  private declineSealedOffer(taskId: string, admission: OfferAdmissionTiming, agentRef: AgentRef | undefined, code: SealedDeclineCode): void {
    return declineSealedOffer.call(this, taskId, admission, agentRef, code);
  }

  /** Pre-claim, fail-closed rejection (protocol §3.2) — never claims first. */
  private decline(taskId: string, admission: OfferAdmissionTiming, reason: string, retryable: boolean, agentRef?: AgentRef, code?: TaskDeclinePayload['code']): void {
    const timings = admission.snapshot();
    this.deps.send(createEnvelope(
      'task.decline',
      {
        reason, retryable, ...(agentRef === undefined ? {} : { agentRef }), ...(code === undefined ? {} : { code }),
        ...(timings === undefined ? {} : { admission: timings }),
      },
      { taskId },
    ));
  }

  private fail(taskId: string, reason: string, retryable: boolean, failure?: TaskFailure): Promise<void> {
    return fail.call(this, taskId, reason, retryable, failure);
  }

  /**
   * Claimed Agent failures before ActiveTask registration still carry the
   * exact AgentRef and normally have Agent-local, fsynced terminal evidence
   * first. A bounded storage failure degrades observably but cannot strand
   * the already-claimed cloud task forever; the exact terminal still goes on
   * the wire and handleOffer's finally block releases the lease.
   */
  private failClaimedAgent(
    taskId: string,
    reason: string,
    retryable: boolean,
    context: ClaimedAgentFailureContext,
    failure?: TaskFailure,
  ): Promise<boolean> {
    return failClaimedAgent.call(this, taskId, reason, retryable, context, failure);
  }

  /**
   * Build the optional terminal observation from facts this running daemon
   * actually has. No offered `dispatchSelection` is echoed here: it is a
   * requested execution target, not an adapter-reported provider/model fact.
   * The bundled adapter event contracts currently expose token observations
   * (Codex and Claude) but no provider/model observation, so those keys stay
   * absent. Pi reports one native usage observation per provider call
   * (`adapters/pi/events.ts`), so its block carries the LAST call's figures —
   * telemetry, exactly like the other runtimes' — and a Pi run that reported
   * none omits the block rather than fabricating one from independently known
   * runtime, elapsed duration, or Local Agent version.
   *
   * "Reported none" includes a last observation that carries NEITHER token
   * count: Pi still emits a `usage` event for a call whose usage block was
   * unreadable (so the prepared lane can count the call), and a terminal block
   * built from it would be a usage observation with no usage in it.
   */
  private terminalInferenceUsagePayload(active: ActiveTask): { usage?: TerminalInferenceUsage } {
    return terminalInferenceUsagePayload.call(this, active);
  }

  /**
   * The prepared-only terminal observation, present exactly on a prepared
   * Execution that observed at least one provider call's prompt. It is
   * evidence the Host checks its own budget ruling against, deliberately a
   * separate field from the telemetry-only `usage` block.
   */
  private preparedObservationPayload(active: ActiveTask): { preparedObservation?: TerminalPreparedObservation } {
    return preparedObservationPayload.call(this, active);
  }

  /** Exact Agent identity projection for claim/terminal wire payloads. */
  private agentTerminalPayload(
    active: ActiveTask,
  ): {
    agentRef?: AgentRef;
    harnessId?: string;
    agentHomeProjection?: TerminalAgentHomeProjection;
    agentHomeMemoryChange?: TerminalAgentHomeMemoryChange;
  } {
    return agentTerminalPayload.call(this, active);
  }

  /**
   * Wire v3 result channel, at `turn_end`: the one place a staged
   * `submit_result` outcome becomes `task.complete.document`.
   *
   * `{deliver: true}` permits the reply lane, with either the staged outcome
   * or a typed result failure to persist before handing off a required reply.
   * A failure never becomes a completion document.
   * `{deliver: false}` means this method has ALREADY reported `task.fail`
   * (or the task was finished meanwhile by someone else); the caller returns.
   *
   * The result context is revoked first, so no new submit is accepted, and
   * the read queues behind any stage already writing: the record read here is
   * final. Offers without a result-document projection (`mode: 'none'`,
   * message-only and legacy offers) never read the store and carry no
   * document. Failure, cancel and interrupt paths never come here.
   */
  private resolveStagedResult(
    active: ActiveTask,
  ): Promise<{ deliver: true; document?: unknown; failure?: ResultReplyFailure } | { deliver: false }> {
    return resolveStagedResult.call(this, active);
  }

  /** Persist Agent terminal truth before wire when local storage is available. */
  private persistAgentTerminalEvidence(
    active: ActiveTask,
    cause: AgentTerminalCause,
    reason?: string,
  ): Promise<boolean> {
    return persistAgentTerminalEvidence.call(this, active, cause, reason);
  }

  /**
   * Memory-change evidence of a `memory-reader` Attempt (#317), measured once
   * at its first terminal decision, before the terminal envelope is built.
   * The execution lease is still held, so the overlap flag covers every
   * writer that started before this point.
   */
  private measureReaderMemoryChange(active: ActiveTask): Promise<void> {
    return measureReaderMemoryChange.call(this, active);
  }

  private retryAgentTerminalEvidence(
    write: () => Promise<unknown>,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
    return retryAgentTerminalEvidence.call(this, write);
  }

  private reportAgentTerminalEvidenceFailure(input: {
    taskId: string;
    agentRef: AgentRef;
    runtimeId: string;
    cwd: string;
    cause: AgentTerminalCause;
    reason?: string;
    error: unknown;
  }): void {
    return reportAgentTerminalEvidenceFailure.call(this, input);
  }

  async retryTerminalFinalization(taskId: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (active) await this.settleSemanticTerminal(active);
  }

  private readonly finalizationAttempts = new Map<string, Promise<boolean>>();

  /**
   * In-flight finalization attempts of this runner's Attempts that hold a
   * lease of `homeAccess` on `canonicalHome` and are already finishing. See
   * `reserveOfferHome` (#476): only these are worth waiting on; a finished
   * Attempt without an in-flight attempt keeps its slot as a live holder.
   */
  private homeFinalizations(canonicalHome: string, homeAccess: AgentHomeAccessMode): Promise<boolean>[] {
    return homeFinalizations.call(this, canonicalHome, homeAccess);
  }

  private finish(taskId: string): Promise<boolean> {
    const existing = this.finalizationAttempts.get(taskId);
    if (existing) return existing;
    const attempt = this.finishOnce(taskId).finally(() => this.finalizationAttempts.delete(taskId));
    this.finalizationAttempts.set(taskId, attempt);
    return attempt;
  }

  private finishOnce(taskId: string): Promise<boolean> {
    return finishOnce.call(this, taskId);
  }

  /**
   * Once per execution, after `Session.close()` (so adapter counters are
   * final) and the terminal commit. Synchronous and in memory: it cannot hold
   * the terminal or the lease release, and a failure here is only logged.
   */
  private publishExecutionRecord(active: ActiveTask): void {
    return publishExecutionRecord.call(this, active);
  }

  private settleSemanticTerminal(active: ActiveTask, prepare?: () => Promise<Envelope>): Promise<boolean> {
    return settleSemanticTerminal.call(this, active, prepare);
  }

  /**
   * Release the preparation pin this Execution holds, if it took one.
   *
   * Best effort by design, and loudly: a pin that cannot be released costs
   * retention, not correctness — the record stays uncollectable until an
   * operator intervenes — whereas turning a release failure into a task-terminal
   * would rewrite an already-established result for a reason the task itself had
   * nothing to do with.
   */
  private releasePreparationPin(taskId: string): Promise<void> {
    return releasePreparationPin.call(this, taskId);
  }

  /** M3-B: bounded insert for `finishedTaskIds` — see its class-level doc comment and `MAX_TRACKED_TASK_IDS`. Evicts the oldest (first-inserted) entry once over cap. */
  private addFinishedTaskId(taskId: string): void {
    this.finishedTaskIds.add(taskId);
    if (this.finishedTaskIds.size > MAX_TRACKED_TASK_IDS) {
      const oldest = this.finishedTaskIds.values().next().value;
      if (oldest !== undefined) this.finishedTaskIds.delete(oldest);
    }
  }

  private addStrictDeclinedTaskId(taskId: string): void {
    this.strictDeclinedTaskIds.add(taskId);
    if (this.strictDeclinedTaskIds.size > MAX_TRACKED_TASK_IDS) {
      const oldest = this.strictDeclinedTaskIds.values().next().value;
      if (oldest !== undefined) this.strictDeclinedTaskIds.delete(oldest);
    }
  }

  /**
   * Selects which adapter runs this offer, gated on CAPABILITY (MCP toolset
   * projection, when required) and PRESENCE (`adapter.detect()`) — pre-claim,
   * in both the explicit-runtime and auto-select branches.
   *
   * Explicit-runtime branch (`requestedRuntime` set): allowlist and
   * known-adapter checks first, THEN the capability check, THEN presence. A
   * capability mismatch here is a permanent characteristic of naming THIS
   * runtime — `retryable: false`, the same class as "not in allowlist" /
   * "unknown runtime" above it.
   *
   * Auto-select branch (`requestedRuntime` absent): candidates are ordered
   * by `runtimePreference` (default {@link DEFAULT_RUNTIME_PREFERENCE}) —
   * see `orderByPreference` — then walked in that order; a candidate without
   * the required capability is skipped (not detected at all — capability is
   * checked first, cheaper than a real subprocess probe). If NOTHING eligible
   * is available, `retryable: true` — unlike the explicit branch, this is
   * device-specific (which runtimes happen to be installed here), so a
   * different device's installed runtime set might satisfy it.
   */
  private pickAdapter(
    requestedRuntime: string | undefined,
    requiresMcpToolsets: boolean,
    signal: AbortSignal,
    requiresMcpToolApprovals = false,
  ): Promise<PickResult> {
    return pickAdapter.call(this, requestedRuntime, requiresMcpToolsets, signal, requiresMcpToolApprovals);
  }
}
