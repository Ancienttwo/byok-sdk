import { hash, type CompactVeto } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from './model';

/**
 * The K8 compact veto (#816). Open every Bot ledger with it: `new HostLedger(file, tenant, { compactVeto: botCompactVeto })`.
 * A Turn id is its K4 intent key. K8 reads the intent of a Turn until the Turn and its readers settle, so K4 keeps it until then.
 * A key without a Turn, for example a Host job, is not a K8 key.
 */
export const botCompactVeto: CompactVeto = (ledger, key) => {
  // Read only: `stateOf` would create the collaboration row inside the compaction.
  const state = ledger.application.collaboration as unknown as CollaborationState | undefined;
  if (state === undefined) return undefined;
  if (state.version !== 2) return 'Unsupported Bot collaboration state version';
  const turn = Object.hasOwn(state.turns, key) ? state.turns[key]! : undefined;
  if (!turn) return undefined;
  // A Turn without an intent, for example one that ended before promotion, has no K4 result left to report.
  if (!turn.conclusion || ledger.intents[hash(key)] && !turn.reported) return 'The Turn is not concluded and reported';
  for (const d of Object.values(state.delegations)) {
    if (d.lateTurnId === key || !d.verdict && (d.chainTurnIds.includes(key) || d.cancel?.targetTurnId === key)) {
      return 'An unresolved delegation references the Turn';
    }
  }
  const seat = Object.hasOwn(state.team.seats, key) ? state.team.seats[key]! : undefined;
  if (seat && !seat.released) return 'The room seat of the Turn is not released';
  // A receipt is settled when K4 holds it for message replay, and a delegated reply body when its delegation has a verdict.
  for (const [taskId, reply] of Object.entries(state.replies)) {
    if (reply.turnId !== key) continue;
    const receipt = ledger.executions[taskId]?.messageReceipt;
    if (receipt?.messageId !== reply.messageId || receipt.contentHash !== reply.contentHash
      || reply.body !== undefined && !(turn.delegationId && state.delegations[turn.delegationId]?.verdict)) {
      return 'The reply receipt of the Turn is not settled';
    }
  }
  return undefined;
};
