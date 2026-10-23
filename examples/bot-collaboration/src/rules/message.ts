import type { Turn } from './turn';
import { BOT_REPLY_MAX_BYTES, type DelegationState } from './delegation';

/**
 * The first acceptance of one Agent message as a pure rule (#739 D1). The SDK has already checked the binding.
 * A delegated reply body is stored with its acceptance record; that record is the only reply body authority (§3.3).
 */
export interface MessageFields { taskId: string; payload: { body: string; messageId: string; contentHash: string; contentType: string } }
export type MessageDisposition = { outcome: 'accepted' } | { outcome: 'refused'; reasonCode: string };
/** `deliver` queues the body for the Host channel. Absent: the Host has no channel. */
export function acceptMessage(state: DelegationState, turnId: string, input: MessageFields, now: () => number,
  deliver?: (turn: Turn, key: string, text: string) => void): MessageDisposition {
  const refuse = (reasonCode: string) => ({ outcome: 'refused' as const, reasonCode });
  const turn = state.turns[turnId];
  if (!turn) return refuse('binding_mismatch');
  const delegation = turn.delegationId ? state.delegations[turn.delegationId] : undefined;
  if (delegation?.verdict) {
    state.audit.push(`Delegation message after verdict: ${delegation.id} ${input.taskId}`);
    return refuse('delegation_resolved');
  }
  // Cancel and first acceptance meet in this transaction boundary (§8.8).
  if (delegation?.cancel?.targetTurnId === turn.id) {
    state.audit.push(`Delegation message after cancel: ${delegation.id} ${input.taskId}`);
    return refuse('delegation_cancelled');
  }
  if (delegation && Buffer.byteLength(input.payload.body, 'utf8') > BOT_REPLY_MAX_BYTES) return refuse('reply_too_large');
  state.replies[input.taskId] = { turnId: turn.id, messageId: input.payload.messageId, contentHash: input.payload.contentHash,
    contentType: input.payload.contentType, acceptedAt: now(), ...(delegation ? { body: input.payload.body } : {}) };
  deliver?.(turn, input.payload.messageId, input.payload.body);
  return { outcome: 'accepted' };
}
