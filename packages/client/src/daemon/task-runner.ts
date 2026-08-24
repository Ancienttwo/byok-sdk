import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  checkResultDocument,
  createEnvelope,
  RESULT_DOCUMENT_MAX_BYTES,
  RuntimeIdSchema,
  TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS,
  TERMINAL_INFERENCE_USAGE_MAX_TOKENS,
  type AgentEvent,
  type AgentEgressPolicy,
  type BlobRef,
  type Envelope,
  type PermissionMode,
  type PermissionPolicy,
  type ResultDocumentCheck,
  type RuntimeId,
  type TerminalInferenceUsage,
  type TaskOfferPayload,
  type TaskOfferForAgentPayload,
  type TaskOfferForAgentWithEgressPayload,
  type TaskOfferForAgentWithEgressFreshPayload,
  type TaskOfferWithToolsetsPayload,
} from '@byok-sdk/protocol';
import {
  SteerUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  sealRuntimeOperationManifest,
  type McpStdioServerConfig,
  type McpToolsetConfig,
  type RuntimeAdapter,
  type RuntimeAdapterDescriptor,
  type RuntimeOperationStartInput,
  type Session,
} from '../types';
import {
  AgentHomeBusyError,
  AgentHomeResolutionError,
  AgentHomeManager,
  type AgentHomeBinding,
  type AgentRef,
  validateAgentRef,
} from '../agent-home';
import {
  AgentSessionHandoffStore,
  type AgentTerminalCause,
} from './agent-session-handoff-store';
import {
  RuntimeDisposalFailure,
  isRuntimeDisposalFailure,
  projectRuntimeBoundaryFailure,
  type RuntimeDisposalStage,
} from '../runtime-failure';
import { ApprovalNotFoundError, type ApprovalDecision, type ApprovalOrigin, type ApprovalRegistry } from './approvals';
import type { BlobResolver } from './blob-client';
import type { TaskQueueWatermark } from './control-protocol';
import { buildRuntimeEnv } from './environment';
import { computeEffectivePolicy } from './policy';
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
const AGENT_TERMINAL_EVIDENCE_RETRY_DELAY_MS = 20;

/** Bound best-effort Git observation so terminal protocol outcomes cannot wait forever on repository I/O. */
const GIT_OBSERVATION_TIMEOUT_MS = 5_000;

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
 * before). Only ever thrown for an adapter that actually wires up a real
 * approval channel (claude, under `confirm` mode) — pi/codex's own
 * `resolveApproval()` still throw their own unrelated, adapter-specific
 * "not supported at all" errors, which are NOT instances of this class and
 * therefore still fall through to the pre-existing fail-the-task behavior,
 * unchanged.
 */
export class NoPendingApprovalError extends Error {
  constructor(public readonly taskId: string) {
    super(`no pending out-of-band approval to resolve for task ${taskId}`);
    this.name = 'NoPendingApprovalError';
  }
}

/** Inline artifact payloads must stay under this many UTF-8 bytes — mirrors the frozen `TaskArtifactPayloadSchema.inline` limit in `packages/protocol` (see docs/protocol.md §7). Anything bigger goes through the blob client. */
const MAX_INLINE_ARTIFACT_BYTES = 64 * 1024;

/**
 * M3-B: cap for both `finishedTaskIds` and `pendingCancelled` below (each
 * gains one entry per finished/cancelled task and was never pruned) — fine
 * for the short-lived CLI invocations M0-M2 ran as, but M3 turns the daemon
 * into a background service meant to stay up for weeks, so unbounded growth
 * here is a real, if slow, memory leak. Each collection evicts its OLDEST
 * (first-inserted) entry once over this cap — the same bounded-ring idiom
 * `ConnectionHub`'s per-device dedup window already uses server-side
 * (packages/server/src/hub.ts's `DEDUP_RING_CAPACITY`), just applied here to
 * task ids. `Map`/`Set` iterate in insertion order (ECMA-262), so "oldest"
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
export const MAX_PROGRESS_BATCH_BYTES_EXCEEDED_REASON_PREFIX =
  'resource limit exceeded: progressBatch.maxBatchBytes';

/**
 * additive-minor (`task.complete.document`): same stable-PREFIX contract as
 * {@link MAX_DURATION_EXCEEDED_REASON_PREFIX} above, carried by every
 * `task.fail` this daemon reports because a configured
 * `DaemonConfig.resultDocument` extractor produced a document that could not
 * be delivered — over the cap, not JSON-serializable, or destined for a
 * server that never advertised the `result-document` capability. All three
 * are `retryable: false`: none of them can come out differently on a retry
 * against the same server with the same extractor. Everything after the
 * prefix is human-readable detail (including the measured size), not part of
 * the stable shape.
 *
 * There is deliberately no "send it anyway" or "send it truncated" path.
 * A document is the task's PRIMARY structured result, so quietly dropping or
 * mangling it would report success while destroying the thing the task
 * existed to produce.
 */
export const RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX = 'result document undeliverable';

/**
 * The task identity handed to a {@link ResultDocumentExtractor} alongside the
 * final output text. Deliberately minimal — identity only, no session
 * handle, no workspace path, no adapter: this seam exists to turn text the
 * runtime already produced into the product's own JSON, not to become a
 * general-purpose end-of-task callback with access to the daemon's innards.
 */
export interface ResultDocumentTask {
  readonly taskId: string;
  readonly sessionRef: string;
}

/**
 * Host-supplied glue that turns a finished task's final output into the
 * product's structured terminal result (`task.complete.document`). Returning
 * `undefined` means "this task has no structured result" and completes the
 * task exactly as it would have without an extractor configured at all.
 *
 * SYNCHRONOUS by contract, like every other single-purpose callback on
 * `TaskRunnerDeps`, and the runtime ENFORCES that rather than trusting it:
 * the returned value is treated as data and JSON-encoded as-is, never
 * awaited, so a returned promise would encode to an empty document (`{}`) —
 * a well-formed, under-cap, and completely WRONG result. A thenable return
 * is therefore rejected exactly like a throw (`task.fail`, `retryable:
 * false`), because delivering a confidently wrong terminal result is worse
 * than delivering none.
 *
 * Throwing is a real outcome, not a nuisance: it fails the task
 * (`retryable: false`) rather than completing it without the result the
 * extractor was supposed to produce — see {@link
 * RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}.
 */
export type ResultDocumentExtractor = (finalOutput: string, task: ResultDocumentTask) => unknown;

/**
 * Human-readable detail for a rejected document, one branch per rejection
 * reason the protocol's own {@link checkResultDocument} can return. Kept
 * exhaustive over the union (the `never` default) so a new rejection reason
 * added upstream fails this package's typecheck instead of silently
 * degrading into a vague catch-all message.
 */
function resultDocumentRejectionDetail(check: Extract<ResultDocumentCheck, { ok: false }>): string {
  switch (check.reason) {
    case 'over-cap':
      return `${check.bytes} bytes as canonical JSON, over the ${RESULT_DOCUMENT_MAX_BYTES}-byte limit (it is never truncated — a truncated JSON document is not valid JSON; use artifactRefs for a result this size)`;
    case 'not-serializable':
      return 'not JSON-serializable (JSON.stringify threw, or produced no output at all)';
    case 'not-plain-json':
      return 'not plain JSON data: it does not equal its own JSON round trip, so serializing it would silently change it (an undefined-valued key, NaN, a function or symbol value, a Date, a toJSON that rewrites the value, or a getter that answers differently on a second read)';
    default: {
      const exhaustive: never = check;
      throw new Error(`unhandled result document rejection: ${JSON.stringify(exhaustive)}`);
    }
  }
}

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
  /** M5: see `DaemonConfig.runtimeEnvironment`'s own doc comment (`create-daemon.ts`) — the per-device, per-runtime env-allowlist override `handleOffer` merges into `buildRuntimeEnv`'s `locallyAllowedNames`. */
  runtimeEnvironment?: Record<string, { allow?: string[] }>;
  /** Reads the daemon's current validated device-local registry once per offer. */
  getMcpToolsets?: () => ReadonlyMap<string, McpToolsetConfig>;
  permissionDefaults?: PermissionPolicy;
  workspaceRoot: string;
  /** Strict Agent offer authority. Absent means legacy offers never resolve an Agent home. */
  agentHome?: AgentHomeManager;
  /** Local authority: legacy offers are declined after journal/dedup/cancel precedence. */
  strictAgentOnly?: boolean;
  /** Exact host-selected policy accepted by `task.offer_for_agent_with_egress`. */
  agentEgressPolicy?: Readonly<AgentEgressPolicy>;
  /** Always-present projection/sanitizer consumer; it defaults to metadata-only. */
  agentEgress?: AgentEgressController;
  /** Durable exact-match Agent session handoff authority. */
  agentSessionHandoffs?: AgentSessionHandoffStore;
  deviceId: string;
  send: (envelope: Envelope) => void;
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
  productId: string;
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
  /**
   * M5 batch-3 (workstream 2): overrides {@link DEFAULT_MAX_TASK_OUTPUT_BYTES}
   * — see that constant's own doc comment and `DaemonConfig.maxTaskOutputBytes`
   * (`create-daemon.ts`) for the full contract. Validated (rejecting
   * zero/negative) at the `DaemonConfig` layer, not here — this seam trusts
   * its caller, same as every other optional numeric override on this
   * interface (`shutdownInterruptTimeoutMs`, `approvalTimeoutMs`).
   */
  maxTaskOutputBytes?: number;
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
  /**
   * additive-minor (`task.complete.document`): the host's structured-result
   * extractor, consulted once per task at the moment `task.complete` is
   * built — see {@link ResultDocumentExtractor} and `DaemonConfig
   * .resultDocument` (`create-daemon.ts`) for the full contract.
   *
   * Optional, and absent by default: with no extractor supplied, the
   * completion path is byte-identical to what it was before this seam
   * existed — no document is computed, no capability is consulted, and
   * `task.complete` carries exactly the fields it always did.
   */
  resultDocument?: { readonly extract: ResultDocumentExtractor };
}

/** See {@link TaskRunnerDeps.admissionGuard}. */
export type AdmissionGuardDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string; readonly retryable: boolean };

interface ActiveTask {
  taskId: string;
  /** True only for the distinct task.offer_for_agent_with_egress contract. */
  egressEnabled: boolean;
  adapter: RuntimeAdapter;
  session: Session;
  workspaceDir: string;
  agentBinding?: AgentHomeBinding;
  agentRef?: AgentRef;
  agentHandoff?: {
    sessionRef: string;
    runtimeId: string;
    cwd: string;
  };
  terminalCause?: AgentTerminalCause;
  terminalReason?: string;
  agentTerminalPersisted?: boolean;
  agentTerminalEvidenceFailureReported?: boolean;
  gitWorkspaceId?: string;
  gitLease?: GitWorkspaceLease;
  gitBaseline?: string;
  batcher: ProgressBatcher;
  summaryParts: string[];
  /**
   * M4 Phase 3: the `ApprovalRegistry` id of the single out-of-band approval
   * currently DISPATCHED (registered + `task.await_approval` sent) for this
   * task, if any — set by `requestApproval`/`dispatchApproval`, cleared once
   * resolved (by a real decision or by the timeout). `undefined` whenever
   * nothing is dispatched right now — including while `approvalQueue` below
   * is non-empty but hasn't been dispatched yet. See `requestApproval` and
   * `RuntimeOperationStartInput.approvalChannel.resolve`'s doc comments.
   */
  pendingApprovalId?: string;
  /**
   * M4 Phase 4 (fold-in from the P3 gate): FIFO queue of `requestApproval`
   * calls for this SAME task that arrived while another one was already
   * dispatched (`pendingApprovalId` set) — see `requestApproval`'s own doc
   * comment for the full concurrency bug this fixes (claude's parallel tool
   * use can call it more than once for one task before the first resolves).
   * Bounded by {@link MAX_PENDING_APPROVALS_PER_TASK}.
   */
  approvalQueue: QueuedApprovalRequest[];
  /**
   * M5 batch-3 (workstream 2): the wall-clock timer enforcing
   * `payload.limits.maxDurationMs` for this task, if the offer set one — see
   * `armMaxDurationTimer`. `undefined` when no `maxDurationMs` was set.
   * Cleared unconditionally at the top of `finish()` so every terminal
   * outcome (success, fail, cancel, or daemon shutdown) leaves no dangling
   * timer and can never fire a stray fail for a task that already ended a
   * different way.
   */
  maxDurationTimer?: ReturnType<typeof setTimeout>;
  /**
   * M5 batch-3 (workstream 2): running total of accumulated agent-event
   * output bytes counted so far for `DaemonConfig.maxTaskOutputBytes`
   * enforcement — see `TaskRunner.pump`'s own per-event counting for exactly
   * what's counted (a serialized-payload-length approximation, not an exact
   * wire-byte accountant).
   */
  outputBytesSoFar: number;
  /** Device monotonic-ish wall-clock anchor taken only after a Session started. */
  startedAtMs: number;
  /**
   * Last runtime usage observation received before this task's terminal
   * signal. This is intentionally NOT accumulated: Codex and Claude expose a
   * terminal turn-level usage object, and adding observations would invent a
   * cross-runtime accounting meaning this client does not own.
   */
  lastUsage?: Extract<AgentEvent, { type: 'usage' }>;
  /** Distinguishes runner-initiated teardown from an unexpected event-stream end. */
  beingTornDown?: boolean;
  /** Set before the first disposal await so no racing path can publish a second semantic terminal. */
  finalizationStarted?: boolean;
  /** Reserved synchronously by the one path allowed to publish this task's terminal envelope. */
  semanticTerminalReserved?: boolean;
  semanticTerminalSettled?: Promise<boolean>;
  resolveSemanticTerminalSettled?: (disposed: boolean) => void;
  /** Shared receipt for concurrent finish/shutdown callers; cleared after a failed attempt so shutdown can retry. */
  disposalAttempt?: Promise<void>;
}

interface ClaimedAgentFailureContext {
  readonly binding: AgentHomeBinding;
  readonly runtimeId: string;
  readonly sessionRef?: string;
}

/** One not-yet-dispatched `requestApproval` call waiting its turn — see `ActiveTask.approvalQueue`. */
interface QueuedApprovalRequest {
  summary: string;
  resolve: (result: { approved: boolean; reason?: string }) => void;
  /**
   * C1 (cross-model review, P1): forwarded verbatim to `dispatchApproval`
   * once this request is actually dispatched (`dispatchNextQueuedApproval`)
   * — see `requestApproval`'s own doc comment for why this exists at all.
   */
  onOrigin?: (origin: ApprovalOrigin) => void;
}

type PickResult =
  | { ok: true; adapter: RuntimeAdapter; descriptor: RuntimeAdapterDescriptor }
  | { ok: false; reason: string; retryable: boolean };

/**
 * M5 (claimed runtime): `RuntimeAdapter.descriptor.id` is a bare `string` (`../types.ts`)
 * — deliberately wider than the frozen wire `RuntimeIdSchema`, so a custom,
 * embedder-supplied adapter for a runtime this protocol doesn't know about
 * can still be plugged in. `task.claim.runtime` (`TaskClaimPayloadSchema`)
 * is narrower (`'pi' | 'claude' | 'codex'`), so the picked adapter's id must
 * be checked before it can be sent on the wire — mirrors `create-daemon.ts`'s
 * own `isRuntimeId` gate for `conn.hello.runtimes` reporting. An adapter
 * whose id isn't one of these is simply omitted from `task.claim.runtime`
 * (never sent as an invalid enum value), the same fail-closed-by-omission
 * shape `detectRuntimes` already applies.
 */
function isKnownRuntimeId(id: string): id is RuntimeId {
  return RuntimeIdSchema.safeParse(id).success;
}

/** Preserve a runtime/device number only when the terminal wire contract can represent it exactly. */
function terminalUsageNumber(value: number | undefined, maximum: number): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

/**
 * M5 batch-3 (workstream 1): default auto-select priority order — claude,
 * then codex, then pi LAST. Product decision: pi is this SDK's FALLBACK
 * runtime (tried only once nothing better is available/capable), not the
 * default it silently was before this change (see `ALL_RUNTIME_IDS`'s own
 * doc comment, `create-daemon.ts`, for how the old accidental default arose).
 * Overridable per-daemon via `DaemonConfig.runtimePreference` /
 * `TaskRunnerDeps.runtimePreference`; this is only the fallback when that's
 * left unset.
 */
const DEFAULT_RUNTIME_PREFERENCE: readonly RuntimeId[] = ['claude', 'codex', 'pi'];

/**
 * Reorders `candidates` by `preference` (lower index tried first), appending
 * every candidate whose id isn't named in `preference` at all — e.g. a
 * product-supplied adapter for a runtime id outside the frozen
 * `RuntimeIdSchema` enum (`RuntimeAdapter.descriptor.id` is deliberately a plain
 * `string`, wider than `RuntimeId` — see `types.ts`'s own doc comment) —
 * after every ranked one, in their original relative order. Safe because
 * `Array.prototype.sort` has been a stable sort since ES2019: two candidates
 * that tie on rank (both unranked, or the same explicit rank) never get
 * reordered relative to each other. This guarantees a candidate already
 * present in `deps.adapters` is never silently dropped from auto-select just
 * because `preference` doesn't happen to mention its id.
 */
function orderByPreference(candidates: readonly RuntimeAdapter[], preference: readonly string[]): RuntimeAdapter[] {
  const rank = new Map(preference.map((id, index) => [id, index]));
  return [...candidates].sort((a, b) => (rank.get(a.descriptor.id) ?? preference.length) - (rank.get(b.descriptor.id) ?? preference.length));
}

/**
 * M5 batch-3 (workstream 1): whether `adapter` can express `mode` AT ALL —
 * consults the exact same `RuntimeCapabilities.permissionModes` already
 * reported on the wire (`create-daemon.ts`'s `toRuntimeInfoCapabilities`)
 * rather than instantiating or probing anything new. A pure, synchronous,
 * zero-I/O check — deliberately consulted BEFORE `adapter.detect()` in
 * `pickAdapter` below, so a structurally-incapable candidate never pays for
 * a real subprocess probe it could never have won anyway.
 *
 * This is a pre-claim structural gate. Per-offer semantic validation belongs
 * to the required side-effect-free `prepare()` step below; no policy mismatch
 * may wait for a post-claim process start.
 */
function adapterSupportsMode(descriptor: RuntimeAdapterDescriptor, mode: PermissionMode): boolean {
  return descriptor.capabilities.permissionModes.includes(mode);
}

function adapterSupportsMcpToolsets(descriptor: RuntimeAdapterDescriptor): boolean {
  return descriptor.capabilities.mcpToolsets === true;
}

type AcceptedOfferPayload =
  | TaskOfferPayload
  | TaskOfferWithToolsetsPayload
  | TaskOfferForAgentPayload
  | TaskOfferForAgentWithEgressPayload
  | TaskOfferForAgentWithEgressFreshPayload;

function withoutRequiredToolsets(payload: AcceptedOfferPayload): TaskOfferPayload {
  const { requiredToolsets, egressPolicy, ...offer } = payload as TaskOfferWithToolsetsPayload
    & Partial<TaskOfferForAgentWithEgressPayload>
    & Partial<TaskOfferForAgentWithEgressFreshPayload>;
  void requiredToolsets;
  void egressPolicy;
  return offer as TaskOfferPayload;
}

function sameEgressPolicy(left: Readonly<AgentEgressPolicy>, right: Readonly<AgentEgressPolicy>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function offeredAgentRef(payload: AcceptedOfferPayload): AgentRef | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'agentRef')) return undefined;
  return validateAgentRef((payload as unknown as { agentRef?: unknown }).agentRef);
}

/**
 * The fresh egress offer deliberately has no sessionRef. Preserve that absence
 * through admission and manifest sealing so only the legacy egress message
 * can take the exact-resume path.
 */
function offeredSessionRef(payload: AcceptedOfferPayload): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'sessionRef')) return undefined;
  const value = (payload as unknown as { sessionRef?: unknown }).sessionRef;
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * M5 batch-3 (workstream 2): races `fn()` against `timeoutMs`, resolving
 * `true` once `fn()` itself settles (success OR rejection — a rejection is
 * swallowed here, the same best-effort contract every teardown call in this
 * file already applies to `session.interrupt()`/`session.close()`) and
 * `false` if `timeoutMs` elapses first with `fn()` still pending. Unlike a
 * plain `Promise.race`, the caller can tell WHICH one won —
 * `teardownActiveTask` needs that to decide whether to escalate to a hard
 * kill.
 */
function raceSettleFirst(fn: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    timer.unref?.();
    void (async () => {
      try {
        await fn();
      } catch {
        // best-effort — the caller only cares whether this settled in time
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    })();
  });
}

/**
 * M5 batch-3 (workstream 2): approximate output size of one normalized
 * `AgentEvent`, for `DaemonConfig.maxTaskOutputBytes` enforcement (`pump`
 * below) — the UTF-8 byte length of `JSON.stringify(event)`. This is a
 * serialized-payload-length APPROXIMATION of the event's eventual wire cost,
 * not an exact accountant: `task.progress` batching/envelope framing
 * overhead is not included, and for an `artifact` event this counts only the
 * event's own `{name, contentType}` shape — the artifact's actual file bytes
 * are read/uploaded separately by `sendArtifact` and are NOT counted here
 * (capping that would need a different hook; out of scope for this cap).
 * Good enough to catch a genuinely runaway task without needing an exact
 * wire-byte accountant. Never throws: a shape `JSON.stringify` can't handle
 * (it never should for a well-formed `AgentEvent`) counts as 0 bytes rather
 * than crashing the task loop over an accounting nicety.
 */
function estimateEventBytes(event: AgentEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
  } catch {
    return 0;
  }
}

type OpenArtifactResult = { ok: true; handle: FileHandle } | { ok: false; reason: string };

/**
 * Finding F7/N5 (artifact path traversal + TOCTOU symlink race): resolve an
 * artifact `name` against `workspaceDir`, then **open it and verify the
 * open file descriptor** — never a path-based check followed by a separate
 * re-open by pathname.
 *
 * The prior version (`resolveArtifactPath`) realpath'd the candidate to
 * verify containment and returned a *path string*; `sendArtifact` then
 * reopened that path via `fs.readFile(path)`. That's a classic
 * check-then-use race: between the realpath check and the later open, the
 * final path component can be swapped for a symlink pointing outside the
 * workspace (a compromised/buggy runtime, or something written by the very
 * agent turn that reported this artifact name), and the reopen would
 * silently follow it. Confirmed pre-fix: swapping the artifact's final
 * component for a symlink to `/etc/hosts` after the containment check
 * passed but before the read caused the daemon to read and upload
 * `/etc/hosts` as the task artifact.
 *
 * Fix: the LEXICAL pathname containment check below (`path.resolve` +
 * string-prefix) is only a fast, well-messaged early reject (defense in
 * depth — rejects absolute `name`s and `../` traversal before touching the
 * filesystem at all). It is followed by a SECOND, filesystem-resolving
 * containment check (finding P4/Codex): `fs.realpath` the full candidate
 * path and re-check containment against the realpath'd workspace root. This
 * exists because the lexical check alone cannot catch an INTERMEDIATE path
 * component that's actually a symlink pointing outside the workspace — e.g.
 * `name = "sublink/secret.txt"` where `<workspace>/sublink` is a symlink to
 * an outside directory: `<workspace>/sublink/secret.txt` lexically starts
 * with `<workspace>/` regardless of what `sublink` points at, and
 * `O_NOFOLLOW` (below) only guards the *final* path component per POSIX
 * `open(2)` semantics — it has nothing to reject when the final component,
 * once the intermediate symlink is followed, is itself a perfectly ordinary
 * regular file. Resolving the realpath of the WHOLE candidate and checking
 * containment against it catches this: the resolved path lands outside the
 * workspace root regardless of which component in the middle was the
 * symlink. After both containment checks pass, the actual TOCTOU security
 * boundary is still `O_NOFOLLOW` on the `open()` call itself, which fails
 * atomically (`ELOOP`) if the FINAL path component is a symlink — there is
 * no window between "check" and "use" for that component specifically,
 * just an open that refuses to follow one — plus an `fstat` on the
 * resulting *file descriptor* (not the path) to confirm it's a regular
 * file. `sendArtifact` reads from that same handle and closes it when done;
 * the bytes it hashes/inlines/uploads are the exact bytes that passed every
 * check, not a re-read of whatever exists at the path afterward.
 *
 * Residual (documented, not fixed here): a *static* intermediate symlink
 * (created ahead of time, no race needed) is now closed by the realpath
 * containment check above. The only gap left is a genuine RACE: an
 * intermediate directory component swapped for a symlink AFTER the
 * candidate's realpath call above resolves but BEFORE the subsequent
 * `open()`. Closing that fully needs Linux's `openat2`/`RESOLVE_BENEATH`
 * (resolve-and-open as one atomic, symlink-constrained operation), which
 * Node's stdlib doesn't expose, and isn't implemented cross-platform here.
 *
 * Windows (M3 TODO): the `O_NOFOLLOW` guard is POSIX-only. On Windows
 * `fs.constants.O_NOFOLLOW` does not exist, so the `?? 0` below no-ops the
 * flag there and the final-component symlink guarantee does NOT hold: a
 * symlinked final component is opened and followed like any other file
 * (reparse-point/symlink handling for that platform isn't implemented yet).
 * It is deliberately NOT papered over with a pre-open `lstat` rejection —
 * `lstat`-then-`open` re-opens the exact check-then-use TOCTOU window
 * `O_NOFOLLOW` exists to close atomically, which would be racy security
 * theater, not a guard. The lexical + realpath containment checks above
 * still run on Windows and remain its floor of protection, but they are
 * defense-in-depth, not an equivalent; until a real Windows-side mechanism
 * exists, workspace confinement there stays a convention, not an enforced
 * boundary (see `docs/security.md`'s "Workspace confinement is a
 * convention, not a sandbox"). For the same reason the symlink/TOCTOU
 * rejection tests in `__tests__/daemon-blob.test.ts` are skipIf-gated to
 * win32 — on Windows they would pass vacuously (a rejected open for the
 * wrong reason, e.g. `ENOENT` on a nonexistent target) and green CI there
 * must never be mistaken for the guard having held.
 */
async function openArtifact(workspaceDir: string, name: string): Promise<OpenArtifactResult> {
  // Workspace root is daemon-created (see `resolveWorkspaceDir`) and
  // trusted — realpath'd exactly once, not derived from the untrusted
  // `name`, so this step has no TOCTOU exposure of its own.
  const realWorkspaceDir = await fs.realpath(workspaceDir).catch(() => workspaceDir);
  const candidate = path.resolve(realWorkspaceDir, name);

  const prefix = realWorkspaceDir.endsWith(path.sep) ? realWorkspaceDir : realWorkspaceDir + path.sep;
  if (candidate !== realWorkspaceDir && !candidate.startsWith(prefix)) {
    return { ok: false, reason: `artifact name "${name}" resolves outside the task workspace — rejected` };
  }

  // Finding P4/Codex: the check above is LEXICAL and does not catch an
  // intermediate path component that's actually a symlink pointing outside
  // the workspace (`O_NOFOLLOW` below only guards the final component).
  // Resolve the full candidate's real path and re-check containment against
  // it — this fails closed whenever any intermediate component resolves
  // outside the workspace root, even though the final component (once
  // resolved) is an ordinary regular file. A realpath failure here (ENOENT,
  // a broken intermediate link, etc.) falls through to the `open()` below
  // unchanged, so that call produces the natural, consistent "could not be
  // opened" error instead of a differently-worded one — it doesn't grant
  // any additional access, since `open()` would fail for the same
  // underlying reason (and still can't follow a symlinked final component
  // either way).
  let realCandidate = candidate;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch {
    // handled by the open() call below
  }
  if (realCandidate !== realWorkspaceDir && !realCandidate.startsWith(prefix)) {
    return { ok: false, reason: `artifact name "${name}" resolves outside the task workspace — rejected` };
  }

  const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    handle = await fs.open(candidate, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    return { ok: false, reason: `artifact "${name}" could not be opened: ${errorMessage(err)}` };
  }

  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close().catch(() => {});
      return { ok: false, reason: `artifact "${name}" is not a regular file` };
    }
  } catch (err) {
    await handle.close().catch(() => {});
    return { ok: false, reason: `artifact "${name}" could not be verified: ${errorMessage(err)}` };
  }

  return { ok: true, handle };
}

/**
 * Per-connection task orchestration: offer -> (decline | prepare -> seal ->
 * claim -> prepared operation -> started) -> seq-ordered progress batches -> complete/fail/
 * cancelled, plus approve/reject/cancel/steer handling.
 *
 * M1 rework (docs/protocol.md §3, §5, §10 — `packages/protocol` is frozen,
 * not editable here): pre-claim rejections (unknown/disallowed runtime,
 * policy exceeding this device's ceiling) now send `task.decline` and never
 * claim at all — `TASK_TRANSITIONS.Offered` gained a direct `-> Failed` edge
 * precisely so this no longer has to claim-then-fail. A successful claim is
 * followed by `task.started` only once the adapter session has actually
 * started (`task.claim` alone no longer implies `Running`). Cancellation
 * reports the explicit `task.cancelled` message instead of the old
 * `task.fail({reason:'cancelled'})` convention.
 */
export class TaskRunner {
  private readonly tasks = new Map<string, ActiveTask>();
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
  private readonly inFlightOffers = new Set<string>();
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

  constructor(private readonly deps: TaskRunnerDeps) {}

  get activeTaskCount(): number {
    return this.tasks.size;
  }

  /**
   * Transport-boundary classification for the currently active task. Legacy
   * tasks and plain Agent-home offers are deliberately false: the additive
   * egress contract must never reclassify their existing wire semantics.
   */
  usesAgentEgress(taskId: string): boolean {
    return this.tasks.get(taskId)?.egressEnabled === true;
  }

  /** M5 batch-3 (workstream 2): effective `maxTaskOutputBytes` cap for this daemon — see {@link DEFAULT_MAX_TASK_OUTPUT_BYTES}'s own doc comment. */
  private get maxTaskOutputBytes(): number {
    return this.deps.maxTaskOutputBytes ?? DEFAULT_MAX_TASK_OUTPUT_BYTES;
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

  /** M4 Phase 2: stop claiming any FUTURE `task.offer` — see `stoppingOffers`'s own doc comment. Idempotent. */
  stopAcceptingOffers(): void {
    this.stoppingOffers = true;
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
    const active = [...this.tasks.values()];
    await Promise.all(active.map((task) => this.shutdownTask(task, reason)));
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
  private async teardownActiveTask(active: ActiveTask, reason: string, retryable: boolean): Promise<boolean> {
    if (active.finalizationStarted) return this.finish(active.taskId);
    if (!this.reserveSemanticTerminal(active)) return active.semanticTerminalSettled ?? false;
    // A soft interrupt may end the event stream; mark it as runner-initiated
    // before crossing that boundary.
    active.beingTornDown = true;
    await this.observeGit(active, 'salvage');
    const timeoutMs = this.deps.shutdownInterruptTimeoutMs ?? DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS;
    await raceSettleFirst(() => active.session.interrupt(), timeoutMs);
    if (this.tasks.get(active.taskId) !== active) return true;
    await this.persistAgentTerminalEvidence(active, 'failed', reason);
    this.deps.send(
      createEnvelope(
        'task.fail',
        { reason, retryable, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active) },
        { taskId: active.taskId },
      ),
    );
    return this.finish(active.taskId);
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
  private async failActiveTaskForResourceLimit(taskId: string, reason: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    await this.teardownActiveTask(active, reason, false);
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
    const timer = setTimeout(() => {
      void this.failActiveTaskForResourceLimit(
        active.taskId,
        `${MAX_DURATION_EXCEEDED_REASON_PREFIX}: task exceeded its configured wall-clock limit of ${maxDurationMs}ms`,
      );
    }, maxDurationMs);
    timer.unref?.();
    active.maxDurationTimer = timer;
  }

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'task.offer':
        await this.handleOffer(envelope.task_id, envelope.payload, false);
        return;
      case 'task.offer_with_toolsets':
        await this.handleOffer(envelope.task_id, envelope.payload, false);
        return;
      case 'task.offer_for_agent':
        await this.handleOffer(envelope.task_id, envelope.payload, true);
        return;
      case 'task.offer_for_agent_with_egress':
        await this.handleOffer(envelope.task_id, envelope.payload, true);
        return;
      case 'task.offer_for_agent_with_egress_fresh':
        await this.handleOffer(envelope.task_id, envelope.payload, true);
        return;
      case 'task.cancel':
        await this.handleCancel(envelope.task_id, envelope.payload.reason);
        return;
      case 'task.steer':
        await this.handleSteer(envelope.task_id, envelope.payload.text);
        return;
      case 'task.approve':
        await this.handleApprove(envelope.task_id, envelope.payload.approvalId);
        return;
      case 'task.reject':
        await this.handleReject(envelope.task_id, envelope.payload.reason, envelope.payload.approvalId);
        return;
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
    if (this.tasks.has(taskId) || this.finishedTaskIds.has(taskId) || this.strictDeclinedTaskIds.has(taskId)) {
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
    const decline = (reason: string, retryable: boolean): void => {
      this.decline(taskId, reason, retryable, agentRef);
    };
    const sessionRef = offeredSessionRef(payload);
    if ('egressPolicy' in payload) {
      if (this.deps.agentEgressPolicy === undefined || !sameEgressPolicy(this.deps.agentEgressPolicy, payload.egressPolicy)) {
        decline('Agent egress offer policy is not exactly enabled by this daemon', false);
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
    let agentBinding: AgentHomeBinding | undefined;
    let agentLeaseTransferred = false;
    try {
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
        return;
      }

      // Gate A strict local authority: journal receive precedes this runner,
      // and dedup plus pre-cancel above retain their established precedence.
      // This is deliberately before admission, adapter preparation, workspace
      // materialization, claim, start, or any terminal receipt bookkeeping.
      if (this.deps.strictAgentOnly === true && !strictAgentOffer) {
        this.addStrictDeclinedTaskId(taskId);
        decline('strict Agent-only daemon refuses legacy task offers', false);
        return;
      }

      // S3b (L-002): the pre-claim admission veto stays after the strict
      // receive/dedup/cancel precedence above and before every runtime or
      // workspace side effect.
      const guarded = this.deps.admissionGuard?.({ taskId, payload });
      if (guarded !== undefined && !guarded.admit) {
        decline(guarded.reason, guarded.retryable);
        return;
      }

      // M4 Phase 2: the control socket's `shutdown` RPC flips this before
      // tearing down active tasks — any later offer is declined outright.
      if (this.stoppingOffers) {
        decline('daemon is shutting down', true);
        return;
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
        return;
      }

      // M5 batch-3 (workstream 1): `policy.workspaceRoot` IS merged into the
      // effective policy handed to the adapter (`computeEffectivePolicy`,
      // policy.ts) as `ctx.policy.workspaceRoot` — but no bundled adapter
      // actually reads or enforces it; every adapter derives its real
      // confinement from `ctx.workspaceDir` (the daemon-created per-task
      // directory) instead (see docs/security.md's "Workspace confinement is
      // a convention, not a sandbox" section). An OFFER that asks for this
      // control is asking for something that looks live but isn't — decline
      // it fail-closed rather than silently accept an unenforced security
      // constraint. Deliberately checks the RAW offer's own
      // `payload.policy.workspaceRoot`, never the merged/effective policy:
      // `computeEffectivePolicy` falls back to the device's configured
      // CEILING's `workspaceRoot` when the offer itself didn't set one
      // (policy.ts), and that ceiling-only case is a separate, operator-owned
      // decision handled by a one-time startup warning instead (see
      // `create-daemon.ts`'s `start()`) — checking the effective value here
      // would incorrectly decline every single offer once an operator
      // configures ANY ceiling workspaceRoot, not just the ones that actually
      // asked for one.
      if (payload.policy.workspaceRoot !== undefined) {
        decline(
          'offer policy requests workspaceRoot, which no bundled runtime adapter enforces — declining fail-closed rather than silently accepting an unenforced security control',
          true,
        );
        return;
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
        return;
      }

      const requiredToolsets = 'requiredToolsets' in payload ? payload.requiredToolsets : undefined;
      const resolvedMcp = requiredToolsets ? this.resolveMcpServers(requiredToolsets) : undefined;
      if (resolvedMcp && !resolvedMcp.ok) {
        decline(resolvedMcp.reason, true);
        return;
      }

      const decision = computeEffectivePolicy(payload.policy, this.deps.permissionDefaults);
      if (!decision.ok) {
        decline(decision.reason ?? 'policy rejected', false);
        return;
      }

      const offered = withoutRequiredToolsets(payload);
      const requestedRuntime = payload.dispatchSelection?.runtimeId ?? payload.runtime;
      const pick = await this.pickAdapter(requestedRuntime, payload.policy.mode, requiredToolsets !== undefined);
      if (!pick.ok) {
        decline(pick.reason, pick.retryable);
        return;
      }
      let prepared: Awaited<ReturnType<RuntimeAdapter['prepare']>>;
      try {
        prepared = await pick.adapter.prepare({
          offer: offered,
          policy: decision.policy,
          descriptor: pick.descriptor,
          requiredToolsetIds: requiredToolsets ?? [],
          ...(resolvedMcp?.ok ? { mcpServers: resolvedMcp.servers } : {}),
        });
      } catch (error) {
        decline(`runtime preparation failed: ${errorMessage(error)}`, true);
        return;
      }
      if (prepared.kind === 'reject') {
        decline(prepared.reason, prepared.retryable);
        return;
      }

      if (agentRef !== undefined) {
        try {
          agentBinding = await this.deps.agentHome!.acquire(agentRef);
        } catch (error) {
          decline(
            `Agent home admission failed: ${errorMessage(error)}`,
            error instanceof AgentHomeBusyError || !(error instanceof AgentHomeResolutionError),
          );
          return;
        }
      }

      let known: Awaited<ReturnType<SessionWorkspaceStore['get']>> = undefined;
      let workspaceDir: string;
      let gitLease: GitWorkspaceLease | undefined;
      let gitWorkspaceId: string | undefined;
      let gitBaseline: string | undefined;
      let gitExisting = false;
      let plainWorkspaceNeedsResolve = false;
      if (agentBinding !== undefined) {
        workspaceDir = agentBinding.lease.cwd;
        if (sessionRef !== undefined) {
          try {
            await this.deps.agentSessionHandoffs!.requireMatch({
              agentRef: agentBinding.resolution.agentRef,
              sessionRef,
              runtimeId: pick.descriptor.id,
              cwd: workspaceDir,
            });
          } catch (error) {
            await agentBinding.lease.release().catch(() => {});
            agentBinding = undefined;
            decline(`Agent session handoff mismatch: ${errorMessage(error)}`, false);
            return;
          }
        }
        try {
          await this.deps.agentHome!.initialize(agentBinding);
        } catch (error) {
          await agentBinding.lease.release().catch(() => {});
          agentBinding = undefined;
          decline(`Agent home initialization failed: ${errorMessage(error)}`, false);
          return;
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
          workspaceDir = path.join(this.deps.workspaceRoot, taskId);
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
        workspaceDir = known?.workspaceDir ?? path.join(this.deps.workspaceRoot, taskId);
        plainWorkspaceNeedsResolve = true;
      } else {
        decline('workspace mode is unavailable', true);
        return;
      }

      const env = buildRuntimeEnv({
        ambient: process.env,
        requirements: pick.descriptor.environmentRequirements,
        locallyAllowedNames: this.deps.runtimeEnvironment?.[pick.descriptor.id]?.allow,
      });
      const manifest = sealRuntimeOperationManifest({
        taskId,
        runtimeId: pick.descriptor.id,
        descriptor: pick.descriptor,
        policy: decision.policy,
        requiredToolsetIds: requiredToolsets ?? [],
        ...(offered.dispatchSelection === undefined ? {} : { dispatchSelection: offered.dispatchSelection }),
        ...(sessionRef === undefined || (known === undefined && agentBinding === undefined)
          ? {}
          : { sessionRef }),
        ...(agentBinding === undefined ? {} : {
          agentRef: agentBinding.resolution.agentRef,
          cwd: agentBinding.lease.cwd,
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

      // All semantic admission is now in `prepare()` and the frozen manifest.
      // Claim is the first externally visible commitment; instruction bytes,
      // workspace preparation, and process creation remain after it.
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
      let resolvedInstruction: string;
      try {
        resolvedInstruction = await this.resolveInstruction(payload.instruction);
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

      const startInput: RuntimeOperationStartInput = {
        manifest,
        instruction: gitWorkspaceId ? prependGitWorkspaceGuidance(resolvedInstruction) : resolvedInstruction,
        env,
        ...(resolvedMcp?.ok ? { mcpServers: resolvedMcp.servers } : {}),
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
            // `session.resolveApproval()` (e.g. `ClaudeSession.resolveApproval`
            // under `confirm` mode), which in turn is called ONLY from
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
        session = await prepared.operation.start(startInput);
      } catch (err) {
        const failure = projectRuntimeBoundaryFailure(err, 'start');
        if (failure.contractViolation) {
          console.error('[byok/client] runtime adapter start() returned an untyped failure', err);
        }
        await this.updateGitPhaseBestEffort(gitWorkspaceId, 'failed', 'repository-invalid');
        gitLease?.release();
        if (agentBinding === undefined) {
          await this.fail(taskId, failure.reason, failure.retryable);
        } else {
          await this.failClaimedAgent(taskId, failure.reason, failure.retryable, {
            binding: agentBinding,
            runtimeId: pick.descriptor.id,
          });
        }
        return;
      }

      let active!: ActiveTask;
      active = {
        taskId,
        egressEnabled: 'egressPolicy' in payload,
        adapter: pick.adapter,
        session,
        workspaceDir,
        ...(agentBinding === undefined ? {} : {
          agentBinding,
          agentRef: agentBinding.resolution.agentRef,
          agentHandoff: {
            sessionRef: session.sessionRef,
            runtimeId: pick.descriptor.id,
            cwd: workspaceDir,
          },
        }),
        gitWorkspaceId,
        gitLease,
        gitBaseline,
        summaryParts: [],
        batcher: new ProgressBatcher(
          (seq, events) => {
            const projected = active.egressEnabled
              ? this.deps.agentEgress?.projectLatestValue({
                  agentRef: active.agentRef,
                  taskId,
                  events,
                  serverCapabilities: this.deps.getServerCapabilities?.() ?? [],
                }) ?? []
              : events;
            if (projected.length > 0) this.deps.send(createEnvelope('task.progress', { seq, events: [...projected] }, { taskId, seq }));
          },
          this.deps.batcherOptions,
        ),
        approvalQueue: [],
        outputBytesSoFar: 0,
        startedAtMs: Date.now(),
      };

      // A strict Agent handoff is the local restart authority. It is
      // intentionally awaited and fsynced before task.started; an Agent
      // runtime session that has no durable exact-match receipt must never be
      // advertised as resumable.
      if (agentBinding !== undefined) {
        try {
          await this.deps.agentSessionHandoffs!.record({
            agentRef: agentBinding.resolution.agentRef,
            taskId,
            sessionRef: session.sessionRef,
            runtimeId: pick.descriptor.id,
            cwd: workspaceDir,
            leaseId: agentBinding.lease.leaseId,
          });
        } catch (error) {
          await session.close().catch(() => {});
          await this.failClaimedAgent(
            taskId,
            `Agent session handoff could not be durably written before start: ${errorMessage(error)}`,
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
        agentLeaseTransferred = agentBinding !== undefined;
        this.tasks.set(taskId, active);
        this.reserveSemanticTerminal(active);
        try {
          await session.interrupt();
        } catch {
          // best-effort — still report cancellation below
        }
        await this.updateGitPhaseBestEffort(gitWorkspaceId, 'cancelled');
        await this.persistAgentTerminalEvidence(active, 'cancelled', reason);
        this.deps.send(
          createEnvelope(
            'task.cancelled',
            { reason, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active) },
            { taskId },
          ),
        );
        await this.finish(taskId);
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
      agentLeaseTransferred = agentBinding !== undefined;
      this.tasks.set(taskId, active);
      // M5 batch-3 (workstream 2): see `armMaxDurationTimer`'s own doc
      // comment — still inside the synchronous construct -> register -> arm
      // -> pump handoff described just below (no `await` yet).
      if (payload.limits?.maxDurationMs !== undefined) {
        this.armMaxDurationTimer(active, payload.limits.maxDurationMs);
      }
      void this.pump(active);

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
    } finally {
      if (agentBinding !== undefined && !agentLeaseTransferred) {
        await agentBinding.lease.release().catch(() => {});
      }
      this.inFlightOffers.delete(taskId);
    }
  }

  /** Protocol §7: an instruction too large to inline arrives as a `blobRef` — resolve it via the blob client rather than failing closed. */
  private async resolveInstruction(instruction: TaskOfferPayload['instruction']): Promise<string> {
    if (typeof instruction === 'string') return instruction;
    return this.deps.blobClient.resolveInstruction(instruction.blobRef);
  }

  /** Resolve every requested logical id locally and reject missing/colliding server authority before claim. */
  private resolveMcpServers(
    requiredToolsets: readonly string[],
  ):
    | { ok: true; servers: Readonly<Record<string, McpStdioServerConfig>> }
    | { ok: false; reason: string } {
    const registry = this.deps.getMcpToolsets?.();
    if (!registry || registry.size === 0) {
      return { ok: false, reason: 'offer requires MCP toolsets, but this device has no local mcpToolsets registry' };
    }
    const servers = Object.create(null) as Record<string, McpStdioServerConfig>;
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
      }
    }
    if (Object.keys(servers).length === 0) {
      return { ok: false, reason: 'required MCP toolsets resolved to no servers; refusing to run without tools' };
    }
    return { ok: true, servers: Object.freeze(servers) };
  }

  private async pump(active: ActiveTask): Promise<void> {
    try {
      for await (const event of active.session.events) {
        if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return;
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
          );
          return;
        }

        if (event.type === 'usage') {
          // Terminal usage is last-observed, not an accumulator. The bundled
          // Codex/Claude adapters emit their runtime terminal observation
          // before turn_end/error; a custom adapter that emits several keeps
          // only the latest actual observation rather than inventing a sum.
          active.lastUsage = event;
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
          // `byok-approval-mcp.ts`/`create-daemon.ts`'s control socket —
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
          active.batcher.push(event);
          active.batcher.flush();
          const finalOutput = active.summaryParts.join('');
          // additive-minor (`task.complete.document`): resolved BEFORE the
          // 'completed' git observation below, so a task that cannot deliver
          // its structured result takes the salvage path `fail()` already
          // applies to every other failure — rather than being observed as
          // completed and only then failed.
          const outcome = await this.resolveResultDocument(active, finalOutput);
          if (!outcome.deliver) return; // already reported task.fail and finished
          await this.observeGit(active, 'completed');
          if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return;
          // F3 (codex adversarial review, P1): the capability was checked
          // inside `resolveResultDocument` — but `observeGit` above is an
          // await, and a reconnect landing in that window can replace the
          // connection with one whose current transport never advertised
          // `result-document` (`ConnectionManager` clears learned capabilities
          // across transport boundaries, and only a fresh WS ack or poll
          // response repopulates them). The queued envelope would
          // then drain to a server that strips the document silently — the
          // exact loss this whole gate exists to prevent. So the flag is
          // re-read here, after the last await, immediately before the
          // envelope is handed to `send`. See `resolveResultDocument`'s own
          // doc comment for the residual window this still cannot close.
          if (outcome.document !== undefined && !this.hasResultDocumentCapability()) {
            await this.fail(
              active.taskId,
              `${RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}: the connected server stopped advertising the result-document capability before this completion could be sent (a reconnect to an older server), so it would silently discard this document`,
              false,
            );
            return;
          }
          if (!this.reserveSemanticTerminal(active)) return;
          await this.persistAgentTerminalEvidence(active, 'complete');
          this.deps.send(
            createEnvelope(
              'task.complete',
              {
                summary: finalOutput,
                sessionRef: active.session.sessionRef,
                // Spread rather than `document: outcome.document`, so a
                // completion with no document is the exact same payload it
                // was before this field existed — not one carrying an
                // explicit `document: undefined` key.
                //
                // `outcome.document` is the protocol's CANONICAL SNAPSHOT
                // (`checkResultDocument`), never the object the extractor
                // returned: pure data serializes identically at the root
                // (where it was measured) and nested inside this payload
                // (where the codec actually serializes it), so a contextual
                // `toJSON(key)` or an unstable getter cannot make the wire
                // bytes differ from what the cap gate approved.
                ...(outcome.document !== undefined ? { document: outcome.document } : {}),
                ...this.terminalInferenceUsagePayload(active),
                ...this.agentTerminalPayload(active),
              },
              { taskId: active.taskId, sessionRef: active.session.sessionRef },
            ),
          );
          await this.finish(active.taskId);
          return;
        }
        if (event.type === 'progress') {
          active.summaryParts.push(event.text);
        }
        if (event.type === 'artifact') {
          if (active.agentRef !== undefined && this.deps.agentEgress !== undefined) {
            // A runtime artifact is content, not activity metadata. Strict
            // Agent egress never uploads it through the legacy blob path;
            // only the separately capability-gated artifact-read contract
            // may authorize a content transfer.
            this.deps.agentEgress.noteTransportDrop('policy_denied', active.agentRef);
          } else {
            await this.sendArtifact(active, event.name, event.contentType);
          }
        }
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
      const failure = projectRuntimeBoundaryFailure(undefined, 'run');
      console.error('[byok/client] runtime adapter events iterable ended without terminal authority');
      await this.fail(active.taskId, failure.reason, failure.retryable);
    } catch (err) {
      if (this.tasks.get(active.taskId) !== active || active.beingTornDown) return;
      active.batcher.flush();
      if (err instanceof ProgressEventTooLargeError) {
        await this.failActiveTaskForResourceLimit(
          active.taskId,
          `${MAX_PROGRESS_BATCH_BYTES_EXCEEDED_REASON_PREFIX}: event requires ${err.actualBytes} UTF-8 bytes, exceeding the configured limit of ${err.maxBatchBytes} bytes`,
        );
        return;
      }
      const failure = projectRuntimeBoundaryFailure(err, 'run');
      if (failure.contractViolation) {
        console.error('[byok/client] runtime adapter events iterable returned an untyped failure', err);
      }
      await this.fail(active.taskId, failure.reason, failure.retryable);
    }
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
      bytes = await opened.handle.readFile();
    } catch (err) {
      this.reportArtifactError(active, name, `failed to read artifact "${name}": ${errorMessage(err)}`);
      return;
    } finally {
      await opened.handle.close().catch(() => {});
    }

    if (bytes.length <= MAX_INLINE_ARTIFACT_BYTES) {
      const inline = bytes.toString('base64');
      if (new TextEncoder().encode(inline).length <= MAX_INLINE_ARTIFACT_BYTES) {
        this.deps.send(createEnvelope('task.artifact', { name, contentType, inline }, { taskId: active.taskId }));
        return;
      }
    }

    try {
      const blobRef: BlobRef = await this.deps.blobClient.uploadArtifact(bytes, contentType);
      this.deps.send(createEnvelope('task.artifact', { name, contentType, blobRef }, { taskId: active.taskId }));
    } catch (err) {
      this.reportArtifactError(active, name, `failed to upload artifact "${name}": ${errorMessage(err)}`);
    }
  }

  /** Loud, non-silent artifact failure (finding F7): logged, and folded into this task's own progress stream as an `error` AgentEvent rather than swallowed — the task itself can still complete normally, but the omission is now visible. */
  private reportArtifactError(active: ActiveTask, name: string, reason: string): void {
    console.error(`[byok/client] artifact "${name}" for task ${active.taskId} dropped: ${reason}`);
    active.batcher.push({ type: 'error', message: reason });
  }

  private async handleCancel(taskId: string, reason: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) {
      // Finding F4: not registered yet — record it in case handleOffer is
      // still in flight for this exact taskId (claimed but not yet started;
      // see the class-level doc on `pendingCancelled` and the two
      // checkpoints in handleOffer). A genuinely stale/unknown/already-
      // finished taskId just leaves a harmless, never-consulted entry —
      // identical in effect to the old silent-drop behavior for that case
      // (M3-B: except now bounded — see `setPendingCancelled`).
      this.setPendingCancelled(taskId, reason);
      return;
    }
    if (active.finalizationStarted) {
      await this.finish(taskId);
      return;
    }
    if (!this.reserveSemanticTerminal(active)) {
      await active.semanticTerminalSettled;
      return;
    }
    try {
      await active.session.interrupt();
    } catch {
      // best-effort — still report cancellation below
    }
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
    this.deps.send(
      createEnvelope(
        'task.cancelled',
        { reason, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active) },
        { taskId },
      ),
    );
    await this.finish(taskId);
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
   * M4 Phase 3: the daemon-side half of the out-of-band approval channel
   * (`types.ts`'s `ApprovalChannel`) — called from `create-daemon.ts`'s
   * `approvals.request` control method, itself called by `byok-approval-mcp`
   * (a claude-spawned MCP-server child process, NOT the adapter/session
   * in-process — see `ApprovalChannel`'s own doc comment for the full why
   * this seam exists at all rather than an `AgentEvent`).
   *
   * Deliberately independent of the dormant `needs_approval` `AgentEvent`
   * path in `pump()` below (~line 611): empirically confirmed (M4 Phase 3
   * STEP 0), claude's own stream-json output emits NOTHING while a
   * permission-prompt-tool call is outstanding — the gap between a `tool_use`
   * frame and its `tool_result` is invisible on the wire, indistinguishable
   * from ordinary model "thinking" latency. `pump()`'s for-await loop over
   * `active.session.events` therefore has no event to ever branch on for
   * this case; the ONLY signal that a task is paused arrives out-of-band,
   * over the control socket, which is exactly what this method is for. The
   * `needs_approval` path stays dormant, untouched, for a hypothetical
   * future adapter whose runtime DOES expose the pause on its own event
   * stream.
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
   * M4 Phase 4 (fold-in from the P3 gate — concurrent-approval-overwrite
   * fix): claude's parallel tool use can call this MORE THAN ONCE for the
   * SAME task before the first call's approval is resolved — each parallel
   * tool call is its own independent `byok-approval-mcp` `tools/call`
   * request, and the MCP protocol lets several be in flight on one
   * connection at once (see `byok-approval-mcp.ts`'s own doc comment on
   * sharing one control-socket connection across them). Before this fix,
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
   * (`byok-approval-mcp.ts`, `create-daemon.ts`'s control socket, this file's
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
   * awaiting `requestApproval()`'s promise (`byok-approval-mcp`, ultimately
   * the paused runtime turn). Any further progress from the resumed session
   * can only be produced AFTER that unblock, which needs at least one more
   * microtask/event-loop turn — so `task.approval_resolved` is always queued
   * ahead of it with no extra bookkeeping needed here.
   */
  private sendApprovalResolved(taskId: string, approvalId: string, decision: ApprovalDecision): void {
    const capabilities = this.deps.getServerCapabilities?.() ?? [];
    if (!capabilities.includes('approval_resolved')) return;
    this.deps.send(
      createEnvelope(
        'task.approval_resolved',
        { approvalId, decision, resolvedBy: 'local', at: new Date().toISOString() },
        { taskId },
      ),
    );
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
    if (active.finalizationStarted) {
      await this.finish(taskId);
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
    if (!this.reserveSemanticTerminal(active)) {
      await active.semanticTerminalSettled;
      return;
    }
    try {
      await active.session.interrupt();
    } catch {
      // best-effort
    }
    await this.observeGit(active, 'salvage');
    // Same reasoning as handleCancel() above: the server already moved this
    // task to `Failed` and closed its event queue before this notification
    // arrived, so flushing buffered progress here would be unobservable and
    // only trigger a spurious server-side warning.
    await this.persistAgentTerminalEvidence(active, 'failed', reason ?? 'rejected');
    this.deps.send(
      createEnvelope(
        'task.fail',
        { reason: reason ?? 'rejected', retryable: false, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active) },
        { taskId },
      ),
    );
    await this.finish(taskId);
  }

  /** Pre-claim, fail-closed rejection (protocol §3.2) — never claims first. */
  private decline(taskId: string, reason: string, retryable: boolean, agentRef?: AgentRef): void {
    this.deps.send(createEnvelope(
      'task.decline',
      { reason, retryable, ...(agentRef === undefined ? {} : { agentRef }) },
      { taskId },
    ));
  }

  private async fail(taskId: string, reason: string, retryable: boolean): Promise<void> {
    const active = this.tasks.get(taskId);
    if (active?.finalizationStarted) {
      await this.finish(taskId);
      return;
    }
    if (active && !this.reserveSemanticTerminal(active)) {
      await active.semanticTerminalSettled;
      return;
    }
    if (active) await this.observeGit(active, 'salvage');
    if (active) await this.persistAgentTerminalEvidence(active, 'failed', reason);
    this.deps.send(
      createEnvelope(
        'task.fail',
        active === undefined
          ? { reason, retryable }
          : { reason, retryable, ...this.terminalInferenceUsagePayload(active), ...this.agentTerminalPayload(active) },
        { taskId },
      ),
    );
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
  ): Promise<boolean> {
    const agentRef = context.binding.resolution.agentRef;
    const result = await this.retryAgentTerminalEvidence(() =>
      this.deps.agentSessionHandoffs!.recordTaskTerminal({
        agentRef,
        taskId,
        runtimeId: context.runtimeId,
        cwd: context.binding.lease.cwd,
        leaseId: context.binding.lease.leaseId,
        ...(context.sessionRef === undefined ? {} : { sessionRef: context.sessionRef }),
        terminalReason: reason,
      }),
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
      { reason, retryable, agentRef },
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
   * absent. Pi exposes no native usage observation, so its terminal payload
   * omits this optional block rather than fabricating a usage observation from
   * independently known runtime, elapsed duration, or Local Agent version.
   */
  private terminalInferenceUsagePayload(active: ActiveTask): { usage?: TerminalInferenceUsage } {
    const release = this.deps.localAgentRelease;
    const runtimeId = active.adapter.descriptor.id;
    if (release === undefined || active.lastUsage === undefined || !isKnownRuntimeId(runtimeId)) return {};

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

  /** Exact Agent identity projection for claim/terminal wire payloads. */
  private agentTerminalPayload(active: ActiveTask): { agentRef?: AgentRef } {
    return active.agentRef === undefined ? {} : { agentRef: active.agentRef };
  }

  /**
   * additive-minor (`task.complete.document`): the whole daemon-side gate
   * between a configured {@link ResultDocumentExtractor} and the wire —
   * called once, from the `turn_end` completion path, immediately before
   * `task.complete` is built.
   *
   * `{deliver: true}` means "go on and send `task.complete`", carrying the
   * document when there is one. `{deliver: false}` means this method has
   * ALREADY reported `task.fail` and finished the task; the caller must
   * return without sending anything further.
   *
   * Four fail-closed branches, all `retryable: false` (see
   * {@link RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX} for why none of them
   * can succeed on a retry):
   *
   *   1. The extractor threw — its error is surfaced, never swallowed.
   *   2. The extractor returned a thenable, violating the synchronous
   *      contract in the one way that would otherwise ship a wrong answer.
   *   3. The document is over the cap, not JSON-serializable, or not plain
   *      JSON data, per `checkResultDocument` — the protocol's OWN check,
   *      imported rather than reimplemented, so this gate and the server's
   *      schema validation can never disagree about what is legal.
   *   4. The connected server never advertised `result-document`. Its
   *      tolerant `z.object()` would silently strip the field on arrival
   *      (`version.ts`'s own flag doc comment), so "send anyway" is not a
   *      degraded-but-working path — it is the task's primary structured
   *      result being deleted in transit with nothing reported anywhere.
   *
   * The capability is checked LAST, deliberately: a document that is itself
   * invalid is the host's own bug and is worth reporting as such even when
   * the connected server could not have accepted any document at all. It is
   * then re-checked once more by the caller after its own last await, since
   * a reconnect can invalidate this answer in between (F3).
   *
   * **Residual window (bounded, deliberately not hacked around).** Even the
   * caller's re-check happens before `ConnectionManager.send` hands the
   * envelope to a transport, and a queued envelope can outlive the
   * connection it was queued for: a reconnect between `send()` and the
   * outbox actually draining could still deliver this `task.complete` to a
   * rolled-back N-1 server that strips the document. Closing that would
   * mean teaching the transport outbox to inspect payload semantics and
   * mint a substitute `task.fail` for a task this runner already finished —
   * a second authority over terminal outcomes living in the queue, which is
   * worse than the window it closes. Documented instead, here and in
   * docs/protocol.md §7.2.
   */
  private async resolveResultDocument(
    active: ActiveTask,
    finalOutput: string,
  ): Promise<{ deliver: true; document?: unknown } | { deliver: false }> {
    const extract = this.deps.resultDocument?.extract;
    if (!extract) return { deliver: true };

    let document: unknown;
    try {
      document = extract(finalOutput, { taskId: active.taskId, sessionRef: active.session.sessionRef });
    } catch (err) {
      await this.fail(
        active.taskId,
        `${RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}: the configured resultDocument.extract threw: ${errorMessage(err)}`,
        false,
      );
      return { deliver: false };
    }

    // A thenable is the one violation of the synchronous contract that would
    // otherwise pass every check below and ship a WRONG answer: a promise
    // JSON-stringifies to `{}` — a well-formed, comfortably-under-cap
    // document that the server accepts, persists, and hands the product as
    // its truthful terminal result. Silently delivering `{}` where the real
    // document should be is strictly worse than failing, so this is
    // fail-closed alongside the throw branch above rather than left to the
    // documented contract alone.
    if (typeof (document as { then?: unknown } | null | undefined)?.then === 'function') {
      await this.fail(
        active.taskId,
        `${RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}: the configured resultDocument.extract returned a promise; the contract is synchronous (an awaited value is never read, and a promise encodes to an empty document)`,
        false,
      );
      return { deliver: false };
    }

    // "This task has no structured result" — indistinguishable, on the wire
    // and to the server, from no extractor being configured at all.
    if (document === undefined) return { deliver: true };

    const check = checkResultDocument(document);
    if (!check.ok) {
      const detail = resultDocumentRejectionDetail(check);
      await this.fail(active.taskId, `${RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}: ${detail}`, false);
      return { deliver: false };
    }

    if (!this.hasResultDocumentCapability()) {
      await this.fail(
        active.taskId,
        `${RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}: the connected server did not advertise the result-document capability, so it would silently discard this ${check.bytes}-byte document`,
        false,
      );
      return { deliver: false };
    }

    // The CANONICAL SNAPSHOT, not the object the extractor returned — see
    // `checkResultDocument` and the send site in `pump`.
    return { deliver: true, document: check.canonical };
  }

  /**
   * Whether the CURRENTLY connected server advertised `result-document` —
   * read fresh on every call, never captured, because the answer changes
   * across a reconnect or transport switch (`ConnectionManager` clears the
   * old advertisement at the boundary, then repopulates it from a fresh WS
   * ack or successful poll response). An absent `getServerCapabilities` seam is
   * "no capabilities", the fail-closed reading.
   */
  private hasResultDocumentCapability(): boolean {
    return (this.deps.getServerCapabilities?.() ?? []).includes('result-document');
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
    active.terminalCause = cause;
    active.terminalReason = reason;
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
          cwd: handoff.cwd,
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

  private async finish(taskId: string): Promise<boolean> {
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
      active.batcher.stop();
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

    const attempt = active.disposalAttempt ?? active.session.close();
    active.disposalAttempt = attempt;
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
      console.error(`[byok/client] runtime disposal failed for task ${taskId}: ${failure.message}`);
      this.deps.onRuntimeDisposalFailure?.({
        taskId,
        runtimeId: active.adapter.descriptor.id,
        stage: failure.stage,
        reason: failure.message,
      });
      active.resolveSemanticTerminalSettled?.(false);
      return false;
    }
    if (this.tasks.get(taskId) !== active) return true;
    if (active.agentBinding !== undefined && active.agentRef !== undefined && active.agentHandoff !== undefined) {
      const agentRef = active.agentRef;
      const handoff = active.agentHandoff;
      if (!active.agentTerminalPersisted) {
        const cause = active.terminalCause ?? 'failed';
        const result = await this.retryAgentTerminalEvidence(() =>
          this.deps.agentSessionHandoffs!.recordTerminal(
            {
              agentRef,
              sessionRef: handoff.sessionRef,
              runtimeId: handoff.runtimeId,
              cwd: handoff.cwd,
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
      this.tasks.delete(taskId);
      active.resolveSemanticTerminalSettled?.(leaseReleased);
      return leaseReleased;
    }
    active.gitLease?.release();
    this.tasks.delete(taskId);
    active.resolveSemanticTerminalSettled?.(true);
    return true;
  }

  private reserveSemanticTerminal(active: ActiveTask): boolean {
    if (active.semanticTerminalReserved || active.finalizationStarted) return false;
    active.semanticTerminalReserved = true;
    active.beingTornDown = true;
    active.semanticTerminalSettled = new Promise<boolean>((resolve) => {
      active.resolveSemanticTerminalSettled = resolve;
    });
    return true;
  }

  /** M3-B: bounded insert for `finishedTaskIds` — see its class-level doc comment and `MAX_TRACKED_TASK_IDS`. Evicts the oldest (first-inserted) entry once over cap, same idiom as `ConnectionHub.checkAndRecordDuplicate` (packages/server/src/hub.ts). */
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
    const dir = reuseDir ?? path.join(this.deps.workspaceRoot, taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * M5 batch-3 (workstream 1): selects which adapter runs this offer, now
   * gated on both PRESENCE (`adapter.detect()`, as before) and CAPABILITY
   * (`adapterSupportsMode` — can this adapter even express `policyMode`?
   * new in this batch) — pre-claim, in both the explicit-runtime and
   * auto-select branches.
   *
   * Explicit-runtime branch (`requestedRuntime` set): semantics otherwise
   * unchanged from before this batch — allowlist and known-adapter checks
   * first, THEN the new capability check, THEN presence. A capability
   * mismatch here is a permanent characteristic of naming THIS runtime with
   * THIS policy (e.g. pi never supports `confirm`, on any device, by
   * design — `pi/permission-mapping.ts`) — `retryable: false`, the same
   * class as "not in allowlist"/"unknown runtime" above it, since retrying
   * this exact (runtime, mode) pair anywhere changes nothing.
   *
   * Auto-select branch (`requestedRuntime` absent): candidates are ordered
   * by `runtimePreference` (default {@link DEFAULT_RUNTIME_PREFERENCE}) —
   * see `orderByPreference` — then walked in that order; a candidate that
   * can't express `policyMode` is skipped (not detected at all — capability
   * is checked first, cheaper than a real subprocess probe) and the walk
   * continues down the preference order, exactly as "skip non-supporting
   * adapters and continue down the order" describes. If NOTHING eligible
   * supports the mode, `retryable: true` — unlike the explicit branch, this
   * is device-specific (which runtimes happen to be installed here), so a
   * different device's installed runtime set might satisfy it.
   */
  private async pickAdapter(
    requestedRuntime: string | undefined,
    policyMode: PermissionMode,
    requiresMcpToolsets: boolean,
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
      if (!adapterSupportsMode(descriptor, policyMode)) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" cannot express permission mode "${policyMode}"`,
          retryable: false,
        };
      }
      if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" cannot project required MCP toolsets`,
          retryable: false,
        };
      }
      const detected = await adapter.detect();
      if (!detected.present) {
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
      if (!adapterSupportsMode(descriptor, policyMode)) continue;
      if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) continue;
      const detected = await adapter.detect();
      if (detected.present) return { ok: true, adapter, descriptor };
    }
    return {
      ok: false,
      reason: requiresMcpToolsets
        ? `no available runtime on this device can express permission mode "${policyMode}" with required MCP toolsets`
        : `no available runtime on this device can express permission mode "${policyMode}"`,
      retryable: true,
    };
  }
}
