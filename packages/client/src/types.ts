import type { AgentEvent, PermissionPolicy, TaskOfferPayload } from '@byok/protocol';

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
 * Per-task execution context handed to {@link RuntimeAdapter.start}. `policy`
 * is the already fail-closed-checked *effective* policy (offer policy merged
 * against the daemon's configured ceiling) — the adapter must obey this, not
 * whatever the raw task offer's own `policy` field said.
 */
export interface TaskContext {
  workspaceDir: string;
  policy: PermissionPolicy;
  env: NodeJS.ProcessEnv;
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
}

/**
 * Uniform seam every concrete runtime (pi now; claude/codex in M2) implements.
 *
 * Credential-isolation rule: an adapter spawns only the runtime's official
 * binary. It never reads, proxies, or forwards that runtime's own credential
 * storage (OAuth tokens, API keys on disk, `~/.claude`, `~/.codex`, `~/.pi`
 * auth state, etc). Presence checks are limited to environment variable
 * *names* (see {@link RuntimeDetectResult.authPresent}).
 */
export interface RuntimeAdapter {
  id: string;
  detect(): Promise<RuntimeDetectResult>;
  capabilities(): RuntimeCapabilities;
  start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session>;
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
