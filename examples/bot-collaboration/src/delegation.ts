import { hash, taskId as taskIdOf, type LedgerState } from '@byok-sdk/server/execution-core';
import type { CollaborationState, Delegation, DelegationCancel } from './model';
import * as rules from './rules/delegation';

// K8 adapter for the pure delegation rules in `rules/delegation.ts`. It reads the K4 intent facts of each Turn from the ledger.
export { BOT_REPLY_MAX_BYTES, BOT_REQUEST_MAX_BYTES, CONTEXT_FIXED_MAX_BYTES, DEFAULT_CANCEL_GRACE_MS, DEFAULT_INSTRUCTION_MAX_BYTES,
  FRAME_MAX_BYTES, HOP_LIMIT, OPEN_DELEGATION_ENTRY_MAX_BYTES, OPEN_DELEGATIONS_MAX_BYTES, OPEN_DELEGATIONS_MAX_ITEMS,
  REPLY_REQUEST_MAX_BYTES, REPLY_RETRY_MAX_MS, REPLY_UNCERTAIN_AFTER_MS, ROOT_BOT_BUDGET, ROSTER_ENTRY_MAX_BYTES,
  applyDelegate, claimUnit, crossBotRequest, delegationBlock, delegationDue, endChain, instructionOverhead, isCrossBot,
  minimumInstructionBytes, observeStart, openDelegations, openDelegationsContext, reconcileReply, releaseUnit, reserveUnits,
  resolveDelegation, retryReply, type DelegationTimers } from './rules/delegation';

/** The K4 facts of each Turn, read by Turn id when a rule asks for them. */
export function intentFacts(s: Pick<LedgerState, 'intents' | 'executions'>): rules.IntentFacts {
  const intent = (key: string) => s.intents[hash(key)];
  return {
    intent: key => {
      const row = intent(key);
      return row && { taskId: row.taskId, ...(row.conclusion ? { conclusion: row.conclusion } : {}), ...(row.cancelReason ? { cancelReason: row.cancelReason } : {}) };
    },
    started: key => {
      const row = intent(key);
      return !!row && Array.from({ length: row.generation + 1 }, (_, g) => s.executions[taskIdOf(key, g)]).some(execution =>
        execution?.started || execution?.terminal !== undefined && execution.terminal.envelope.type !== 'task.decline');
    },
    declineCode: key => {
      const row = intent(key), envelope = row && s.executions[row.taskId]?.terminal?.envelope;
      return envelope?.type === 'task.decline' ? envelope.payload.code : undefined;
    },
    offeredTo: key => {
      const row = intent(key), execution = row && s.executions[row.taskId];
      return row?.phase === 'inflight' && execution?.submission === 'delivered' && !execution.started && execution.attempt?.status === 'offered'
        ? row.execution.deviceId : undefined;
    },
  };
}
/** Only the intent rows: cancel arbitration reads no execution. */
export function intentRows(s: Pick<LedgerState, 'intents'>): Pick<rules.IntentFacts, 'intent'> {
  return { intent: key => intentFacts({ intents: s.intents, executions: {} }).intent(key) };
}
export function observeDevices(s: LedgerState, state: CollaborationState, devices: ReadonlyMap<string, boolean>, emit: rules.Publish): void {
  rules.observeDevices(state, intentFacts(s), devices, emit);
}
export function arbitrateCancel(s: Pick<LedgerState, 'intents'>, state: CollaborationState, d: Delegation, now: number, emit: rules.Publish,
  reason?: DelegationCancel['reason']): boolean {
  return rules.arbitrateCancel(state, intentRows(s), d, now, emit, reason);
}
export function settleDelegations(s: LedgerState, state: CollaborationState, now: number, emit: rules.Publish, timers?: rules.DelegationTimers): void {
  rules.settleDelegations(state, intentFacts(s), now, emit, timers);
}
export function abandonDelegation(s: LedgerState, state: CollaborationState, d: Delegation, now: number, emit: rules.Publish): boolean {
  return rules.abandonDelegation(state, intentRows(s), d, now, emit);
}
