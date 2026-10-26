import type { PoolClient } from 'pg';
import { CompactVetoError } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { compactVeto } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { storedKey } from './layout';
import { intentIdentity, retire, retiredIntents } from './retention';

export interface IntentCompactionInput {
  /** Explicit acknowledgement that the intent rows of these Turns may be removed for good. */
  acknowledgedTurnIds: readonly string[];
}
export interface IntentCompaction { compactedIntents: number; alreadyCompactedIntents: number }

/** The distinct, valid Turn ids of `input`; throws on a malformed input. */
export function acknowledgedTurnIds(input: IntentCompactionInput): string[] {
  if (!Array.isArray(input?.acknowledgedTurnIds)) throw new Error('Acknowledged Turn ids must be an array');
  const turnIds: string[] = [...new Set(input.acknowledgedTurnIds)];
  if (turnIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid acknowledged Turn id');
  return turnIds;
}

/**
 * Removes the settled intent rows of the acknowledged Turns, as K4 `compact` removes settled intents (#793 S8). The caller
 * holds the scope lock and passes the state of its transaction. Each removed row leaves a permanent intent tombstone in the
 * same transaction, so the Turn can never freeze again. A refusal or a throw writes nothing.
 *
 * Routine intents are refused: K4 compacts a routine intent with its occurrence, retiring the slot and giving the intent
 * tombstone the slot's expiry (`ledger.ts` compact), and H does not compact occurrences.
 */
export async function decideCompaction(client: PoolClient, scopeKey: string, state: CollaborationState,
  input: IntentCompactionInput): Promise<IntentCompaction> {
  const turnIds = acknowledgedTurnIds(input);
  const found = await client.query<{ key: string; source: string; conclusion: string | null }>(
    'SELECT key, source, conclusion FROM intent WHERE scope = $1 AND key = ANY($2::text[])', [scopeKey, turnIds.map(storedKey)]);
  const rows = new Map(found.rows.map(row => [row.key, row]));
  const present = turnIds.filter(id => rows.has(storedKey(id)));
  const retired = await retiredIntents(client, scopeKey, turnIds.filter(id => !rows.has(storedKey(id))));
  // As K4 `compact`, the K8 veto sees every acknowledged intent before anything is removed. H keeps one receipt per task,
  // the accepted reply itself (messages.ts), so only a delegated reply body without its verdict can refuse on the receipt.
  for (const turnId of present) {
    const reason = compactVeto(state, turnId, { hasIntent: id => rows.has(storedKey(id)), receipt: taskId => state.replies[taskId] });
    if (reason !== undefined) throw new CompactVetoError(turnId, reason);
  }
  for (const turnId of turnIds) {
    const row = rows.get(storedKey(turnId));
    if (!row) {
      if (!retired.has(turnId)) throw new Error('Acknowledged intent not found');
      continue;
    }
    if (row.source === 'routine') throw new Error('H does not compact routine intents');
    if (row.conclusion === null) throw new Error('Only settled intents can be compacted');
  }
  for (const turnId of present) await client.query('DELETE FROM intent WHERE scope = $1 AND key = $2', [scopeKey, storedKey(turnId)]);
  await retire(client, scopeKey, 'intent', present.map(intentIdentity));
  return { compactedIntents: present.length, alreadyCompactedIntents: turnIds.length - present.length };
}
