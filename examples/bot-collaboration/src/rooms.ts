import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { hash, type LedgerState } from '../../host-execution-core/src/model';
import type { CollaborationState, Turn } from './model';
import type { Round, Seat, TeamState } from './team-model';
import { activeBot, same, roomVisibility } from './team';

export const ROOM_GRACE_MS = 240_000;
import { HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS, historyWindow } from './history';
export const ROOM_CONTEXT_BYTES = HISTORY_MAX_BYTES;
export const ROOM_CONTEXT_MESSAGES = HISTORY_MAX_ITEMS;
export type Mentions = readonly string[] | 'all';
function reserve(team: TeamState, round: Round, botId: string, triggerMessageId?: string): void {
  const room = team.rooms[round.roomId]!;
  activeBot(team, botId);
  if (!room.members.includes(botId)) throw new Error('Called Bot is not a member');
  if (round.seats.length >= round.limit) throw new Error('Round seat budget reached');
  if ((round.counts[botId] ?? 0) >= (botId === round.admin ? 4 : 2)) throw new Error('Member seat budget reached');
  const id = hash([round.id, round.seats.length, botId]);
  round.counts[botId] = (round.counts[botId] ?? 0) + 1;
  round.seats.push(id);
  team.seats[id] = { id, roundId: round.id, botId, status: 'waiting', released: false, late: false, ...(triggerMessageId ? { triggerMessageId } : {}) };
}
function newRound(team: TeamState, id: string, root: string, roomId: string, input: string, members: readonly string[], triggerMessageId?: string): Round {
  const room = team.rooms[roomId];
  if (!room) throw new Error('Room not found');
  const distinct = [...new Set(members)];
  // Validate all members before changing any budget or round row.
  distinct.forEach(botId => { if (!room.members.includes(botId)) throw new Error('Mention is not a member'); activeBot(team, botId); });
  const round: Round = { id, root, roomId, input, seats: [], counts: {}, limit: distinct.length + 4 + (room.admin ? 4 : 0),
    ...(room.admin ? { admin: room.admin } : {}), closed: distinct.length === 0 };
  distinct.forEach(botId => reserve(team, round, botId, triggerMessageId));
  team.rounds[id] = round;
  return round;
}
export function roomInput(state: CollaborationState, key: string, roomId: string, text: string, mentions: Mentions): string {
  const team = state.team, room = team.rooms[roomId];
  if (!room) throw new Error('Room not found');
  if (!text.trim()) throw new Error('Room input is empty');
  const id = hash(['room-input', roomId, key]), input = JSON.stringify({ text, mentions });
  const prior = team.rounds[id];
  if (prior) { if (!same(prior.input, input)) throw new Error('Room input identity conflict'); return id; }
  newRound(team, id, id, roomId, input, mentions === 'all' ? room.members : mentions);
  room.visibleFrom = roomVisibility(room, room.members);
  team.roots[id] = { autonomous: 0, late: 0 };
  room.messages.push({ id, from: 'user', text, late: false });
  return id;
}
export function memberPresent(team: TeamState, seat: Seat): boolean {
  const room = team.rooms[team.rounds[seat.roundId]!.roomId];
  return !!room?.members.includes(seat.botId) && !team.bots[seat.botId]?.archived;
}
function observeStart(seat: Seat, now: number): void {
  if (seat.startedAt !== undefined) return;
  seat.startedAt = now;
  seat.deadline = now + ROOM_GRACE_MS;
}
export function applySpeech(state: CollaborationState, turn: Turn, document: BotTurnOutcome, taskId: string, now: number,
  accept: (action: string, work: () => void) => void): void {
  const team = state.team, seat = team.seats[turn.id]!;
  const round = team.rounds[seat.roundId]!, room = team.rooms[round.roomId]!;
  let accepted = false;
  accept('speech', () => {
    if (!memberPresent(team, seat) || seat.status === 'busy' || seat.status === 'removed' || seat.status === 'blocked') throw new Error('Seat no longer has speech authority');
    const speech = document.speech;
    if (!speech || speech.kind === 'post' && !speech.text.trim()) {
      seat.status = 'failed'; seat.released = true; throw new Error('A seat needs a post or explicit pass');
    }
    observeStart(seat, now);
    seat.late ||= now >= seat.deadline!;
    if (speech.kind === 'post') {
      if (seat.late && team.roots[round.root]!.late >= 10) {
        seat.status = 'failed'; seat.released = true; throw new Error('Late post budget is 10');
      }
      room.messages.push({ id: seat.id, from: seat.botId, text: speech.text, late: seat.late });
      if (seat.late) team.roots[round.root]!.late++;
    }
    seat.status = speech.kind; seat.released = true; accepted = true;
  });
  if (accepted && document.room_call) accept('room_call', () => {
    const members = [...document.room_call!.members];
    if (new Set(members).size !== members.length) throw new Error('Duplicate room_call member');
    // A batch is atomic. Refusal must not consume any seat or round budget.
    const copy = structuredClone(team);
    const triggerMessageId = document.speech?.kind === 'post' ? seat.id : seat.triggerMessageId;
    if (round.closed) {
      if (copy.roots[round.root]!.autonomous >= 3) throw new Error('Autonomous round budget is 3');
      const id = hash([taskId, 'room_call']);
      newRound(copy, id, round.root, round.roomId, JSON.stringify({ calledBy: seat.botId }), members, triggerMessageId);
      copy.roots[round.root]!.autonomous++;
    } else {
      for (const botId of members) reserve(copy, copy.rounds[round.id]!, botId, triggerMessageId);
    }
    state.team = copy;
  });
}
/** Cancel only work that has lost admission. Never release K4's running writer. */
export function advanceRooms(s: LedgerState, state: CollaborationState, now: number,
  add: (id: string, botId: string, request: string) => void): void {
  const team = state.team;
  for (const seat of Object.values(team.seats)) {
    const intent = s.intents[hash(seat.id)], execution = intent && s.executions[intent.taskId];
    // Keep completed speech and failures immutable. A released late seat is
    // still waiting for terminal, so membership changes must still revoke it.
    if (seat.released && ['post', 'pass', 'failed', 'busy', 'blocked', 'removed'].includes(seat.status)) continue;
    if (!memberPresent(team, seat)) {
      seat.status = 'removed'; seat.released = true;
      if (intent && !execution?.started && !intent.conclusion) intent.cancelReason = 'cancelled';
      const turn = state.turns[seat.id];
      if (turn && !intent) { turn.status = 'failed'; turn.conclusion = 'cancelled'; }
      continue;
    }
    if (intent?.conclusion) {
      seat.status = intent.conclusion === 'expired' ? 'busy' : 'failed'; seat.released = true;
      seat.reason = intent.conclusion; continue;
    }
    if (seat.released) continue;
    if (execution?.started) { observeStart(seat, now); seat.status = 'running'; }
    if (seat.deadline !== undefined && now >= seat.deadline) {
      if (execution?.started) { seat.status = 'late'; seat.late = true; }
      else {
        seat.status = 'busy';
        if (intent) intent.cancelReason = 'cancelled';
        const turn = state.turns[seat.id];
        if (turn && !intent) { turn.status = 'failed'; turn.conclusion = 'expired'; }
      }
      seat.released = true;
    }
  }
  for (const round of Object.values(team.rounds)) {
    const seat = round.seats.map(id => team.seats[id]!).find(row => !row.released);
    if (!seat) { round.closed = true; continue; }
    if (seat.status !== 'waiting') continue;
    seat.status = 'queued'; seat.deadline = now + ROOM_GRACE_MS;
    const room = team.rooms[round.roomId]!;
    const requestIndex = room.messages.findIndex(message => message.id === (seat.triggerMessageId ?? round.root));
    const visibleFrom = room.visibleFrom?.[seat.botId] ?? room.messages.length;
    const message = requestIndex >= visibleFrom ? room.messages[requestIndex] : undefined;
    add(seat.id, seat.botId, JSON.stringify({ roomId: round.roomId, roundId: round.id, request: message?.text, requestFrom: message?.from }));
  }
}
export function roomContext(team: TeamState, turn: Turn) {
  const seat = team.seats[turn.id];
  if (!seat) throw new Error('Room seat not found');
  const round = team.rounds[seat.roundId]!, room = team.rooms[round.roomId]!;
  const visible = room.messages.slice(room.visibleFrom?.[seat.botId] ?? room.messages.length);
  const messages = visible.slice(-ROOM_CONTEXT_MESSAGES);
  return { historyWindow: historyWindow('messages', visible.length - messages.length),
    room: { id: room.id, name: room.name, members: room.members, announcement: room.announcement,
      visibility: 'after_join' as const, messages },
    round: { id: round.id, limit: round.limit, counts: round.counts }, seat: { id: seat.id, deadline: seat.deadline } };
}
