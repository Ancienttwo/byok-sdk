import type { Card } from './turn';
import type { CoalesceState } from './coalesce';
import type { Seat } from './rooms';
import { delegationDue, type DelegationState, type DelegationTimers } from './delegation';

/**
 * The times when a Host sync has collaboration work to do (#793 S4): each open input batch's seal, each pending card's
 * expiry, each unreleased seat's deadline, and the delegation times (`delegationDue`: reply checks, the cancel grace and
 * the uncertain timer). L arms its timer with them; H stores their minimum as its scope's due time. Routine slots are K4's.
 */
export function collaborationDue(state: Pick<DelegationState, 'delegations'> & CoalesceState & {
  readonly cards: Readonly<Record<string, Card>>; readonly team: { readonly seats: Readonly<Record<string, Seat>> } }, timers?: DelegationTimers): number[] {
  return [
    ...Object.values(state.inputBatches ?? {}).filter(batch => batch.state === 'open').map(batch => batch.sealAt),
    ...Object.values(state.cards).filter(card => card.state === 'pending').map(card => card.expiresAt),
    ...Object.values(state.team.seats).filter(seat => !seat.released && seat.deadline !== undefined).map(seat => seat.deadline!),
    ...delegationDue(state, timers),
  ];
}
