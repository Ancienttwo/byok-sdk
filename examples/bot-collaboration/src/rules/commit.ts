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
  /** A keyless command gets no record, so its id is not a dedup key. */
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
/** The command record of a keyed command. */
export interface RecordOptions {
  /** The fields that decide the command's effect. Only their hash is stored. */
  evidence: Json;
  /** The message of an identity conflict. */
  conflict: () => string;
}
export interface CommitOptions {
  /** The scope that this store owns. */
  scope: string;
  /**
   * Absent: the commit has no record and no replay. This is so for a keyless command, which applies at each call,
   * and for a callback that the caller already deduplicates durably, as K4 does for terminals and messages.
   */
  record?: RecordOptions;
}
export function revisionOf(state: CommitState): number { return state.revision ?? 0; }
/**
 * Replay first, then the revision check: a retry with its original expected revision gets its original result.
 * Every new commit adds 1 to the revision, also for a refused disposition. A commit without a record is always new.
 */
export function commit<C>(state: CommitState, request: CommitRequest<C>, options: CommitOptions,
  decide: (out: (intent: OutboxIntent) => void) => Disposition): CommitResult {
  if (request.scope !== options.scope) throw new CommitConflict('scope_mismatch', 'Commit scope mismatch');
  if (typeof request.commandId !== 'string' || !request.commandId) throw new Error('Invalid command id');
  const record = options.record, evidence = record && hash(canonical(record.evidence));
  const prior = evidence ? state.commands?.[request.commandId] : undefined;
  if (prior) {
    if (prior.evidence !== evidence) throw new CommitConflict('identity_conflict', record!.conflict());
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
  if (evidence) (state.commands ??= {})[request.commandId] = { evidence, result: structuredClone(result) };
  return result;
}
