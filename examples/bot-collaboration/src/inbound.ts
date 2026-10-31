import { json, type CollaborationState, type Turn } from './model';
import type { Json } from './rules/turn';
import type { Round } from './team-model';
import { inboundDisposition, inboundDispositions, type InboundDisposition, type InboundState, type InboundTurn } from './rules/inbound';

/**
 * The K8 adapter for the inbound disposition projection (#1229 item 3). The pure rule reads Turn and batch rows; this
 * adapter adds one synthetic row per round root, because a round input stores its round id as the inbound root and its
 * seat Turns have their own roots.
 */
/** A round root answers a room input when any seat Turn concluded; otherwise the round is still open. */
function roundTurn(state: CollaborationState, round: Round): InboundTurn {
  const turns = round.seats.map(id => state.turns[id]).filter((turn): turn is Turn => turn !== undefined);
  const conclusions = turns.map(turn => turn.conclusion).filter((value): value is string => value !== undefined);
  if (conclusions.includes('cancelled')) return { id: round.id, root: round.root, status: 'failed', conclusion: 'cancelled' };
  if (turns.some(turn => turn.status === 'succeeded' || turn.conclusion === 'succeeded' || turn.conclusion === 'delivered')) {
    return { id: round.id, root: round.root, status: 'succeeded', conclusion: 'succeeded' };
  }
  const failed = new Set(['failed', 'expired', 'declined', 'superseded', 'abandoned']);
  if (conclusions.some(conclusion => failed.has(conclusion)) || turns.some(turn => turn.status === 'failed')) {
    return { id: round.id, root: round.root, status: 'failed', conclusion: 'failed' };
  }
  return { id: round.id, root: round.root, status: 'queued' };
}
/** The rows that the pure rule reads. A round with no seat Turn is still the round root that answers its input. */
export function inboundState(state: CollaborationState): InboundState {
  const turns: Record<string, InboundTurn> = { ...state.turns };
  for (const round of Object.values(state.team.rounds)) if (round.root === round.id) turns[round.id] ??= roundTurn(state, round);
  return { channel: state.channel, turns, inputBatches: state.inputBatches };
}
/** The Host UI read (#1229): every recorded inbound human message and its current destination, oldest first. */
export function inboundDispositionsOf(state: CollaborationState): InboundDisposition[] {
  // Most Hosts never receive IM input. Skip building round rows when there is no inbound row at all.
  if (Object.keys(state.channel?.inbounds ?? {}).length === 0) return [];
  return inboundDispositions(inboundState(state));
}
/**
 * One projection id per destination transition. The id names the destination, so a projection value never changes and
 * the K4 outbox can hold every transition without an identity conflict.
 */
export function inboundProjection(disposition: InboundDisposition): { id: string; value: Json } {
  const id = disposition.disposition === 'filtered'
    ? `inbound:${disposition.id}:filtered:${disposition.code}`
    : `inbound:${disposition.id}:${disposition.disposition}:${disposition.turnId}`;
  return { id, value: json(disposition) };
}
/** Publishes the current destination of each message. `project` is idempotent for an unchanged destination. */
export function projectInboundDispositions(state: CollaborationState, emit: (id: string, value: Json) => void): void {
  for (const disposition of inboundDispositionsOf(state)) {
    const projection = inboundProjection(disposition);
    emit(projection.id, projection.value);
  }
}
