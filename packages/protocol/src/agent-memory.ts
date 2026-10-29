/**
 * `@byok-sdk/protocol/agent-memory` — the Host-side Agent memory contract that both
 * `@byok-sdk/client` (the device) and `@byok-sdk/server/execution-core` (the Host)
 * use: the file and export shapes, the model path policy, the Host transport and
 * projection ports, and the memory error bases. It is zod-free so the embedded
 * `@byok-sdk/client/agent-memory` entry stays schema-free, and it is its own entry
 * so the error classes have one runtime definition.
 */
import type { AgentMemoryIntentCompletion, AgentMemoryIntentReservation } from './agent-memory-intent';
import type { AgentMemoryProjectionMutation } from './agent-memory-projection';
import type { AgentRef } from './messages';

export class AgentMemoryError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentMemoryError'; }
}
/**
 * Deterministic refusal: the same input against the same home state fails the
 * same way on every retry (an invalid path, a forbidden delete, an oversized or
 * non-UTF-8 file, a non-regular leaf, a platform without a secure backend).
 */
export class AgentMemoryValidationError extends AgentMemoryError {
  constructor(message: string) { super(message); this.name = 'AgentMemoryValidationError'; }
}

export interface AgentMemoryFile { readonly path: string; readonly revision: string; readonly byteCount: number; readonly content: string; }
export interface AgentMemorySnapshot { readonly files: readonly AgentMemoryFile[]; readonly totalBytes: number; }

/** Raw local-only Host result. Never send this through the redacted projection port. */
export interface AgentMemoryExport extends AgentMemorySnapshot {
  /** Validated Host request, not proof of a globally current profile revision. */
  readonly requestedAgentRef: AgentRef;
  /** Present only when the home has a durable applied profile projection. */
  readonly appliedProfileRevision?: string;
  /** sha256 of UTF-8 JSON ["byok-agent-memory-export.v1", [[path, revision, byteCount], ...]]. */
  readonly snapshotDigest: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// Windows maps a device name, with or without an extension, and a name that
// ends in a dot to another name. Every platform refuses them.
const WINDOWS_ALIAS = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)|\.$/iu;
const SECRET_LIKE = /(?:^|[-_.])(secret|token|credential|password|passwd|api[-_]?key|private[-_]?key|cookie)(?:$|[-_.])/iu;
function safeSegment(value: string): boolean { return SAFE_SEGMENT.test(value) && !WINDOWS_ALIAS.test(value); }

/** Model input can name one allowed file, never a root, directory, glob, or internal SDK state. */
export function validateAgentMemoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000\\]/u.test(value)) throw new AgentMemoryValidationError('memory path is invalid');
  if (value === 'MEMORY.md') return value;
  // POSIX absoluteness is exactly a leading '/'; backslashes were refused above.
  if (value.startsWith('/') || /[*?\[{]/u.test(value)) throw new AgentMemoryValidationError('memory path must name exactly one file');
  const parts = value.split('/');
  if (parts.length < 2 || parts[0] !== 'notes' || !value.endsWith('.md') || parts.some((part) => part === '' || part === '.' || part === '..' || part === '.byok' || !safeSegment(part) || SECRET_LIKE.test(part))) {
    throw new AgentMemoryValidationError('memory path must be MEMORY.md or notes/<safe-relative>.md');
  }
  return value;
}

/** Exactly what the daemon hands the Host transport for one fetch. */
export interface AgentMemoryIntentFetchInput {
  readonly intentId: string;
  readonly agentRef: AgentRef;
  /** `held`: a ledger slot is reserved; `none`: the Host must not release or change state. */
  readonly reservation: AgentMemoryIntentReservation;
}

/**
 * Host-injected transport for Host-approved Agent memory intents. The Host
 * authenticates the device on its own routes; the SDK never sees an assertion.
 *
 * - `fetch` resolves with the Host's fetch answer (release / withheld /
 *   terminal / deferred) for exactly this intent and reservation.
 * - `complete` delivers one terminal completion and resolves with the Host's
 *   DURABLE readback for it.
 *
 * Both answers are copied into inert plain data and strictly parsed. A throw
 * from either is a transport failure: the notice is not acknowledged and a
 * redelivery retries. Neither is ever called while the Agent home is leased.
 */
export interface AgentMemoryIntentTransport {
  fetch(request: AgentMemoryIntentFetchInput): Promise<unknown>;
  complete(completion: AgentMemoryIntentCompletion): Promise<unknown>;
}

/**
 * Optional bridge to a complete hosted client. It receives the canonical,
 * already-redacted protocol mutation only; the SDK intentionally owns no
 * consent, cloud transport, or raw-source upload fallback.
 */
export interface AgentMemoryProjectionPort {
  publish(input: Readonly<{ mutation: AgentMemoryProjectionMutation }>): Promise<{ readonly accepted: boolean }>;
}
