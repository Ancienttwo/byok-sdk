import { hash, type CompactVeto, type HostLedger, type LedgerState } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState, Turn } from './model';
import { routineOccurrence } from './routines';
import { compactVeto } from './rules/commands';

/**
 * K4 compacted the intent of this Turn, so its identity can never run again (#816). The intent tombstone proves it.
 * A routine Turn's tombstone expires with its slot, but K4 removes its occurrence with the intent, and a routine Turn is
 * written with its occurrence. So a routine Turn without its occurrence was compacted too.
 */
export function turnIntentRetired(ledger: HostLedger, s: Pick<LedgerState, 'occurrences'>, turn: Turn, now: number): boolean {
  return ledger.hasTombstone('intent', turn.id, now) || turn.source === 'routine' && !s.occurrences[routineOccurrence(turn)];
}

/**
 * The K8 compact veto (#816). Open every Bot ledger with it: `new HostLedger(file, tenant, { compactVeto: botCompactVeto })`.
 * It runs the K8 rule `compactVeto` (rules/compaction.ts) on the ledger's K4 intents and execution receipts.
 */
export const botCompactVeto: CompactVeto = (ledger, key) => {
  // Read only: `stateOf` would create the collaboration row inside the compaction.
  const state = ledger.application.collaboration as unknown as CollaborationState | undefined;
  if (state === undefined) return undefined;
  if (state.version !== 3) return 'Unsupported Bot collaboration state version';
  // #975: an exported domain keeps what it exported, so nothing of it is compacted.
  if (state.switchExport) return 'switch_exported';
  return compactVeto(state, key, { hasIntent: turnId => !!ledger.intents[hash(turnId)],
    receipt: taskId => ledger.executions[taskId]?.messageReceipt });
};
