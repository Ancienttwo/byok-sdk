import type { AgentEvent, PermissionPolicy, TaskOfferPayload } from '@byok/protocol';
import type { RuntimeEnvironmentRequirements } from './daemon/environment';

export type { RuntimeEnvironmentRequirements } from './daemon/environment';

export interface GitWorkspaceConfig {
  mode: 'local-checkpoints';
}

/**
 * Result of probing whether a runtime is usable on this machine. `authPresent`
 * is computed without ever reading the runtime's own credential storage (see
 * the credential-isolation rule on {@link RuntimeAdapter}) — it only reflects
 * whether a recognized environment variable name is set.
 */
export interface RuntimeDetectResult {
  present: boolean;
  version?: string;
  authPresent?: boolean;
}

/** What a runtime adapter can do, advertised so the daemon can pick/validate adapters. */
export interface RuntimeCapabilities {
  steer: boolean;
  resume: boolean;
  /** Subset of {@link PermissionPolicy}'s `mode` values this adapter can express without widening. */
  permissionModes: string[];
}

/**
 * M4 Phase 3: the out-of-band approval channel `TaskRunner` (`daemon/
 * task-runner.ts`) hands to an adapter's `start()` via `TaskContext
 * .approvalChannel`, for a runtime whose approval mechanism genuinely needs
 * to reach back into the daemon from OUTSIDE the adapter's own process — the
 * claude adapter's concrete case: `claude`'s `--permission-prompt-tool`
 * resolves a pending permission entirely inside a SEPARATE MCP-server child
 * process claude itself spawns (see `bin/byok-approval-mcp.ts`), which has
 * no in-process handle to this task's `Session` at all and must instead call
 * back into the SAME daemon over its control socket. `storeDir`/`productId`
 * are exactly what that out-of-process helper needs to find and authenticate
 * against this daemon's control socket (`daemon/control-protocol.ts`
 * `controlEndpointPath`/`controlTokenPath`); `taskId` is how its request gets
 * correlated back to THIS task once it arrives. `resolve()` is the
 * daemon-side counterpart: it resolves the single most-recently-registered
 * pending approval for this task (via `TaskRunner.requestApproval`'s own
 * `ApprovalRegistry` entry — see `daemon/approvals.ts`), and rejects if none
 * is currently pending, mirroring `Session.resolveApproval`'s own
 * no-notion-of-approval-pending fail-closed contract one level up.
 *
 * Optional and adapter-agnostic on purpose: only an adapter whose runtime
 * genuinely supports an out-of-band pause (claude, today) ever reads this;
 * every other adapter (pi, codex) ignores it exactly as before this field
 * existed.
 */
export interface ApprovalChannel {
  taskId: string;
  storeDir: string;
  productId: string;
  /** Default wait (ms) before the daemon force-resolves an unanswered approval request as a fail-closed rejection — see `TaskRunner.requestApproval`. */
  timeoutMs: number;
  /** Resolve the single currently-pending out-of-band approval for this task. Rejects if none is pending right now. */
  resolve(approved: boolean, reason?: string): Promise<void>;
}

/**
 * Per-task execution context handed to {@link RuntimeAdapter.start}. `policy`
 * is the already fail-closed-checked *effective* policy (offer policy merged
 * against the daemon's configured ceiling) — the adapter must obey this, not
 * whatever the raw task offer's own `policy` field said.
 */
export interface TaskContext {
  workspaceDir: string;
  policy: PermissionPolicy;
  env: NodeJS.ProcessEnv;
  /** Prepared local checkpoint repository metadata; absent for legacy plain workspaces. */
  gitWorkspace?: {
    workspaceId: string;
    baseline?: string;
  };
  /** M4 Phase 3 — see {@link ApprovalChannel}. Optional/adapter-agnostic: unset for every adapter that never requests an out-of-band approval. */
  approvalChannel?: ApprovalChannel;
}

/**
 * A running (or resumable) unit of work on a runtime. One `Session` maps to
 * one underlying runtime process/session for the lifetime of a task.
 */
export interface Session {
  /** Opaque runtime session id, reported back to the server via `task.complete.sessionRef`. */
  sessionRef: string;
  /** Normalized events for this session; the daemon batches these into `task.progress`. */
  events: AsyncIterable<AgentEvent>;
  /** Inject steering text into a running turn (mid-stream). */
  steer(text: string): Promise<void>;
  /** Send a new instruction on the same session after it has gone idle. */
  followUp(task: TaskOfferPayload): Promise<void>;
  /** Best-effort abort of the current turn (used for `task.cancel`). */
  interrupt(): Promise<void>;
  /** Tear down the underlying runtime process/session. Idempotent. */
  close(): Promise<void>;
  /**
   * Resolve a session paused on `needs_approval` (protocol §5). The
   * server's own state has already moved by the time this is called (§4 —
   * `task.approve`/`task.reject` are best-effort notifications, not
   * requests awaiting a reply): `approved: true` must make the session
   * resume producing events (`task.progress` continuing is the proof);
   * `approved: false` means the caller will immediately follow up with
   * `interrupt()` + `close()` and report `task.fail` — an adapter that has
   * no notion of `needs_approval` at all (i.e. never emits one) should
   * throw a descriptive error here rather than silently no-op, since a
   * caller receiving `task.approve`/`task.reject` for one of its tasks
   * implies something upstream expected approval support that isn't there.
   */
  resolveApproval(approved: boolean, reason?: string): Promise<void>;
}

/**
 * Uniform seam every concrete runtime (pi now; claude/codex in M2) implements.
 *
 * Credential-isolation rule: an adapter spawns only the runtime's official
 * binary. It never reads, proxies, or forwards that runtime's own credential
 * storage (OAuth tokens, API keys on disk, `~/.claude`, `~/.codex`, `~/.pi`
 * auth state, etc). Presence checks are limited to environment variable
 * *names* (see {@link RuntimeDetectResult.authPresent}).
 *
 * M5: separately, {@link RuntimeAdapter.environmentRequirements} below
 * declares which environment variable NAMES (never values inspected here
 * either) this adapter's runtime needs forwarded into its own spawned
 * process — see that method's own doc comment and `daemon/environment.ts`.
 */
export interface RuntimeAdapter {
  id: string;
  detect(): Promise<RuntimeDetectResult>;
  capabilities(): RuntimeCapabilities;
  start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session>;
  /**
   * M5: declares which environment variable names (exact, or `*`-suffixed
   * prefix) this runtime's own CLI needs beyond the always-included
   * platform baseline (`daemon/environment.ts`'s `buildRuntimeEnv`) —
   * `task-runner.ts` builds each task's `TaskContext.env` from this instead
   * of ever handing a spawned agent the daemon's raw `process.env` again.
   * Optional and fail-closed by omission: an adapter that doesn't implement
   * this gets the platform baseline ONLY, never an implicit "everything."
   */
  environmentRequirements?(): RuntimeEnvironmentRequirements;
}

/**
 * Thrown by `RuntimeAdapter.start` when the task can never succeed on this
 * adapter as offered — an unsupported `PermissionPolicy` (fail-closed) or an
 * instruction shape the adapter can't handle (e.g. a blob-ref in M0) — as
 * opposed to a transient/environmental failure (spawn error, missing
 * credentials) that might succeed on a later retry. The daemon uses this
 * distinction to set `task.fail`'s `retryable` flag correctly instead of
 * treating every `start()` failure the same way.
 */
export class PolicyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyUnsupportedError';
  }
}
