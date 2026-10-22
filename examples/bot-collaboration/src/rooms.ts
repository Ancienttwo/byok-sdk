import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { hash, type LedgerState } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState, Turn } from './model';
import type { TeamState } from './team-model';
import { HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS, historyWindow } from './history';
import * as rules from './rules/rooms';

// K8 adapter for the pure room rules in `rules/rooms.ts`, and the room view of a seat Turn's ContextPack.
export { ROOM_GRACE_MS, memberPresent, roomVisibility, type Mentions } from './rules/rooms';
export const ROOM_CONTEXT_BYTES = HISTORY_MAX_BYTES;
export const ROOM_CONTEXT_MESSAGES = HISTORY_MAX_ITEMS;
export function roomInput(state: CollaborationState, key: string, roomId: string, text: string, mentions: rules.Mentions, from?: string): string {
  return rules.roomInput(state.team, key, roomId, text, mentions, from);
}
export function applySpeech(state: CollaborationState, turn: Turn, document: BotTurnOutcome, taskId: string, now: number,
  accept: (action: string, work: () => void) => void): void {
  rules.applySpeech(state.team, turn.id, document, taskId, now, accept);
}
/**
 * Seat facts come from the K4 intent and execution of each seat Turn. A cancel of admitted work sets
 * the K4 `cancelReason`; a seat Turn without an intent fails at once. Then the new seat Turns are added.
 */
export function advanceRooms(s: LedgerState, state: CollaborationState, now: number,
  add: (id: string, botId: string, request: string) => void): void {
  const facts: Record<string, rules.SeatFacts> = {};
  for (const id of Object.keys(state.team.seats)) {
    const intent = s.intents[hash(id)], execution = intent && s.executions[intent.taskId];
    facts[id] = { admitted: !!intent, started: !!execution?.started, conclusion: intent?.conclusion };
  }
  const { cancel, turns } = rules.advanceRooms(state.team, facts, now);
  for (const { seatId, conclusion } of cancel) {
    const intent = s.intents[hash(seatId)], turn = state.turns[seatId];
    if (intent) intent.cancelReason = 'cancelled';
    else if (turn) { turn.status = 'failed'; turn.conclusion = conclusion; }
  }
  for (const turn of turns) add(turn.id, turn.botId, turn.request);
}
export function roomContext(team: TeamState, turn: Turn, turnLimit = ROOM_CONTEXT_MESSAGES) {
  const seat = team.seats[turn.id];
  if (!seat) throw new Error('Room seat not found');
  const round = team.rounds[seat.roundId]!, room = team.rooms[round.roomId]!;
  const visible = room.messages.slice(room.visibleFrom?.[seat.botId] ?? room.messages.length);
  const messages = visible.slice(-turnLimit);
  return { historyWindow: historyWindow('messages', visible.length - messages.length, turnLimit),
    room: { id: room.id, name: room.name, members: room.members, announcement: room.announcement,
      visibility: 'after_join' as const, messages },
    round: { id: round.id, limit: round.limit, counts: round.counts }, seat: { id: seat.id, deadline: seat.deadline } };
}
