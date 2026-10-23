import { hash, taskId, type HostLedger, type LedgerState } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from './model';
import { turnIntentRetired } from './compaction';

export function promoteReplyReceipts(ledger: HostLedger, ledgerState: LedgerState, state: CollaborationState, now: number): void {
  // Upgrade prior K8 receipts into K4's execution-owned acceptance fact. No replay/projection here.
  for (const [id, reply] of Object.entries(state.replies)) {
    const execution = ledgerState.executions[id], turn = state.turns[reply.turnId];
    const intent = ledgerState.intents[hash(reply.turnId)];
    // A compacted Turn keeps its business receipt. K4 no longer holds the execution.
    if (!execution && !intent && turn && turnIntentRetired(ledger, ledgerState, turn, now)) continue;
    if (!execution || !turn || !intent) throw new Error('Orphaned legacy reply receipt');
    if (!Number.isSafeInteger(intent.generation) || intent.generation < 0
      || intent.generation >= intent.retry.maxAttempts) throw new Error('Invalid legacy reply generation');
    let bound = false;
    for (let generation = 0; generation <= intent.generation; generation++) {
      if (taskId(turn.id, generation) === id) { bound = true; break; }
    }
    if (!bound || execution.input.taskId !== id || !execution.input.payload.messageEgress
      || !execution.input.agentMessageContext || (turn.delegationId
        && execution.input.agentMessageContext.freshnessCursor !== turn.id)) throw new Error('Invalid legacy reply binding');
    const receipt = { messageId: reply.messageId, contentHash: reply.contentHash };
    if (execution.messageReceipt && (execution.messageReceipt.messageId !== receipt.messageId
      || execution.messageReceipt.contentHash !== receipt.contentHash)) throw new Error('Conflicting legacy reply receipt');
    execution.messageReceipt ??= receipt;
  }
}
