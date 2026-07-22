import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  createEnvelope,
  type BlobRef,
  type Envelope,
  type PermissionPolicy,
  type TaskOfferPayload,
} from '@byok/protocol';
import { PolicyUnsupportedError, type RuntimeAdapter, type Session, type TaskContext } from '../types';
import type { ApprovalDecision, ApprovalOrigin, ApprovalRegistry } from './approvals';
import type { BlobResolver } from './blob-client';
import type { TaskQueueWatermark } from './control-protocol';
import { buildRuntimeEnv } from './environment';
import { computeEffectivePolicy } from './policy';
import { ProgressBatcher, type ProgressBatcherOptions } from './progress-batcher';
import type { SessionWorkspaceStore } from './session-workspace-store';

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

export interface TaskRunnerDeps {
  adapters: RuntimeAdapter[];
  runtimeAllowlist?: string[];
  /** M5: see `DaemonConfig.runtimeEnvironment`'s own doc comment (`create-daemon.ts`) — the per-device, per-runtime env-allowlist override `handleOffer` merges into `buildRuntimeEnv`'s `locallyAllowedNames`. */
  runtimeEnvironment?: Record<string, { allow?: string[] }>;
  permissionDefaults?: PermissionPolicy;
  workspaceRoot: string;
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
  /**
   * M4 Phase 3: this daemon's control-socket identity + the shared registry
   * backing the control socket's own `approvals.list`/`approvals.resolve`
   * methods (`create-daemon.ts` constructs ONE `ApprovalRegistry` and passes
   * the SAME instance here) — see `requestApproval`'s own doc comment for
   * why `TaskRunner` needs a handle on all three. `storeDir`/`productId` are
   * copied verbatim into every task's `TaskContext.approvalChannel`.
   */
  approvalRegistry: ApprovalRegistry;
  storeDir: string;
  productId: string;
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
  /** Finding F5(a): overrides {@link DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS} — see `shutdownTask`'s own doc comment. */
  shutdownInterruptTimeoutMs?: number;
  /**
   * M4 (additive-minor, `task.approval_resolved`): the negotiated
   * `conn.ack.capabilities` of the CURRENTLY (or most recently) connected
   * server — read fresh at call time (mirrors `getCursor`/`getToken`'s own
   * "read fresh, not captured once" convention elsewhere in this codebase),
   * since the capability is learned asynchronously, after this `TaskRunner`
   * is already constructed (`create-daemon.ts`'s `start()` builds `deps`
   * before `connection` exists). `create-daemon.ts` wires this to
   * `ConnectionManager.getServerCapabilities`. Optional, and treated as "no
   * capabilities" when absent, so a minimal test harness that doesn't care
   * about this gate isn't forced to supply one — see `sendApprovalResolved`.
   */
  getServerCapabilities?: () => readonly string[];
}

interface ActiveTask {
  taskId: string;
  adapter: RuntimeAdapter;
  session: Session;
  workspaceDir: string;
  batcher: ProgressBatcher;
  summaryParts: string[];
  /**
   * M4 Phase 3: the `ApprovalRegistry` id of the single out-of-band approval
   * currently DISPATCHED (registered + `task.await_approval` sent) for this
   * task, if any — set by `requestApproval`/`dispatchApproval`, cleared once
   * resolved (by a real decision or by the timeout). `undefined` whenever
   * nothing is dispatched right now — including while `approvalQueue` below
   * is non-empty but hasn't been dispatched yet. See `requestApproval` and
   * `TaskContext.approvalChannel.resolve`'s doc comments.
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
}

/** One not-yet-dispatched `requestApproval` call waiting its turn — see `ActiveTask.approvalQueue`. */
interface QueuedApprovalRequest {
  summary: string;
  resolve: (result: { approved: boolean; reason?: string }) => void;
}

type PickResult =
  | { ok: true; adapter: RuntimeAdapter }
  | { ok: false; reason: string; retryable: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * M3 TODO (Windows): `fs.constants.O_NOFOLLOW` is `undefined` on Windows,
 * so the `?? 0` below no-ops the flag there (reparse-point/symlink handling
 * for that platform isn't implemented yet) — the realpath+prefix
 * containment checks remain the floor of protection on Windows until it
 * is.
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
 * Per-connection task orchestration: offer -> (decline | claim -> adapter
 * session -> started) -> seq-ordered progress batches -> complete/fail/
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
   * `adapter.start()`) has no `this.tasks` entry to land on — it used to be
   * silently dropped, and the runtime session `handleOffer` was about to
   * register would then run an unsupervised ("zombie") turn nobody asked
   * for anymore. Recording the taskId here lets `handleOffer` consult it at
   * the two points where it can still safely react (see its body): before
   * claiming at all (decline instead of ever starting a session), and right
   * after `adapter.start()` resolves but before this task is registered as
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
   * block task A in `adapter.start()`, deliver A's own `task.cancel` (so
   * `pendingCancelled` gets an entry for A while A is still in-flight),
   * then deliver `MAX_TRACKED_TASK_IDS` more cancels for unrelated taskIds
   * nobody ever offered — under naive oldest-wins eviction, A's entry (the
   * single oldest) gets evicted purely because of unrelated churn, so when
   * `adapter.start()` finally resolves, checkpoint 2 finds no cancel marker
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
   * a no-op — never a second `adapter.start()` call, which would orphan the
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
   * M4 Phase 2: best-effort shutdown of every currently ACTIVE task, for the
   * control socket's `shutdown` RPC. Mirrors `handleCancel`'s best-effort
   * `session.interrupt()` style (an interrupt failure is swallowed; the
   * terminal message is sent either way) but reports `task.fail` rather than
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
   * Finding F5(a): `session.interrupt()` is now raced against its own
   * bounded deadline ({@link DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS}) rather
   * than awaited unconditionally — see that constant's own doc comment for
   * why an unbounded `await` here meant `task.fail` was silently never
   * sent at all for a task whose adapter's `interrupt()` hangs. The
   * interrupt attempt itself is wrapped so it can never reject/throw past
   * the race (synchronously OR via a rejected promise) — only ever
   * best-effort, exactly as before; `task.fail` is now sent and `finish()`
   * called UNCONDITIONALLY once EITHER settles, not only on the (hopefully
   * common) path where interrupt itself resolved first.
   */
  private async shutdownTask(active: ActiveTask, reason: string): Promise<void> {
    const timeoutMs = this.deps.shutdownInterruptTimeoutMs ?? DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS;
    const interruptSettled = (async (): Promise<void> => {
      try {
        await active.session.interrupt();
      } catch {
        // best-effort — still report the failure below regardless
      }
    })();
    await Promise.race([
      interruptSettled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    this.deps.send(
      createEnvelope('task.fail', { reason: `daemon shutting down: ${reason}`, retryable: true }, { taskId: active.taskId }),
    );
    await this.finish(active.taskId);
  }

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'task.offer':
        await this.handleOffer(envelope.task_id, envelope.payload);
        return;
      case 'task.cancel':
        await this.handleCancel(envelope.task_id, envelope.payload.reason);
        return;
      case 'task.steer':
        await this.handleSteer(envelope.task_id, envelope.payload.text);
        return;
      case 'task.approve':
        await this.handleApprove(envelope.task_id);
        return;
      case 'task.reject':
        await this.handleReject(envelope.task_id, envelope.payload.reason);
        return;
      default:
        return; // conn.* and daemon->server-only types are handled elsewhere / not applicable
    }
  }

  private async handleOffer(taskId: string, payload: TaskOfferPayload): Promise<void> {
    // Finding P2, Fix 2c (redelivered offer for an already-active/finished
    // task): checked first, ahead of everything below — a redelivered
    // `task.offer` for a taskId this device already claimed/started, or
    // already finished, can never be "the first time" for it, so there is
    // nothing left to decide. Without this, the stalled-cursor long-poll
    // re-pull (see `ConnectionManager.dedupWatermark`) redelivering this
    // same offer while its first `adapter.start()` is still in flight (or
    // well after it already succeeded) would start a SECOND adapter session
    // for the same task, orphaning the first.
    if (this.tasks.has(taskId) || this.finishedTaskIds.has(taskId)) {
      return;
    }

    // M4 Phase 2: the control socket's `shutdown` RPC flips this before
    // tearing down active tasks (see `stopAcceptingOffers`'s own doc
    // comment) — any offer arriving after that point is declined outright,
    // never claimed.
    if (this.stoppingOffers) {
      this.decline(taskId, 'daemon is shutting down', true);
      return;
    }

    // Finding #5: mark this taskId as "in-flight" for the entire remainder
    // of this call — `evictPendingCancelled` must never remove a
    // `pendingCancelled` entry for a taskId in this set (see its own doc
    // comment and `inFlightOffers`'s class-level doc comment for the exact
    // counterexample this closes). The `finally` below clears it on every
    // exit path (decline, fail, the checkpoint-2 cancel-teardown, or
    // successful registration) — never leaked past this one call.
    this.inFlightOffers.add(taskId);
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
        this.decline(taskId, reason ? `cancelled before claim: ${reason}` : 'cancelled before claim', false);
        return;
      }

      const pick = await this.pickAdapter(payload.runtime);
      if (!pick.ok) {
        this.decline(taskId, pick.reason, pick.retryable);
        return;
      }

      const decision = computeEffectivePolicy(payload.policy, this.deps.permissionDefaults);
      if (!decision.ok) {
        this.decline(taskId, decision.reason ?? 'policy rejected', false);
        return;
      }

      // Every check above is local/config-driven (an adapter's `detect()` is
      // the only I/O, and it costs nothing to have run before committing) and
      // needed no commitment from this device. Only now do we actually take
      // the task — `task.decline` above is the alternative path for anything
      // that got this far without claiming.
      this.deps.send(createEnvelope('task.claim', { deviceId: this.deps.deviceId }, { taskId }));

      let resolvedInstruction: string;
      try {
        resolvedInstruction = await this.resolveInstruction(payload.instruction);
      } catch (err) {
        await this.fail(taskId, `failed to resolve instruction blob: ${errorMessage(err)}`, true);
        return;
      }

      // Finding #3 (session/workspace continuity): an offer naming a
      // sessionRef this device has previously recorded (via a prior task's
      // `task.complete.sessionRef`) reuses that exact workspace directory —
      // this is what lets a runtime adapter's own resume mechanism (e.g. pi's
      // `--session <id>`, scoped to the cwd/project a session was created
      // under — see pi-adapter.ts) actually find the session again. An
      // unknown or absent sessionRef is always treated as "start fresh",
      // exactly as before this feature existed.
      const known = payload.sessionRef ? await this.deps.sessionWorkspaces.get(payload.sessionRef) : undefined;

      let workspaceDir: string;
      try {
        workspaceDir = await this.resolveWorkspaceDir(taskId, known?.workspaceDir);
      } catch (err) {
        await this.fail(taskId, `failed to create task workspace: ${errorMessage(err)}`, true);
        return;
      }

      const ctx: TaskContext = {
        workspaceDir,
        policy: decision.policy,
        // M5: no longer `process.env` verbatim (see `environment.ts`'s own
        // module doc comment for the credential-leak gap that closed) —
        // built fresh per task from the SPECIFIC adapter `pickAdapter`
        // above already selected, so this always runs after adapter
        // selection: `pick.adapter.environmentRequirements?.()` (undefined
        // ⇒ platform baseline only, fail-closed) plus this device's own
        // `runtimeEnvironment` override, keyed by that same adapter's `id`.
        env: buildRuntimeEnv({
          ambient: process.env,
          requirements: pick.adapter.environmentRequirements?.(),
          locallyAllowedNames: this.deps.runtimeEnvironment?.[pick.adapter.id]?.allow,
        }),
        // M4 Phase 3: adapter-agnostic and cheap to always populate — only an
        // adapter whose runtime genuinely supports an out-of-band approval
        // pause (claude, today) ever reads this. `resolve` is a closure over
        // `taskId` (not a pre-bound approvalId): it looks up whichever
        // approval is CURRENTLY pending for this task at call time, since one
        // task/session can face several approval requests, one at a time,
        // over its life. See `types.ts`'s `ApprovalChannel` doc comment.
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
      const effectiveOffer: TaskOfferPayload = {
        ...payload,
        instruction: resolvedInstruction,
        // Never forward a sessionRef this device has no recorded workspace
        // for (stale, from another device, or simply made up) — an adapter
        // that tries to resume an id it never minted fails outright (pi:
        // "No session found matching '<id>'", exit 1, empirically confirmed)
        // instead of silently starting fresh, so an unresolvable sessionRef
        // must look identical to "none supplied" by the time it reaches the
        // adapter, not get forwarded as a resume attempt doomed to fail.
        sessionRef: known ? payload.sessionRef : undefined,
      };

      let session: Session;
      try {
        session = await pick.adapter.start(effectiveOffer, ctx);
      } catch (err) {
        // A PolicyUnsupportedError means this exact task can never succeed on
        // this adapter (fail-closed policy/instruction mismatch) — not
        // retryable. Anything else (spawn failure, missing credentials, etc)
        // is treated as environmental and possibly transient.
        const retryable = !(err instanceof PolicyUnsupportedError);
        await this.fail(taskId, `adapter failed to start: ${errorMessage(err)}`, retryable);
        return;
      }

      // Finding F4, checkpoint 2 ("consulted when start() resolves"): a
      // task.cancel arrived while adapter.start() was in flight — i.e. AFTER
      // task.claim already went out above, so declining is no longer an
      // option. Tear the just-started session down before it's ever
      // registered as active (this.tasks.set below) or reported task.started,
      // so pump() never begins and no zombie turn runs — then report the
      // outcome exactly like a post-registration cancel would (M1 gap #6:
      // task.cancelled, not task.fail).
      if (this.pendingCancelled.has(taskId)) {
        const reason = this.pendingCancelled.get(taskId);
        this.pendingCancelled.delete(taskId);
        try {
          await session.interrupt();
        } catch {
          // best-effort — still report cancellation below
        }
        try {
          await session.close();
        } catch {
          // best-effort teardown
        }
        this.deps.send(createEnvelope('task.cancelled', { reason }, { taskId }));
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
      const active: ActiveTask = {
        taskId,
        adapter: pick.adapter,
        session,
        workspaceDir,
        summaryParts: [],
        batcher: new ProgressBatcher(
          (seq, events) => this.deps.send(createEnvelope('task.progress', { seq, events }, { taskId, seq })),
          this.deps.batcherOptions,
        ),
        approvalQueue: [],
      };
      this.tasks.set(taskId, active);
      void this.pump(active);

      // Record (or refresh) this session's resumable workspace for any future
      // task.offer that carries the same sessionRef, fire-and-forget:
      // `session.sessionRef` is always the adapter's real, resumable
      // identifier (see PiSession / resolveFreshSessionId) whether or not
      // *this* dispatch was itself a resume. Deliberately not awaited — see
      // the comment above; losing this mapping only costs a future resume
      // opportunity, never the correctness of the task in progress.
      void this.deps.sessionWorkspaces
        .record(session.sessionRef, { workspaceDir, runtimeSessionId: session.sessionRef })
        .catch(() => {});
    } finally {
      this.inFlightOffers.delete(taskId);
    }
  }

  /** Protocol §7: an instruction too large to inline arrives as a `blobRef` — resolve it via the blob client rather than failing closed. */
  private async resolveInstruction(instruction: TaskOfferPayload['instruction']): Promise<string> {
    if (typeof instruction === 'string') return instruction;
    return this.deps.blobClient.resolveInstruction(instruction.blobRef);
  }

  private async pump(active: ActiveTask): Promise<void> {
    try {
      for await (const event of active.session.events) {
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

        if (event.type === 'needs_approval') {
          active.batcher.flush();
          this.deps.send(
            createEnvelope('task.await_approval', { summary: event.summary }, { taskId: active.taskId }),
          );
          continue;
        }
        if (event.type === 'turn_end') {
          active.batcher.push(event);
          active.batcher.flush();
          this.deps.send(
            createEnvelope(
              'task.complete',
              { summary: active.summaryParts.join(''), sessionRef: active.session.sessionRef },
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
          await this.sendArtifact(active, event.name, event.contentType);
        }
        active.batcher.push(event);
      }
      // The events iterable ended without an explicit turn_end. This is
      // usually the underlying runtime process exiting unexpectedly — but
      // it's also exactly what happens when `handleCancel`/`handleReject`
      // concurrently call `session.close()` while this loop is still
      // awaiting the same iterable (ending it is how those paths stop the
      // session). Check identity against the tasks map — if something else
      // already finished this exact active task, its own message
      // (task.cancelled / task.fail) already reported the outcome; this is
      // not a second failure.
      if (this.tasks.get(active.taskId) !== active) return;
      await this.fail(active.taskId, 'runtime session ended without completing the task', true);
    } catch (err) {
      if (this.tasks.get(active.taskId) !== active) return;
      active.batcher.flush();
      await this.fail(active.taskId, `runtime error: ${errorMessage(err)}`, true);
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
    try {
      await active.session.interrupt();
    } catch {
      // best-effort — still report cancellation below
    }
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
    this.deps.send(createEnvelope('task.cancelled', { reason }, { taskId }));
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
   * how many `task.offer`s are simultaneously mid-`adapter.start()` — nowhere
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

  private async handleSteer(taskId: string, text: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    await active.session.steer(text);
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
   */
  async requestApproval(taskId: string, summary: string): Promise<{ approved: boolean; reason?: string }> {
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
        active.approvalQueue.push({ summary, resolve });
      });
    }

    return this.dispatchApproval(active, summary);
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
  private dispatchApproval(active: ActiveTask, summary: string): Promise<{ approved: boolean; reason?: string }> {
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
    this.deps.send(createEnvelope('task.await_approval', { summary }, { taskId }));

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
    void this.dispatchApproval(active, next.summary).then(next.resolve);
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
  private async handleApprove(taskId: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    try {
      await active.session.resolveApproval(true);
    } catch (err) {
      if (err instanceof NoPendingApprovalError) {
        this.deps.onStaleApprovalDecision?.(taskId, 'approve');
        return;
      }
      await this.fail(taskId, `failed to resume session after approval: ${errorMessage(err)}`, false);
    }
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
  private async handleReject(taskId: string, reason: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    try {
      await active.session.resolveApproval(false, reason);
    } catch (err) {
      if (err instanceof NoPendingApprovalError) {
        this.deps.onStaleApprovalDecision?.(taskId, 'reject', reason);
        return;
      }
      // best-effort — still report the rejection outcome below
    }
    try {
      await active.session.interrupt();
    } catch {
      // best-effort
    }
    // Same reasoning as handleCancel() above: the server already moved this
    // task to `Failed` and closed its event queue before this notification
    // arrived, so flushing buffered progress here would be unobservable and
    // only trigger a spurious server-side warning.
    this.deps.send(createEnvelope('task.fail', { reason: reason ?? 'rejected', retryable: false }, { taskId }));
    await this.finish(taskId);
  }

  /** Pre-claim, fail-closed rejection (protocol §3.2) — never claims first. */
  private decline(taskId: string, reason: string, retryable: boolean): void {
    this.deps.send(createEnvelope('task.decline', { reason, retryable }, { taskId }));
  }

  private async fail(taskId: string, reason: string, retryable: boolean): Promise<void> {
    this.deps.send(createEnvelope('task.fail', { reason, retryable }, { taskId }));
    await this.finish(taskId);
  }

  private async finish(taskId: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    active.batcher.stop();
    this.tasks.delete(taskId);
    this.addFinishedTaskId(taskId); // finding P2 (Fix 2c) — see its own doc comment

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
        // Already resolved by a real decision/timeout that raced this —
        // benign, same "first resolution wins" guarantee ApprovalRegistry
        // already documents; nothing left to do.
      }
    }

    try {
      await active.session.close();
    } catch {
      // best-effort teardown
    }
  }

  /** M3-B: bounded insert for `finishedTaskIds` — see its class-level doc comment and `MAX_TRACKED_TASK_IDS`. Evicts the oldest (first-inserted) entry once over cap, same idiom as `ConnectionHub.checkAndRecordDuplicate` (packages/server/src/hub.ts). */
  private addFinishedTaskId(taskId: string): void {
    this.finishedTaskIds.add(taskId);
    if (this.finishedTaskIds.size > MAX_TRACKED_TASK_IDS) {
      const oldest = this.finishedTaskIds.values().next().value;
      if (oldest !== undefined) this.finishedTaskIds.delete(oldest);
    }
  }

  /** `reuseDir`, when set (a known sessionRef's recorded workspace), is used verbatim instead of a fresh `workspaceRoot/<taskId>` directory — `mkdir recursive` is idempotent either way, so ensuring-exists is safe to do unconditionally. */
  private async resolveWorkspaceDir(taskId: string, reuseDir: string | undefined): Promise<string> {
    const dir = reuseDir ?? path.join(this.deps.workspaceRoot, taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async pickAdapter(requestedRuntime: string | undefined): Promise<PickResult> {
    const allowlist = this.deps.runtimeAllowlist;

    if (requestedRuntime) {
      if (allowlist && !allowlist.includes(requestedRuntime)) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" is not in this device's runtime allowlist`,
          retryable: false,
        };
      }
      const adapter = this.deps.adapters.find((a) => a.id === requestedRuntime);
      if (!adapter) {
        return { ok: false, reason: `unknown runtime "${requestedRuntime}"`, retryable: false };
      }
      const detected = await adapter.detect();
      if (!detected.present) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" is not installed/available on this device`,
          retryable: true,
        };
      }
      return { ok: true, adapter };
    }

    const candidates = allowlist
      ? this.deps.adapters.filter((a) => allowlist.includes(a.id))
      : this.deps.adapters;
    for (const adapter of candidates) {
      const detected = await adapter.detect();
      if (detected.present) return { ok: true, adapter };
    }
    return { ok: false, reason: 'no available runtime found on this device', retryable: true };
  }
}
