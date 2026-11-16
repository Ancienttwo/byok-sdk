import { hash, type CompactVeto, type HostLedger, type HostLedgerOptions, type LedgerState } from '@byok-sdk/server/execution-core';
import type { CollaborationState, Turn } from './model.js';
import { routineOccurrence } from './routines.js';
import { compactVeto } from './rules/commands.js';

/**
 * K4 compacted the intent of this Turn, so its identity can never run again (#816). The intent tombstone proves it.
 * A routine Turn's tombstone expires with its slot, but K4 removes its occurrence with the intent, and a routine Turn is
 * written with its occurrence. So a routine Turn without its occurrence was compacted too.
 */
export function turnIntentRetired(ledger: HostLedger, s: Pick<LedgerState, 'occurrences'>, turn: Turn, now: number): boolean {
  return ledger.hasTombstone('intent', turn.id, now) || turn.source === 'routine' && !s.occurrences[routineOccurrence(turn)];
}

/**
 * The K8 compact veto (#816). `botLedgerOptions` registers it; the Host checks this identity.
 * It runs the K8 rule `compactVeto` (rules/compaction.ts) on the ledger's K4 intents and execution receipts.
 */
export const botCompactVeto: CompactVeto = (ledger, key) => {
  // Read only: `stateOf` would create the collaboration row inside the compaction.
  const state = ledger.application.collaboration as unknown as CollaborationState | undefined;
  if (state === undefined) return undefined;
  // #975: an exported domain keeps what it exported, so nothing of it is compacted.
  if (state.switchExport) return 'switch_exported';
  return compactVeto(state, key, { hasIntent: turnId => !!ledger.intents[hash(turnId)],
    receipt: taskId => ledger.executions[taskId]?.messageReceipt });
};

/** The format of K8 state in a Host ledger: its `k8` row of `host_store_format`. */
export const K8_FORMAT = 3;
/**
 * The options of every Bot ledger: the K8 compact veto and the `k8` format row. Open it with
 * `new HostLedger(file, tenant, botLedgerOptions)`, or `{ ...botLedgerOptions, projectionOutboxLimits }` to add options.
 */
export const botLedgerOptions: Readonly<HostLedgerOptions> = Object.freeze({
  compactVeto: botCompactVeto, expectedFormats: Object.freeze({ k8: K8_FORMAT }),
});
