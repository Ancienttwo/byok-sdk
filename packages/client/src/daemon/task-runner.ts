import { resultReplyFailureReason, type ResultReplyFailure } from './result-reply-failure';
import type { ActivityIngress } from '@byok-sdk/protocol';
import { AgentMessageDraftPublisher } from './agent-message-draft';
import type { ScratchRoot, ExecutionScratch } from './retention/scratch';
import { observePreparedMemory, type PreparedAgentMemoryState } from './prepared-agent-memory';
import { InputPreparationRequestError } from './input-preparation-service';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import type { PiRuntimeLaunchResources } from '../adapters/pi/runtime-launch';
import { awaitAdmission } from './admission-wait';
import { terminalIdentity } from './terminal-identity';
import { abortedStartOf, startOwnedRuntime } from './runtime-start';
import { StartupOwnership } from './startup-ownership';
import { DEFAULT_ARTIFACT_LIMITS, readArtifactBytes } from './artifact-read';
import { observeRuntimeDetection } from '../runtime-detection';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createEnvelope,
  PreparedAgentMemoryModeSchema,
  TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS,
  TERMINAL_INFERENCE_USAGE_MAX_TOKENS,
  type AgentMessageContentType,
  type AgentMessageDispositionPayload,
  type AgentMessageEgressRequirement,
  type AgentEgressPolicy,
  type BlobRef,
  type Envelope,
  type SealedDeclineCode,
  type PreparedAgentMemoryMode,
  type RuntimeId,
  type TerminalInferenceUsage,
  type TerminalPreparedObservation,
  type TerminalAgentHomeProjection,
  type TerminalAgentHomeMemoryChange,
  type TerminalProjectionSelection,
  type TaskOfferPayload,
  type TaskDeclinePayload,
  type TaskFailure,
  type TaskOfferForAgentPayload,
  type TaskOfferForAgentWithEgressPayload,
  type TaskOfferForAgentWithEgressFreshPayload,
  type TaskOfferPreparedPayload,
  type TaskOfferWithToolsetsPayload,
  requiredReceiverCapabilities,
  SEALED_SPLIT_TABLE,
  validateResultOutcome,
} from '@byok-sdk/protocol';
import {
  SteerUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  sealRuntimeOperationManifest,
  type McpStdioServerConfig,
  type McpToolsetConfig,
  type RuntimeAdapter,
  type RuntimeOperationStartInput,
  type RuntimePreparedLaunchV1,
  type Session,
} from '../types';
import {
  admitPreparedOffer,
  type PreparedOfferServerProjection,
} from './prepared-offer-admission';
import type { InputPreparationStore } from './input-preparation-store';
import {
  inputPreparationDigest,
  type InputPreparationRuntimeIdentityV1,
  type InputPreparationBindingV1,
} from '../input-preparation';
import {
  AgentHomeBusyError,
  AgentHomeReaderRunMissingError,
  AgentHomeResolutionError,
  AgentHomeManager,
  type AgentHomeExecutionBinding,
  type AgentRef,
} from '../agent-home';
import {
  compareAgentHomeMemory,
  digestAgentHomeMemory,
  isReaderRunName,
  type AgentHomeAccessMode,
} from '../agent-home-readers';
import {
  AgentSessionHandoffStore,
  type AgentTerminalCause,
} from './agent-session-handoff-store';
import {
  RuntimeDisposalFailure,
  isRuntimeDisposalFailure,
  isRuntimeStartupDisposalFailure,
  projectRuntimeBoundaryFailure,
  type RuntimeDisposalStage,
} from '../runtime-failure';
import { ApprovalNotFoundError, type ApprovalDecision, type ApprovalOrigin, type ApprovalRegistry } from './approvals';
import type { BlobResolver } from './blob-client';
import type { SealedTasks } from './sealed-task';
import { DAEMON_TASK_FAILURE, taskFailureField } from './task-failure';
import type {
  AgentResultDescribeParams,
  AgentResultDescribeResult,
  AgentResultSubmitParams,
  AgentResultSubmitResult,
  TaskQueueWatermark,
} from './control-protocol';
import { DEFAULT_MAX_INLINE_EVENT_BYTES, spillOversizedEvent } from './event-spill';
import { ExecutionRecordAccumulator, type ExecutionRecord } from './execution-record';
import { buildRuntimeEnv } from './environment';
import { toRuntimeInfoCapabilities } from './runtime-capabilities';
import type { LocalAgentReleaseIdentity } from '../release-identity';
import {
  ProgressBatcher,
  ProgressEventTooLargeError,
  type ProgressBatcherOptions,
} from './progress-batcher';
import type { SessionWorkspaceStore } from './session-workspace-store';
import type { GitWorkspaceManager, GitWorkspaceLease, GitWorkspaceObservation, GitWorkspaceError, GitErrorCategory } from './git-workspace';
import { prependGitWorkspaceGuidance } from './git-workspace';
import type { GitWorkspaceStore, GitWorkspaceLedgerRecord, GitWorkspacePhase } from './git-workspace-store';
import type { AgentEgressController } from './agent-egress-controller';
import { AgentMessageOutbox, type AgentMessageOutboxRecord } from './agent-message-outbox';
import {
  AGENT_MEMORY_MCP_SERVER_NAME,
  AGENT_MESSAGE_MCP_SERVER_NAME,
  AGENT_RESULT_MCP_SERVER_NAME,
  AGENT_RESULT_TOOL_NAME,
  AGENT_RESULT_TOOL_DESCRIPTION,
} from '../sdk-reserved-mcp';
import { AgentResultStore, type AgentResultRecord } from './agent-result-store';
import {
  McpAuthorityError,
  MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS,
  probeMcpServer,
  type McpToolsProbeOptions,
} from './mcp-tools-probe';
import {
  bindMcpToolsetServerObservation,
  type McpServerObservation,
  type McpToolsetServerObservation,
} from '../mcp/observation';
import type { ResolvedAgentMessageMcpBin } from './resolve-agent-message-mcp-bin';
import { prependAgentMemoryModeGuidance } from './memory-guidance';
import type { ResolvedAgentMemoryMcpBin } from './resolve-agent-memory-mcp-bin';
import {
  AgentMemoryService,
  AgentMemoryError,
  isAgentMemorySecureFilesystemAvailable,
  snapshotAndProjectAgentMemory,
  type AgentMemoryAuditWarning,
  type AgentMemoryHostedProjection,
  type AgentMemoryTaskContext,
} from './agent-memory';
import { openAgentMemoryFilesystemHelper } from './agent-memory-fs-helper';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
import { MAX_TIMER_DELAY_MS } from '../util/timer-delay';
import type { PreparedExecutionObservation, ActiveTask, AgentResultContext, PendingMessageTask, ClaimedAgentFailureContext, PickResult, OfferPhaseContext, OfferRuntimeInput, HostToolsetContextEntry } from './task-runner/support';
import { AGENT_TERMINAL_EVIDENCE_RETRY_DELAY_MS, GIT_OBSERVATION_TIMEOUT_MS, MAX_INLINE_ARTIFACT_BYTES, observePreparedCall, settledOrWithdrawn, closingReply, executionTerminalOf, isKnownRuntimeId, terminalUsageNumber, DEFAULT_RUNTIME_PREFERENCE, orderByPreference, adapterSupportsMcpToolsets, withoutRequiredToolsets, offeredPreparation, offeredInstruction, sameEgressPolicy, offeredAgentRef, offeredSessionRef, offeredHomeAccess, errorMessage, outboundErrorMessage, raceSettleFirst, estimateEventBytes, openArtifact, freshHostToolsetContextToken, NO_SEALED_SPILL, offerSettlements, trackOffer, observeTerminalUsage } from './task-runner/support';

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
 * M4 Phase 3 hardening (orchestrator-directed fix): thrown by the
 * `ctx.approvalChannel.resolve` closure built in `handleOffer` below when
 * this task has no CURRENTLY pending out-of-band approval to resolve.
 * Distinguished from a plain `Error` specifically so `handleApprove`/
 * `handleReject` can tell "a wire task.approve/task.reject arrived for an
 * approval a DIFFERENT, faster path (a racing local `approvals.resolve`, or
 * this exact decision arriving twice) already resolved" — a benign,
 * expected race, audit-worthy but never task-state-affecting — apart from
 * "the session's own resolveApproval() failed for some other, genuine
 * reason" (an adapter-level problem, which still fails the task exactly as
 * before). Only thrown for a custom adapter wiring an approval channel.
 * Bundled adapters reject confirm and throw their own unsupported errors.
 */
export class NoPendingApprovalError extends Error {
  constructor(public readonly taskId: string) {
    super(`no pending out-of-band approval to resolve for task ${taskId}`);
    this.name = 'NoPendingApprovalError';
  }
}


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
   * section, and a `task.offer_prepared` arriving there is declined by name
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
  /** Parent of legacy `workspaceRoot/<taskId>` workspaces. Required unless `strictAgentOnly` is true. */
  workspaceRoot?: string;
  /** Strict Agent offer authority. Absent means legacy offers never resolve an Agent home. */
  agentHome?: AgentHomeManager;
  /** Local authority: legacy offers are declined after journal/dedup/cancel precedence. */
  strictAgentOnly?: boolean;
  /**
   * How many `memory-reader` Attempts may run concurrently in ONE canonical
   * Agent home — see `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`'s
   * own doc comment (`create-daemon.ts`) for the validated contract. Unset
   * defaults to {@link DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME}.
   * The writer limit is fixed at one.
   */
  maxConcurrentReaderAttemptsPerAgentHome?: number;
  /** Exact host-selected policy accepted by `task.offer_for_agent_with_egress`. */
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
  /**
   * Finding #3 (session/workspace continuity): persists `sessionRef ->
   * workspaceDir` across daemon restarts so a `task.offer` naming a
   * previously-reported `sessionRef` reuses that exact workspace instead of
   * a fresh `workspaceRoot/<taskId>` — see `handleOffer` and
   * `SessionWorkspaceStore`'s own doc comment.
   */
  sessionWorkspaces: SessionWorkspaceStore;
  gitWorkspaceManager?: GitWorkspaceManager;
  gitWorkspaceStore?: GitWorkspaceStore;
  onGitWorkspaceEvent?: (event: {
    taskId: string;
    workspaceId: string;
    phase: GitWorkspacePhase;
    observation?: GitWorkspaceObservation;
    errorCategory?: string;
  }) => void;
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
   * M4 Phase 3 hardening: called by `handleApprove`/`handleReject` instead of
   * failing the task when the referenced approval turns out to be stale
   * (see {@link NoPendingApprovalError}) — an audit-only signal, never
   * gating any task-state decision. `create-daemon.ts` wires this to
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
   * M4 (additive-minor, `task.approval_resolved`): the capabilities advertised
   * by the CURRENT transport's server (`conn.ack` on WS, the latest successful
   * events response on long-poll) — read fresh at call time (mirrors
   * `getCursor`/`getToken`'s own
   * "read fresh, not captured once" convention elsewhere in this codebase),
   * since the capability is learned asynchronously, after this `TaskRunner`
   * is already constructed (`create-daemon.ts`'s `start()` builds `deps`
   * before `connection` exists). `create-daemon.ts` wires this to
   * `ConnectionManager.getServerCapabilities`. Optional, and treated as "no
   * capabilities" when absent, so a minimal test harness that doesn't care
   * about this gate isn't forced to supply one — see `sendApprovalResolved`.
   */
  getServerCapabilities?: () => readonly string[];
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

















type AcceptedOfferPayload =
  | TaskOfferPayload
  | TaskOfferWithToolsetsPayload
  | TaskOfferForAgentPayload
  | TaskOfferForAgentWithEgressPayload
  | TaskOfferForAgentWithEgressFreshPayload
  | TaskOfferPreparedPayload;

















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
    if (deps.strictAgentOnly !== true && (typeof deps.workspaceRoot !== 'string' || deps.workspaceRoot === '')) {
      throw new Error('TaskRunnerDeps.workspaceRoot is required unless strictAgentOnly is true');
    }
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

  /** A legacy offer's workspace. Only a non-strict runner admits one, and its constructor required the root. */
  private legacyWorkspaceDir(taskId: string): string {
    if (this.deps.workspaceRoot === undefined) throw new Error('legacy workspace requested from a strict Agent-only runner');
    return path.join(this.deps.workspaceRoot, taskId);
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
      pendingApprovals: (active.pendingApprovalId !== undefined ? 1 : 0) + active.approvalQueue.length,
    }));
  }

  /** Authenticated control-socket entry used only by the SDK-owned task MCP helper. */
  async publishAgentMessage(input: {
    readonly contextToken: string;
    readonly contentType: AgentMessageContentType;
    readonly body: string;
  }): Promise<{ messageId: string; state: 'staged' | 'pending' }> {
    const taskId = this.messageContextByToken.get(input.contextToken);
    if (taskId === undefined || this.messageContextByTask.get(taskId) !== input.contextToken) {
      throw new Error('invalid or expired Agent message task context');
    }
    const pending = this.pendingMessageTasks.get(taskId);
    const active = this.tasks.get(taskId);
    const context = pending ?? (active?.messageRequirement && active.agentRef && active.messageOutbox
      ? { taskId, agentRef: active.agentRef, requirement: active.messageRequirement, outbox: active.messageOutbox }
      : undefined);
    if (context === undefined) throw new Error('task has no active required Agent message contract');
    const isCurrent = () => {
      if (this.messageContextByToken.get(input.contextToken) !== taskId
        || this.messageContextByTask.get(taskId) !== input.contextToken || this.pendingCancelled.has(taskId)) return false;
      const current = this.tasks.get(taskId);
      return current === undefined
        ? active === undefined && this.pendingMessageTasks.get(taskId) === pending
        : (active === undefined || current === active) && current.messageOutbox === context.outbox && this.canPublishAgentMessage(current);
    };
    if (!isCurrent()) throw new Error('invalid or expired Agent message task context');
    const record = await context.outbox.appendDraft({
      taskId,
      tenantId: this.deps.tenantId!,
      agentRef: context.agentRef,
      requirement: context.requirement,
      contentType: input.contentType,
      body: input.body,
      maxPendingEvents: 64,
      maxPendingBytes: 4 * 1024 * 1024,
    });
    if (!isCurrent()) throw new Error('invalid or expired Agent message task context');
    const current = this.tasks.get(taskId);
    if (current === undefined) return { messageId: record.messageId, state: 'staged' };
    const activated = await this.activateAgentMessage(context.outbox, taskId, current.session.sessionRef, isCurrent,
      () => current.messageSendAttempted === true);
    if (!isCurrent()) throw new Error('invalid or expired Agent message task context');
    if (activated === undefined) throw new Error('Agent message draft disappeared before activation');
    this.sendAgentMessageRecord(context.outbox, activated);
    return { messageId: activated.messageId, state: 'pending' };
  }

  /**
   * Authenticated control-socket entry used only by the SDK result helper:
   * the one tool it advertises, whose `inputSchema` is the offer's frozen
   * result schema. Valid from injection (the helper preflight lists tools
   * before the runtime starts) until `turn_end` or teardown revokes it.
   */
  describeAgentResult(input: AgentResultDescribeParams): AgentResultDescribeResult {
    const context = this.resultContextByToken.get(input.contextToken);
    if (context === undefined || this.resultContextByTask.get(context.taskId) !== context || this.pendingCancelled.has(context.taskId)) {
      throw new Error('invalid or expired Agent result task context');
    }
    return {
      name: AGENT_RESULT_TOOL_NAME,
      description: AGENT_RESULT_TOOL_DESCRIPTION,
      inputSchema: context.schema as Record<string, unknown>,
    };
  }

  /**
   * Authenticated control-socket entry used only by the SDK result helper.
   * Validates the raw outcome against the frozen schema, then stages the
   * canonical snapshot durably before answering. `staged` is the only ack;
   * delivery happens at `turn_end`. A rejected outcome stores nothing.
   */
  async submitAgentResult(input: AgentResultSubmitParams): Promise<AgentResultSubmitResult> {
    const context = this.resultContextByToken.get(input.contextToken);
    if (context === undefined || this.resultContextByTask.get(context.taskId) !== context) {
      throw new Error('invalid or expired Agent result task context');
    }
    const { taskId } = context;
    const active = this.tasks.get(taskId);
    const isCurrent = (): boolean => {
      if (this.resultContextByToken.get(input.contextToken) !== context
        || this.resultContextByTask.get(taskId) !== context || this.pendingCancelled.has(taskId)) return false;
      const current = this.tasks.get(taskId);
      return current === undefined ? active === undefined : (active === undefined || current === active) && this.canPublishAgentMessage(current);
    };
    if (!isCurrent()) throw new Error('invalid or expired Agent result task context');
    const { store, agentRef } = context;
    const tenantId = this.deps.tenantId;
    if (store === undefined || agentRef === undefined || tenantId === undefined) {
      throw new Error('the Agent result store is not bound for this task');
    }
    const check = validateResultOutcome(context.schema, input.outcome);
    if (!check.ok) {
      return {
        state: 'rejected',
        reason: check.reason,
        issues: check.issues.map((issue) => ({ pointer: issue.pointer, keyword: issue.keyword, message: issue.message })),
        truncated: check.truncated,
      };
    }
    const record = await store.stage({
      taskId,
      tenantId,
      agentRef,
      contract: context.contract,
      schema: context.schema,
      outcome: check.canonical,
      byteCount: check.bytes,
    });
    if (!isCurrent()) throw new Error('invalid or expired Agent result task context');
    return { state: 'staged', receiptId: record.receiptId };
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
  async recoverAgentMessageOutboxes(agentsRoot: string, resultFailureTasks: ReadonlyMap<string, { agentRef: AgentRef; contract: string }> = new Map(), isCancelled?: (taskId: string) => Promise<boolean>): Promise<void> {
    if (this.deps.tenantId === undefined) throw new Error('Agent message recovery requires authenticated tenant enrollment');
    for (const outbox of await AgentMessageOutbox.recover(agentsRoot, this.deps.tenantId)) {
      this.messageOutboxesByHome.set(outbox.homeDir, Promise.resolve(outbox));
      for (let record of outbox.records()) {
        if (await isCancelled?.(record.taskId)) { await outbox.revoke(record.taskId); continue; }
        const binding = resultFailureTasks.get(record.taskId);
        if (binding !== undefined && (record.agentRef.agentId !== binding.agentRef.agentId
          || record.agentRef.profileRevision !== binding.agentRef.profileRevision || record.contract !== binding.contract)) {
          throw new Error('recovered required reply does not match its durable offer');
        }
        if (record.sessionRef === undefined && record.recoverySessionRef !== undefined && resultFailureTasks.has(record.taskId)) {
          record = await outbox.activate(record.taskId, record.recoverySessionRef) ?? record;
        }
        if (record.sessionRef === undefined && !resultFailureTasks.has(record.taskId)) continue;
        const existing = this.recoveredMessageOutboxes.get(record.taskId);
        if (existing !== undefined && existing !== outbox) throw new Error(`multiple Agent message outboxes claim task ${record.taskId}`);
        this.recoveredMessageOutboxes.set(record.taskId, outbox);
      }
    }
  }

  private agentMessageOutbox(homeDir: string): Promise<AgentMessageOutbox> {
    const existing = this.messageOutboxesByHome.get(homeDir);
    if (existing !== undefined) return existing;
    const opened = AgentMessageOutbox.open(homeDir);
    this.messageOutboxesByHome.set(homeDir, opened);
    void opened.catch(() => {
      if (this.messageOutboxesByHome.get(homeDir) === opened) this.messageOutboxesByHome.delete(homeDir);
    });
    return opened;
  }

  /** A recovery terminal must not close first-message admission before this durable draft has a disposition. */
  hasPendingRecoveredAgentMessage(taskId: string): boolean {
    if (this.cancelledRecoveredMessages.has(taskId)) return false;
    return this.recoveredMessageOutboxes.get(taskId)?.retryableRecords()
      .some((record) => record.taskId === taskId && record.sessionRef !== undefined) === true;
  }

  async cancelRecoveredAgentMessage(taskId: string, persist: () => Promise<void>): Promise<void> {
    this.cancelledRecoveredMessages.add(taskId);
    const timer = this.recoveredMessageRetryTimers.get(taskId);
    if (timer !== undefined) clearTimeout(timer);
    this.recoveredMessageRetryTimers.delete(taskId);
    await persist();
    await this.recoveredMessageOutboxes.get(taskId)?.revoke(taskId);
    this.recoveredMessageOutboxes.delete(taskId);
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
  private async activateAgentMessage(
    outbox: AgentMessageOutbox, taskId: string, sessionRef: string, isCurrent: () => boolean,
    wasSendAttempted: () => boolean = () => false,
  ): Promise<AgentMessageOutboxRecord | undefined> {
    if (!isCurrent()) return undefined;
    const record = await outbox.activate(taskId, sessionRef, isCurrent);
    if (!isCurrent()) {
      if (!wasSendAttempted()) await outbox.revoke(taskId);
      return undefined;
    }
    return record;
  }

  private sendAgentMessageRecord(outbox: AgentMessageOutbox, record: AgentMessageOutboxRecord): void {
    const active = this.tasks.get(record.taskId);
    const authorized = active === undefined
      ? !this.cancelledRecoveredMessages.has(record.taskId) && this.recoveredMessageOutboxes.get(record.taskId) === outbox
      : active.messageOutbox === outbox && this.canPublishAgentMessage(active);
    if (!authorized || record.sessionRef === undefined
      || !outbox.retryableRecords().some(pending => pending.messageId === record.messageId)) return;
    if (active !== undefined) {
      active.messageDraft?.finalize(record.body);
      active.messageDraft?.stop();
      active.messageSendAttempted = true;
    }
    const envelope = this.agentMessageEnvelopes.get(record) ?? createEnvelope('agent.message.publish', outbox.publishPayload(record), {
      taskId: record.taskId,
      sessionRef: record.sessionRef,
    });
    this.agentMessageEnvelopes.set(record, envelope);
    this.deps.send(envelope);
    if (active?.messageOutbox === outbox) {
      if (active.messageRetryTimer !== undefined) clearTimeout(active.messageRetryTimer);
      active.messageRetryTimer = setTimeout(() => {
        active.messageRetryTimer = undefined;
        if (this.tasks.get(record.taskId) !== active) return;
        const pending = outbox.get(record.taskId);
        if (pending !== undefined) this.sendAgentMessageRecord(outbox, pending);
      }, 1_000);
      active.messageRetryTimer.unref?.();
      return;
    }
    if (this.recoveredMessageOutboxes.get(record.taskId) === outbox) {
      const prior = this.recoveredMessageRetryTimers.get(record.taskId);
      if (prior !== undefined) clearTimeout(prior);
      const timer = setTimeout(() => {
        this.recoveredMessageRetryTimers.delete(record.taskId);
        const pending = outbox.get(record.taskId);
        if (pending !== undefined && this.recoveredMessageOutboxes.get(record.taskId) === outbox) {
          this.sendAgentMessageRecord(outbox, pending);
        }
      }, 1_000);
      timer.unref?.();
      this.recoveredMessageRetryTimers.set(record.taskId, timer);
    }
  }

  private async handleAgentMessageDisposition(taskId: string, disposition: AgentMessageDispositionPayload): Promise<void> {
    const active = this.tasks.get(taskId);
    const outbox = active?.messageOutbox ?? this.recoveredMessageOutboxes.get(taskId);
    if (outbox === undefined) return;
    const outcome = await outbox.applyDisposition(taskId, disposition, () => this.deps.recordAgentMessageAccepted?.(taskId) ?? Promise.resolve());
    if (active === undefined) {
      if (outcome === 'accepted' || outcome === 'held' || outcome === 'refused') {
        const timer = this.recoveredMessageRetryTimers.get(taskId);
        if (timer !== undefined) clearTimeout(timer);
        this.recoveredMessageRetryTimers.delete(taskId);
      }
      if (outcome === 'accepted') this.recoveredMessageOutboxes.delete(taskId);
      return;
    }
    // Disposition persistence may race cancellation and disposal. Never create
    // a new terminal for an execution that finished while its receipt was written.
    if (this.tasks.get(taskId) !== active) return;
    if (outcome === 'held') {
      if (active.messageRetryTimer !== undefined) clearTimeout(active.messageRetryTimer);
      active.messageRetryTimer = undefined;
      return;
    }
    if (outcome === 'refused') {
      if (active.messageRetryTimer !== undefined) clearTimeout(active.messageRetryTimer);
      active.messageRetryTimer = undefined;
      this.revokeAgentMessageContext(taskId);
      active.pendingMessageCompletion = undefined;
      await this.fail(taskId, 'required Agent message was refused', false);
      return;
    }
    if (outcome !== 'accepted') return;
    if (active.messageRetryTimer !== undefined) {
      clearTimeout(active.messageRetryTimer);
      active.messageRetryTimer = undefined;
    }
    active.messageAccepted = true;
    this.revokeAgentMessageContext(taskId);
    if (active.pendingMessageCompletion !== undefined) {
      const completion = active.pendingMessageCompletion;
      active.pendingMessageCompletion = undefined;
      if (completion.failureReason !== undefined) await this.fail(taskId, completion.failureReason, false);
      else await this.publishSuccessfulCompletion(active, completion.finalOutput, completion.document);
    }
  }

  /** M4 Phase 2: stop claiming any FUTURE `task.offer` — see `stoppingOffers`'s own doc comment. Idempotent. */
  stopAcceptingOffers(): void {
    this.stoppingOffers = true;
    // Contract §8.2(1): a daemon on its way down signs nothing more for any
    // task. The control handler's own `shutting_down` gate answers first, so
    // this is not the refusal a caller sees — it is the registry telling the
    // truth regardless of which path initiated the shutdown.
    this.revokeAllHostToolsetContexts();
    this.startupOwnership.stopRetry();
    for (const abort of this.inFlightBlobAborts.values()) abort.abort();
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
   */
  async shutdownActiveTasks(reason: string): Promise<void> {
    const offers = offerSettlements.get(this);
    if (offers?.size) await Promise.all(offers);
    const active = [...this.tasks.values()];
    await Promise.all(active.map((task) => this.shutdownTask(task, reason)));
    await this.startupOwnership.disposeAll();
  }

  private closeActiveSession(active: ActiveTask): Promise<void> {
    // Store the receipt before close runs. A synchronous throw is a rejected
    // receipt, just like an adapter's asynchronous disposal failure.
    const attempt = active.disposalAttempt ??= Promise.resolve().then(async () => { await active.session.close(); await active.scratch.release(); });
    // Interrupt can start close before finalization waits for it. Observe the
    // rejection here, but retain the receipt until finalization reports it.
    void attempt.catch(() => undefined);
    return attempt;
  }

  private async awaitActiveSessionClose(active: ActiveTask): Promise<boolean> {
    const attempt = this.closeActiveSession(active);
    try {
      await attempt;
    } catch (caught) {
      if (active.disposalAttempt === attempt) active.disposalAttempt = undefined;
      const failure = isRuntimeDisposalFailure(caught)
        ? caught
        : new RuntimeDisposalFailure({
            stage: 'quiescence',
            reason: `${active.adapter.descriptor.id} session.close() returned an untyped disposal failure`,
          }, { cause: caught });
      // stderr is a service log: the stage and the reason's size, never its text (issue #395).
      console.error(
        `[byok/client] runtime disposal failed for task ${active.taskId}: runtime=${active.adapter.descriptor.id} stage=${failure.stage} reasonBytes=${Buffer.byteLength(failure.message, 'utf8')}`,
      );
      this.deps.onRuntimeDisposalFailure?.({
        taskId: active.taskId,
        runtimeId: active.adapter.descriptor.id,
        stage: failure.stage,
        reason: failure.message,
      });
      return false;
    }
    return true;
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
  private async interruptBounded(active: ActiveTask, drainEvents = true): Promise<void> {
    const timeoutMs = this.deps.shutdownInterruptTimeoutMs ?? DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    await raceSettleFirst(() => active.session.interrupt(), timeoutMs);
    // Close drains native stdio even if an ACK arrived before final usage, or
    // the adapter never supplies turn_end. Retain this SAME receipt for finish
    // to await/retry; a deadline is never proof of disposal.
    this.closeActiveSession(active);
    if (drainEvents) {
      // Drain events already delivered by interrupt before publishing usage.
      // A pending close/next() is not metering authority and cannot hold the
      // cancellation ACK hostage. One scheduler turn drains queued microtasks;
      // a close receipt (including a hung one) is still awaited by finish().
      if (Date.now() < deadline) {
        await Promise.race([active.eventPump ?? Promise.resolve(),
          new Promise<void>(resolve => setImmediate(resolve))]);
      }
    }
  }

  private async teardownActiveTask(active: ActiveTask, reason: string, retryable: boolean, drainEvents = true): Promise<boolean> {
    return this.settleSemanticTerminal(active, async () => {
      active.blobAbort.abort();
      await this.observeGit(active, 'salvage');
      await this.interruptBounded(active, drainEvents);
      await this.persistAgentTerminalEvidence(active, 'failed', reason);
      return createEnvelope('task.fail', {
        reason,
        retryable,
        ...this.failurePayload(DAEMON_TASK_FAILURE),
        ...this.terminalInferenceUsagePayload(active),
        ...this.preparedObservationPayload(active),
        ...this.agentTerminalPayload(active),
      }, { taskId: active.taskId });
    });
  }

  /** Graceful-shutdown caller of {@link teardownActiveTask} — see `shutdownActiveTasks`'s own doc comment. `retryable: true`: nothing about the task/policy itself was ever at fault, only this device's own availability right now. */
  private async shutdownTask(active: ActiveTask, reason: string): Promise<void> {
    const disposed = await this.teardownActiveTask(active, `daemon shutting down: ${reason}`, true);
    if (!disposed) {
      throw new RuntimeDisposalFailure({
        stage: 'quiescence',
        reason: `${active.adapter.descriptor.id} runtime ownership remains active after shutdown disposal failed`,
      });
    }
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
    // `maxDurationMs` is server-supplied and unbounded above; a limit beyond
    // one timer's range (~24.8 days) is armed in capped steps so it still
    // fires at the real limit instead of immediately. Each step replaces
    // `active.maxDurationTimer`, so `finish()` always clears the live one.
    const limitAt = Date.now() + maxDurationMs;
    const arm = (remainingMs: number): void => {
      const capped = remainingMs > MAX_TIMER_DELAY_MS;
      const timer = setTimeout(() => {
        if (capped) {
          if (!active.finalizationStarted) arm(Math.max(0, limitAt - Date.now()));
          return;
        }
        void this.failActiveTaskForResourceLimit(
          active.taskId,
          `${MAX_DURATION_EXCEEDED_REASON_PREFIX}: task exceeded its configured wall-clock limit of ${maxDurationMs}ms`,
        );
      }, capped ? MAX_TIMER_DELAY_MS : remainingMs);
      timer.unref?.();
      active.maxDurationTimer = timer;
    };
    arm(maxDurationMs);
  }

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'task.offer':
        await trackOffer(this, this.handleOffer(envelope.task_id, envelope.payload, false));
        return;
      case 'task.offer_with_toolsets':
        await trackOffer(this, this.handleOffer(envelope.task_id, envelope.payload, false));
        return;
      case 'task.offer_for_agent':
        await trackOffer(this, this.handleOffer(envelope.task_id, envelope.payload, true));
        return;
      case 'task.offer_for_agent_with_egress':
        await trackOffer(this, this.handleOffer(envelope.task_id, envelope.payload, true));
        return;
      case 'task.offer_for_agent_with_egress_fresh':
        await trackOffer(this, this.handleOffer(envelope.task_id, envelope.payload, true));
        return;
      case 'task.offer_prepared':
        await trackOffer(this, this.handleOffer(envelope.task_id, envelope.payload, true));
        return;
      case 'task.cancel':
        await this.handleCancel(envelope.task_id, envelope.payload.reason);
        return;
      case 'task.steer':
        // #654 §6.2: a task that seals its input takes no plaintext steer.
        if (this.deps.sealedTasks?.sealsInput(envelope.task_id)) {
          console.error(`[byok/client] plaintext task.steer for task ${envelope.task_id} dropped: the task seals its input`);
          return;
        }
        await this.handleSteer(envelope.task_id, envelope.payload.text);
        return;
      case 'task.approve':
        await this.handleApprove(envelope.task_id, envelope.payload.approvalId);
        return;
      case 'task.reject':
        await this.handleReject(envelope.task_id, envelope.payload.reason, envelope.payload.approvalId);
        return;
      case 'agent.message.disposition':
        await this.handleAgentMessageDisposition(envelope.task_id, envelope.payload);
        return;
      // #654: a sealed offer that cannot be opened is declined, not dropped,
      // so the task does not wait for a timeout; a sealed steer that cannot
      // be opened is dropped.
      case 'task.offer_sealed':
      case 'task.offer_with_toolsets_sealed':
      case 'task.offer_for_agent_sealed':
      case 'task.offer_for_agent_with_egress_sealed':
      case 'task.offer_for_agent_with_egress_fresh_sealed':
        await trackOffer(this, this.handleSealedOffer(envelope));
        return;
      case 'task.steer_sealed': {
        if (this.deps.sealedTasks === undefined) {
          console.error(
            `[byok/client] inbound sealed task.steer for task ${envelope.task_id} rejected: this daemon does not open sealed task input — acked without retry; this envelope should have been gated server-side`,
          );
          return;
        }
        if (!this.tasks.has(envelope.task_id)) return;
        const taskId = envelope.task_id;
        await this.deps.sealedTasks.applySteer(envelope, (text) => this.handleSteer(taskId, text));
        return;
      }
      default:
        return; // conn.* and daemon->server-only types are handled elsewhere / not applicable
    }
  }

  private async handleOffer(
    taskId: string,
    payload: AcceptedOfferPayload,
    strictAgentOffer: boolean,
  ): Promise<void> {
    // Finding P2, Fix 2c (redelivered offer for an already-active/finished
    // task): checked first, ahead of everything below — a redelivered
    // `task.offer` for a taskId this device already claimed/started, or
    // already finished, can never be "the first time" for it, so there is
    // nothing left to decide. Without this, the stalled-cursor long-poll
    // re-pull (see `ConnectionManager.dedupWatermark`) redelivering this
    // same offer while its first prepared operation is still in flight (or
    // well after it already succeeded) would start a SECOND adapter session
    // for the same task, orphaning the first.
    if (this.tasks.has(taskId) || this.startupOwnership.has(taskId) || this.inFlightOffers.has(taskId) || this.finishedTaskIds.has(taskId) || this.strictDeclinedTaskIds.has(taskId)) {
      return;
    }

    let agentRef: AgentRef | undefined;
    if (strictAgentOffer) {
      try {
        agentRef = offeredAgentRef(payload);
      } catch (error) {
        this.decline(taskId, `invalid AgentRef: ${errorMessage(error)}`, false);
        return;
      }
      if (agentRef === undefined || this.deps.agentHome === undefined || this.deps.agentSessionHandoffs === undefined) {
        this.decline(
          taskId,
          'Agent offer requires the SDK-owned agent-home-contract layout and handoff store',
          false,
          agentRef,
        );
        return;
      }
    }
    const decline = (reason: string, retryable: boolean, code?: TaskDeclinePayload['code']): void => {
      this.decline(taskId, reason, retryable, agentRef, code);
    };
    const sessionRef = offeredSessionRef(payload);
    const homeAccess = offeredHomeAccess(payload);
    const readerAttempt = homeAccess === 'memory-reader';
    const homeBusyCode = readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy';
    // The prepared lane is selected by the presence of this value and nothing
    // else. Absent for every ordinary offer, so every branch below that does
    // not mention it behaves exactly as it did before this lane existed.
    const preparation = offeredPreparation(payload);
    const offeredMemory = 'agentMemory' in payload ? payload.agentMemory : undefined;
    if (preparation !== undefined && !PreparedAgentMemoryModeSchema.safeParse(offeredMemory).success) {
      decline('agent_memory_selection_invalid: prepared offers require an explicit memory selection', false);
      return;
    }
    // The prepared lane refused both `*-if-admitted` values above, so this view is exact there.
    const agentMemory = offeredMemory === 'read-if-admitted' || offeredMemory === 'read-write-if-admitted'
      ? undefined
      : offeredMemory;
    const preparedMemorySelected = preparation !== undefined && agentMemory !== 'none';
    // An ordinary Agent offer may select its own memory (#614). Absent keeps the
    // daemon admission: a writer `read-write`, a reader `read`, and `off` none.
    // An explicit selection is never changed to a smaller one, except
    // `read-if-admitted` and `read-write-if-admitted`, which run as `read` and
    // `read-write` when admitted and else `none` (#815, #833). Admission is read
    // once here; the runtime binding uses this answer.
    const ordinaryMemory = preparation === undefined ? offeredMemory : undefined;
    if ((ordinaryMemory === 'read-write' || ordinaryMemory === 'read-write-if-admitted') && readerAttempt) {
      decline('agent_memory_selection_invalid: a memory-reader Attempt reads memory only', false);
      return;
    }
    const memoryAdmitted = this.agentMemoryMcpAdmitted();
    if ((ordinaryMemory === 'read' || ordinaryMemory === 'read-write') && !memoryAdmitted) {
      decline('agent_memory_unavailable: this daemon does not admit the Agent memory MCP', false);
      return;
    }
    const ordinaryMemoryMode: PreparedAgentMemoryMode = ordinaryMemory === 'read-if-admitted'
      ? (memoryAdmitted ? 'read' : 'none')
      : ordinaryMemory === 'read-write-if-admitted'
        ? (memoryAdmitted ? 'read-write' : 'none')
        : ordinaryMemory ?? (this.deps.agentMemoryMcp === 'off' ? 'none' : readerAttempt ? 'read' : 'read-write');
    const ordinaryMemoryMcp = ordinaryMemoryMode !== 'none' && memoryAdmitted;
    const preparationLane = this.deps.inputPreparationLane;
    if (preparation !== undefined) {
      if (preparationLane === undefined) {
        // By name, not by reinterpretation. A daemon with no input-preparation
        // section holds no record this reference could mean, and running the
        // offer some other way would be running an Execution nobody counted.
        this.decline(taskId, 'preparation_lane_unconfigured: this daemon is not configured for input preparation', false, agentRef);
        return;
      }
      // BEFORE the first read. A restarted daemon reaches this line with a
      // store that nothing has opened yet, and an unopened store is not an
      // empty one — `get` refuses rather than answering `undefined`, so this
      // await is what turns a durable record back into a visible one.
      //
      // The redelivery guard above must hold across this await too. Without
      // the marker here, a second delivery of this offer under a new seq
      // passes the guard while this one waits, and then acts on a task this
      // delivery claims, starts or declines. The marker is released on both
      // exits and added again below, with no await in between.
      this.inFlightOffers.add(taskId);
      try {
        await preparationLane.open();
      } catch (error) {
        this.decline(
          taskId,
          `preparation_store_unavailable: the preparation store could not be opened: ${outboundErrorMessage(error)}`,
          false,
          agentRef,
        );
        return;
      } finally {
        this.inFlightOffers.delete(taskId);
      }
      if (preparationLane.store.get(preparation.reference) === undefined) {
        this.decline(taskId, 'preparation_not_found: no preparation record under this reference on this device', false, agentRef);
        return;
      }
    }
    const messageRequirement = 'messageEgress' in payload ? payload.messageEgress : undefined;
    const terminalProjection = 'terminalProjection' in payload ? payload.terminalProjection : undefined;
    if ('egressPolicy' in payload) {
      if (this.deps.agentEgressPolicy === undefined || !sameEgressPolicy(this.deps.agentEgressPolicy, payload.egressPolicy)) {
        decline('Agent egress offer policy is not exactly enabled by this daemon', false);
        return;
      }
    }
    if (messageRequirement !== undefined && (agentRef === undefined || (preparation === undefined && this.deps.agentMessageMcpBin === undefined) || this.deps.tenantId === undefined)) {
      decline('required Agent message egress is unavailable on this daemon', false);
      return;
    }
    if (terminalProjection?.mode === 'result-document') {
      if (agentRef === undefined || this.deps.tenantId === undefined || this.deps.agentResultMcpBin === undefined) {
        decline('offer requires a result document but this daemon cannot host the submit_result channel: it needs an Agent offer, an enrolled tenant and the SDK result helper', false);
        return;
      }
    }

    // Finding #5: mark this taskId as "in-flight" for the entire remainder
    // of this call — `evictPendingCancelled` must never remove a
    // `pendingCancelled` entry for a taskId in this set (see its own doc
    // comment and `inFlightOffers`'s class-level doc comment for the exact
    // counterexample this closes). The `finally` below clears it on every
    // exit path (decline, fail, the checkpoint-2 cancel-teardown, or
    // successful registration) — never leaked past this one call.
    this.inFlightOffers.add(taskId);
    const blobAbort = new AbortController();
    const startupDeadline = Date.now() + (this.deps.startupTimeoutMs ?? 30_000);
    const startupTimer = setTimeout(() => blobAbort.abort(new Error('runtime startup deadline exceeded during admission/start')),
      this.deps.startupTimeoutMs ?? 30_000);
    startupTimer.unref?.();
    const admissionWithdrawn = (): boolean => {
      if (!blobAbort.signal.aborted) return false;
      const cancelled = this.pendingCancelled.has(taskId);
      decline(cancelled ? 'cancelled before claim' : this.stoppingOffers ? 'daemon is shutting down' : 'runtime startup deadline exceeded', !cancelled);
      return true;
    };
    this.inFlightBlobAborts.set(taskId, blobAbort);
    let agentBinding: AgentHomeExecutionBinding | undefined;
    let gitLease: GitWorkspaceLease | undefined;
    // The one owner of the offer's leases, pin, and contexts at each moment.
    // Each change of owner happens on the same synchronous path as the
    // startup registration or the active handoff it names.
    let owner: 'offer' | 'startup' | 'active' = 'offer';
    let runtimeLaunch: PiRuntimeLaunchResources | undefined;
    let executionScratch: ExecutionScratch | undefined;
    let reservedHome: string | undefined;
    const releaseReservation = (): void => {
      if (reservedHome === undefined) return;
      const remaining = this.homeReservations.get(reservedHome)! - 1;
      if (remaining === 0) this.homeReservations.delete(reservedHome);
      else this.homeReservations.set(reservedHome, remaining);
      reservedHome = undefined;
    };
    const reserveHome = (reservationKey: string): void => {
      this.homeReservations.set(reservationKey, (this.homeReservations.get(reservationKey) ?? 0) + 1);
      reservedHome = reservationKey;
    };
    const phase: OfferPhaseContext = {
      taskId, decline, admissionWithdrawn, admissionSignal: blobAbort.signal, releaseReservation, reserveHome,
    };
    try {
      if (this.admitOffer(phase, strictAgentOffer) === undefined) return;

      if (agentRef !== undefined) {
        if (await this.reserveOfferHome(phase, agentRef, readerAttempt, sessionRef, homeAccess) === undefined) return;
      }

      const offerLimits = this.admitOfferLimits(phase, payload);
      if (offerLimits === undefined) return;
      const { requiredToolsets, resolvedMcp } = offerLimits;
      const runtime = await this.prepareOfferRuntime(phase, {
        acquireScratch: async () => {
          const scratch = await this.deps.scratchRoot.create();
          executionScratch = scratch;
          return scratch;
        },
        payload, agentRef, preparation, preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp, messageRequirement, terminalProjection,
        readerAttempt, requiredToolsets, resolvedMcp, blobAbort,
      });
      if (runtime === undefined) return;
      const { scratch, offered, pick, env, mcpEnv, mcpToolsetTools, prepared } = runtime;
      let taskMcpServers = runtime.taskMcpServers;

      if (agentRef !== undefined) {
        // A resumed reader runs again in the run directory its session handoff
        // recorded. The ledger lives in the home, so it is found by sessionRef.
        let readerRunDirectory: string | undefined;
        if (readerAttempt && sessionRef !== undefined) {
          try {
            const resolution = await this.deps.agentHome!.layout.resolve(agentRef);
            readerRunDirectory = await this.deps.agentSessionHandoffs!.readerSessionCwd({
              agentRef: resolution.agentRef,
              sessionRef,
              runtimeId: pick.descriptor.id,
              home: resolution.canonicalHome,
            });
          } catch (error) {
            decline(`Agent session handoff mismatch: ${outboundErrorMessage(error)}`, error instanceof AgentHomeBusyError,
              error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
            return;
          }
        }
        try {
          agentBinding = await this.deps.agentHome!.acquireExecution(agentRef, {
            taskId,
            sessionRef,
            homeAccess,
            ...(readerRunDirectory === undefined ? {} : { runDirectory: readerRunDirectory }),
          });
          releaseReservation();
        } catch (error) {
          decline(
            `Agent home admission failed: ${outboundErrorMessage(error)}`,
            error instanceof AgentHomeBusyError || !(error instanceof AgentHomeResolutionError),
            error instanceof AgentHomeBusyError ? homeBusyCode : undefined,
          );
          return;
        }
      }

      let known: Awaited<ReturnType<SessionWorkspaceStore['get']>> = undefined;
      let workspaceDir: string;
      let gitWorkspaceId: string | undefined;
      let gitBaseline: string | undefined;
      let gitExisting = false;
      let plainWorkspaceNeedsResolve = false;
      let appliedAgentHomeProjection: TerminalAgentHomeProjection | undefined;
      let readerMemoryBaseline: ActiveTask['readerMemoryBaseline'];
      if (agentBinding !== undefined) {
        workspaceDir = agentBinding.lease.cwd;
        if (sessionRef !== undefined) {
          try {
            await this.deps.agentSessionHandoffs!.requireMatch({
              agentRef: agentBinding.resolution.agentRef,
              sessionRef,
              runtimeId: pick.descriptor.id,
              home: agentBinding.resolution.canonicalHome,
              cwd: workspaceDir,
              ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
            });
          } catch (error) {
            await agentBinding.lease.release().catch(() => {});
            agentBinding = undefined;
            decline(`Agent session handoff mismatch: ${outboundErrorMessage(error)}`, false);
            return;
          }
        }
        if (readerAttempt) {
          const fresh = sessionRef === undefined;
          try {
            await this.deps.agentHome!.prepareReaderRun(agentBinding, { fresh });
          } catch (error) {
            await agentBinding.lease.release().catch(() => {});
            agentBinding = undefined;
            // A busy run directory (a redelivered task found a directory it
            // cannot reuse) may clear; every other failure is permanent.
            decline(error instanceof AgentHomeReaderRunMissingError
              ? `Agent session ${sessionRef} cannot resume: its reader run directory no longer exists`
              : `Agent reader run directory preparation failed: ${outboundErrorMessage(error)}`,
              error instanceof AgentHomeBusyError,
              error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
            return;
          }
        }
        try {
          await this.deps.agentHome!.initializeExecution(agentBinding);
        } catch (error) {
          await agentBinding.lease.release().catch(() => {});
          agentBinding = undefined;
          decline(`Agent home initialization failed: ${outboundErrorMessage(error)}`, error instanceof AgentHomeBusyError,
            error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
          return;
        }
        // Terminal evidence only (#318): an unreadable projection record must not
        // block an Attempt that ran before this evidence existed, so omit it.
        appliedAgentHomeProjection = await this.deps.agentHome!.readAppliedProjection(agentBinding).catch((error: unknown) => {
          console.warn(`[byok/client] Agent-home projection record is unreadable for ${taskId}; terminal evidence omits it: ${errorMessage(error)}`);
          return undefined;
        });
        // Evidence only (#317): the SDK does not make memory read-only. The
        // reader terminal compares this digest with one taken at the terminal.
        if (readerAttempt) {
          readerMemoryBaseline = { digest: await digestAgentHomeMemory(agentBinding.resolution.canonicalHome) };
        }
        if (messageRequirement !== undefined) {
          try {
            const outbox = await this.agentMessageOutbox(agentBinding.resolution.canonicalHome);
            this.pendingMessageTasks.set(taskId, {
              taskId,
              agentRef: agentBinding.resolution.agentRef,
              requirement: messageRequirement,
              outbox,
            });
          } catch (error) {
            await agentBinding.lease.release().catch(() => {});
            agentBinding = undefined;
            decline(`Agent message outbox initialization failed: ${outboundErrorMessage(error)}`, true);
            return;
          }
        }
        if (terminalProjection?.mode === 'result-document') {
          try {
            const store = await this.agentResultStore(agentBinding.resolution.canonicalHome);
            const context = this.resultContextByTask.get(taskId);
            if (context === undefined) throw new Error('the task result context was revoked before its Agent home was bound');
            context.store = store;
            context.agentRef = agentBinding.resolution.agentRef;
          } catch (error) {
            await agentBinding.lease.release().catch(() => {});
            agentBinding = undefined;
            decline(`Agent result store initialization failed: ${outboundErrorMessage(error)}`, true);
            return;
          }
        }
      } else if (this.deps.gitWorkspaceManager && this.deps.gitWorkspaceStore) {
        known = sessionRef ? await this.deps.sessionWorkspaces.get(sessionRef) : undefined;
        const gitManager = this.deps.gitWorkspaceManager;
        const gitStore = this.deps.gitWorkspaceStore;
        if (sessionRef) {
          const ledger = await gitStore.findBySessionAnyPhase(sessionRef).catch(() => undefined);
          const sameProtocolTask = ledger?.taskId === taskId;
          const interruptedOldTask = ledger?.phase === 'interrupted' && sameProtocolTask;
          const activeDifferentTask = ledger !== undefined && ledger.taskId !== taskId && (ledger.phase === 'preparing' || ledger.phase === 'active');
          if (!known || known.workspaceKind !== 'git' || !known.gitWorkspaceId || !ledger ||
              ledger.workspaceId !== known.gitWorkspaceId || ledger.sessionRef !== sessionRef ||
              path.resolve(ledger.workspaceDir) !== path.resolve(known.workspaceDir) ||
              interruptedOldTask || activeDifferentTask) {
            decline('session is incompatible with Git workspace mode', true);
            return;
          }
          workspaceDir = known.workspaceDir;
          gitWorkspaceId = known.gitWorkspaceId;
          gitBaseline = ledger.baseline;
          gitExisting = true;
          try {
            await gitManager.validateExisting(workspaceDir);
          } catch {
            decline('workspace is busy or unavailable', true);
            return;
          }
        } else {
          workspaceDir = this.legacyWorkspaceDir(taskId);
          gitWorkspaceId = randomUUID();
        }
        try {
          gitLease = await gitManager.acquireLease(workspaceDir, sessionRef);
        } catch {
          decline('workspace is busy or unavailable', true);
          return;
        }
      } else if (!this.deps.gitWorkspaceManager && !this.deps.gitWorkspaceStore) {
        known = sessionRef ? await this.deps.sessionWorkspaces.get(sessionRef) : undefined;
        workspaceDir = known?.workspaceDir ?? this.legacyWorkspaceDir(taskId);
        plainWorkspaceNeedsResolve = true;
      } else {
        decline('workspace mode is unavailable', true);
        return;
      }

      if (prepared.operation.resolveRuntimeLaunch !== undefined) {
        try {
          runtimeLaunch = await prepared.operation.resolveRuntimeLaunch({
            kind: preparation === undefined ? 'instruction' : 'prepared', cwd: workspaceDir, env,
            scratch,
          });
        } catch (error) {
          gitLease?.release();
          if (!admissionWithdrawn()) decline(`runtime launch admission failed: ${errorMessage(error)}`, false);
          return;
        }
        if (admissionWithdrawn()) { gitLease?.release(); return; }
      }

      // `env` was built before admission (see its declaration above) so the
      // MCP probes and the runtime child are guaranteed to share one
      // allowlist decision rather than two computations that could drift.
      const manifest = sealRuntimeOperationManifest({
        ...(preparation === undefined ? {} : {agentMemory}),
        taskId,
        runtimeId: pick.descriptor.id,
        descriptor: pick.descriptor,
        requiredToolsetIds: requiredToolsets ?? [],
        ...(offered.dispatchSelection === undefined ? {} : { dispatchSelection: offered.dispatchSelection }),
        ...(sessionRef === undefined || (known === undefined && agentBinding === undefined)
          ? {}
          : { sessionRef }),
        ...(agentBinding === undefined ? {} : {
          agentRef: agentBinding.resolution.agentRef,
          cwd: agentBinding.lease.cwd,
          ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
          lease: {
            leaseId: agentBinding.lease.leaseId,
            canonicalHome: agentBinding.resolution.canonicalHome,
          },
        }),
        cwd: workspaceDir,
        workspace: {
          workspaceDir,
          ...(gitWorkspaceId === undefined ? {} : { workspaceId: gitWorkspaceId }),
          ...(gitBaseline === undefined ? {} : { baseline: gitBaseline }),
        },
        forwardedEnvironmentNames: Object.freeze(Object.keys(env).sort()),
      });

      // The prepared lane's whole admission, in the one order it is allowed to
      // happen: COMPARE the sealed Execution against the record item by item,
      // then PIN, then claim. Pinning strictly before the claim is what makes
      // single consumption real — two runners that both compared successfully
      // race the store's compare-and-set, and the loser returns here having
      // sent no claim and dispatched nothing.
      let preparedLaunch: RuntimePreparedLaunchV1 | undefined;
      let preparedObservation: PreparedExecutionObservation | undefined;
      if (preparation !== undefined) {
        const lane = preparationLane!;
        const record = lane.store.get(preparation.reference);
        if (record === undefined) {
          gitLease?.release();
          decline('preparation_not_found: no preparation record under this reference on this device', false);
          return;
        }
        // Each memory admission stage declines with its own C5 `reason: detail`
        // pair, decided by the stage (or the typed error it raised), never by
        // reading an error message. Every one is before pin and claim, and no
        // raw helper/transport text reaches the wire.
        const declineMemory = (reason: string): void => {
          gitLease?.release();
          decline(reason, false);
        };
        if (agentMemory === undefined) {
          declineMemory('agent_memory_selection_invalid: prepared offers require an explicit memory selection');
          return;
        }
        if (record.binding.agentMemory !== agentMemory) {
          declineMemory('agent_memory_mismatch: the offered Agent memory selection differs from the named preparation');
          return;
        }
        try {
          await lane.authorizeAgentMemory(record.binding);
        } catch (error) {
          declineMemory(error instanceof InputPreparationRequestError
            ? `${error.code}: ${error.message}`
            : 'authority_unavailable: the local Agent memory authority could not be consulted');
          return;
        }
        let memory: PreparedAgentMemoryState | null = null;
        if (agentMemory !== 'none') {
          const describe = this.deps.agentMemoryDescribeBin;
          if (describe === undefined || this.deps.agentMemoryMcpBin === undefined
            || !isAgentMemorySecureFilesystemAvailable(this.deps.resolveAgentMemoryFilesystemHelperBin !== undefined)) {
            declineMemory('unsupported_input: agent_memory_unavailable');
            return;
          }
          try {
            memory = await observePreparedMemory(describe, mcpEnv, blobAbort.signal);
          } catch {
            declineMemory('toolsets_unobservable: agent_memory_descriptor_unobservable');
            return;
          }
        }
        // Only the toolsets this offer names: the preparation bound exactly the
        // revisions of the toolsets its record named, so binding every toolset
        // configured on the device would make an unrelated one a digest
        // mismatch. An unconfigured name was already declined above.
        const registryRevisions = lane.toolsetDefinitionRevisions();
        const revisions: Record<string, string> = {};
        for (const toolsetId of requiredToolsets ?? []) {
          const revision = registryRevisions.get(toolsetId);
          if (revision !== undefined) revisions[toolsetId] = revision;
        }
        const servers: PreparedOfferServerProjection[] = [];
        for (const [serverName, server] of Object.entries(resolvedMcp?.ok ? resolvedMcp.servers : {})) {
          const toolsetId = resolvedMcp!.toolsetIdByServer.get(serverName);
          if (toolsetId === undefined) continue;
          servers.push({
            serverName,
            toolsetId,
            command: server.command,
            args: Object.freeze([...(server.args ?? [])]),
          });
        }
        const admitted = await admitPreparedOffer({
          offeredAgentMemory: agentMemory, memory,
          terminalProjection,
          record,
          artifactPath: lane.store.artifactPathOf(record),
          offered: preparation,
          agentRef: agentRef!,
          deviceId: this.deps.deviceId,
          policyRevision: lane.policyRevision,
          runtime: lane.runtime,
          // No projected server (memory-only or tool-less) means an empty
          // observation, not a missing one; a missing one with servers still
          // present stays a fail-closed decline in admission.
          observation: mcpToolsetTools ?? (preparedMemorySelected || servers.length === 0 ? {} : undefined),
          servers,
          toolsetDefinitionRevisions: Object.freeze(revisions),
          nowMs: Date.now(),
        });
        if (!admitted.ok) {
          gitLease?.release();
          // Non-retryable, every one of them: re-offering the same reference
          // against the same device state reaches the same answer, and a
          // prepared failure never permits sending a DIFFERENT input under the
          // same accounting.
          decline(`${admitted.reason}: ${admitted.detail}`, false);
          return;
        }
        let pinned: Awaited<ReturnType<InputPreparationStore['pin']>>;
        try {
          pinned = await lane.store.pin(record.recordId, {
            taskId,
            manifestDigest: inputPreparationDigest(manifest),
            sealedAt: new Date().toISOString(),
          });
        } catch (error) {
          gitLease?.release();
          decline(`preparation_not_ready: the preparation pin could not be written: ${errorMessage(error)}`, false);
          return;
        }
        if (pinned.kind === 'occupied') {
          gitLease?.release();
          decline(
            `preparation_already_pinned: task ${JSON.stringify(pinned.record.pin!.taskId)} already consumed this preparation`,
            false,
          );
          return;
        }
        this.preparationPinsByTask.set(taskId, record.recordId);
        preparedLaunch = admitted.launch;
        // Seeded from the durable record the admission just compared, never
        // from the offer: the digest the Host ruled on and the window of the
        // model D was compiled for.
        preparedObservation = {
          requestDigest: record.artifact!.requestDigest,
          contextWindow: admitted.launch.expected.model.contextWindow,
          calls: 0,
        };
      }

      // All semantic admission is now in `prepare()` and the frozen manifest.
      // Claim is the first externally visible commitment; instruction bytes,
      // workspace preparation, and process creation remain after it.
      if (admissionWithdrawn()) { gitLease?.release(); return; }
      await this.deps.beforeClaim?.(taskId, manifest.descriptor.id);
      if (admissionWithdrawn()) { gitLease?.release(); return; }
      if (!isKnownRuntimeId(manifest.descriptor.id)) this.claimedHarnesses.set(taskId, manifest.descriptor.id);
      this.deps.send(
        createEnvelope(
          'task.claim',
          {
            deviceId: this.deps.deviceId,
            ...(manifest.agentRef === undefined ? {} : { agentRef: manifest.agentRef }),
            // M5 (claimed runtime, docs/protocol.md §3.1): the ACTUAL adapter
            // `pickAdapter` just selected — covers both the explicit-runtime
            // path (`payload.runtime` named one) and the auto-select
            // (preference-ordered, pi last by default — M5 batch-3, see
            // `DEFAULT_RUNTIME_PREFERENCE`) path (`payload.runtime` was
            // absent) uniformly, since `pick.adapter` already reflects
            // whichever one won either way. Distinct from `payload.runtime`
            // (the merely REQUESTED runtime): this is what closes the gap
            // where an auto-selected task left the server never learning
            // which runtime actually ran.
            runtime: isKnownRuntimeId(manifest.descriptor.id) ? manifest.descriptor.id : undefined,
            ...(!isKnownRuntimeId(manifest.descriptor.id) ? { harnessId: manifest.descriptor.id } : {}),
            // S0/D-4 (`task.claim.capabilities`, docs/protocol.md §2.4): the
            // selected adapter's own capability self-report, carried on the
            // same message that establishes the task↔runtime binding. The
            // server gates control messages (`task.steer`) on this and only
            // this — connection-level `conn.hello.runtimes[].capabilities`
            // stays device discovery on both transports and cannot replace
            // the claim-time truth for this exact task/runtime binding.
            //
            // Sent UNCONDITIONALLY, deliberately NOT gated on
            // `isKnownRuntimeId` the way `runtime` above is: `runtime` is a
            // closed protocol enum a custom adapter has no member of, but
            // capabilities are a self-report every adapter can make honestly.
            // Gating them would silently strip a custom steer-capable
            // adapter's own truth and leave the server fail-closing on it
            // forever.
            capabilities: toRuntimeInfoCapabilities(manifest.descriptor.capabilities),
          },
          { taskId },
        ),
      );

      // Resolve the instruction blob after claim; workspace preparation follows.
      // A prepared Execution resolves nothing here — it carries no instruction,
      // and the empty string below is never read: the prepared start variant has
      // no `instruction` field for it to reach.
      const offeredInstructionValue = offeredInstruction(payload);
      let resolvedInstruction: string;
      try {
        resolvedInstruction = offeredInstructionValue === undefined
          ? ''
          : await this.resolveInstruction(offeredInstructionValue, blobAbort.signal);
        if (plainWorkspaceNeedsResolve) workspaceDir = await this.resolveWorkspaceDir(taskId, known?.workspaceDir);
      } catch (err) {
        gitLease?.release();
        const reason = `failed to resolve instruction blob: ${errorMessage(err)}`;
        if (agentBinding === undefined) {
          await this.fail(taskId, reason, true);
        } else {
          await this.failClaimedAgent(taskId, reason, true, {
            binding: agentBinding,
            runtimeId: pick.descriptor.id,
          });
        }
        return;
      }

      if (this.deps.gitWorkspaceManager && gitLease) {
        try {
          let observation: GitWorkspaceObservation;
          if (gitExisting) {
            observation = await this.deps.gitWorkspaceManager.validateExisting(workspaceDir);
          } else {
            const workspaceId = gitWorkspaceId ?? randomUUID();
            const now = new Date().toISOString();
            gitWorkspaceId = workspaceId;
            await this.deps.gitWorkspaceStore?.upsert({
              workspaceId,
              taskId,
              workspaceDir,
              phase: 'preparing',
              commitsSinceBaseline: 0,
              staged: 0,
              unstaged: 0,
              untracked: 0,
              conflicted: 0,
              createdAt: now,
              updatedAt: now,
            });
            this.deps.onGitWorkspaceEvent?.({ taskId, workspaceId, phase: 'preparing' });
            observation = await this.deps.gitWorkspaceManager.prepareFresh(workspaceDir);
          }
          const workspaceId = gitWorkspaceId ?? randomUUID();
          const phase: GitWorkspacePhase = 'active';
          const now = new Date().toISOString();
          const ledgerRecord: GitWorkspaceLedgerRecord = {
            workspaceId,
            taskId,
            workspaceDir,
            sessionRef,
            phase,
            baseline: gitBaseline ?? observation.head,
            current: observation.head,
            commitsSinceBaseline: observation.commitsSinceBaseline,
            staged: observation.staged,
            unstaged: observation.unstaged,
            untracked: observation.untracked,
            conflicted: observation.conflicted,
            createdAt: now,
            updatedAt: now,
          };
          await this.deps.gitWorkspaceStore?.upsert(ledgerRecord);
          this.deps.onGitWorkspaceEvent?.({ taskId, workspaceId, phase, observation });
          gitWorkspaceId = workspaceId;
          gitBaseline = gitBaseline ?? observation.head;
        } catch (err) {
          const category = (err as GitWorkspaceError).category ?? 'repository-invalid';
          await this.updateGitPhaseBestEffort(gitWorkspaceId, 'failed', category);
          gitLease.release();
          this.deps.onGitWorkspaceEvent?.({ taskId, workspaceId: gitWorkspaceId ?? '', phase: 'failed', errorCategory: category });
          await this.fail(taskId, 'Git workspace preparation failed', true);
          return;
        }
      }

      if (preparedLaunch !== undefined && preparedLaunch.agentMemory !== 'none') {
        // Post-claim: a failure here is a truthful task failure, never a raw
        // throw that strands the claimed task. The finally below revokes any
        // context token minted for it and releases the pin.
        try {
          const helper = this.deps.agentMemoryMcpBin;
          if (preparedLaunch.memory === null || agentRef === undefined || helper === undefined) throw new Error('prepared Agent memory execution state missing');
          taskMcpServers = this.withAgentMemoryMcp(taskMcpServers, taskId, agentRef, preparedLaunch.agentMemory, helper, 'complete');
        } catch {
          const reason = 'agent_memory_unavailable: the sealed Agent memory helper could not be bound for launch';
          await this.updateGitPhaseBestEffort(gitWorkspaceId, 'failed');
          gitLease?.release();
          if (agentBinding === undefined) {
            await this.fail(taskId, reason, false);
          } else {
            await this.failClaimedAgent(taskId, reason, false, {
              binding: agentBinding,
              runtimeId: pick.descriptor.id,
            });
          }
          return;
        }
      }
      const durableBinding = agentBinding;
      const startInput: RuntimeOperationStartInput = {
        scratch,
        ...(runtimeLaunch?.kind !== 'pi-durable' ? {} : { durableContext: {
          tenantId: this.deps.tenantId!, replicaRoot: path.join(this.deps.storeDir, 'durable-replicas'), lifecycle: {
            ownsLease: () => durableBinding !== undefined && !blobAbort.signal.aborted && !this.pendingCancelled.has(taskId),
            record: async (kind: 'tool-intent' | 'tool-committed' | 'respawn-intent', ordinal: number) => {
              if (!durableBinding || !this.deps.recordDurableTransition || !this.deps.tenantId) throw new Error('durable parent authority unavailable');
              await this.deps.agentHome!.executionLeaseManager.mutate(durableBinding, () => {
                // Do not overwrite a persisted normal-turn failure intent.
                if (this.tasks.get(taskId)?.resultReplyFailure !== undefined) return Promise.resolve();
                return this.deps.recordDurableTransition!(taskId, durableBinding.lease.leaseId, kind, ordinal);
              });
            },
          },
        } }),
        mcpEnv,
        ...(runtimeLaunch === undefined ? {} : { runtimeLaunch }),
        // The two lanes are mutually exclusive authority over the same bytes,
        // so they are two variants rather than one shape with an optional
        // field: the prepared Execution's request was compiled, counted and
        // frozen before this offer existed, and the ordinary one's is the
        // instruction resolved above. `preparedLaunch` is set ONLY after the
        // item-by-item comparison passed, the manifest was sealed, the record
        // was pinned and the claim went out.
        ...(preparedLaunch === undefined
          ? {
            kind: 'instruction' as const,
            instruction: agentBinding === undefined
              ? (gitWorkspaceId ? prependGitWorkspaceGuidance(resolvedInstruction) : resolvedInstruction)
              : prependAgentMemoryModeGuidance(resolvedInstruction, ordinaryMemoryMode, readerAttempt),
          }
          : { kind: 'prepared' as const, preparation: preparedLaunch }),
        manifest,
        env,
        ...(taskMcpServers === undefined ? {} : { mcpServers: taskMcpServers }),
        ...(mcpToolsetTools === undefined ? {} : { mcpToolsetTools }),
        approvalChannel: {
          taskId,
          storeDir: this.deps.storeDir,
          productId: this.deps.productId,
          timeoutMs: this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          resolve: async (approved, reason) => {
            const currentActive = this.tasks.get(taskId);
            const pendingId = currentActive?.pendingApprovalId;
            if (!pendingId) {
              throw new NoPendingApprovalError(taskId);
            }
            // 'wire': this closure is invoked ONLY by an adapter's own
            // `session.resolveApproval()` on a custom adapter, which is called from
            // `handleApprove`/`handleReject` below — i.e. a server-sent wire
            // `task.approve`/`task.reject`. The server already knows this
            // decision (it sent it); `task.approval_resolved` must never be
            // sent back for it — see `ApprovalOrigin`'s own doc comment
            // (`approvals.ts`) and `sendApprovalResolved`'s gate below.
            this.deps.approvalRegistry.resolve(pendingId, approved ? 'approve' : 'reject', reason, 'wire');
          },
        },
      };
      let session: Session;
      try {
        session = await startOwnedRuntime(input => prepared.operation.start(input), startInput, blobAbort.signal,
          Math.max(0, startupDeadline - Date.now()));
      } catch (err) {
        const disposalFailure = isRuntimeStartupDisposalFailure(err);
        const cancelled = this.pendingCancelled.has(taskId);
        if (disposalFailure || cancelled) {
          if (cancelled) {
            this.revokeAgentMessageContext(taskId);
            this.revokeAgentResultContext(taskId);
          }
          const ownedBinding = agentBinding;
          const cancellation = createEnvelope('task.cancelled', {
            reason: this.pendingCancelled.get(taskId),
            ...terminalIdentity(this.claimedHarnesses.get(taskId)),
            ...(agentBinding === undefined ? {} : { agentRef: agentBinding.resolution.agentRef }),
          }, { taskId });
          let cancellationSettled = false;
          const abortedStart = abortedStartOf(err);
          this.startupOwnership.register(taskId, {
            runtimeId: pick.descriptor.id,
            ...(abortedStart === undefined ? {} : { abortedStart }),
            dispose: async () => { if (disposalFailure) await err.retryDisposal(); await scratch.release(); },
            ...(cancelled ? { settle: async () => {
              if (cancellationSettled) return;
              // Retain startup ownership on a failed durable barrier, just as
              // active cancellation retains its owner until terminal evidence.
              await this.pendingMessageTasks.get(taskId)?.outbox.revoke(taskId);
              this.deps.send(cancellation);
              cancellationSettled = true;
              this.pendingCancelled.delete(taskId);
              this.addFinishedTaskId(taskId);
            } } : {}),
            release: async () => {
              await ownedBinding?.lease.release();
              gitLease?.release();
              await this.releasePreparationPin(taskId);
            },
          });
          owner = 'startup';
          // An abort while the start still runs is not a disposal failure:
          // nothing has been disposed yet. `StartupOwnership.dispose` reports
          // it if a later attempt fails.
          if (disposalFailure && abortedStart === undefined) this.deps.onRuntimeDisposalFailure?.({ taskId,
            runtimeId: pick.descriptor.id, stage: 'quiescence', reason: err.message });
          if (!cancelled) {
            const reason = this.stoppingOffers ? 'daemon shutting down during runtime startup' : errorMessage(err);
            const retryable = this.stoppingOffers;
            if (agentBinding === undefined) await this.fail(taskId, reason, retryable);
            else await this.failClaimedAgent(taskId, reason, retryable, {
              binding: agentBinding, runtimeId: pick.descriptor.id,
            });
          }
          return;
        }
        const failure = projectRuntimeBoundaryFailure(err, 'start');
        if (failure.contractViolation) {
          // Never the error object itself: stderr is a service log and an
          // adapter's error can carry runtime output (issue #395).
          console.error(`[byok/client] runtime adapter ${pick.descriptor.id} start() returned an untyped failure for task ${taskId}`);
        }
        await this.updateGitPhaseBestEffort(gitWorkspaceId, 'failed', 'repository-invalid');
        gitLease?.release();
        if (agentBinding === undefined) {
          await this.fail(taskId, failure.reason, failure.retryable, failure.failure);
        } else {
          await this.failClaimedAgent(taskId, failure.reason, failure.retryable, {
            binding: agentBinding,
            runtimeId: pick.descriptor.id,
          }, failure.failure);
        }
        return;
      }

      const ownedBinding = agentBinding;
      this.startupOwnership.register(taskId, {
        runtimeId: pick.descriptor.id,
        dispose: async () => { await session.close(); await scratch.release(); },
        release: async () => {
          await ownedBinding?.lease.release();
          gitLease?.release();
          await this.releasePreparationPin(taskId);
        },
      });
      owner = 'startup';
      try {
      if (agentBinding !== undefined) {
        try {
          await agentBinding.lease.bindSession(session.sessionRef);
        } catch (error) {
          await this.failClaimedAgent(
            taskId,
            `Agent session execution lease could not bind the runtime session: ${outboundErrorMessage(error)}`,
            false,
            {
              binding: agentBinding,
              runtimeId: pick.descriptor.id,
              sessionRef: session.sessionRef,
            },
          );
          return;
        }
      }

      let active!: ActiveTask;
      active = {
        taskId,
        blobAbort,
        egressEnabled: 'egressPolicy' in payload,
        adapter: pick.adapter,
        session,
        scratch,
        workspaceDir,
        ...(agentBinding === undefined ? {} : {
          agentBinding,
          agentRef: agentBinding.resolution.agentRef,
          agentHandoff: {
            sessionRef: session.sessionRef,
            runtimeId: pick.descriptor.id,
            home: agentBinding.resolution.canonicalHome,
            cwd: workspaceDir,
            ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
          },
          ...(appliedAgentHomeProjection === undefined ? {} : { appliedAgentHomeProjection }),
          ...(readerMemoryBaseline === undefined ? {} : { readerMemoryBaseline }),
        }),
        gitWorkspaceId,
        gitLease,
        gitBaseline,
        summaryParts: [],
        finalTextParts: [],
        batcher: new ProgressBatcher(
          (seq, events) => {
            const projected = active.egressEnabled
              ? this.deps.agentEgress?.projectLatestValue({
                  agentRef: active.agentRef,
                  taskId,
                  events,
                }) ?? []
              : events;
            if (projected.length > 0) this.deps.send(createEnvelope('task.progress', { seq, events: [...projected] }, { taskId, seq }));
          },
          this.deps.batcherOptions,
          () => this.ingressBudget,
        ),
        approvalQueue: [],
        outputBytesSoFar: 0,
        startedAtMs: Date.now(),
        executionRecord: new ExecutionRecordAccumulator(taskId, pick.descriptor.trajectoryEvidence, session),
        ...(preparedObservation === undefined ? {} : { prepared: preparedObservation }),
        ...(messageRequirement === undefined ? {} : {
          messageRequirement,
          messageOutbox: this.pendingMessageTasks.get(taskId)!.outbox,
        }),
        ...(terminalProjection === undefined ? {} : { terminalProjection }),
        ...(terminalProjection?.mode !== 'result-document' ? {} : { resultStore: this.resultContextByTask.get(taskId)?.store }),
      };
      // #654 D9: a task with sealing streams no draft (design §6.1, §10.4).
      if (active.messageRequirement !== undefined && active.agentRef !== undefined
        && pick.descriptor.capabilities.messageDraft === true
        && this.deps.getServerCapabilities?.().includes('agent-message-draft')
        && this.deps.sealedTasks?.isSealed(taskId) !== true) {
        active.messageDraft = new AgentMessageDraftPublisher({
          taskId,
          agentRef: active.agentRef,
          maxBytes: active.messageRequirement.maxBytes,
          maxCoalesceMs: this.deps.agentEgressPolicy!.activity.maxCoalesceMs,
          getServerCapabilities: () => this.deps.getServerCapabilities?.() ?? [],
          send: envelope => this.deps.send(envelope),
        });
      }

      // A strict Agent handoff is the local restart authority. It is
      // intentionally awaited and fsynced before task.started; an Agent
      // runtime session that has no durable exact-match receipt must never be
      // advertised as resumable.
      if (agentBinding !== undefined) {
        const binding = agentBinding;
        try {
          await this.deps.agentHome!.mutateExecution(binding, () =>
            this.deps.agentSessionHandoffs!.record({
              agentRef: binding.resolution.agentRef,
              taskId,
              sessionRef: session.sessionRef,
              runtimeId: pick.descriptor.id,
              home: binding.resolution.canonicalHome,
              cwd: workspaceDir,
              ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
              leaseId: binding.lease.leaseId,
            }));
        } catch (error) {
          await this.failClaimedAgent(
            taskId,
            `Agent session handoff could not be durably written before start: ${outboundErrorMessage(error)}`,
            false,
            {
              binding: agentBinding,
              runtimeId: pick.descriptor.id,
              sessionRef: session.sessionRef,
            },
          );
          return;
        }
      }
      const activatedMessageRecord = active.messageOutbox === undefined
        ? undefined
        : await this.activateAgentMessage(active.messageOutbox, taskId, session.sessionRef,
          () => !this.pendingCancelled.has(taskId) && !blobAbort.signal.aborted);

      // Finding F4, checkpoint 2 ("consulted when start() resolves"): a
      // task.cancel arrived while prepared-operation start() was in flight — i.e. AFTER
      // task.claim already went out above, so declining is no longer an
      // option. Tear the just-started session down before it's ever
      // registered as active (this.tasks.set below) or reported task.started,
      // so pump() never begins and no zombie turn runs — then report the
      // outcome exactly like a post-registration cancel would (M1 gap #6:
      // task.cancelled, not task.fail).
      if (this.pendingCancelled.has(taskId)) {
        const reason = this.pendingCancelled.get(taskId);
        this.pendingCancelled.delete(taskId);
        this.startupOwnership.transferToActive(taskId);
        this.tasks.set(taskId, active);
        owner = 'active';
        await this.settleSemanticTerminal(active, async () => {
          active.eventPump ??= this.pump(active);
          await this.interruptBounded(active);
          await this.updateGitPhaseBestEffort(gitWorkspaceId, 'cancelled');
          await this.persistAgentTerminalEvidence(active, 'cancelled', reason);
          return createEnvelope('task.cancelled', {
            reason, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active),
          }, { taskId });
        });
        return;
      }

      // Claimed -> Running (M1 gap #2): report `task.started` only once the
      // adapter session has actually started — never implied by `task.claim`.
      this.deps.send(createEnvelope('task.started', {}, { taskId }));

      // This handoff (construct `active` -> register it -> kick off `pump()`)
      // must stay synchronous, with no `await` in between: a `task.cancel`
      // (or `task.steer`/`task.approve`/`task.reject`) for this exact taskId
      // can arrive and be processed by `handleEnvelope` at any `await` point,
      // and every one of those handlers starts with `this.tasks.get(taskId)`
      // — if this task isn't registered yet, they silently no-op (see e.g.
      // `handleCancel`). An earlier version of this method awaited the
      // sessionWorkspaces write (below) before registering `active` and broke
      // exactly this: a cancel racing a task.offer lost its `interrupt()`/
      // `task.cancelled` entirely.
      this.inFlightBlobAborts.delete(taskId);
      this.startupOwnership.transferToActive(taskId);
      this.tasks.set(taskId, active);
      owner = 'active';
      this.pendingMessageTasks.delete(taskId);
      if (active.messageOutbox !== undefined && activatedMessageRecord !== undefined) {
        this.sendAgentMessageRecord(active.messageOutbox, activatedMessageRecord);
      }
      // M5 batch-3 (workstream 2): see `armMaxDurationTimer`'s own doc
      // comment — still inside the synchronous construct -> register -> arm
      // -> pump handoff described just below (no `await` yet).
      if (payload.limits?.maxDurationMs !== undefined) {
        this.armMaxDurationTimer(active, payload.limits.maxDurationMs);
      }
      active.eventPump = this.pump(active);

      // Record (or refresh) this session's resumable workspace for any future
      // task.offer that carries the same sessionRef, fire-and-forget:
      // `session.sessionRef` is always the adapter's real, resumable
      // identifier (see PiSession / resolveFreshSessionId) whether or not
      // *this* dispatch was itself a resume. Deliberately not awaited — see
      // the comment above; losing this mapping only costs a future resume
      // opportunity, never the correctness of the task in progress.
      if (agentBinding === undefined) {
        void this.deps.sessionWorkspaces
          .record(session.sessionRef, {
            workspaceDir,
            runtimeSessionId: session.sessionRef,
            ...(gitWorkspaceId ? { workspaceKind: 'git' as const, gitWorkspaceId } : {}),
          })
          .catch(() => {});
      }
      if (gitWorkspaceId && this.deps.gitWorkspaceStore) {
        void this.deps.gitWorkspaceStore.attachSession(gitWorkspaceId, session.sessionRef).catch(() => {});
      }
      } catch (error) {
        if (this.tasks.has(taskId)) throw error;
        const reason = `runtime activation failed: ${outboundErrorMessage(error)}`;
        if (agentBinding === undefined) await this.fail(taskId, reason, false);
        else await this.failClaimedAgent(taskId, reason, false, {
          binding: agentBinding, runtimeId: pick.descriptor.id, sessionRef: session.sessionRef,
        });
      }
    } finally {
      clearTimeout(startupTimer);
      releaseReservation();
      try {
        if (owner === 'startup') {
          // Startup release must succeed. The startup owner releases the
          // leases and the preparation pin only after the disposal receipt
          // and the terminal commit. A failed release keeps the owner, and
          // StartupOwnership retries it.
          await this.startupOwnership.dispose(taskId);
        }
        if (owner === 'offer') {
          // Offer release is best effort. The offer never became an
          // Execution: it declined, failed, threw, or was cancelled before
          // `start()` published a session. Each early exit already released
          // its leases before it declined or failed; these calls only cover
          // a throw, and each release is idempotent. The nonces minted for
          // its would-be children die with it.
          this.pendingMessageTasks.delete(taskId);
          this.revokeAgentMessageContext(taskId);
          this.revokeAgentResultContext(taskId);
          this.revokeAgentMemoryContext(taskId);
          this.deleteHostToolsetContexts(taskId);
          await agentBinding?.lease.release().catch(() => {});
          gitLease?.release();
          await this.releasePreparationPin(taskId);
        }
        // An active task's Session owns the runtime launch. The projection
        // holds env or IPC references, not the key, so removing it does not
        // revoke a credential. Its cleanup timing for a retained startup
        // stays unchanged here.
        if (owner === 'offer' && executionScratch !== undefined) {
          try { await executionScratch.release(); }
          catch (error) {
            this.deps.scratchRoot?.abandon(executionScratch.token);
            this.deps.onRuntimeDisposalFailure?.({ taskId, runtimeId: 'scratch', stage: 'cleanup', reason: 'offer scratch disposal did not complete' });
            throw error;
          }
        }
      } finally {
        this.inFlightBlobAborts.delete(taskId);
        this.inFlightOffers.delete(taskId);
        this.claimedHarnesses.delete(taskId);
      }
    }
  }

  private admitOffer(phase: OfferPhaseContext, strictAgentOffer: boolean): true | undefined {
    const { taskId, decline } = phase;
    // Finding F4, checkpoint 1 ("before claim where possible -> decline
    // path"): a task.cancel already arrived for this exact taskId before
    // this offer was even looked at. Decline outright — never claim, never
    // spawn a runtime session for a task that's already dead. Checked first
    // (ahead of every other pre-claim check below) so a pre-cancelled offer
    // costs nothing beyond this map lookup.
    if (this.pendingCancelled.has(taskId)) {
      const reason = this.pendingCancelled.get(taskId);
      this.pendingCancelled.delete(taskId);
      decline(reason ? `cancelled before claim: ${reason}` : 'cancelled before claim', false);
      return undefined;
    }

    // Gate A strict local authority: journal receive precedes this runner,
    // and dedup plus pre-cancel above retain their established precedence.
    // This is deliberately before admission, adapter preparation, workspace
    // materialization, claim, start, or any terminal receipt bookkeeping.
    if (this.deps.strictAgentOnly === true && !strictAgentOffer) {
      this.addStrictDeclinedTaskId(taskId);
      decline('strict Agent-only daemon refuses legacy task offers', false);
      return undefined;
    }
    return true;
  }

  private async reserveOfferHome(
    phase: OfferPhaseContext,
    agentRef: AgentRef,
    readerAttempt: boolean,
    sessionRef: string | undefined,
    homeAccess: AgentHomeAccessMode,
  ): Promise<true | undefined> {
    const { taskId, decline, admissionWithdrawn, admissionSignal, reserveHome } = phase;
    // WP0 (canonical Agent home single writer): execution is serialized per
    // canonical Agent home. Placed exactly here — after the receive, dedup,
    // pre-cancel and strict-Agent-only precedence above, before adapter
    // preparation, the workspace, the claim, or any process side effect —
    // so a duplicate or pre-cancelled offer returns above without ever
    // consuming a slot, and a busy home costs the offer nothing beyond this
    // count.
    //
    // Counted per HOME, not per lane: two different runtimes on two
    // different lanes still share `MEMORY.md`, `notes/` and `.git` in that
    // one directory, and only a per-home count stops them co-writing it.
    // The decline reason carries counts only — never a path, never prompt
    // text — because `task.decline` leaves this device.
    //
    // Canonical-home reservations bridge this check and lease acquisition.
    // Different homes may start concurrently; check-and-reserve has no await.
    //
    // #476: an Attempt whose semantic terminal is already published still
    // holds its lease until `finishOnce` releases it after `Session.close()`,
    // the terminal commit and the memory snapshot. A Host that offers the
    // same home right after observing that terminal would otherwise race the
    // release. So when the count is at the limit and enough of it belongs to
    // this runner's Attempts that are already finishing (finalization started
    // and an in-flight finalization attempt), admission waits ONCE for those
    // attempts to settle (or for the offer to be withdrawn), then recounts
    // from the lease registry and reserves or declines exactly as without the
    // wait. A finished Attempt with no in-flight finalization (failed
    // disposal, retained ownership) is a live holder and is never waited on.
    // Once offers are stopping, there is no wait at all.
    // The lease registry stays the only admission authority; the wait only
    // decides when to read it.
    //
    // The count key is derived with `canonicalHomePath()`, NOT `resolve()`:
    // this gate runs before the host's own admission veto, so it must not
    // create `agents/<agentId>` or bind an Agent identity for an offer that
    // is about to be declined. `resolve()` still runs later, on the
    // admission path, for an offer that actually executes.
    //
    // Writers and `memory-reader` Attempts are counted apart: one writer,
    // and up to `maxConcurrentReaderAttemptsPerAgentHome` readers, each in
    // its own run directory. A fresh reader names that directory after its
    // taskId, so a taskId that is not one plain path segment is refused here,
    // before any side effect.
    if (readerAttempt && sessionRef === undefined && !isReaderRunName(taskId)) {
      decline('a memory-reader Attempt needs a taskId that is one plain path segment ([A-Za-z0-9._-], at most 128 characters)', false);
      return undefined;
    }
    const limit = readerAttempt ? this.maxConcurrentReaderAttemptsPerAgentHome : 1;
    let canonicalHome: string;
    try {
      canonicalHome = await this.deps.agentHome!.layout.canonicalHomePath(agentRef);
    } catch (error) {
      decline(
        `Agent home admission failed: ${outboundErrorMessage(error)}`,
        !(error instanceof AgentHomeResolutionError),
        error instanceof AgentHomeBusyError
          ? readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy'
          : undefined,
      );
      return undefined;
    }
    if (admissionWithdrawn()) return undefined;
    const reservationKey = `${homeAccess}\0${canonicalHome}`;
    const countHome = (): number => this.deps.agentHome!.executionLeaseManager.activeAttemptCount(canonicalHome, homeAccess)
      + (this.homeReservations.get(reservationKey) ?? 0);
    let active = countHome();
    // A daemon that is stopping never parks an offer: `stopAcceptingOffers`
    // aborts only the admission signals that existed when it ran, so an offer
    // that arrived after it would otherwise wait on a finishing Attempt.
    if (active >= limit && !this.stoppingOffers) {
      const finishing = this.homeFinalizations(canonicalHome, homeAccess);
      if (finishing.length > 0 && active - finishing.length < limit) {
        await settledOrWithdrawn(finishing, admissionSignal);
        if (admissionWithdrawn()) return undefined;
        active = countHome();
      }
    }
    if (active >= limit) {
      decline(`agent home busy: ${active} active ${readerAttempt ? 'reader ' : ''}attempt(s)`, true,
        readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy');
      return undefined;
    }
    // Check and reserve are synchronous at the canonical-home authority.
    reserveHome(reservationKey);
    return true;
  }

  private admitOfferLimits(phase: OfferPhaseContext, payload: AcceptedOfferPayload) {
    const { taskId, decline } = phase;
    // S3b (L-002): the pre-claim admission veto stays after the strict
    // receive/dedup/cancel precedence above and before every runtime or
    // workspace side effect.
    const guarded = this.deps.admissionGuard?.({ taskId, payload });
    if (guarded !== undefined && !guarded.admit) {
      decline(guarded.reason, guarded.retryable);
      return undefined;
    }

    // M4 Phase 2: the control socket's `shutdown` RPC flips this before
    // tearing down active tasks — any later offer is declined outright.
    if (this.stoppingOffers) {
      decline('daemon is shutting down', true);
      return undefined;
    }

    // M5 batch-3 (workstream 1): `limits.maxTokens` has no hard-enforcement
    // path on ANY bundled runtime adapter today — nothing actually counts
    // or caps tokens against it. Silently accepting the offer would let a
    // caller believe a token ceiling is in effect when nothing checks it;
    // declining fail-closed, pre-claim, is honest about that gap and lets
    // the dispatcher route the task elsewhere instead of running
    // unbounded. `retryable: true` — a different device's adapter set (or
    // a future SDK version) might genuinely enforce this, so re-routing
    // can help even though nothing here can. `limits.maxDurationMs` is
    // deliberately left OUT of this admission gate: unlike maxTokens, it
    // IS hard-enforced — daemon-authoritative, at the TaskRunner layer
    // itself (a wall-clock timer armed once this task is registered as
    // active — see `armMaxDurationTimer` — not delegated to any adapter),
    // so there is no gap here to decline fail-closed for.
    if (payload.limits?.maxTokens !== undefined) {
      decline(
        `offer requests limits.maxTokens (${payload.limits.maxTokens}), which no bundled runtime adapter enforces — declining fail-closed rather than silently ignoring it`,
        true,
      );
      return undefined;
    }

    if (
      payload.dispatchSelection !== undefined &&
      payload.runtime !== undefined &&
      payload.runtime !== payload.dispatchSelection.runtimeId
    ) {
      decline(
        `offer runtime ${payload.runtime} does not match dispatchSelection.runtimeId ${payload.dispatchSelection.runtimeId}`,
        false,
      );
      return undefined;
    }

    if (payload.harnessId !== undefined && (payload.runtime !== undefined || payload.dispatchSelection !== undefined)) {
      decline('harnessId cannot be combined with a built-in runtime selection', false);
      return undefined;
    }
    if (payload.harnessId !== undefined && !(this.deps.getServerCapabilities?.() ?? []).includes('custom-harness')) {
      decline('server does not support custom-harness identity', false);
      return undefined;
    }
    const requiredToolsets = 'requiredToolsets' in payload ? payload.requiredToolsets : undefined;
    const resolvedMcp = requiredToolsets ? this.resolveMcpServers(requiredToolsets) : undefined;
    if (resolvedMcp && !resolvedMcp.ok) {
      decline(resolvedMcp.reason, true);
      return undefined;
    }
    return { requiredToolsets, resolvedMcp };
  }

  private async prepareOfferRuntime(phase: OfferPhaseContext, input: OfferRuntimeInput) {
    const { taskId, decline, admissionWithdrawn } = phase;
    const {
      payload, agentRef, preparation, preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp, messageRequirement, terminalProjection,
      readerAttempt, requiredToolsets, resolvedMcp, blobAbort,
    } = input;
    const offered = withoutRequiredToolsets(payload);
    const requestedRuntime = payload.harnessId ?? payload.dispatchSelection?.runtimeId ?? payload.runtime;
    const requiresAgentMemoryMcp = preparation === undefined && agentRef !== undefined && ordinaryMemoryMcp;
    let pick: PickResult;
    try {
      pick = await this.pickAdapter(
        requestedRuntime,
        requiredToolsets !== undefined
          || (preparation === undefined && (messageRequirement !== undefined || terminalProjection?.mode === 'result-document'))
          || requiresAgentMemoryMcp || preparedMemorySelected,
        blobAbort.signal,
      );
    } catch (error) {
      if (!admissionWithdrawn()) decline(`runtime detection failed: ${outboundErrorMessage(error)}`, true);
      return undefined;
    }
    if (admissionWithdrawn()) return undefined;
    if (!pick.ok) {
      decline(pick.reason, pick.retryable);
      return undefined;
    }
    if (readerAttempt && pick.descriptor.capabilities.durablePi === true) {
      // Durable Pi binds its replica to the canonical home as its cwd.
      decline('durable Pi runs only in the canonical Agent home; it does not run memory-reader Attempts', false);
      return undefined;
    }
    if (!isKnownRuntimeId(pick.descriptor.id) && !(this.deps.getServerCapabilities?.() ?? []).includes('custom-harness')) {
      decline('server does not support the selected custom harness identity', false);
      return undefined;
    }
    // Scratch-free declines do not own an Execution resource or contend on
    // its store gate. Acquire it at the first consumer; handleOffer retains
    // ownership across this await and releases it on every pre-start exit.
    const scratch = await input.acquireScratch();
    if (admissionWithdrawn()) return undefined;
    // The environment EVERY child process of this task receives: the
    // daemon's own, minus the hard deny (`./environment.ts`). Computed here,
    // before admission, so the admission-time MCP probes below see exactly
    // what the runtime path sees. One computation, both phases.
    const env = { ...buildRuntimeEnv({ ambient: process.env }), ...scratch.env };
    const mcpEnv = pick.descriptor.id === 'pi' ? projectPiMcpEnvironment(env) : env;
    if (resolvedMcp?.ok && agentRef !== undefined && this.deps.prepareHostTaskContext) {
      await this.deps.prepareHostTaskContext(taskId, blobAbort.signal);
      if (admissionWithdrawn()) return undefined;
    }
    // Contract §8.1: the host toolset servers this task will actually run
    // get their per-`(task, server)` nonce here, on the copy handed to the
    // adapter. The admission probe below keeps reading `resolvedMcp.servers`,
    // which stays clean — a `tools/list` handshake is not this task's
    // execution and has no business holding its tool authority.
    let taskMcpServers = resolvedMcp?.ok
      ? this.withHostToolsetContext(resolvedMcp.servers, taskId, agentRef, resolvedMcp.toolsetIdByServer)
      : undefined;
    if (preparation === undefined) {
      taskMcpServers = this.withAgentMessageMcp(taskMcpServers, taskId, messageRequirement);
    }
    taskMcpServers = this.withAgentResultMcp(taskMcpServers, taskId, terminalProjection);
    // Only the adapters that register projected toolset tools themselves
    // need the daemon's `tools/list` observation (see
    // `RuntimeAdapterDescriptor.requiresMcpToolsetToolObservation`). An
    // adapter whose runtime lists the tools itself must not pay a probe per
    // projected server on every offer.
    const needsToolsetObservation = resolvedMcp?.ok === true
      && pick.descriptor.requiresMcpToolsetToolObservation === true;
    if (preparation === undefined && messageRequirement !== undefined && this.deps.agentMessageMcpPreflight !== undefined) {
      try {
        await this.deps.agentMessageMcpPreflight(taskMcpServers![AGENT_MESSAGE_MCP_SERVER_NAME]!, mcpEnv);
      } catch (error) {
        decline(`required Agent message helper preflight failed: ${outboundErrorMessage(error)}`, false);
        return undefined;
      }
    }
    if (preparation === undefined && terminalProjection?.mode === 'result-document' && this.deps.agentResultMcpPreflight !== undefined) {
      try {
        await this.deps.agentResultMcpPreflight(taskMcpServers![AGENT_RESULT_MCP_SERVER_NAME]!, mcpEnv);
      } catch (error) {
        decline(`required Agent result helper preflight failed: ${outboundErrorMessage(error)}`, false);
        return undefined;
      }
    }
    if (requiresAgentMemoryMcp && agentRef !== undefined && ordinaryMemoryMode !== 'none') {
      try {
        // A `read` task, which includes every reader, is sealed `read` and its helper lists only `memory_recall`.
        taskMcpServers = this.withAgentMemoryMcp(taskMcpServers, taskId, agentRef, ordinaryMemoryMode, this.deps.agentMemoryMcpBin!, 'granted');
      } catch (error) {
        decline(`Agent memory MCP configuration failed: ${errorMessage(error)}`, false);
        return undefined;
      }
    }
    // Observe each projected toolset server's OWN tool list before the
    // adapter is asked to admit the task. Both bundled runtimes refuse an
    // MCP tool they were not told to allow, and the only honest source for
    // those names is the server itself — device toolset configuration
    // carries `command`/`args` and nothing more.
    //
    // All servers are probed CONCURRENTLY under one shared deadline
    // (`MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS`, see its own doc comment):
    // Downloads belong to this offer; a serial loop would
    // multiply the timeout by the server count and let one unresponsive
    // command delay `task.cancel`/`task.approve` for minutes. Every probe
    // kills its own child when the deadline expires, so a decline never
    // leaves a probed server running.
    //
    // Retryability follows the KIND of failure, not the phase: a spawn
    // error, an early exit, or a timeout may well succeed later and stays
    // retryable, exactly like the workspace-busy declines below. A server
    // that answered and reported an ungrantable tool name has stated a
    // permanent fact about itself — re-offering the task would probe the
    // same command and get the same answer forever, so that declines
    // non-retryably and names the server and the tool.
    let mcpToolsetTools: Record<string, McpToolsetServerObservation> | undefined;
    if (needsToolsetObservation) {
      const probe = this.deps.mcpToolsetToolsProbe ?? probeMcpServer;
      const entries = Object.entries(resolvedMcp!.servers);
      const settled = await Promise.allSettled(entries.map(async ([serverName, server]) => {
        const observation = await probe(serverName, server, {
          label: `MCP toolset server "${serverName}"`,
          timeoutMs: MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS,
          env: mcpEnv,
        });
        if (observation.tools.length === 0) throw new Error('tools/list reported no tools');
        // The toolset id is the registry's fact about this server, joined
        // on here so the adapter receives one self-describing record instead
        // of an observation plus a parallel map that could disagree with it.
        const toolsetId = resolvedMcp!.toolsetIdByServer.get(serverName);
        if (toolsetId === undefined) {
          throw new Error('observed a server that belongs to no projected toolset');
        }
        return bindMcpToolsetServerObservation(observation, toolsetId);
      }));
      const observed: Record<string, McpToolsetServerObservation> = {};
      let failure: { serverName: string; error: unknown } | undefined;
      for (let index = 0; index < entries.length; index += 1) {
        const serverName = entries[index]![0];
        const result = settled[index]!;
        if (result.status === 'fulfilled') observed[serverName] = result.value;
        else if (failure === undefined) failure = { serverName, error: result.reason };
      }
      if (failure !== undefined) {
        decline(
          `required MCP toolset server "${failure.serverName}" could not be observed: ${outboundErrorMessage(failure.error)}`,
          !(failure.error instanceof McpAuthorityError),
        );
        return undefined;
      }
      mcpToolsetTools = Object.freeze(observed);
    }
    let prepared: Awaited<ReturnType<RuntimeAdapter['prepare']>>;
    try {
      prepared = await awaitAdmission(() => pick.adapter.prepare({
        signal: blobAbort.signal,
        offer: offered,
        descriptor: pick.descriptor,
        requiredToolsetIds: requiredToolsets ?? [],
        ...(taskMcpServers === undefined ? {} : { mcpServers: taskMcpServers }),
        ...(mcpToolsetTools === undefined ? {} : { mcpToolsetTools }),
      }), blobAbort.signal);
    } catch (error) {
      if (!admissionWithdrawn()) decline(`runtime preparation failed: ${outboundErrorMessage(error)}`, true);
      return undefined;
    }
    if (admissionWithdrawn()) return undefined;
    if (prepared.kind === 'reject') {
      decline(prepared.reason, prepared.retryable);
      return undefined;
    }
    return { scratch, offered, pick, env, mcpEnv, taskMcpServers, mcpToolsetTools, prepared };
  }

  private withAgentMessageMcp(
    existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
    taskId: string,
    requirement: Readonly<AgentMessageEgressRequirement> | undefined,
  ): Readonly<Record<string, McpStdioServerConfig>> | undefined {
    if (requirement === undefined) return existing;
    const bin = this.deps.agentMessageMcpBin!;
    const contextToken = `${randomUUID()}.${randomUUID()}`;
    this.revokeAgentMessageContext(taskId);
    this.messageContextByToken.set(contextToken, taskId);
    this.messageContextByTask.set(taskId, contextToken);
    return Object.freeze({
      ...(existing ?? {}),
      [AGENT_MESSAGE_MCP_SERVER_NAME]: Object.freeze({
        command: bin.command,
        args: Object.freeze([...bin.args]),
        env: Object.freeze({
          BYOK_STORE_DIR: this.deps.storeDir,
          BYOK_PRODUCT_ID: this.deps.productId,
          BYOK_AGENT_MESSAGE_CONTEXT: contextToken,
        }),
      }),
    });
  }

  private withAgentResultMcp(
    existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
    taskId: string,
    selection: Readonly<TerminalProjectionSelection> | undefined,
  ): Readonly<Record<string, McpStdioServerConfig>> | undefined {
    if (selection?.mode !== 'result-document') return existing;
    const bin = this.deps.agentResultMcpBin!;
    const contextToken = `${randomUUID()}.${randomUUID()}`;
    this.revokeAgentResultContext(taskId);
    const context: AgentResultContext = { taskId, token: contextToken, contract: selection.contract, schema: selection.schema };
    this.resultContextByToken.set(contextToken, context);
    this.resultContextByTask.set(taskId, context);
    return Object.freeze({
      ...(existing ?? {}),
      [AGENT_RESULT_MCP_SERVER_NAME]: Object.freeze({
        command: bin.command,
        args: Object.freeze([...bin.args]),
        env: Object.freeze({
          BYOK_STORE_DIR: this.deps.storeDir,
          BYOK_PRODUCT_ID: this.deps.productId,
          BYOK_AGENT_RESULT_CONTEXT: contextToken,
        }),
      }),
    });
  }

  private revokeAgentResultContext(taskId: string): void {
    const context = this.resultContextByTask.get(taskId);
    if (context !== undefined) this.resultContextByToken.delete(context.token);
    this.resultContextByTask.delete(taskId);
  }

  private agentResultStore(homeDir: string): Promise<AgentResultStore> {
    const existing = this.resultStoresByHome.get(homeDir);
    if (existing !== undefined) return existing;
    const opened = AgentResultStore.open(homeDir);
    this.resultStoresByHome.set(homeDir, opened);
    void opened.catch(() => {
      if (this.resultStoresByHome.get(homeDir) === opened) this.resultStoresByHome.delete(homeDir);
    });
    return opened;
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
    if (existing !== undefined && Object.prototype.hasOwnProperty.call(existing, AGENT_MEMORY_MCP_SERVER_NAME)) {
      throw new Error(`MCP server name "${AGENT_MEMORY_MCP_SERVER_NAME}" is reserved by the daemon`);
    }
    const contextToken = `${randomUUID()}.${randomUUID()}`;
    this.revokeAgentMemoryContext(taskId);
    this.memoryContextByToken.set(contextToken, Object.freeze({ taskId, agentRef: Object.freeze({ ...agentRef }), mode }));
    this.memoryContextByTask.set(taskId, contextToken);
    return Object.freeze({
      ...(existing ?? {}),
      [AGENT_MEMORY_MCP_SERVER_NAME]: Object.freeze({
        command: bin.command,
        args: Object.freeze([...bin.args]),
        env: Object.freeze({
          BYOK_STORE_DIR: this.deps.storeDir,
          BYOK_PRODUCT_ID: this.deps.productId,
          BYOK_AGENT_MEMORY_CONTEXT: contextToken,
          BYOK_PREPARED_AGENT_MEMORY_MODE: mode,
          ...(toolList === 'granted' ? { BYOK_AGENT_MEMORY_TOOL_LIST: 'granted' } : {}),
        }),
      }),
    });
  }

  /** Reconstruct all sensitive context from the active sealed task, never from MCP/model arguments. */
  private activeMemoryContext(contextToken: string): AgentMemoryTaskContext {
    const registered = this.memoryContextByToken.get(contextToken);
    if (registered === undefined || this.memoryContextByTask.get(registered.taskId) !== contextToken || this.memoryClosingTasks.has(registered.taskId)) {
      throw new Error('invalid, expired, or quiescing Agent memory task context');
    }
    const active = this.tasks.get(registered.taskId);
    if (
      active === undefined ||
      active.finalizationStarted ||
      active.agentBinding === undefined ||
      active.agentRef === undefined ||
      active.agentHandoff === undefined ||
      this.deps.tenantId === undefined ||
      active.agentRef.agentId !== registered.agentRef.agentId ||
      active.agentRef.profileRevision !== registered.agentRef.profileRevision ||
      active.agentBinding.resolution.agentRef.agentId !== registered.agentRef.agentId ||
      active.agentBinding.resolution.agentRef.profileRevision !== registered.agentRef.profileRevision ||
      active.agentHandoff.sessionRef !== active.session.sessionRef ||
      active.agentHandoff.runtimeId !== active.adapter.descriptor.id ||
      active.agentHandoff.cwd !== active.agentBinding.lease.cwd ||
      active.agentBinding.lease.canonicalHome !== active.agentBinding.resolution.canonicalHome
    ) {
      throw new Error('Agent memory context no longer matches its exact active task identity');
    }
    return Object.freeze({
      taskId: registered.taskId,
      tenantId: this.deps.tenantId,
      deviceId: this.deps.deviceId,
      agentRef: Object.freeze({ ...active.agentRef }),
      sessionRef: active.session.sessionRef,
      runtimeId: active.adapter.descriptor.id,
      canonicalHome: active.agentBinding.resolution.canonicalHome,
      leaseId: active.agentBinding.lease.leaseId,
      homeIdentity: active.agentBinding.lease.homeIdentity,
    });
  }

  private async runMemoryOperation<T>(contextToken: string, required: 'read'|'write', operation: (context: AgentMemoryTaskContext) => Promise<T>): Promise<T> {
    let context = this.activeMemoryContext(contextToken);
    if (required === 'write' && this.memoryContextByToken.get(contextToken)?.mode !== 'read-write') throw new AgentMemoryError('agent_memory_operation_denied: write denied by sealed capability');
    context = await this.bindAgentMemoryFilesystem(context);
    // The helper handshake is asynchronous. Reconstruct the authority again so
    // a task that began closing during it cannot retain a stale context.
    const current = this.activeMemoryContext(contextToken);
    if (current.taskId !== context.taskId || current.leaseId !== context.leaseId) throw new Error('Agent memory context changed during secure filesystem handshake');
    context = Object.freeze({ ...current, ...(context.filesystem === undefined ? {} : { filesystem: context.filesystem }) });
    const pending = this.memoryInFlightByTask.get(context.taskId) ?? new Set<Promise<unknown>>();
    this.memoryInFlightByTask.set(context.taskId, pending);
    const result = operation(context);
    pending.add(result);
    try {
      return await result;
    } finally {
      pending.delete(result);
      if (pending.size === 0) this.memoryInFlightByTask.delete(context.taskId);
    }
  }

  private async quiesceAndSnapshotAgentMemory(active: ActiveTask): Promise<void> {
    if (active.agentBinding === undefined || active.agentRef === undefined || active.agentHandoff === undefined) return;
    if (!isAgentMemorySecureFilesystemAvailable(this.deps.resolveAgentMemoryFilesystemHelperBin !== undefined)) return;
    if (this.deps.tenantId === undefined) {
      console.error(`[byok/client] Agent memory quiescent snapshot skipped for ${active.taskId}: exact tenant context is unavailable`);
      return;
    }
    this.memoryClosingTasks.add(active.taskId);
    try {
      await Promise.allSettled([...this.memoryInFlightByTask.get(active.taskId) ?? []]);
      const context = await this.bindAgentMemoryFilesystem({
        taskId: active.taskId,
        tenantId: this.deps.tenantId,
        deviceId: this.deps.deviceId,
        agentRef: active.agentRef,
        sessionRef: active.agentHandoff.sessionRef,
        runtimeId: active.agentHandoff.runtimeId,
        canonicalHome: active.agentBinding.resolution.canonicalHome,
        leaseId: active.agentBinding.lease.leaseId,
        homeIdentity: active.agentBinding.lease.homeIdentity,
      });
      await snapshotAndProjectAgentMemory(context, this.deps.agentMemoryHostedProjection);
    } catch (error) {
      // Projection never becomes a second task-terminal authority. A failed
      // snapshot/upload is observable locally and preserves the raw home plus
      // any already-appended redacted outbox record for later replay.
      console.error(`[byok/client] Agent memory quiescent snapshot failed for ${active.taskId}: ${errorMessage(error)}`);
    } finally {
      await this.closeAgentMemoryFilesystem(active.taskId);
    }
  }

  private async bindAgentMemoryFilesystem(context: AgentMemoryTaskContext): Promise<AgentMemoryTaskContext> {
    const helperBin = this.deps.resolveAgentMemoryFilesystemHelperBin?.();
    if (helperBin === undefined) return context;
    let filesystem = this.memoryFilesystemByTask.get(context.taskId);
    if (filesystem === undefined) {
      filesystem = openAgentMemoryFilesystemHelper({
        helperBin,
        assetRoot: this.deps.agentMemoryHelperAssetRoot,
        canonicalHome: context.canonicalHome,
        homeIdentity: context.homeIdentity,
      });
      this.memoryFilesystemByTask.set(context.taskId, filesystem);
      void filesystem.catch(() => {
        if (this.memoryFilesystemByTask.get(context.taskId) === filesystem) this.memoryFilesystemByTask.delete(context.taskId);
      });
    }
    return Object.freeze({ ...context, filesystem: await filesystem });
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
    agentRef: AgentRef | undefined,
    toolsetIdByServer: ReadonlyMap<string, string>,
  ): Readonly<Record<string, McpStdioServerConfig>> {
    // §8.1's capability gate, asked before anything is minted. An undeclared
    // lane gets no nonce at all — not a weaker one, and not a device
    // assertion's identity wearing a task's name. The MCP child then fails
    // explicitly for want of a token (§8.2(1)), which is the visible outcome
    // §8.3 asks for when a device or a deployment cannot serve this lane.
    if (this.deps.hostTaskContextAvailable?.() !== true) return servers;
    if (agentRef === undefined) return servers;
    // A re-offer of the same taskId must not leave the previous attempt's
    // nonces mintable: the old child is gone, so its tokens are authority
    // nobody holds any more.
    this.deleteHostToolsetContexts(taskId);
    const frozenAgentRef = Object.freeze({ ...agentRef });
    const tokens = new Set<string>();
    const injected: Record<string, McpStdioServerConfig> = {};
    for (const [serverName, server] of Object.entries(servers)) {
      const toolsetId = toolsetIdByServer.get(serverName);
      // A server with no owning toolset would mean the resolution above lost
      // the binding; minting a nonce for it would produce a claim no frozen
      // offer can confirm, so it simply gets no task lane.
      if (toolsetId === undefined) {
        injected[serverName] = server;
        continue;
      }
      const contextToken = freshHostToolsetContextToken();
      this.hostToolsetContextByToken.set(contextToken, {
        taskId,
        agentRef: frozenAgentRef,
        toolsetId,
        serverName,
        state: 'active',
      });
      tokens.add(contextToken);
      injected[serverName] = Object.freeze({
        ...server,
        env: Object.freeze({
          BYOK_STORE_DIR: this.deps.storeDir,
          BYOK_PRODUCT_ID: this.deps.productId,
          [HOST_TOOLSET_CONTEXT_ENV]: contextToken,
        }),
      });
    }
    if (tokens.size > 0) this.hostToolsetContextTokensByTask.set(taskId, tokens);
    return Object.freeze(injected);
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
  private async resolveInstruction(instruction: TaskOfferPayload['instruction'], signal: AbortSignal): Promise<string> {
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
      }
    | { ok: false; reason: string } {
    const registry = this.deps.getMcpToolsets?.();
    if (!registry || registry.size === 0) {
      return { ok: false, reason: 'offer requires MCP toolsets, but this device has no local mcpToolsets registry' };
    }
    const servers = Object.create(null) as Record<string, McpStdioServerConfig>;
    const toolsetIdByServer = new Map<string, string>();
    for (const toolsetId of requiredToolsets) {
      const toolset = registry.get(toolsetId);
      if (!toolset) {
        return { ok: false, reason: `required MCP toolset "${toolsetId}" is not configured on this device` };
      }
      for (const [serverName, server] of Object.entries(toolset.mcpServers)) {
        if (Object.prototype.hasOwnProperty.call(servers, serverName)) {
          return {
            ok: false,
            reason: `required MCP toolsets collide on server name "${serverName}"; refusing ambiguous projection`,
          };
        }
        servers[serverName] = Object.freeze({
          command: server.command,
          ...(server.args ? { args: Object.freeze([...server.args]) } : {}),
        });
        toolsetIdByServer.set(serverName, toolsetId);
      }
    }
    if (Object.keys(servers).length === 0) {
      return { ok: false, reason: 'required MCP toolsets resolved to no servers; refusing to run without tools' };
    }
    return { ok: true, servers: Object.freeze(servers), toolsetIdByServer };
  }

  private async pump(active: ActiveTask): Promise<void> {
    try {
      for await (let event of active.session.events) {
        if (this.tasks.get(active.taskId) !== active || active.finalizationStarted) return;
        if (active.beingTornDown) {
          // Cancellation owns the result, but the native interrupt may still
          // deliver metering after a tool result/diagnostic. Consume only that
          // observation, never progress, artifacts, approvals or a new terminal.
          if (event.type === 'usage') observeTerminalUsage(active, event);
          if (event.type === 'turn_end') return;
          continue;
        }
        // A concurrent task.cancel/task.reject may already have finished
        // (and deleted) this task while this loop was awaiting the next
        // event — e.g. the runtime's own interrupt handling settles with a
        // trailing turn_end shortly after handleCancel() already reported
        // task.cancelled and started tearing the session down. That event
        // is stray at this point: without this check, the turn_end branch
        // below would unconditionally resend task.complete (and any
        // buffered task.progress) for a task the server already moved to a
        // terminal state, which it can only log as a dropped/illegal
        // transition (console.warn) rather than the silent-drop §9
        // guarantees for genuinely stale terminal messages. Mirrors the
        // same check already used below for the non-turn_end loop exits.
        if (this.tasks.get(active.taskId) !== active) return;
        // Display only: a delta never reaches the batcher, the record or the reply.
        if (event.type === 'message_draft_delta') {
          active.messageDraft?.pushDelta(event.text, event.startsMessage);
          continue;
        }

        // DaemonConfig.maxInlineEventBytes: bound this ONE event before it is
        // counted, batched, or sent. An oversized `tool_use.input` /
        // `tool_result.output` is uploaded to the blob plane in full and
        // replaced inline by a head/tail preview plus a `spill` descriptor
        // (see `event-spill.ts`). Deliberately placed BEFORE the whole-task
        // byte accounting below so `maxTaskOutputBytes` counts what actually
        // goes on the wire, not the pre-spill size — a task that spills is
        // not a task that flooded.
        event = await spillOversizedEvent(event, {
          maxInlineBytes: this.maxInlineEventBytes,
          // #654: a sealed task never stores a plaintext spill blob. Its
          // event keeps the preview, which is sealed with the rest of the batch.
          blobClient: this.deps.sealedTasks?.sealsOutput(active.taskId) ? NO_SEALED_SPILL : this.deps.blobClient,
          taskId: active.taskId,
          signal: active.blobAbort.signal,
          log: (message) => {
            if (!active.beingTornDown) console.error(`[byok/client] ${message}`);
          },
        });
        // The upload above is a real await: a concurrent cancel/reject may
        // have finished this task while it was in flight. Same guard, same
        // reason as the two above — see this loop's own top-of-body checks.
        if (this.tasks.get(active.taskId) !== active || active.finalizationStarted) return;
        if (active.beingTornDown) continue; // skip the aborted spill, then drain queued interrupt usage
        // After the spill (it reads `spill.unstoredReason`) and the teardown
        // guards, so the record ends exactly where the terminal decision is.
        active.executionRecord.observe(event);

        // M5 batch-3 (workstream 2): DaemonConfig.maxTaskOutputBytes
        // enforcement — see `estimateEventBytes`'s own doc comment for
        // exactly what's counted (a serialized-payload-length
        // approximation) and what isn't (batching overhead; an artifact's
        // actual file bytes, uploaded separately by `sendArtifact`). Checked
        // here, before any per-event-type handling below, so a task that's
        // about to be torn down for this never pays for `sendArtifact`'s own
        // disk I/O or dispatches a pointless approval request first.
        active.outputBytesSoFar += estimateEventBytes(event);
        if (active.outputBytesSoFar > this.maxTaskOutputBytes) {
          active.batcher.flush();
          await this.failActiveTaskForResourceLimit(
            active.taskId,
            `${MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX}: task emitted approximately ${active.outputBytesSoFar} bytes of output (serialized-event-length approximation), exceeding the configured limit of ${this.maxTaskOutputBytes} bytes`,
            false, // Called by this pump: it cannot await its own settlement.
          );
          return;
        }

        if (event.type === 'usage') {
          // Terminal usage is last-observed, not an accumulator. The bundled
          // Codex/Claude adapters emit their runtime terminal observation
          // before turn_end/error; a custom adapter that emits several keeps
          // only the latest actual observation rather than inventing a sum.
          // Keep terminal provider cost observation when a separate context snapshot arrives.
          observeTerminalUsage(active, event);
          if (active.prepared !== undefined) {
            const verdict = observePreparedCall(active.prepared, event);
            if (verdict !== undefined) {
              // The observation that ended the Execution still reaches the
              // wire, ahead of the typed failure it caused.
              active.batcher.push(event);
              active.batcher.flush();
              await this.teardownActiveTask(active, verdict, false, false);
              return;
            }
          }
        }

        // The session hook can be stateful. Share one decision with both text lanes.
        const startsMessage = event.type === 'progress'
          && active.adapter.descriptor.progressEventsAreMessages === true && event.text.trim() !== ''
          && active.session.progressStartsMessage?.(event) !== false;
        active.messageDraft?.push(event, startsMessage);
        if (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'needs_approval') {
          // A tool interaction ends the current text run: whatever the model
          // said before it was narration about what it was ABOUT to do, not
          // its answer. See `ActiveTask.finalTextParts` for why `usage`,
          // `artifact` and `turn_end` deliberately do not reset here.
          active.finalTextParts.length = 0;
        }

        if (event.type === 'needs_approval') {
          active.batcher.flush();
          // Acceptance finding 1 (dormant branch bypassing the approval
          // registry): this used to mint its own approvalId and stamp it
          // onto `active.pendingApprovalId` directly, entirely bypassing
          // `deps.approvalRegistry` — no registry entry ever existed for it,
          // and nothing ever cleared this field for it either (clearing
          // lived ONLY in `dispatchApproval`'s own `onResolve` callback,
          // which is registered only when a request actually goes through
          // the registry). For a hypothetical adapter mixing this
          // stream-based path with the out-of-band `approvalChannel` path
          // on the SAME task (e.g. a custom session whose `resolveApproval()`
          // sometimes delegates to `ctx.approvalChannel.resolve()`), that
          // meant: this event could clobber an already-dispatched channel
          // approval's id (a later wire decision for the REAL dispatched
          // approval would then look stale and be dropped); a resolved
          // dormant approval left a stale id blocking every later
          // `requestApproval` call for this task until the task finished;
          // and routing a wire decision through `ctx.approvalChannel.resolve()`
          // for a dormant id that was never registered threw
          // `ApprovalNotFoundError` — not treated as benign staleness by
          // `handleApprove`/`handleReject` — failing the task outright.
          //
          // Fix: reuse `requestApproval`, the SAME entry point a real
          // out-of-band approval (MCP-triggered) goes through. This gives
          // the dormant path the exact same lifecycle: it queues (rather
          // than clobbers) behind an already-dispatched approval for this
          // task, registers in `deps.approvalRegistry` once actually
          // dispatched, and arms the same timeout — see
          // `task-runner-approval.test.ts`'s mixed-path regression test.
          //
          // C1 (cross-model review, P1): reusing `requestApproval` fixed the
          // registry-bypass above, but its returned promise used to be
          // discarded outright (`void`d with no continuation at all). That
          // was harmless for the WIRE path — `handleApprove`/`handleReject`
          // already call `active.session.resolveApproval()` themselves,
          // directly, before ever touching the registry (see
          // `clearPendingApproval`'s own doc comment) — but a decision that
          // resolves THIS registry entry any OTHER way (the local
          // control-socket CLI's `approvals.resolve`, this request's own
          // `dispatchApproval` timeout, or a bounded-eviction fallback in
          // `ApprovalRegistry.register`) never goes through
          // `handleApprove`/`handleReject` at all — so nothing ever called
          // `session.resolveApproval()` for it. The runtime session stayed
          // paused forever even though the daemon (and, for a `'local'`
          // origin, the server too, via `sendApprovalResolved`) already
          // considered the approval resolved.
          //
          // Fix: chain a continuation onto the SAME promise that forwards
          // the decision into `active.session.resolveApproval()` — but ONLY
          // when the resolution's origin is NOT `'wire'`, since the wire
          // path already did that itself, synchronously, before this
          // registry entry was ever resolved; forwarding again here would
          // double-resolve the session. `origin` is deliberately NOT part of
          // the promise's own resolved value — that shape (`{approved,
          // reason}`) is `requestApproval`'s public contract, asserted
          // exactly by this file's own tests and relied on by
          // `create-daemon.ts`'s shared control socket —
          // instead it's threaded through via the optional `onOrigin`
          // callback parameter (additive, invisible to every other caller).
          // See `task-runner-approval.test.ts`'s "C1" describe block for the
          // local-resolve / wire-resolve / timeout regression tests, and
          // `clearPendingApproval`'s own doc comment for the sibling wire
          // half of this exact design.
          const { taskId } = active;
          let resolutionOrigin: ApprovalOrigin = 'local';
          void this.requestApproval(taskId, event.summary, (origin) => {
            resolutionOrigin = origin;
          }).then(async ({ approved, reason }) => {
            if (resolutionOrigin === 'wire') return;
            // The task may have finished (completed/failed/cancelled) by the
            // time this settles — look it up fresh rather than trust the
            // `active` closed over above, mirroring every other post-await
            // guard in this method (e.g. this loop's own stray-event check,
            // and the catch block below).
            if (this.tasks.get(taskId) !== active) return;
            try {
              await active.session.resolveApproval(approved, reason);
            } catch (err) {
              await this.fail(taskId, `failed to resume session after approval decision: ${errorMessage(err)}`, false);
            }
          });
          continue;
        }
        if (event.type === 'turn_end') {
          if (active.prepared !== undefined && active.prepared.initialPromptTokens === undefined) {
            // A prepared result nobody can check against its byte bound is not
            // a success. Fail closed rather than completing without evidence.
            active.batcher.flush();
            await this.fail(
              active.taskId,
              `${PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX}: this prepared Execution settled with no provider usage observed`,
              false,
            );
            return;
          }
          active.batcher.push(event);
          active.batcher.flush();
          const finalOutput = active.summaryParts.join('');
          // Resolve the result decision before Git observation and reply handoff.
          // Missing/unreadable results can still deliver a required reply; a task
          // that cannot deliver its required result takes the salvage path
          // `fail()` already applies to every other failure — rather than
          // being observed as completed and only then failed.
          const outcome = await this.resolveStagedResult(active);
          if (!outcome.deliver) return; // already reported task.fail and finished
          const failureReason = outcome.failure === undefined ? undefined
            : resultReplyFailureReason(outcome.failure, active.terminalProjection!.mode === 'result-document' ? active.terminalProjection!.contract : '');
          if (outcome.failure !== undefined) active.resultReplyFailure = outcome.failure;
          else await this.observeGit(active, 'completed');
          if (!this.canPublishAgentMessage(active)) return;
          const recordFailure = async () => {
            if (outcome.failure === undefined) return;
            if (this.deps.recordResultReplyFailure === undefined) throw new Error('required reply result failure has no durable intent writer');
            await this.deps.recordResultReplyFailure(active.taskId, outcome.failure);
          };
          if (active.messageRequirement !== undefined && !active.messageAccepted) {
            // Tool-authored and daemon-authored replies share one immutable
            // draft and one append → failure intent → activation boundary.
            // A recovery binding stays inert until the journal intent exists.
            const outbox = active.messageOutbox;
            let refusalReason: string | undefined;
            try {
              if (outbox === undefined || active.agentRef === undefined) {
                refusalReason = 'required Agent message lane is unavailable for this task';
                throw new Error(refusalReason);
              }
              if (outbox.get(active.taskId) === undefined) {
                const body = (closingReply(active) ?? finalOutput).trim();
                if (body === '') {
                  refusalReason = 'runtime produced no reply text for the required Agent message';
                  throw new Error(refusalReason);
                }
                try {
                  await outbox.appendDraft({ taskId: active.taskId, tenantId: this.deps.tenantId!,
                    agentRef: active.agentRef, requirement: active.messageRequirement,
                    contentType: active.messageRequirement.contentType, body,
                    ...(outcome.failure === undefined ? {} : { recoverySessionRef: active.session.sessionRef }),
                    maxPendingEvents: 64, maxPendingBytes: 4 * 1024 * 1024 });
                } catch (error) {
                  // An in-flight tool author may win the immutable draft.
                  if (!active.messageAccepted && outbox.get(active.taskId) === undefined) throw error;
                }
              }
              if (!this.canPublishAgentMessage(active)) return;
              await recordFailure();
              if (!this.canPublishAgentMessage(active)) return;
              if (!active.messageAccepted) {
                active.pendingMessageCompletion = { finalOutput, ...(failureReason === undefined ? {} : { failureReason }), ...(outcome.document === undefined ? {} : { document: outcome.document }) };
                const activated = await this.activateAgentMessage(outbox, active.taskId, active.session.sessionRef,
                  () => this.canPublishAgentMessage(active), () => active.messageSendAttempted === true);
                if (!this.canPublishAgentMessage(active)) return;
                if (activated === undefined) throw new Error('Agent message draft disappeared before activation');
                this.sendAgentMessageRecord(outbox, activated);
                return;
              }
            } catch (err) {
              if (outcome.failure !== undefined) throw err; // preserve the runtime-boundary failure projection
              if (!this.canPublishAgentMessage(active)) return;
              active.pendingMessageCompletion = undefined;
              await this.fail(active.taskId, refusalReason ?? `failed to deliver the required Agent message: ${errorMessage(err)}`, false);
              return;
            }
          } else {
            await recordFailure();
            if (!this.canPublishAgentMessage(active)) return;
          }
          if (failureReason !== undefined) await this.fail(active.taskId, failureReason, false);
          else await this.publishSuccessfulCompletion(active, finalOutput, outcome.document);
          return;
        }
        if (event.type === 'progress') {
          active.summaryParts.push(event.text);
          // A blank whole message must not erase the reply that came before it.
          if (startsMessage) {
            active.finalTextParts.length = 0;
          }
          active.finalTextParts.push(event.text);
        }
        if (event.type === 'artifact') await this.sendArtifact(active, event.name, event.contentType);
        active.batcher.push(event);
      }
      // The events iterable ended without either an explicit turn_end or a
      // typed RuntimeExecutionFailure. Bundled adapters translate process
      // disappearance into a typed infrastructure failure before their
      // iterable ends; a clean end here is therefore an adapter-contract
      // violation, not permission for TaskRunner to guess provider meaning.
      // This is also exactly what happens when `handleCancel`/`handleReject`
      // concurrently call `session.close()` while this loop is still
      // awaiting the same iterable (ending it is how those paths stop the
      // session). Check identity against the tasks map — if something else
      // already finished this exact active task, its own message
      // (task.cancelled / task.fail) already reported the outcome; this is
      // not a second failure. M5 batch-3 (workstream 2): `beingTornDown` is
      // the SAME guard for `teardownActiveTask`'s own controlled teardown
      // (graceful shutdown / resource-limit enforcement) — see
      // `ActiveTask.beingTornDown`'s own doc comment for why the identity
      // check alone doesn't cover that path's pre-finish() hard-kill
      // `close()` call.
      if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return;
      active.executionRecord.streamEnded();
      const failure = projectRuntimeBoundaryFailure(undefined, 'run');
      console.error('[byok/client] runtime adapter events iterable ended without terminal authority');
      await this.fail(active.taskId, failure.reason, failure.retryable, failure.failure);
    } catch (err) {
      if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return;
      active.batcher.flush();
      if (err instanceof ProgressEventTooLargeError) {
        await this.failActiveTaskForResourceLimit(
          active.taskId,
          `${ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX}: event requires ${err.actualBytes} UTF-8 bytes, exceeding the advertised activity ingress limit of ${err.maxBytes} bytes`,
          false,
        );
        return;
      }
      // The runner fails the task as the runtime's `run` failure below, so the
      // record counts the throw as the runtime ending its stream.
      active.executionRecord.streamEnded();
      const failure = projectRuntimeBoundaryFailure(err, 'run');
      if (failure.contractViolation) {
        // Never the error object itself (issue #395); see the start() case.
        console.error(
          `[byok/client] runtime adapter ${active.adapter.descriptor.id} events iterable returned an untyped failure for task ${active.taskId}`,
        );
      }
      await this.fail(active.taskId, failure.reason, failure.retryable, failure.failure);
    }
  }

  private async publishSuccessfulCompletion(active: ActiveTask, finalOutput: string, document?: unknown): Promise<void> {
    await this.settleSemanticTerminal(active, async () => {
      await this.persistAgentTerminalEvidence(active, 'complete');
      const finalMessage = closingReply(active);
      return createEnvelope('task.complete', {
        summary: finalOutput,
        ...(finalMessage === undefined ? {} : { finalMessage }),
        sessionRef: active.session.sessionRef,
        ...(document !== undefined ? { document } : {}),
        ...this.terminalInferenceUsagePayload(active),
        ...this.preparedObservationPayload(active),
        ...this.agentTerminalPayload(active),
      }, { taskId: active.taskId, sessionRef: active.session.sessionRef });
    });
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
  private async sendArtifact(active: ActiveTask, name: string, contentType: string): Promise<void> {
    const opened = await openArtifact(active.workspaceDir, name);
    if (!opened.ok) {
      this.reportArtifactError(active, name, opened.reason);
      return;
    }

    let bytes: Buffer;
    try {
      const limits = this.deps.artifactLimits ?? DEFAULT_ARTIFACT_LIMITS;
      const remaining = limits.maxTaskBytes - (active.artifactBytesSoFar ?? 0);
      bytes = await readArtifactBytes(opened.handle, Math.min(limits.maxFileBytes, remaining),
        active.blobAbort.signal, count => { active.artifactBytesSoFar = (active.artifactBytesSoFar ?? 0) + count; });
    } catch (err) {
      this.reportArtifactError(active, name, `failed to read artifact "${name}": ${errorMessage(err)}`);
      return;
    } finally {
      await opened.handle.close().catch(() => {});
    }

    if (this.tasks.get(active.taskId) !== active || active.blobAbort.signal.aborted || active.beingTornDown) return;
    const sealedTasks = this.deps.sealedTasks;
    if (sealedTasks?.sealsOutput(active.taskId)) {
      // #654 decision 12b: a sealed task's artifact is sealed inline content.
      // It is never uploaded as a plaintext blob.
      const inline = bytes.toString('base64');
      if (Buffer.byteLength(inline, 'utf8') > SEALED_SPLIT_TABLE['task.artifact_sealed'].limits.inline) {
        this.reportArtifactError(active, name, `artifact "${name}" is over the sealed inline limit and was not sent`);
        return;
      }
      try {
        const sealed = await sealedTasks.sealArtifact(active.taskId, { name, contentType, inline });
        if (this.tasks.get(active.taskId) !== active || active.blobAbort.signal.aborted || active.beingTornDown) return;
        if (sealed === undefined) this.reportArtifactError(active, name, `artifact "${name}" was not sent: no sealing key`);
        else this.deps.send(sealed);
      } catch (err) {
        this.reportArtifactError(active, name, `failed to seal artifact "${name}": ${errorMessage(err)}`);
      }
      return;
    }
    if (bytes.length <= MAX_INLINE_ARTIFACT_BYTES) {
      const inline = bytes.toString('base64');
      if (new TextEncoder().encode(inline).length <= MAX_INLINE_ARTIFACT_BYTES) {
        this.deps.send(createEnvelope('task.artifact', { name, contentType, inline }, { taskId: active.taskId }));
        return;
      }
    }

    try {
      const blobRef: BlobRef = await this.deps.blobClient.uploadArtifact(bytes, contentType, {
        signal: active.blobAbort.signal,
      });
      if (this.tasks.get(active.taskId) !== active || active.blobAbort.signal.aborted || active.beingTornDown) return;
      this.deps.send(createEnvelope('task.artifact', { name, contentType, blobRef }, { taskId: active.taskId }));
    } catch (err) {
      this.reportArtifactError(active, name, `failed to upload artifact "${name}": ${errorMessage(err)}`);
    }
  }

  /** Loud, non-silent artifact failure (finding F7): logged, and folded into this task's own progress stream as an `error` AgentEvent rather than swallowed — the task itself can still complete normally, but the omission is now visible. */
  private reportArtifactError(active: ActiveTask, name: string, reason: string): void {
    if (active.blobAbort.signal.aborted || active.beingTornDown) return;
    // The name and reason go to the task's own progress stream; stderr is a
    // service log and gets sizes only (issue #395).
    console.error(
      `[byok/client] artifact for task ${active.taskId} dropped: nameBytes=${Buffer.byteLength(name, 'utf8')} reasonBytes=${Buffer.byteLength(reason, 'utf8')}`,
    );
    active.batcher.push({ type: 'error', message: reason });
  }

  private async handleCancel(taskId: string, reason: string | undefined): Promise<void> {
    // Contract §8.2(1) / AC11: the FIRST statement of this handler, before the
    // active-task lookup and before any `await`. A cancel and a
    // `task_assertion.issue` can arrive as two frames the daemon dispatches on
    // the same tick; revoking anywhere below an await would leave a window in
    // which a task this device has already agreed to cancel can still mint new
    // tool authority. Unconditional, so it covers the not-yet-registered offer
    // window too — a taskId with no nonces is simply a no-op here.
    this.revokeHostToolsetContexts(taskId);
    const active = this.tasks.get(taskId);
    if (!active) {
      if (this.startupOwnership.has(taskId) && !this.inFlightOffers.has(taskId)) {
        await this.startupOwnership.dispose(taskId);
        return;
      }
      // Finding F4: not registered yet — record it in case handleOffer is
      // still in flight for this exact taskId (claimed but not yet started;
      // see the class-level doc on `pendingCancelled` and the two
      // checkpoints in handleOffer). A genuinely stale/unknown/already-
      // finished taskId just leaves a harmless, never-consulted entry —
      // identical in effect to the old silent-drop behavior for that case
      // (M3-B: except now bounded — see `setPendingCancelled`).
      this.setPendingCancelled(taskId, reason);
      this.inFlightBlobAborts.get(taskId)?.abort();
      return;
    }
    await this.settleSemanticTerminal(active, async () => {
      active.blobAbort.abort();
      await this.interruptBounded(active);
      await this.observeGit(active, 'salvage');
      // Deliberately NOT active.batcher.flush()-ed here (M1-4 e2e finding):
      // §4's "server state is authoritative on its own action" rule means the
      // server already moved this task to `Cancelled` — and already closed
      // this task's ServerTaskEvent queue (hub.ts's onStateChange, called
      // synchronously from cancelTask() before task.cancel is even sent) —
      // before this notification reaches the daemon at all. Any progress
      // still buffered in the batcher at this point can therefore never reach
      // an embedder no matter what: sending it only draws a
      // dropped/illegal-transition warning on the server for a `task.progress`
      // arriving against an already-terminal task (hub.ts's onProgress has no
      // §9 stale-terminal-message idempotency for task.progress the way it
      // does for task.complete/fail/cancelled). `finish()` below already stops
      // the batcher; nothing else needs to happen with its buffer contents.
      // M1 gap #6: the canonical, explicit cancellation message — no longer
      // `task.fail({reason:'cancelled'})`.
      await this.persistAgentTerminalEvidence(active, 'cancelled', reason);
      return createEnvelope('task.cancelled', {
        reason, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active),
      }, { taskId });
    });
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
    for (const key of this.pendingCancelled.keys()) {
      if (!this.inFlightOffers.has(key)) {
        this.pendingCancelled.delete(key);
        return;
      }
    }
    console.warn(
      `[byok/client] pendingCancelled exceeded ${MAX_TRACKED_TASK_IDS} entries with every tracked taskId currently in-flight — leaving it temporarily over cap rather than evict a marker a running handleOffer() still needs`,
    );
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
  private async handleSteer(taskId: string, text: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    try {
      await active.session.steer(text);
    } catch (err) {
      if (err instanceof SteerUnsupportedError) {
        console.error(
          `[byok/client] inbound task.steer for task ${taskId} rejected: runtime "${err.runtimeId}" has no steering channel (${err.message}) — acked without retry; this envelope should have been gated server-side`,
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Daemon-side shared out-of-band ApprovalChannel, exposed through the
   * control socket's approvals.request method for custom adapters. Bundled
   * Claude no longer uses it. The separate needs_approval event path remains
   * available to adapters that expose a pause through their event stream.
   *
   * Sends `task.await_approval` (protocol §5), registers a fresh entry in
   * `deps.approvalRegistry`, and races it against `deps.approvalTimeoutMs`
   * (default {@link DEFAULT_APPROVAL_TIMEOUT_MS}) — an unanswered request
   * force-resolves as a fail-closed rejection once the deadline passes. Both
   * that timeout AND a real decision (server wire `task.approve`/
   * `task.reject` via `handleApprove`/`handleReject` below, OR the local
   * CLI's `approvals.resolve` in `control-server.ts`) converge on the exact
   * same `ApprovalRegistry.resolve()` call — "first resolution wins, the
   * loser is a clean already-resolved no-op" is `ApprovalRegistry`'s own
   * existing guarantee, reused here rather than reimplemented.
   *
   * Fails closed immediately (no registry entry ever created) for a `taskId`
   * that isn't currently active on this device — a stale/unknown/
   * already-finished task has nothing to pause.
   *
   * Custom adapters can request more than one approval for the same task
   * before the first request resolves. Before the queue was introduced,
   * `active.pendingApprovalId = approvalId` above was unconditional — a
   * second concurrent call for the same task silently overwrote the first
   * call's id, so only the LATEST request was ever wire-resolvable
   * (`ctx.approvalChannel.resolve`, below, and any server `task.approve`/
   * `task.reject`, both resolve by looking up `active.pendingApprovalId`);
   * every earlier one could only ever time out.
   *
   * Fix: only ONE approval per task is ever actually DISPATCHED (registered
   * in `approvalRegistry` + `task.await_approval` sent + its own timeout
   * window running) at a time — see `dispatchApproval` below. A second
   * (third, ...) concurrent call for a task that already has one dispatched
   * queues (FIFO, `active.approvalQueue`) instead of overwriting anything,
   * and is only dispatched — with its OWN fresh approvalId and its OWN
   * timeout window starting at THAT dispatch, not at this call's arrival —
   * once the currently-dispatched one resolves (see
   * `dispatchNextQueuedApproval`). The MCP callers on the other end are
   * already independently blocked, each awaiting its own `requestApproval`
   * promise, so this added latency for a queued request is transparent to
   * them: nothing here changes what claude itself observes beyond "the
   * answer took a bit longer." Bounded by
   * {@link MAX_PENDING_APPROVALS_PER_TASK}: a request arriving once this
   * task's queue is already full is rejected fail-closed immediately,
   * mirroring the unknown/inactive-taskId case above.
   *
   * C1 (cross-model review, P1): `onOrigin`, if supplied, is invoked
   * synchronously — strictly BEFORE this method's own returned promise
   * resolves — with the `ApprovalOrigin` (`'wire' | 'local'`) the eventual
   * decision actually resolved through (see `ApprovalRegistry.resolve`'s own
   * `origin` parameter). Purely additive/internal: every existing caller
   * (`create-daemon.ts`'s control socket and this file's
   * own tests) omits it and observes exactly the same `{approved, reason}`
   * resolution as before. `pump()`'s dormant `needs_approval` branch is the
   * one caller that supplies it, to decide whether it still needs to
   * forward the decision into `active.session.resolveApproval()` itself —
   * see that branch's own doc comment for why origin can't simply ride
   * along on the resolved value instead.
   */
  async requestApproval(
    taskId: string,
    summary: string,
    onOrigin?: (origin: ApprovalOrigin) => void,
  ): Promise<{ approved: boolean; reason?: string }> {
    const active = this.tasks.get(taskId);
    if (!active) {
      return { approved: false, reason: 'task is not currently active on this device' };
    }

    if (active.pendingApprovalId !== undefined) {
      if (active.approvalQueue.length >= MAX_PENDING_APPROVALS_PER_TASK) {
        return {
          approved: false,
          reason: `too many approval requests already queued for task ${taskId} (max ${MAX_PENDING_APPROVALS_PER_TASK}) — rejected fail-closed`,
        };
      }
      return new Promise((resolve) => {
        active.approvalQueue.push({ summary, resolve, onOrigin });
      });
    }

    return this.dispatchApproval(active, summary, onOrigin);
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
   *
   * C1: `onOrigin` — see `requestApproval`'s own doc comment — is forwarded
   * verbatim from whichever caller dispatched this (directly, or via
   * `QueuedApprovalRequest.onOrigin` once `dispatchNextQueuedApproval` pulls
   * it off the queue) and invoked from the registered `onResolve` callback
   * below, BEFORE `resolve(...)` — so it always fires strictly before this
   * method's own returned promise settles.
   */
  private dispatchApproval(
    active: ActiveTask,
    summary: string,
    onOrigin?: (origin: ApprovalOrigin) => void,
  ): Promise<{ approved: boolean; reason?: string }> {
    const { taskId } = active;
    const approvalId = randomUUID();
    active.pendingApprovalId = approvalId;
    // Finding F4: see `onApprovalDispatched`'s own doc comment — must fire
    // BEFORE `deps.send` below so the observer has already stashed this
    // approvalId by the time that same synchronous call triggers
    // `DaemonObserver.handleOutboundEnvelope`'s `task.await_approval` case.
    this.deps.onApprovalDispatched?.(taskId, approvalId);
    // Mirrors the dormant needs_approval branch's own flush-before-pausing
    // discipline (~line 611 below): whatever progress already accumulated
    // this turn should reach the server before the task's state moves to
    // AwaitApproval, not sit buffered behind an indefinite pause.
    active.batcher.flush();
    // M5 (approval targeting): approvalId is always included — see
    // TaskAwaitApprovalPayloadSchema's own doc comment (@byok-sdk/protocol) for
    // why no capability gating is needed to send it safely.
    this.deps.send(createEnvelope('task.await_approval', { summary, approvalId }, { taskId }));

    const timeoutMs = this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.deps.approvalRegistry.resolve(approvalId, 'reject', `approval timed out after ${timeoutMs}ms with no decision`);
        } catch {
          // Already resolved by a real decision that raced the timer — the
          // registered onResolve callback below already fired; nothing left
          // to do here.
        }
      }, timeoutMs);
      timer.unref?.();

      this.deps.approvalRegistry.register(
        { approvalId, taskId, summary, createdAt: new Date().toISOString() },
        (decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin) => {
          clearTimeout(timer);
          if (active.pendingApprovalId === approvalId) active.pendingApprovalId = undefined;
          // M4 (additive-minor): report a LOCAL resolution to the server
          // immediately — but never a 'wire' one (the server already knows;
          // see `ApprovalOrigin`'s own doc comment, `approvals.ts`). This is
          // the single convergence point for every local path: the CLI's
          // `approvals.resolve`, this same method's own timeout branch above,
          // `finish()`'s fail-closed cleanup, and the registry's own
          // bounded-eviction fallback all funnel through `onResolve` here.
          if (origin === 'local') {
            this.sendApprovalResolved(taskId, approvalId, decision);
          }
          // C1: fires BEFORE `resolve(...)` below — a caller chaining
          // `.then()` onto this method's returned promise (`pump()`'s
          // dormant `needs_approval` branch) must already be able to see
          // this origin by the time that continuation runs.
          onOrigin?.(origin);
          resolve({ approved: decision === 'approve', reason });
          this.dispatchNextQueuedApproval(active);
        },
      );
    });
  }

  /**
   * M4 (additive-minor, `task.approval_resolved` — see `messages.ts`'s own
   * doc comment on `TaskApprovalResolvedPayloadSchema` for the full wire
   * rationale): report a LOCALLY-resolved approval to the server
   * immediately, gated on the negotiated `approval_resolved` capability
   * (`deps.getServerCapabilities` — an old server that never advertises it
   * never receives this message; the daemon then falls back to the
   * pre-existing implicit-resume inference, unconditionally, exactly as
   * before this message existed — the N/N-1 compatibility path).
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
    const capabilities = this.deps.getServerCapabilities?.() ?? [];
    const payload = { approvalId, decision, resolvedBy: 'local', at: new Date().toISOString() } as const;
    if (!requiredReceiverCapabilities('task.approval_resolved', payload).every((flag) => capabilities.includes(flag))) return;
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
    void this.dispatchApproval(active, next.summary, next.onOrigin).then(next.resolve);
  }

  /**
   * Acceptance finding 1 (dormant `needs_approval` branch bypassing the
   * approval registry): resolves whatever `deps.approvalRegistry` entry
   * `pendingId` names (if any — a caller passes `undefined` when nothing was
   * pending to begin with), tagged `'wire'` — the same origin
   * `ctx.approvalChannel.resolve` already uses for a server-sent
   * `task.approve`/`task.reject` (see `ApprovalOrigin`'s own doc comment:
   * `'wire'` is what keeps `sendApprovalResolved` from echoing
   * `task.approval_resolved` back to a server that already knows this
   * decision, since it sent it).
   *
   * Needed because `active.session.resolveApproval()` is adapter-defined:
   * - A channel-based session (claude) already resolves this exact registry
   *   entry itself, via `ctx.approvalChannel.resolve` (`handleOffer` above)
   *   — by the time this runs, that entry is already gone, so this call
   *   throws `ApprovalNotFoundError`, swallowed below: the same
   *   first-resolution-wins race every other caller of `.resolve()` in this
   *   file already treats as benign (see e.g. `dispatchApproval`'s own
   *   timeout branch).
   * - A stream-based session (the dormant `needs_approval` path in `pump()`,
   *   now dispatched via `requestApproval` exactly like a real out-of-band
   *   approval) resolves ONLY through its own in-process `resolveApproval()`
   *   call — nothing else ever touches `deps.approvalRegistry` for it, so
   *   without this call its registry entry and `active.pendingApprovalId`
   *   would otherwise linger until this approval's own timeout (or the task
   *   finishing) instead of clearing the moment the decision actually lands
   *   — which would leave any OTHER approval queued behind it
   *   (`active.approvalQueue`) stuck waiting for that same timeout.
   *
   * Called from `handleApprove`/`handleReject` AFTER `active.session
   * .resolveApproval()` has already been given the decision — never before,
   * since for the channel-based case that call is what actually resolves
   * the registry entry `pendingId` names.
   *
   * CRITICAL follow-up to finding 1 above: `pendingId` is a required
   * parameter — deliberately NOT read from `active.pendingApprovalId` inside
   * this method (indeed, this method no longer takes `active` at all). For a
   * channel-based session (claude), the `await active.session
   * .resolveApproval()` in `handleApprove`/`handleReject` BELOW THIS CALL is
   * exactly what synchronously drives `ctx.approvalChannel.resolve` ->
   * `approvalRegistry.resolve(A)` -> A's own `onResolve`
   * (`dispatchApproval` above) -> `dispatchNextQueuedApproval` — and that
   * last step, still inside the SAME synchronous call and therefore still
   * strictly BEFORE the caller's own `await` settles, dispatches the next
   * queued approval (B) and reassigns `active.pendingApprovalId = B`. A
   * caller that read `active.pendingApprovalId` only AFTER that `await`
   * returned (as this method itself used to, before it took `pendingId` as a
   * parameter) would therefore observe B, not A — resolving B (silently,
   * with A's decision: an auto-approve or a force-reject of an approval no
   * one ever actually decided) instead of the already-gone entry for A this
   * call is actually meant to (harmlessly) no-op against. Callers now
   * capture the target id BEFORE that await (`handleApprove`/`handleReject`
   * below) so this can only ever be asked to resolve the id it was meant to
   * all along. See `task-runner-approval.test.ts`'s channel-routing
   * regression test for this exact interleaving reproduced end to end.
   */
  private clearPendingApproval(pendingId: string | undefined, decision: ApprovalDecision, reason: string | undefined): void {
    if (pendingId === undefined) return;
    try {
      this.deps.approvalRegistry.resolve(pendingId, decision, reason, 'wire');
    } catch (err) {
      // C3 (cross-model review, P2): narrowed to ONLY the benign
      // already-resolved race this catch was ever meant to cover — a bare
      // `catch {}` here used to swallow EVERYTHING, but
      // `ApprovalRegistry.resolve` deletes the entry BEFORE invoking its
      // registered `onResolve` callback (`dispatchApproval` above), so a
      // genuine bug in that callback (`sendApprovalResolved` throwing,
      // `dispatchNextQueuedApproval` failing to dispatch the next queued
      // approval, this same file's own `onOrigin` hook throwing) vanished
      // here too, silently, with nothing ever finding out.
      if (err instanceof ApprovalNotFoundError) {
        // Already resolved via ctx.approvalChannel.resolve (the channel-based
        // adapter path) — benign, same first-resolution-wins guarantee
        // `ApprovalRegistry` already documents on its own `resolve()` method.
        return;
      }
      // Anything else is a genuine failure, not a benign race — propagate
      // it to the caller's existing error handling. Neither `handleApprove`
      // nor `handleReject` wraps this call in a try/catch of their own, so
      // this bubbles all the way up through `handleEnvelope` to
      // `ConnectionManager.process()`'s own existing catch, which logs it
      // and leaves the cursor unadvanced so a reconnect redelivers this
      // exact `task.approve`/`task.reject` for a retry — the same handling
      // every other envelope-handler failure already gets.
      throw err;
    }
  }

  /**
   * Protocol §5 approval flow: the server's own state already moved
   * `AwaitApproval -> Running` before this best-effort notification arrives
   * (§4) — resuming the session is what makes `task.progress` continue.
   *
   * M4 Phase 3 hardening (orchestrator-directed fix): a wire `task.approve`
   * can legitimately arrive AFTER a different, faster path (a racing local
   * `approvals.resolve` over the control socket, or this exact message
   * redelivered) already resolved the SAME approval — `ApprovalRegistry`'s
   * own "first resolution wins" guarantee means `session.resolveApproval()`
   * throws {@link NoPendingApprovalError} for that loser, not because
   * anything is actually wrong. Before this fix, ANY thrown error here
   * (stale or genuine) failed the whole task — for the stale case that
   * meant a task the winning path had ALREADY correctly resumed (and which
   * may go on to complete normally) got marked `Failed` anyway, purely
   * because a second, now-meaningless notification arrived late. Stale is
   * now an audit-only no-op; a genuine failure (the session itself
   * couldn't resume for some real reason) still fails the task exactly as
   * before.
   */
  private async handleApprove(taskId: string, approvalId: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    // M5 (approval targeting, docs/protocol.md): checked FIRST, before ever
    // touching active.session. Closes the race NoPendingApprovalError alone
    // could not: approval A resolves, approval B is dispatched next for the
    // SAME task (active.pendingApprovalId now B), and a LATE task.approve
    // meant for A arrives after. Pre-M5, `ctx.approvalChannel.resolve`
    // always resolved "whichever approval is currently pending" (B),
    // silently applying A's decision to B. A mismatch here is an
    // audit-only no-op via the same onStaleApprovalDecision hook
    // NoPendingApprovalError already uses. An absent approvalId (legacy
    // server, or one that never recorded an id) preserves the pre-M5
    // behavior exactly: resolve whichever approval is currently pending.
    if (approvalId !== undefined && approvalId !== active.pendingApprovalId) {
      this.deps.onStaleApprovalDecision?.(
        taskId,
        'approve',
        `approvalId ${approvalId} does not match the currently pending approval` +
          (active.pendingApprovalId ? ` (${active.pendingApprovalId})` : ' (none pending)'),
      );
      return;
    }
    // CRITICAL: captured BEFORE the await below — see `clearPendingApproval`'s
    // own doc comment for exactly why reading `active.pendingApprovalId`
    // only AFTER `resolveApproval()` settles is wrong: for a channel-based
    // session, that same await's own synchronous side effects (racing
    // through `approvalRegistry.resolve` -> `dispatchNextQueuedApproval`)
    // can already have reassigned it to a different, queued approval by the
    // time control returns here.
    const resolvedId = approvalId ?? active.pendingApprovalId;
    try {
      await active.session.resolveApproval(true);
    } catch (err) {
      if (err instanceof NoPendingApprovalError) {
        this.deps.onStaleApprovalDecision?.(taskId, 'approve');
        return;
      }
      await this.fail(taskId, `failed to resume session after approval: ${errorMessage(err)}`, false);
      return;
    }
    // Acceptance finding 1: see `clearPendingApproval`'s own doc comment.
    this.clearPendingApproval(resolvedId, 'approve', undefined);
  }

  /**
   * Protocol §5 approval flow: the server's own state already moved
   * `AwaitApproval -> Failed` before this best-effort notification arrives
   * (§4) — the daemon's job is just to stop the session and prove it via
   * `task.fail`.
   *
   * M4 Phase 3 hardening (orchestrator-directed fix): same race as
   * `handleApprove` above, but the pre-fix bug here was worse — this method
   * unconditionally interrupted the session and sent `task.fail` regardless
   * of whether `resolveApproval` even threw, so a stale/late wire
   * `task.reject` (the local CLI, or a racing wire approve, already
   * resolved this exact approval a different way) would tear down and fail
   * a task that was already correctly approved and possibly still running
   * fine. Now: a {@link NoPendingApprovalError} short-circuits to an
   * audit-only no-op BEFORE the interrupt/fail/finish sequence — nothing
   * about this task's state is touched. Any OTHER outcome (success, or a
   * genuine non-staleness error) falls through to the existing
   * interrupt+`task.fail`+finish sequence unchanged: the server's own
   * record already moved `AwaitApproval -> Failed` for a REAL reject
   * (§4's "server state is authoritative on its own action" rule), so the
   * daemon must still conform to that regardless of whether telling the
   * session about it succeeded.
   */
  private async handleReject(taskId: string, reason: string | undefined, approvalId: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    if (active.semanticTerminal !== undefined || active.finalizationStarted) {
      await this.settleSemanticTerminal(active);
      return;
    }
    // M5 (approval targeting): same validate-first mismatch check as
    // handleApprove above — see that method's own comment for the full
    // race this closes. Returned early here means NONE of the
    // interrupt+task.fail+finish sequence below runs for a stale decision:
    // the currently-pending (different) approval stays untouched and the
    // task is not torn down.
    if (approvalId !== undefined && approvalId !== active.pendingApprovalId) {
      this.deps.onStaleApprovalDecision?.(
        taskId,
        'reject',
        `approvalId ${approvalId} does not match the currently pending approval` +
          (active.pendingApprovalId ? ` (${active.pendingApprovalId})` : ' (none pending)'),
      );
      return;
    }
    // CRITICAL: captured BEFORE the await below — see handleApprove above
    // and `clearPendingApproval`'s own doc comment for the full race this
    // closes (identical here: a channel-based session's own resolution,
    // still inside this await, can already have reassigned
    // `active.pendingApprovalId` to a different, queued approval).
    const resolvedId = approvalId ?? active.pendingApprovalId;
    try {
      await active.session.resolveApproval(false, reason);
    } catch (err) {
      if (err instanceof NoPendingApprovalError) {
        this.deps.onStaleApprovalDecision?.(taskId, 'reject', reason);
        return;
      }
      // best-effort — still report the rejection outcome below
    }
    // Acceptance finding 1: see `clearPendingApproval`'s own doc comment.
    // Must run BEFORE `finish()` below — its own fail-closed cleanup
    // defaults to origin 'local' (see `ApprovalRegistry.resolve`'s default
    // parameter), which would incorrectly echo `task.approval_resolved`
    // back to a server that already knows this decision (it sent this
    // task.reject itself) if this hadn't already cleared it as 'wire' here.
    this.clearPendingApproval(resolvedId, 'reject', reason);
    await this.settleSemanticTerminal(active, async () => {
      await this.interruptBounded(active);
      await this.observeGit(active, 'salvage');
      // As with cancel, the server has already closed its progress stream.
      await this.persistAgentTerminalEvidence(active, 'failed', reason ?? 'rejected');
      return createEnvelope('task.fail', {
        reason: reason ?? 'rejected', retryable: false,
        ...this.failurePayload(DAEMON_TASK_FAILURE),
        ...this.terminalInferenceUsagePayload(active),
        ...this.preparedObservationPayload(active),
        ...this.agentTerminalPayload(active),
      }, { taskId });
    });
  }

  /**
   * Opens a sealed offer, then runs the plaintext offer through every check of
   * {@link handleOffer}. A server without `sealed-payload-v1` gets a plaintext
   * decline before the open: the task's output could not be sent to it.
   */
  private async handleSealedOffer(envelope: Envelope): Promise<void> {
    const taskId = envelope.task_id!;
    if (this.tasks.has(taskId) || this.startupOwnership.has(taskId) || this.inFlightOffers.has(taskId) || this.finishedTaskIds.has(taskId) || this.strictDeclinedTaskIds.has(taskId) || this.sealedOpening.has(taskId)) return;
    const agentRef = (envelope.payload as { agentRef?: AgentRef }).agentRef;
    const sealedTasks = this.deps.sealedTasks;
    if (sealedTasks === undefined || !this.sealedCodesAllowed()) {
      this.declineSealedOffer(taskId, agentRef, 'sealed_key_unavailable');
      return;
    }
    this.sealedOpening.add(taskId);
    try {
      const opened = await sealedTasks.openOffer(envelope);
      if (!opened.ok) {
        this.declineSealedOffer(taskId, agentRef, opened.code);
        return;
      }
      await this.handleOffer(taskId, opened.offer.payload as AcceptedOfferPayload, opened.offer.type.startsWith('task.offer_for_agent'));
    } finally {
      this.sealedOpening.delete(taskId);
    }
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
  private declineSealedOffer(taskId: string, agentRef: AgentRef | undefined, code: SealedDeclineCode): void {
    if (this.strictDeclinedTaskIds.has(taskId)) return;
    this.addStrictDeclinedTaskId(taskId);
    if (this.sealedCodesAllowed()) {
      this.decline(taskId, code, false, agentRef, code);
    } else {
      const why = this.deps.sealedTasks === undefined ? 'this daemon does not open sealed task input' : 'the server does not accept sealed task output';
      this.decline(taskId, `sealed_payload_unsupported: ${why}`, false, agentRef);
    }
  }

  /** Pre-claim, fail-closed rejection (protocol §3.2) — never claims first. */
  private decline(taskId: string, reason: string, retryable: boolean, agentRef?: AgentRef, code?: TaskDeclinePayload['code']): void {
    this.deps.send(createEnvelope(
      'task.decline',
      { reason, retryable, ...(agentRef === undefined ? {} : { agentRef }), ...(code === undefined ? {} : { code }) },
      { taskId },
    ));
  }

  private async fail(taskId: string, reason: string, retryable: boolean, failure = DAEMON_TASK_FAILURE): Promise<void> {
    const active = this.tasks.get(taskId);
    if (active !== undefined) {
      await this.settleSemanticTerminal(active, async () => {
        await this.observeGit(active, 'salvage');
        await this.persistAgentTerminalEvidence(active, 'failed', reason);
        return createEnvelope('task.fail', {
          reason,
          retryable,
          ...this.failurePayload(failure),
          ...this.terminalInferenceUsagePayload(active),
          ...this.preparedObservationPayload(active),
          ...this.agentTerminalPayload(active),
        }, { taskId });
      });
      return;
    }
    this.deps.send(createEnvelope('task.fail', {
      reason, retryable, ...this.failurePayload(failure), ...terminalIdentity(this.claimedHarnesses.get(taskId)),
    }, { taskId }));
    await this.finish(taskId);
  }

  /**
   * Claimed Agent failures before ActiveTask registration still carry the
   * exact AgentRef and normally have Agent-local, fsynced terminal evidence
   * first. A bounded storage failure degrades observably but cannot strand
   * the already-claimed cloud task forever; the exact terminal still goes on
   * the wire and handleOffer's finally block releases the lease.
   */
  private async failClaimedAgent(
    taskId: string,
    reason: string,
    retryable: boolean,
    context: ClaimedAgentFailureContext,
    failure = DAEMON_TASK_FAILURE,
  ): Promise<boolean> {
    await this.pendingMessageTasks.get(taskId)?.outbox.revoke(taskId);
    const agentRef = context.binding.resolution.agentRef;
    const result = await this.retryAgentTerminalEvidence(() =>
      this.deps.agentHome!.mutateExecution(context.binding, () =>
        this.deps.agentSessionHandoffs!.recordTaskTerminal({
          agentRef,
          taskId,
          runtimeId: context.runtimeId,
          home: context.binding.resolution.canonicalHome,
          cwd: context.binding.lease.cwd,
          ...(context.binding.lease.homeAccess === 'memory-reader' ? { homeAccess: 'memory-reader' as const } : {}),
          leaseId: context.binding.lease.leaseId,
          ...(context.sessionRef === undefined ? {} : { sessionRef: context.sessionRef }),
          terminalReason: reason,
        })),
    );
    if (!result.ok) {
      this.reportAgentTerminalEvidenceFailure({
        taskId,
        agentRef,
        runtimeId: context.runtimeId,
        cwd: context.binding.lease.cwd,
        cause: 'failed',
        reason,
        error: result.error,
      });
    }
    this.deps.send(createEnvelope(
      'task.fail',
      { reason, retryable, ...this.failurePayload(failure), ...terminalIdentity(context.runtimeId, agentRef) },
      { taskId },
    ));
    return result.ok;
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
    const release = this.deps.localAgentRelease;
    const runtimeId = active.adapter.descriptor.id;
    if (!isKnownRuntimeId(runtimeId)) return {};
    if (release === undefined || active.lastUsage === undefined) return {};
    if (active.lastUsage.inputTokens === undefined && active.lastUsage.outputTokens === undefined) return {};

    const nowMs = Date.now();
    const durationMs = terminalUsageNumber(nowMs - active.startedAtMs, TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS);
    const promptTokens = terminalUsageNumber(active.lastUsage?.inputTokens, TERMINAL_INFERENCE_USAGE_MAX_TOKENS);
    const completionTokens = terminalUsageNumber(active.lastUsage?.outputTokens, TERMINAL_INFERENCE_USAGE_MAX_TOKENS);

    return {
      usage: {
        runtime: runtimeId,
        clientVersion: release.version,
        reportedAt: new Date(nowMs).toISOString(),
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    };
  }

  /**
   * The prepared-only terminal observation, present exactly on a prepared
   * Execution that observed at least one provider call's prompt. It is
   * evidence the Host checks its own budget ruling against, deliberately a
   * separate field from the telemetry-only `usage` block.
   */
  private preparedObservationPayload(active: ActiveTask): { preparedObservation?: TerminalPreparedObservation } {
    const observed = active.prepared;
    if (observed?.initialPromptTokens === undefined || observed.maxPromptTokens === undefined) return {};
    return {
      preparedObservation: {
        requestDigest: observed.requestDigest,
        initialPromptTokens: observed.initialPromptTokens,
        maxPromptTokens: observed.maxPromptTokens,
      },
    };
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
    return {
      ...terminalIdentity(active.adapter.descriptor.id, active.agentRef),
      ...(active.appliedAgentHomeProjection === undefined ? {} : { agentHomeProjection: active.appliedAgentHomeProjection }),
      ...(active.agentHomeMemoryChange === undefined ? {} : { agentHomeMemoryChange: active.agentHomeMemoryChange }),
    };
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
  private async resolveStagedResult(
    active: ActiveTask,
  ): Promise<{ deliver: true; document?: unknown; failure?: ResultReplyFailure } | { deliver: false }> {
    const selection = active.terminalProjection;
    if (selection?.mode !== 'result-document') return { deliver: true };
    this.revokeAgentResultContext(active.taskId);
    let record: AgentResultRecord | undefined;
    try {
      if (active.resultStore === undefined) throw new Error('the task has no Agent result store');
      record = await active.resultStore.get(active.taskId);
    } catch (err) {
      if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return { deliver: false };
      if (active.messageRequirement !== undefined) return { deliver: true, failure: 'required-reply-result-unreadable' };
      await this.fail(active.taskId, `${RESULT_UNREADABLE_REASON_PREFIX}: the staged result for contract ${selection.contract} could not be read: ${errorMessage(err)}`, false);
      return { deliver: false };
    }
    if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return { deliver: false };
    if (record === undefined) {
      if (active.messageRequirement !== undefined) return { deliver: true, failure: 'required-reply-result-missing' };
      await this.fail(
        active.taskId,
        `${RESULT_NOT_SUBMITTED_REASON_PREFIX}: the offer requires result contract ${selection.contract}, but the runtime ended its turn without a staged ${AGENT_RESULT_TOOL_NAME} outcome`,
        false,
      );
      return { deliver: false };
    }
    if (record.contract !== selection.contract || record.tenantId !== this.deps.tenantId
      || active.agentRef === undefined || record.agentRef.agentId !== active.agentRef.agentId
      || record.agentRef.profileRevision !== active.agentRef.profileRevision) {
      if (active.messageRequirement !== undefined) return { deliver: true, failure: 'required-reply-result-unreadable' };
      await this.fail(active.taskId, `${RESULT_UNREADABLE_REASON_PREFIX}: the staged result does not belong to this task's contract and Agent`, false);
      return { deliver: false };
    }
    return { deliver: true, document: record.outcome };
  }

  private async observeGit(active: ActiveTask, phase: GitWorkspacePhase): Promise<void> {
    if (!active.gitWorkspaceId || !this.deps.gitWorkspaceManager || !this.deps.gitWorkspaceStore) return;
    try {
      const observation = await new Promise<GitWorkspaceObservation>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Git workspace observation timed out')), GIT_OBSERVATION_TIMEOUT_MS);
        timer.unref?.();
        void this.deps.gitWorkspaceManager!.observe(active.workspaceDir, active.gitBaseline).then(
          (value) => { clearTimeout(timer); resolve(value); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
      await this.deps.gitWorkspaceStore.updateObservation(active.gitWorkspaceId, observation, phase);
      this.deps.onGitWorkspaceEvent?.({ taskId: active.taskId, workspaceId: active.gitWorkspaceId, phase, observation });
    } catch (err) {
      const category = ((err as GitWorkspaceError).category ?? 'repository-invalid') as GitErrorCategory;
      await this.updateGitPhaseBestEffort(active.gitWorkspaceId, phase, category);
      this.deps.onGitWorkspaceEvent?.({ taskId: active.taskId, workspaceId: active.gitWorkspaceId, phase, errorCategory: category });
    }
  }

  private async updateGitPhaseBestEffort(workspaceId: string | undefined, phase: GitWorkspacePhase, errorCategory?: GitErrorCategory): Promise<void> {
    if (!workspaceId || !this.deps.gitWorkspaceStore) return;
    const current = await this.deps.gitWorkspaceStore.get(workspaceId).catch(() => undefined);
    if (!current) return;
    await this.deps.gitWorkspaceStore.upsert({ ...current, phase, ...(errorCategory ? { errorCategory } : {}) }).catch(() => {});
  }

  /** Persist Agent terminal truth before wire when local storage is available. */
  private async persistAgentTerminalEvidence(
    active: ActiveTask,
    cause: AgentTerminalCause,
    reason?: string,
  ): Promise<boolean> {
    // Cancellation revokes publication. Ordinary failure preserves a message that
    // may already be in transport, including its existing admission recovery gate.
    // For unsent messages, join activation and revoke before terminal truth.
    if (cause === 'cancelled' || (cause === 'failed' && !active.messageSendAttempted)) {
      await active.messageOutbox?.revoke(active.taskId);
    }
    active.terminalCause = cause;
    active.terminalReason = reason;
    await this.measureReaderMemoryChange(active);
    if (active.agentBinding === undefined || active.agentRef === undefined || active.agentHandoff === undefined) {
      return true;
    }
    const agentRef = active.agentRef;
    const handoff = active.agentHandoff;
    const result = await this.retryAgentTerminalEvidence(() =>
      this.deps.agentSessionHandoffs!.recordTerminal(
        {
          agentRef,
          sessionRef: handoff.sessionRef,
          runtimeId: handoff.runtimeId,
          home: handoff.home,
          cwd: handoff.cwd,
          ...(handoff.homeAccess === undefined ? {} : { homeAccess: handoff.homeAccess }),
        },
        cause,
        reason,
      ),
    );
    if (result.ok) {
      active.agentTerminalPersisted = true;
      return true;
    }
    console.warn(
      `[byok/client] Agent terminal evidence for ${active.taskId} remained unavailable after ` +
        `${AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS} attempts; publishing the exact terminal and retrying during cleanup: ${errorMessage(result.error)}`,
    );
    return false;
  }

  /**
   * Memory-change evidence of a `memory-reader` Attempt (#317), measured once
   * at its first terminal decision, before the terminal envelope is built.
   * The execution lease is still held, so the overlap flag covers every
   * writer that started before this point.
   */
  private async measureReaderMemoryChange(active: ActiveTask): Promise<void> {
    if (active.readerMemoryBaseline === undefined || active.agentHomeMemoryChange !== undefined) return;
    const binding = active.agentBinding;
    if (binding === undefined) return;
    const after = await digestAgentHomeMemory(binding.resolution.canonicalHome);
    active.agentHomeMemoryChange ??= compareAgentHomeMemory(
      active.readerMemoryBaseline.digest,
      after,
      binding.lease.writerOverlapped(),
    );
  }

  private async retryAgentTerminalEvidence(
    write: () => Promise<unknown>,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
    let lastError: unknown = new Error('Agent terminal evidence write did not run');
    for (let attempt = 1; attempt <= AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS; attempt++) {
      try {
        await write();
        return { ok: true };
      } catch (error) {
        lastError = error;
        if (attempt < AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, AGENT_TERMINAL_EVIDENCE_RETRY_DELAY_MS);
            timer.unref?.();
          });
        }
      }
    }
    return { ok: false, error: lastError };
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
    const error = errorMessage(input.error);
    console.error(
      `[byok/client] Agent terminal evidence permanently unavailable for ${input.taskId} after ` +
        `${AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS} attempts; terminal publication continued to avoid a stuck cloud task: ${error}`,
    );
    this.deps.onAgentTerminalEvidenceFailure?.({
      taskId: input.taskId,
      agentRef: input.agentRef,
      runtimeId: input.runtimeId,
      cwd: input.cwd,
      cause: input.cause,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      attempts: AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS,
      error,
    });
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
    const attempts: Promise<boolean>[] = [];
    for (const active of this.tasks.values()) {
      if (!active.finalizationStarted) continue;
      const binding = active.agentBinding;
      if (binding === undefined || binding.resolution.canonicalHome !== canonicalHome
        || binding.lease.homeAccess !== homeAccess) continue;
      const attempt = this.finalizationAttempts.get(active.taskId);
      if (attempt !== undefined) attempts.push(attempt);
    }
    return attempts;
  }

  private finish(taskId: string): Promise<boolean> {
    const existing = this.finalizationAttempts.get(taskId);
    if (existing) return existing;
    const attempt = this.finishOnce(taskId).finally(() => this.finalizationAttempts.delete(taskId));
    this.finalizationAttempts.set(taskId, attempt);
    return attempt;
  }

  private async finishOnce(taskId: string): Promise<boolean> {
    const active = this.tasks.get(taskId);
    if (!active) return true;
    // M5 batch-3 (workstream 2): see `armMaxDurationTimer`'s own doc
    // comment — `finish()` is the single choke point every terminal outcome
    // (normal completion, fail, cancel, or daemon shutdown) already funnels
    // through, so clearing here (unconditionally, before anything else)
    // guarantees no leaked timer and no stray fail after this task has
    // already ended a different way.
    if (!active.finalizationStarted) {
      active.finalizationStarted = true;
      active.beingTornDown = true;
      if (active.maxDurationTimer) {
        clearTimeout(active.maxDurationTimer);
        active.maxDurationTimer = undefined;
      }
      if (active.messageRetryTimer) {
        clearTimeout(active.messageRetryTimer);
        active.messageRetryTimer = undefined;
      }
      active.batcher.stop();
      active.messageDraft?.stop();
      this.addFinishedTaskId(taskId); // semantic terminal is authoritative even while disposal ownership is retained

    // M4 Phase 4 (gatekeeper LOW advisory): a task can finish (complete,
    // fail, or cancel) while ONE approval is still DISPATCHED
    // (`active.pendingApprovalId`) and/or MORE are QUEUED behind it
    // (`active.approvalQueue` — see `requestApproval`'s own doc comment for
    // the full concurrent-approval design). Left alone, a queued request
    // would eventually get dispatched (a fresh, pointless `task.await_approval`
    // + timeout window for a task that no longer exists) once whatever it
    // was queued behind finally resolves; the dispatched one's own timer
    // would keep running for up to `approvalTimeoutMs` regardless. Both are
    // resolved fail-closed HERE instead: the queue is drained and rejected
    // FIRST (each queued promise settles immediately, never dispatched at
    // all), so that resolving the dispatched one next — which triggers
    // `dispatchNextQueuedApproval` via its own `onResolve` callback — finds
    // an already-empty queue and dispatches nothing. Order matters: doing
    // it the other way around would let that callback pull the first
    // queued entry and dispatch it for real.
      const queued = active.approvalQueue.splice(0);
      for (const request of queued) {
        request.resolve({
          approved: false,
          reason: `task ${taskId} finished before this queued approval request could be dispatched`,
        });
      }
      if (active.pendingApprovalId !== undefined) {
        try {
          this.deps.approvalRegistry.resolve(active.pendingApprovalId, 'reject', `task ${taskId} finished`);
        } catch {
          // Already resolved by a real decision/timeout that raced this.
        }
      }
    }

    if (!await this.awaitActiveSessionClose(active)) return false;
    if (this.tasks.get(taskId) !== active) return true;
    try {
      await this.deps.awaitTerminalCommit?.(taskId);
    } catch {
      return false;
    }
    if (this.tasks.get(taskId) !== active) return true;
    this.publishExecutionRecord(active);
    if (active.agentBinding !== undefined && active.agentRef !== undefined && active.agentHandoff !== undefined) {
      const agentRef = active.agentRef;
      const handoff = active.agentHandoff;
      // Session.close() is the adapter quiescence receipt. Capture only after
      // it, while this exact Agent-home writer lease is still held, so direct
      // runtime file-tool writes cannot escape the deterministic snapshot.
      await this.quiesceAndSnapshotAgentMemory(active);
      if (!active.agentTerminalPersisted) {
        const cause = active.terminalCause ?? 'failed';
        const result = await this.retryAgentTerminalEvidence(() =>
          this.deps.agentSessionHandoffs!.recordTerminal(
            {
              agentRef,
              sessionRef: handoff.sessionRef,
              runtimeId: handoff.runtimeId,
              home: handoff.home,
              cwd: handoff.cwd,
              ...(handoff.homeAccess === undefined ? {} : { homeAccess: handoff.homeAccess }),
            },
            cause,
            active.terminalReason,
          ),
        );
        if (result.ok) {
          active.agentTerminalPersisted = true;
        } else if (!active.agentTerminalEvidenceFailureReported) {
          active.agentTerminalEvidenceFailureReported = true;
          this.reportAgentTerminalEvidenceFailure({
            taskId,
            agentRef,
            runtimeId: handoff.runtimeId,
            cwd: handoff.cwd,
            cause,
            reason: active.terminalReason,
            error: result.error,
          });
        }
      }
      let leaseReleased = true;
      try {
        await active.agentBinding.lease.release();
      } catch (error) {
        console.error(`[byok/client] Agent home lease could not be released for ${taskId}: ${errorMessage(error)}`);
        leaseReleased = false;
      }
      active.gitLease?.release();
      await this.releasePreparationPin(taskId);
      this.tasks.delete(taskId);
      this.revokeAgentMessageContext(taskId);
      this.revokeAgentResultContext(taskId);
      this.revokeAgentMemoryContext(taskId);
      this.deleteHostToolsetContexts(taskId);
      return leaseReleased;
    }
    active.gitLease?.release();
    await this.releasePreparationPin(taskId);
    this.tasks.delete(taskId);
    this.revokeAgentMessageContext(taskId);
    this.revokeAgentResultContext(taskId);
    this.revokeAgentMemoryContext(taskId);
    this.deleteHostToolsetContexts(taskId);
    return true;
  }

  /**
   * Once per execution, after `Session.close()` (so adapter counters are
   * final) and the terminal commit. Synchronous and in memory: it cannot hold
   * the terminal or the lease release, and a failure here is only logged.
   */
  private publishExecutionRecord(active: ActiveTask): void {
    if (active.executionRecordPublished) return;
    active.executionRecordPublished = true;
    const terminal = executionTerminalOf(active.semanticTerminal?.envelope);
    if (terminal === undefined) return;
    try {
      this.deps.onExecutionRecord?.(active.executionRecord.finish(terminal));
    } catch {
      // stderr is a service log: no adapter or listener error text (issue #395).
      console.error(`[byok/client] execution record for task ${active.taskId} was not published`);
    }
  }

  private settleSemanticTerminal(active: ActiveTask, prepare?: () => Promise<Envelope>): Promise<boolean> {
    if (this.tasks.get(active.taskId) !== active) return Promise.resolve(true);
    if (active.semanticTerminal?.attempt) return active.semanticTerminal.attempt;
    if (active.finalizationStarted) return this.finish(active.taskId);
    if (active.semanticTerminal === undefined) {
      if (prepare === undefined) return Promise.resolve(false);
      // First decision wins synchronously, before interrupt or durability I/O.
      // Keep its closure after failure; competing cancel/fail/shutdown reasons
      // may retry it, but can never select a replacement semantic terminal.
      this.revokeHostToolsetContexts(active.taskId);
      active.beingTornDown = true;
      active.semanticTerminal = { prepare };
      active.messageDraft?.stop();
    }
    const terminal = active.semanticTerminal;
    const attempt = Promise.resolve().then(async () => {
      terminal.envelope ??= await terminal.prepare();
      if (this.tasks.get(active.taskId) !== active) return true;
      // Retain the exact envelope even if the synchronous sender throws. The
      // existing terminal journal remains the sole durable wire authority.
      this.deps.send(terminal.envelope);
      return this.finish(active.taskId);
    }).finally(() => {
      if (terminal.attempt === attempt) terminal.attempt = undefined;
    });
    terminal.attempt = attempt;
    return attempt;
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
  private async releasePreparationPin(taskId: string): Promise<void> {
    const recordId = this.preparationPinsByTask.get(taskId);
    if (recordId === undefined) return;
    this.preparationPinsByTask.delete(taskId);
    try {
      await this.deps.inputPreparationLane?.store.unpin(recordId, taskId);
    } catch (error) {
      console.error(
        `[byok/client] preparation pin for task ${taskId} could not be released: ${errorMessage(error)}`,
      );
    }
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

  /** `reuseDir`, when set (a known sessionRef's recorded workspace), is used verbatim instead of a fresh `workspaceRoot/<taskId>` directory — `mkdir recursive` is idempotent either way, so ensuring-exists is safe to do unconditionally. */
  private async resolveWorkspaceDir(taskId: string, reuseDir: string | undefined): Promise<string> {
    const dir = reuseDir ?? this.legacyWorkspaceDir(taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
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
  private async pickAdapter(
    requestedRuntime: string | undefined,
    requiresMcpToolsets: boolean,
    signal: AbortSignal,
  ): Promise<PickResult> {
    const allowlist = this.deps.runtimeAllowlist;

    if (requestedRuntime) {
      if (allowlist && !allowlist.includes(requestedRuntime)) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" is not in this device's runtime allowlist`,
          retryable: false,
        };
      }
      const adapter = this.deps.adapters.find((a) => a.descriptor.id === requestedRuntime);
      if (!adapter) {
        return { ok: false, reason: `unknown runtime "${requestedRuntime}"`, retryable: false };
      }
      const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
      if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" cannot project required MCP toolsets`,
          retryable: false,
        };
      }
      const detected = await awaitAdmission(() => observeRuntimeDetection(adapter, signal), signal);
      // Another device may support this platform, as it may have the runtime installed.
      if (detected.kind === 'refused' && detected.reason === 'platform_unsupported') {
        return { ok: false, reason: `platform_unsupported: runtime "${requestedRuntime}" does not support ${process.platform}`, retryable: true };
      }
      if (detected.kind !== 'available') {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" is not installed/available on this device`,
          retryable: true,
        };
      }
      return { ok: true, adapter, descriptor };
    }

    const eligible = allowlist ? this.deps.adapters.filter((a) => allowlist.includes(a.descriptor.id)) : this.deps.adapters;
    // M5 batch-3: product decision — pi is the FALLBACK runtime, not the
    // default. Ordered independently of `deps.adapters`'s own construction
    // order (which stays whatever `buildDefaultAdapters`/the embedder built
    // it as — see `ALL_RUNTIME_IDS`'s doc comment, `create-daemon.ts`).
    const candidates = orderByPreference(eligible, this.deps.runtimePreference ?? DEFAULT_RUNTIME_PREFERENCE);
    for (const adapter of candidates) {
      const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
      if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) continue;
      const detected = await awaitAdmission(() => observeRuntimeDetection(adapter, signal), signal);
      if (detected.kind === 'available') return { ok: true, adapter, descriptor };
    }
    return {
      ok: false,
      reason: requiresMcpToolsets
        ? 'no available runtime on this device can project required MCP toolsets'
        : 'no available runtime on this device',
      retryable: true,
    };
  }
}
