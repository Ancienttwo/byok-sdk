import type { BotTurnOutcome, RoomFields } from '@byok-sdk/protocol';
import { canonical, hash } from '@byok-sdk/server/execution-core/canonical';
import { HISTORY_MAX_BYTES, HISTORY_MAX_ITEMS, historyWindow } from './history';
import type { TurnFields, TurnsState } from './turn';

/**
 * Room seat arbitration as pure rules (#606 R1). Each function changes only the room slice that the
 * caller passes, does no I/O and takes `now` from the caller. The Host stores the slice, gives the
 * execution facts of each seat, queues the returned seat Turns and cancels the returned work.
 */
export const ROOM_GRACE_MS = 240_000;
export const ROOM_CONTEXT_BYTES = HISTORY_MAX_BYTES;
export const ROOM_CONTEXT_MESSAGES = HISTORY_MAX_ITEMS;
export type Mentions = readonly string[] | 'all';
/** One room message, as stored and as an external room history authority gives it (#883). */
export interface RoomMessage { id: string; from: string; text: string; late: boolean }
export interface Room {
  id: string; name: string; members: string[]; admin?: string; mode: 'mention'; announcement: string;
  visibleFrom: Record<string, number>;
  messages: RoomMessage[];
}
export interface Round {
  id: string; root: string; roomId: string; input: string; seats: string[];
  limit: number; counts: Record<string, number>; admin?: string; closed: boolean;
}
export interface Seat {
  id: string; roundId: string; botId: string;
  status: 'waiting' | 'queued' | 'running' | 'late' | 'post' | 'pass' | 'failed' | 'busy' | 'removed' | 'blocked';
  triggerMessageId?: string; released: boolean; deadline?: number; startedAt?: number; late: boolean; reason?: string;
}
/** The team slice that the rules read and change. Of a Bot, they read only `archived`. */
export interface RoomsState {
  bots: Readonly<Record<string, { readonly archived: boolean }>>;
  rooms: Record<string, Room>; rounds: Record<string, Round>; seats: Record<string, Seat>;
  roots: Record<string, { autonomous: number; late: number }>;
}
/** Execution facts of one seat Turn. `admitted`: the Host queued it for execution. A seat without facts is not admitted. */
export interface SeatFacts { admitted: boolean; started: boolean; conclusion?: string }
/**
 * `cancel`: seats whose work lost admission. The Host cancels admitted work; a Turn that it never
 * admitted ends with `conclusion`. `turns`: the new seat Turns, in queue order.
 */
export interface RoomAdvance {
  cancel: Array<{ seatId: string; conclusion: 'cancelled' | 'expired' }>;
  turns: Array<{ id: string; botId: string; request: string }>;
}
const NOT_ADMITTED: SeatFacts = { admitted: false, started: false };

function activeBot(team: Pick<RoomsState, 'bots'>, botId: string): void {
  const bot = team.bots[botId];
  if (!bot || bot.archived) throw new Error('Bot is archived or absent');
}
function reserve(team: RoomsState, round: Round, botId: string, triggerMessageId?: string): void {
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
function newRound(team: RoomsState, id: string, root: string, roomId: string, input: string, members: readonly string[], triggerMessageId?: string): Round {
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
/** Append offsets stay valid because the ledger retains its complete audit history. */
export function roomVisibility(room: Room, members: readonly string[]): Record<string, number> {
  return Object.fromEntries(members.map(id => [id,
    room.members.includes(id) ? room.visibleFrom?.[id] ?? room.messages.length : room.messages.length,
  ]));
}
export function roomFields(team: Pick<RoomsState, 'bots'>, fields: RoomFields): Omit<Room, 'id' | 'messages'> {
  if (fields.mode && fields.mode !== 'mention') throw new Error('Only mention mode is supported');
  const members = [...fields.members];
  if (!members.length || members.length > 12 || new Set(members).size !== members.length) throw new Error('Room needs 1 to 12 distinct members');
  members.forEach(id => activeBot(team, id));
  if (fields.admin && !members.includes(fields.admin)) throw new Error('Admin must be a room member');
  return { name: fields.name, members, visibleFrom: Object.fromEntries(members.map(id => [id, 0])), ...(fields.admin ? { admin: fields.admin } : {}), mode: 'mention', announcement: fields.announcement ?? '' };
}
/** Owner room edit. An admin that leaves the members is dropped unless the update names one. */
export function updateRoom(team: Pick<RoomsState, 'bots' | 'rooms'>, roomId: string, update: Partial<RoomFields>): void {
  const room = team.rooms[roomId];
  if (!room) throw new Error('Room not found');
  const fields = { ...room, ...update };
  if (!update.admin && !fields.members.includes(fields.admin ?? '')) delete fields.admin;
  const next = roomFields(team, fields);
  next.visibleFrom = roomVisibility(room, next.members);
  Object.assign(room, next); if (!next.admin) delete room.admin;
}
/** `from` is the sender's principal id (#552). Without it, the message is from `user` and the input identity is the K8b one. */
export function roomInput(team: RoomsState, key: string, roomId: string, text: string, mentions: Mentions, from?: string): string {
  const room = team.rooms[roomId];
  if (!room) throw new Error('Room not found');
  if (!text.trim()) throw new Error('Room input is empty');
  const id = hash(['room-input', roomId, key]), input = JSON.stringify({ text, mentions, from });
  const prior = team.rounds[id];
  if (prior) { if (canonical(prior.input) !== canonical(input)) throw new Error('Room input identity conflict'); return id; }
  newRound(team, id, id, roomId, input, mentions === 'all' ? room.members : mentions);
  room.visibleFrom = roomVisibility(room, room.members);
  team.roots[id] = { autonomous: 0, late: 0 };
  room.messages.push({ id, from: from ?? 'user', text, late: false });
  return id;
}
export function memberPresent(team: RoomsState, seat: Seat): boolean {
  const room = team.rooms[team.rounds[seat.roundId]!.roomId];
  return !!room?.members.includes(seat.botId) && !team.bots[seat.botId]?.archived;
}
function observeStart(seat: Seat, now: number): void {
  if (seat.startedAt !== undefined) return;
  seat.startedAt = now;
  seat.deadline = now + ROOM_GRACE_MS;
}
/**
 * Apply the speech of the seat Turn `seatId`. An accepted `room_call` is copied back into `team`,
 * so pass the stored team object itself, not a copy of it.
 */
export function applySpeech(team: RoomsState, seatId: string, document: Pick<BotTurnOutcome, 'speech' | 'room_call'>, taskId: string, now: number,
  accept: (action: string, work: () => void) => void): void {
  const seat = team.seats[seatId]!;
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
    Object.assign(team, copy);
  });
}
/** Cancel only work that has lost admission. Never release a running writer. */
export function advanceRooms(team: RoomsState, facts: Readonly<Record<string, SeatFacts>>, now: number): RoomAdvance {
  const result: RoomAdvance = { cancel: [], turns: [] };
  for (const seat of Object.values(team.seats)) {
    // Keep completed speech and failures immutable. A released late seat is
    // still waiting for terminal, so membership changes must still revoke it.
    if (seat.released && ['post', 'pass', 'failed', 'busy', 'blocked', 'removed'].includes(seat.status)) continue;
    const fact = facts[seat.id] ?? NOT_ADMITTED;
    if (!memberPresent(team, seat)) {
      seat.status = 'removed'; seat.released = true;
      if (!fact.admitted || !fact.started && !fact.conclusion) result.cancel.push({ seatId: seat.id, conclusion: 'cancelled' });
      continue;
    }
    if (fact.conclusion) {
      seat.status = fact.conclusion === 'expired' ? 'busy' : 'failed'; seat.released = true;
      seat.reason = fact.conclusion; continue;
    }
    if (seat.released) continue;
    if (fact.started) { observeStart(seat, now); seat.status = 'running'; }
    if (seat.deadline !== undefined && now >= seat.deadline) {
      if (fact.started) { seat.status = 'late'; seat.late = true; }
      else { seat.status = 'busy'; result.cancel.push({ seatId: seat.id, conclusion: 'expired' }); }
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
    result.turns.push({ id: seat.id, botId: seat.botId,
      request: JSON.stringify({ roomId: round.roomId, roundId: round.id, request: message?.text, requestFrom: message?.from }) });
  }
  return result;
}
/** The projection id of an accepted seat post in room history mode (#883): one per message, so a replay is identical. */
export function roomMessageProjection(roomId: string, messageId: string): string {
  return `room-message:${roomId}:${messageId}`;
}
/** The fields of a seat Turn. Seats never manage or delegate (§5), so no seat Turn carries owner authority. */
export function seatTurn(id: string, botId: string, request: string): TurnFields {
  return { id, root: id, source: 'room_slot', request, botId, hop: 0, authority: 'bot' };
}
/**
 * The room step of a Host sync (#793 S6): `advanceRooms` on the seat facts, then its results. A seat Turn whose work was not
 * admitted fails with the seat's conclusion; `add` queues each new seat Turn. Returns the seats whose admitted work the Host
 * must cancel, as K4 `cancel` of their intents.
 */
export function advanceRoomSeats(state: { team: RoomsState } & Pick<TurnsState, 'turns'>, facts: Readonly<Record<string, SeatFacts>>,
  now: number, add: (id: string, botId: string, request: string) => void): string[] {
  const { cancel, turns } = advanceRooms(state.team, facts, now);
  const admitted: string[] = [];
  for (const { seatId, conclusion } of cancel) {
    const turn = state.turns[seatId];
    if (facts[seatId]?.admitted) admitted.push(seatId);
    else if (turn) { turn.status = 'failed'; turn.conclusion = conclusion; }
  }
  for (const turn of turns) add(turn.id, turn.botId, turn.request);
  return admitted;
}
/** Checks rows from an external room history authority. A row in another shape refuses the whole read. */
export function roomMessages(value: unknown): RoomMessage[] {
  const fail = (): never => { throw new Error('Invalid injected room messages'); };
  if (!Array.isArray(value)) fail();
  return (value as unknown[]).map(row => {
    const r = (row ?? fail()) as Record<string, unknown>;
    const text = (key: string) => typeof r[key] === 'string' ? r[key] as string : fail();
    if (typeof r.late !== 'boolean') fail();
    return { id: text('id'), from: text('from'), text: text('text'), late: r.late as boolean };
  });
}
/**
 * The room view of a seat Turn's ContextPack: the messages that the seat Bot can see, newest last.
 * `injected` are the messages from an external room history authority, which already selected them for this seat's Bot (#883).
 */
export function roomContext(team: Pick<RoomsState, 'rooms' | 'rounds' | 'seats'>, turn: { id: string }, turnLimit = ROOM_CONTEXT_MESSAGES,
  injected?: readonly RoomMessage[]) {
  const seat = team.seats[turn.id];
  if (!seat) throw new Error('Room seat not found');
  const round = team.rounds[seat.roundId]!, room = team.rooms[round.roomId]!;
  const visible = injected ? [...injected] : room.messages.slice(room.visibleFrom?.[seat.botId] ?? room.messages.length);
  const messages = visible.slice(-turnLimit);
  return { historyWindow: historyWindow('messages', visible.length - messages.length, turnLimit),
    room: { id: room.id, name: room.name, members: room.members, announcement: room.announcement,
      visibility: 'after_join' as const, messages },
    round: { id: round.id, limit: round.limit, counts: round.counts }, seat: { id: seat.id, deadline: seat.deadline } };
}
