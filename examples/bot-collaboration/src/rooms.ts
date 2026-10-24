import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { hash, type LedgerState } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState, Turn } from './model';
import * as rules from './rules/rooms';

// K8 adapter for the pure room rules in `rules/rooms.ts`.
export { ROOM_GRACE_MS, memberPresent, roomContext, roomVisibility, type Mentions } from './rules/rooms';
export { ROOM_CONTEXT_BYTES, ROOM_CONTEXT_MESSAGES } from './rules/rooms';
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
  for (const seatId of rules.advanceRoomSeats(state, facts, now, add)) s.intents[hash(seatId)]!.cancelReason = 'cancelled';
}
