import { canonical, hash } from '@byok-sdk/example-host-execution-core';
import type { Json } from './turn';

/**
 * The collaboration commit contract (#739 D1). One commit takes a scope, a command id, an optional
 * expected revision and the command. It returns the new revision, the disposition and the outbox intents.
 *
 * The store runs `commit` in one transaction with the state change, the command record and the outbox
 * writes. A throw from `commit` or from `decide` must leave all three unchanged.
 */
export type Disposition = { outcome: 'accepted'; value?: Json } | { outcome: 'refused'; reasonCode: string; reason?: string };
/** A durable Host outbox row that the commit wrote: a K4 projection id or a channel delivery id. */
export interface OutboxIntent { kind: 'projection' | 'delivery'; id: string }
export interface CommitResult { revision: number; disposition: Disposition; outbox: OutboxIntent[] }
export interface CommitRequest<C> {
  /** An opaque key. In K8 it is the ledger tenant: one product account and workspace. */
  scope: string;
  commandId: string;
  /** Absent: decide on the head. Present and not the head: a `stale_revision` conflict. */
  expectedRevision?: number;
  command: C;
}
/** Dedup evidence. Retention must keep a record while a retry of its command can still arrive. */
export interface CommandRecord { evidence: string; result: CommitResult }
/** Both fields are optional: a state without them is at revision 0 and has no record. */
export interface CommitState { revision?: number; commands?: Record<string, CommandRecord> }
export type CommitConflictCode = 'scope_mismatch' | 'identity_conflict' | 'stale_revision';
export class CommitConflict extends Error {
  constructor(readonly code: CommitConflictCode, message: string) { super(message); this.name = 'CommitConflict'; }
}
export interface CommitOptions {
  /** The scope that this store owns. */
  scope: string;
  /** The fields that decide the command's effect. Only their hash is stored. */
  evidence: Json;
  /** False when the caller already deduplicates this command durably, as K4 does for terminals. */
  record: boolean;
  /** Which new records to keep. Absent: keep each one. A caller that deduplicates some dispositions itself keeps the rest. */
  keep?: (disposition: Disposition) => boolean;
  /** The message of an identity conflict. */
  conflict: () => string;
}
export function revisionOf(state: CommitState): number { return state.revision ?? 0; }
/**
 * Replay first, then the revision check: a retry with its original expected revision gets its original result.
 * Every new commit adds 1 to the revision, also for a refused disposition.
 */
export function commit<C>(state: CommitState, request: CommitRequest<C>, options: CommitOptions,
  decide: (out: (intent: OutboxIntent) => void) => Disposition): CommitResult {
  if (request.scope !== options.scope) throw new CommitConflict('scope_mismatch', 'Commit scope mismatch');
  if (typeof request.commandId !== 'string' || !request.commandId) throw new Error('Invalid command id');
  const evidence = hash(canonical(options.evidence));
  // Own properties only: a command id such as `constructor` or `__proto__` is a valid opaque id.
  const prior = options.record && state.commands && Object.hasOwn(state.commands, request.commandId) ? state.commands[request.commandId] : undefined;
  if (prior) {
    if (prior.evidence !== evidence) throw new CommitConflict('identity_conflict', options.conflict());
    return structuredClone(prior.result);
  }
  const head = revisionOf(state), expected = request.expectedRevision;
  if (expected !== undefined) {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Invalid expected revision');
    if (expected !== head) throw new CommitConflict('stale_revision', `Stale collaboration revision: expected ${expected}, head ${head}`);
  }
  const outbox: OutboxIntent[] = [];
  const disposition = decide(intent => { outbox.push(intent); });
  const result: CommitResult = { revision: head + 1, disposition, outbox };
  state.revision = result.revision;
  if (options.record && (options.keep?.(disposition) ?? true)) {
    Object.defineProperty(state.commands ??= {}, request.commandId,
      { value: { evidence, result: structuredClone(result) }, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
