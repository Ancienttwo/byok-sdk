// Types and helpers shared by `TaskRunner` (../task-runner.ts) and the member
import type { ToolAuthorizationPolicy } from '../../tool-authorization';
import type { RuntimeTaskInput } from '../../types';
// modules in this directory.
//
// A member module holds the bodies of `TaskRunner` methods as functions that
// run with `this` bound to the runner: the class keeps each member's
// declaration, documentation and a one-line delegating stub, because the
// published `task-runner.d.ts` prints every member, private ones included.
// A body reads private state as `this['name']`, which TypeScript type-checks
// like the dot form, and calls other members through the runner so that a
// stub, a test spy or a fixture override still sees every call.
import type { ResultReplyFailure } from '../result-reply-failure';
import { AgentMessageDraftPublisher } from '../agent-message-draft';
import type { ExecutionScratch } from '../retention/scratch';
import { randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeIdSchema, TERMINAL_INFERENCE_USAGE_MAX_TOKENS, type AgentEvent, type AgentMessageEgressRequirement, type AgentEgressPolicy, type Envelope, type PreparedAgentMemoryMode, type RuntimeId, type TerminalAgentHomeProjection, type TerminalAgentHomeMemoryChange, type TerminalProjectionSelection, type TaskDeclinePayload, type InputPreparationOfferBinding } from '@byok-sdk/protocol';
import type { RuntimeAdapter, RuntimeAdapterDescriptor, Session } from '../../types';
import { type AgentHomeExecutionBinding, type AgentRef, validateAgentRef } from '../../agent-home';
import type { AgentHomeAccessMode, AgentHomeMemoryDigest } from '../../agent-home-readers';
import type { AgentTerminalCause } from '../agent-session-handoff-store';
import type { BlobResolver } from '../blob-client';
import { ExecutionRecordAccumulator, type ExecutionRecord } from '../execution-record';
import { ProgressBatcher } from '../progress-batcher';
import { AgentMessageOutbox } from '../agent-message-outbox';
import { AgentResultStore } from '../agent-result-store';
import type { ApprovalKind } from '../approvals';
import type { TaskRunner, TaskRunnerDeps } from '../task-runner';
import { PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX, PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX } from '../task-runner';
import type { OfferAdmissionTiming } from './offer-admission-timing';

/**
 * The offer union `task-runner.ts` declares. It stays unexported there because
 * the published d.ts prints it as a local alias, so the modules here read that
 * one definition through the exported `admissionGuard` seam.
 */
export type AcceptedOfferPayload = Parameters<NonNullable<TaskRunnerDeps['admissionGuard']>>[0]['payload'];

export const AGENT_TERMINAL_EVIDENCE_RETRY_DELAY_MS = 20;

/** Inline artifact payloads must stay under this many UTF-8 bytes — mirrors the frozen `TaskArtifactPayloadSchema.inline` limit in `packages/protocol` (see docs/protocol.md §7). Anything bigger goes through the blob client. */
export const MAX_INLINE_ARTIFACT_BYTES = 64 * 1024;

/**
 * What one prepared Execution has observed about its provider calls so far.
 *
 * Seeded at admission from the durable record — the frozen artifact's request
 * digest and the context window of the model D was compiled for — and advanced
 * by every runtime `usage` event, each of which is ONE provider call's
 * observation on the prepared lane. `initialPromptTokens` is the first call's
 * prompt, the only call whose request is D; `maxPromptTokens` is the largest
 * prompt of any call.
 */
export interface PreparedExecutionObservation {
  readonly requestDigest: string;
  readonly contextWindow: number;
  calls: number;
  initialPromptTokens?: number;
  maxPromptTokens?: number;
}

/**
 * Advance one prepared observation by one provider call and classify it.
 *
 * Returns the typed failure reason when the call ends the Execution —
 * {@link PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX} for a call with no positive,
 * representable prompt count, {@link PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX}
 * for a prompt at or above the context window — and `undefined` when it does
 * not. Numbers only.
 */
export function observePreparedCall(
  observation: PreparedExecutionObservation,
  event: Extract<AgentEvent, { type: 'usage' }>,
): string | undefined {
  // Context-only observations are telemetry, not an unreadable provider call.
  // A bare usage event still represents an unreadable call and fails closed.
  if (event.contextSource !== undefined &&
      event.inputTokens === undefined && event.cachedInputTokens === undefined &&
      event.outputTokens === undefined && event.reasoningTokens === undefined &&
      event.totalTokens === undefined) return undefined;
  observation.calls += 1;
  const prompt = event.inputTokens;
  if (prompt === undefined || !Number.isSafeInteger(prompt) || prompt <= 0 || prompt > TERMINAL_INFERENCE_USAGE_MAX_TOKENS) {
    return `${PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX}: provider call ${observation.calls} of this prepared Execution`
      + ' reported no positive, representable prompt token count';
  }
  if (observation.initialPromptTokens === undefined) observation.initialPromptTokens = prompt;
  observation.maxPromptTokens = Math.max(observation.maxPromptTokens ?? 0, prompt);
  if (prompt >= observation.contextWindow) {
    return `${PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX}: provider call ${observation.calls} of this prepared Execution`
      + ` reported ${prompt} prompt tokens, at or above the ${observation.contextWindow}-token context window`
      + ' of the model its request was prepared for';
  }
  return undefined;
}

export interface ActiveTask {
  taskId: string;
  /** Cancels every blob transfer owned by this task before its terminal path runs. */
  blobAbort: AbortController;
  /** True for offers carrying egressPolicy, including prepared execution. */
  egressEnabled: boolean;
  adapter: RuntimeAdapter;
  session: Session;
  scratch: ExecutionScratch;
  /** One consumer; teardown drains its final usage within the existing interrupt deadline. */
  eventPump?: Promise<void>;
  workspaceDir: string;
  /** Host-resolved before claim; `all` tasks get reminders from the event stream. */
  toolAuthorization: ToolAuthorizationPolicy;
  agentBinding: AgentHomeExecutionBinding;
  agentRef: AgentRef;
  agentHandoff: {
    sessionRef: string;
    runtimeId: string;
    /** Canonical Agent home; the handoff ledger lives under it. */
    home: string;
    cwd: string;
    homeAccess?: 'memory-reader';
  };
  /** The task-free projection applied when this Agent Attempt started; see `TerminalAgentHomeProjectionSchema`. */
  appliedAgentHomeProjection?: TerminalAgentHomeProjection;
  /**
   * A `memory-reader` Attempt's memory digest at start; `digest` is
   * `undefined` when it could not be measured. Absent for a writer.
   */
  readerMemoryBaseline?: { readonly digest: AgentHomeMemoryDigest | undefined };
  /** Measured once, at the first terminal decision; see `TerminalAgentHomeMemoryChangeSchema`. */
  agentHomeMemoryChange?: TerminalAgentHomeMemoryChange;
  terminalCause?: AgentTerminalCause;
  terminalReason?: string;
  agentTerminalPersisted?: boolean;
  agentTerminalEvidenceFailureReported?: boolean;
  batcher: ProgressBatcher;
  summaryParts: string[];
  /**
   * The FINAL text run only: every `progress` text emitted after the last
   * tool interaction (`tool_use` / `tool_result`), which
   * reset it. `summaryParts` above stays the whole run's concatenation and
   * remains what `task.complete.summary` carries; this narrower slice is
   * what the DAEMON-authored required Agent message publishes, so the
   * user-visible reply is the model's closing answer rather than its
   * intermediate narration ("let me read X first…") glued in front of it.
   *
   * The same slice is `task.complete.finalMessage`, so the host reads the same closing reply
   * the daemon would publish. An adapter whose descriptor sets
   * `progressEventsAreMessages` (Codex, Claude) also resets it at each `progress`
   * event that `Session.progressStartsMessage` does not mark as a
   * continuation, so the slice is that runtime's last whole message.
   *
   * `turn_end` deliberately does not reset (it is what reads this), and
   * neither does `usage`: bundled adapters emit terminal usage IMMEDIATELY
   * BEFORE `turn_end` (see `claude/events.ts` — "Ordering is load-bearing"),
   * so resetting on it would discard every closing reply. `artifact` does
   * not reset either — it is a content side effect, not a tool interaction
   * the model narrates around.
   */
  finalTextParts: string[];
  /**
   * The `ApprovalRegistry` id and rejection semantics of the single approval
   * currently DISPATCHED (registered + `task.await_approval` sent) for this
   * task, if any — set by `requestApproval`/`dispatchApproval`, cleared once
   * resolved (by a real decision or by the timeout). `undefined` whenever
   * nothing is dispatched right now — including while `approvalQueue` below
   * is non-empty but hasn't been dispatched yet. See `requestApproval`.
   */
  pendingApproval?: { readonly approvalId: string; readonly kind: ApprovalKind };
  /**
   * M4 Phase 4 (fold-in from the P3 gate): FIFO queue of `requestApproval`
   * calls for this SAME task that arrived while another one was already
   * dispatched (`pendingApproval` set) — see `requestApproval`'s own doc
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
  artifactBytesSoFar?: number;
  /** Device monotonic-ish wall-clock anchor taken only after a Session started. */
  startedAtMs: number;
  /** Fed by `pump` until the terminal decision; published once by `finishOnce`. */
  executionRecord: ExecutionRecordAccumulator;
  executionRecordPublished?: boolean;
  /**
   * Last runtime usage observation received before this task's terminal
   * signal. This is intentionally NOT accumulated: Codex and Claude expose a
   * terminal turn-level usage object, and adding observations would invent a
   * cross-runtime accounting meaning this client does not own.
   */
  lastUsage?: Extract<AgentEvent, { type: 'usage' }>;
  /**
   * Present exactly on a prepared Execution. Unlike `lastUsage` it IS advanced
   * per event, because on the prepared lane each `usage` event is one provider
   * call and the observation it feeds is first-call and maximum, not a sum.
   */
  prepared?: PreparedExecutionObservation;
  /** Distinguishes runner-initiated teardown from an unexpected event-stream end. */
  beingTornDown?: boolean;
  /** Set before the first disposal await so no racing path can publish a second semantic terminal. */
  finalizationStarted?: boolean;
  /** The first terminal decision owns all retries, including pre-publication durability. */
  semanticTerminal?: {
    readonly prepare: () => Promise<Envelope>;
    envelope?: Envelope;
    attempt?: Promise<boolean>;
  };
  /** Shared receipt for concurrent finish/shutdown callers; cleared after a failed attempt so shutdown can retry. */
  disposalAttempt?: Promise<void>;
  messageRequirement?: Readonly<AgentMessageEgressRequirement>;
  messageDraft?: AgentMessageDraftPublisher;
  terminalProjection?: Readonly<TerminalProjectionSelection>;
  /** Present exactly for a result-document task: where its `submit_result` outcome is staged. */
  resultStore?: AgentResultStore;
  messageOutbox?: AgentMessageOutbox;
  /** A send attempt may already have entered transport; failure must preserve its admission recovery. */
  messageSendAttempted?: boolean;
  messageAccepted?: boolean;
  resultReplyFailure?: ResultReplyFailure;
  pendingMessageCompletion?: { readonly finalOutput: string; readonly document?: unknown; readonly failureReason?: string };
  messageRetryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One result-document task's `submit_result` binding. The schema and contract
 * are the offer's frozen selection; `store`/`agentRef` are bound once the
 * Agent home is initialized, before the runtime starts.
 */
export interface AgentResultContext {
  readonly taskId: string;
  readonly token: string;
  readonly contract: string;
  readonly schema: unknown;
  store?: AgentResultStore;
  agentRef?: AgentRef;
}

export interface PendingMessageTask {
  readonly taskId: string;
  readonly agentRef: AgentRef;
  readonly requirement: Readonly<AgentMessageEgressRequirement>;
  readonly outbox: AgentMessageOutbox;
}

export interface ClaimedAgentFailureContext {
  readonly binding: AgentHomeExecutionBinding;
  readonly runtimeId: string;
  readonly sessionRef?: string;
}

/** One not-yet-dispatched `requestApproval` call waiting its turn — see `ActiveTask.approvalQueue`. */
export interface QueuedApprovalRequest {
  readonly kind: ApprovalKind;
  summary: string;
  resolve: (result: { approved: boolean; reason?: string }) => void;
  readonly signal?: AbortSignal;
}

/**
 * A typed pre-claim admission cause that is not a human-readable reason
 * (#1103). Today only a Host-configured version block: the nested wire field and
 * the shared cause vocabulary are later slices, so `offer-runtime` projects the
 * open `task.decline.code` token `runtime_version_blocked` and never parses the
 * reason.
 */
export interface RuntimeVersionBlockedAdmission {
  readonly cause: 'version_blocked';
}

export type PickResult =
  | { ok: true; adapter: RuntimeAdapter; descriptor: RuntimeAdapterDescriptor }
  | { ok: false; reason: string; retryable: boolean; versionBlock?: RuntimeVersionBlockedAdmission };

/** The closures that handleOffer builds once and gives to its phase methods. */
export interface OfferPhaseContext {
  readonly taskId: string;
  readonly decline: (reason: string, retryable: boolean, code?: TaskDeclinePayload['code']) => void;
  readonly admissionWithdrawn: () => boolean;
  /** Aborted exactly when `admissionWithdrawn()` would decline: cancel, shutdown, or the startup deadline. */
  readonly admissionSignal: AbortSignal;
  readonly releaseReservation: () => void;
  readonly reserveHome: (reservationKey: string) => void;
  readonly admission: OfferAdmissionTiming;
}

/** The front-phase values that `prepareOfferRuntime` reads. */
export interface OfferRuntimeInput {
  readonly acquireScratch: () => Promise<ExecutionScratch>;
  readonly payload: AcceptedOfferPayload;
  readonly agentRef: AgentRef;
  readonly preparation: InputPreparationOfferBinding | undefined;
  readonly preparedMemorySelected: boolean;
  /** The memory mode of an ordinary Agent offer; the prepared lane does not read it. */
  readonly ordinaryMemoryMode: PreparedAgentMemoryMode;
  /** Whether an ordinary Agent offer binds the memory MCP, decided once at offer time. */
  readonly ordinaryMemoryMcp: boolean;
  readonly messageRequirement: Readonly<AgentMessageEgressRequirement> | undefined;
  readonly terminalProjection: Readonly<TerminalProjectionSelection> | undefined;
  readonly readerAttempt: boolean;
  readonly requiredToolsets: readonly string[] | undefined;
  readonly resolvedMcp: ReturnType<TaskRunner['resolveMcpServers']> | undefined;
  readonly blobAbort: AbortController;
}

/**
 * Resolves once every attempt settled or `signal` aborted, whichever is first.
 * Never rejects and leaves no listener behind. See `reserveOfferHome` (#476).
 */
export async function settledOrWithdrawn(attempts: readonly Promise<unknown>[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const withdrawn = new Promise<void>((resolve) => { onAbort = resolve; });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([Promise.allSettled(attempts), withdrawn]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** The closing reply (`ActiveTask.finalTextParts`), or `undefined` when it holds only whitespace. */
export function closingReply(active: ActiveTask): string | undefined {
  const text = active.finalTextParts.join('');
  return text.trim() === '' ? undefined : text;
}

/** The execution record's terminal for the semantic terminal envelope this runner sent. */
export function executionTerminalOf(envelope: Envelope | undefined): ExecutionRecord['terminal'] | undefined {
  switch (envelope?.type) {
    case 'task.complete': return 'complete';
    case 'task.fail': return 'failed';
    case 'task.cancelled': return 'cancelled';
    default: return undefined;
  }
}

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
export function isKnownRuntimeId(id: string): id is RuntimeId {
  return RuntimeIdSchema.safeParse(id).success;
}

/** Preserve a runtime/device number only when the terminal wire contract can represent it exactly. */
export function terminalUsageNumber(value: number | undefined, maximum: number): number | undefined {
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
export const DEFAULT_RUNTIME_PREFERENCE: readonly RuntimeId[] = ['claude', 'codex', 'pi'];

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
export function orderByPreference(candidates: readonly RuntimeAdapter[], preference: readonly string[]): RuntimeAdapter[] {
  const rank = new Map(preference.map((id, index) => [id, index]));
  return [...candidates].sort((a, b) => (rank.get(a.descriptor.id) ?? preference.length) - (rank.get(b.descriptor.id) ?? preference.length));
}

export function adapterSupportsMcpToolsets(descriptor: RuntimeAdapterDescriptor): boolean {
  return descriptor.capabilities.mcpToolsets === true;
}

/**
 * The runtime's view of an offer: the wire payload without the fields the
 * daemon itself consumes, and `sessionRef` when the offer resumes a session.
 * `prepare()` admits a RUNTIME, and a preparation reference is not a runtime
 * input: the prepared lane carries it to `start()` as its own start variant.
 */
export function runtimeTaskInput(payload: AcceptedOfferPayload): RuntimeTaskInput {
  const { requiredToolsets, egressPolicy, messageEgress, preparation, session, ...offer } = payload;
  void requiredToolsets;
  void egressPolicy;
  void messageEgress;
  void preparation;
  return { ...offer, ...(session.mode === 'resume' ? { sessionRef: session.sessionRef } : {}) } as RuntimeTaskInput;
}

/**
 * The preparation this offer names, or `undefined` for every ordinary offer.
 * The presence of this value is what selects the prepared lane.
 */
export function offeredPreparation(payload: AcceptedOfferPayload): InputPreparationOfferBinding | undefined {
  return payload.preparation;
}

/**
 * The instruction an ordinary offer carries.
 *
 * A prepared offer has none, and that is not an omission to default around: the
 * user request is already inside the frozen envelope its record retained, and a
 * prepared run that resolved a separate instruction would have two answers to
 * what it is about to send.
 */
export function offeredInstruction(payload: AcceptedOfferPayload): RuntimeTaskInput['instruction'] | undefined {
  return payload.instruction;
}

export function sameEgressPolicy(left: Readonly<AgentEgressPolicy>, right: Readonly<AgentEgressPolicy>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function offeredAgentRef(payload: AcceptedOfferPayload): AgentRef | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'agentRef')) return undefined;
  return validateAgentRef((payload as unknown as { agentRef?: unknown }).agentRef);
}

/**
 * The session a resume offer names; a fresh offer has none. Preserve that
 * absence through admission and manifest sealing so only a resume offer can
 * take the exact-resume path.
 */
export function offeredSessionRef(payload: AcceptedOfferPayload): string | undefined {
  return payload.session.mode === 'resume' ? payload.session.sessionRef : undefined;
}

/** An Agent offer without `homeAccess` is a writer. */
export function offeredHomeAccess(payload: AcceptedOfferPayload): AgentHomeAccessMode {
  return payload.homeAccess === 'memory-reader' ? 'memory-reader' : 'memory-writer';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An absolute path in quotes, as Node filesystem errors name it
 * (`open '/path'`). The matching quote ends it, so every segment may hold
 * spaces, the last one too.
 */
const QUOTED_LOCAL_PATH = /(['"`])(?:\/|[A-Za-z]:[\\/]|\\\\)(?:(?!\1)[^\r\n])*\1/g;

/**
 * The absolute command of a Node spawn error (`spawn /path ENOENT`). Node
 * does not quote it, so the error code after it ends it, and every segment
 * may hold spaces, the last one too.
 */
const SPAWN_LOCAL_PATH = /(?<=(?:^|\s)spawn(?:Sync)? )(?:\/|[A-Za-z]:[\\/]|\\\\)[^\r\n]*?(?= (?:E[A-Z0-9]+|UNKNOWN)(?!\w))/g;

/**
 * An absolute POSIX, drive-letter or UNC path that starts a token. Inner
 * segments may hold spaces (`Application Support/`); the last segment ends at
 * the first space, so the words after the path stay.
 */
const ABSOLUTE_LOCAL_PATH = /(?<=^|[\s'"`(=])(?:\/|[A-Za-z]:[\\/]|\\\\)(?:[^\s'"`,;)\\/]+(?: +[^\s'"`,;)\\/]+)*[\\/])*[^\s'"`,;)\\/]*/g;

/**
 * Agent-home and session-handoff errors, and the filesystem errors under
 * them, name local paths: the canonical home, lease markers, run directories.
 * So do the filesystem errors of the preparation store, the Agent message
 * outbox, the artifact open and a runtime adapter's detect/prepare, and an
 * MCP server probe's spawn error and quoted stderr.
 * `task.decline`, `task.fail` and `task.progress` leave this device, so a
 * reason that forwards one keeps the error's wording and drops each absolute
 * path.
 */
export function outboundErrorMessage(err: unknown): string {
  return errorMessage(err)
    .replace(QUOTED_LOCAL_PATH, '$1<local path>$1')
    .replace(SPAWN_LOCAL_PATH, '<local path>')
    .replace(ABSOLUTE_LOCAL_PATH, '<local path>');
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
export function raceSettleFirst(fn: () => Promise<void>, timeoutMs: number): Promise<boolean> {
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
export function estimateEventBytes(event: AgentEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
  } catch {
    return 0;
  }
}

export type OpenArtifactResult = { ok: true; handle: FileHandle } | { ok: false; reason: string };

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
export async function openArtifact(workspaceDir: string, name: string): Promise<OpenArtifactResult> {
  // The workspace is the SDK-owned Agent home cwd and
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
    return { ok: false, reason: `artifact "${name}" could not be opened: ${outboundErrorMessage(err)}` };
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

/** 32 bytes of CSPRNG, base64url unpadded — one per `(task, server)`, never reused, never derived. */
export function freshHostToolsetContextToken(): string {
  return randomBytes(32).toString('base64url');
}

/** One `(task, host toolset server)` nonce and everything the task signer may claim about it. */
export interface HostToolsetContextEntry {
  readonly taskId: string;
  /** The FROZEN offer's Agent identity (§8.1) — captured at injection, never re-read from a profile later. */
  readonly agentRef: AgentRef;
  /** The logical toolset id from the frozen offer's `requiredToolsets` — the wire's `toolset` field (§8.2 AR-2). */
  readonly toolsetId: string;
  /** The MCP server the nonce was injected into; the `(task, server)` half of the binding §8.1 requires. */
  readonly serverName: string;
  state: 'active' | 'revoked';
}

export const NO_SEALED_SPILL: Pick<BlobResolver, 'uploadArtifact'> = {
  uploadArtifact: async () => { throw new Error('a sealed task stores no plaintext spill blob'); },
};

// Keep internal lifecycle bookkeeping out of the exported class declaration.
export const offerSettlements = new WeakMap<TaskRunner, Set<Promise<void>>>();

export async function trackOffer(runner: TaskRunner, operation: Promise<void>): Promise<void> {
  let offers = offerSettlements.get(runner);
  if (!offers) { offers = new Set(); offerSettlements.set(runner, offers); }
  offers.add(operation);
  try { await operation; }
  finally { offers.delete(operation); }
}

export function observeTerminalUsage(active: ActiveTask, event: Extract<AgentEvent, { type: 'usage' }>): void {
  if (event.contextSource === undefined || event.inputTokens !== undefined ||
      event.cachedInputTokens !== undefined || event.outputTokens !== undefined ||
      event.reasoningTokens !== undefined || event.totalTokens !== undefined || event.model !== undefined) {
    active.lastUsage = event;
  }
}
