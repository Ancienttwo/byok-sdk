import type { Turn } from './turn';
import { BOT_REPLY_MAX_BYTES, type DelegationState } from './delegation';

/**
 * The first acceptance of one Agent message as a pure rule (#739 D1). The SDK has already checked the binding.
 * A delegated reply body is stored with its acceptance record; that record is the only reply body authority (§3.3).
 */
export interface MessageFields { taskId: string; payload: { body: string; messageId: string; contentHash: string; contentType: string } }
export type MessageDisposition = { outcome: 'accepted' } | { outcome: 'refused'; reasonCode: string };
/**
 * `deliver` stages the body for the Host channel; the Turn's outcome makes it visible (#1762). Absent: the Host has no channel. `hostMessage` (#1356) decides the message of
 * a Host intent whose handler has a message handler. An accepted one is recorded without its body and is not delivered.
 */
export function acceptMessage(state: DelegationState, turnId: string, input: MessageFields, now: () => number,
  deliver?: (turn: Turn, key: string, text: string) => void, hostMessage?: () => MessageDisposition): MessageDisposition {
  const refuse = (reasonCode: string) => ({ outcome: 'refused' as const, reasonCode });
  const turn = state.turns[turnId];
  if (!turn) {
    if (!hostMessage) return refuse('binding_mismatch');
    const disposition = hostMessage();
    if (disposition.outcome === 'accepted') {
      state.replies[input.taskId] = { turnId, messageId: input.payload.messageId, contentHash: input.payload.contentHash,
        contentType: input.payload.contentType, acceptedAt: now() };
    }
    return disposition;
  }
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
/**
 * The checked result of a Host intent message handler (#1356). K4 checks only what the Host returns, so the Host checks the
 * handler's result. A thenable throws after its rejection is consumed, and any other shape than a disposition throws.
 */
export function hostMessageDisposition(result: unknown): MessageDisposition {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Host intent message handler must be synchronous');
  }
  const value = result as Record<string, unknown> | null, keys = value && typeof value === 'object' ? Object.keys(value).sort().join() : '';
  if (keys === 'outcome' && value!.outcome === 'accepted') return { outcome: 'accepted' };
  if (keys === 'outcome,reasonCode' && value!.outcome === 'refused' && typeof value!.reasonCode === 'string' && value!.reasonCode) {
    return { outcome: 'refused', reasonCode: value!.reasonCode };
  }
  throw new Error('Invalid Host intent message disposition');
}
