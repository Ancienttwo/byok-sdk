import { hash, MIN_TOMBSTONE_RETENTION_MS, time, type Json } from '@byok-sdk/server/execution-core';
import { DEFAULT_CONTEXT_TURN_LIMIT } from './rules/context';
import type { CollaborationState, Turn } from './model';

/**
 * Explicit retention (#798). The Host acknowledges settled roots. One call moves every row of each root out of the
 * state into per-id rows, and retires the root's Turn, input and round ids for good. It never runs on its own.
 * Command records answer replays for `retentionMs` after they move; the other rows stay.
 */
export interface RetentionInput {
  /**
   * Root ids: the `root` field of a Turn projection, or the round root that `roomInput` and a room `receive` return.
   * A room seat Turn shows its seat id as `root`; it is refused with `seat_root` and its `roundRoot`.
   * A root that is already archived counts again harmlessly.
   */
  acknowledgedRoots: readonly string[];
  now: number;
  /** At least seven days: the replay window of the moved command records. */
  retentionMs: number;
}
/** The ContextPack Turn limit of the Host. Rows in the window of a Bot stay in the state. */
export interface RetentionLimits { contextTurnLimit: number }
/** K4 facts by Turn id. */
export interface RetentionFacts {
  /** The Turn still has its K4 intent. */
  hasIntent(turnId: string): boolean;
  /** The routine occurrence of a routine Turn is not concluded yet. */
  occurrenceOpen(turnId: string): boolean;
}
/** Where retention writes, in the same transaction as the state. L: the K4 application row port. */
export interface RetentionStore {
  put(namespace: string, id: string, value: Json, expiresAt?: number): void;
  expire(namespace: string, now: number): number;
  retire(namespace: string, id: string): void;
  isRetired(namespace: string, id: string): boolean;
}
export interface RetentionResult {
  archivedRoots: number; alreadyArchivedRoots: number; archivedRows: number;
  archivedCommands: number; expiredCommands: number; beforeBytes: number; afterBytes: number;
}
/**
 * The whole call changes nothing. `protected_root`: the root is still in use; acknowledge it again after it settles.
 * `seat_root`: the id is a room seat Turn, which belongs to its round's root. Acknowledge `roundRoot` instead; a retry of
 * the seat id fails the same way each time.
 */
export type RetentionRefusedCode = 'protected_root' | 'seat_root';
export class RetentionRefused extends Error {
  constructor(readonly code: RetentionRefusedCode, readonly root: string, reason: string, readonly roundRoot?: string) {
    super(`Retention refused: ${reason}`); this.name = 'RetentionRefused';
  }
}
const OPEN_DELIVERY = new Set(['pending', 'sending', 'unknown']);
const values = <T>(rows: Record<string, T> | undefined): T[] => Object.values(rows ?? {});
const own = <T>(rows: Record<string, T> | undefined, id: string): T | undefined => rows && Object.hasOwn(rows, id) ? rows[id] : undefined;

/**
 * The ids that a Bot's next ContextPacks can still read: its last Turns, cards and questions.
 * A Turn that has not frozen yet reads the last `limit` other Turns of its Bot (`earlier.slice(-limit)`), which can reach
 * one Turn further back than the window of a new Turn. So a Bot with an unfrozen Turn keeps `limit + 1` Turns.
 */
function contextWindow(state: CollaborationState, limit: number): Set<string> {
  const kept = new Set<string>(), byBot = new Map<string, { turns: string[]; cards: string[]; questions: string[]; unfrozen: boolean }>();
  const of = (botId: string) => {
    let rows = byBot.get(botId);
    if (!rows) byBot.set(botId, rows = { turns: [], cards: [], questions: [], unfrozen: false });
    return rows;
  };
  for (const turn of values(state.turns)) {
    const rows = of(turn.botId);
    rows.turns.push(turn.id);
    // A frozen Turn is `processing` (its offer is in K4) or concluded. Queued and blocked Turns can still freeze.
    if (!turn.conclusion && turn.status !== 'processing') rows.unfrozen = true;
  }
  for (const card of values(state.cards)) { const turn = own(state.turns, card.turnId); if (turn) of(turn.botId).cards.push(card.turnId); }
  for (const question of values(state.questions)) { const turn = own(state.turns, question.turnId); if (turn) of(turn.botId).questions.push(question.turnId); }
  const rows = Math.min(limit, DEFAULT_CONTEXT_TURN_LIMIT);
  for (const bot of byBot.values()) {
    for (const id of [...bot.turns.slice(-(limit + (bot.unfrozen ? 1 : 0))), ...bot.cards.slice(-rows), ...bot.questions.slice(-rows)]) kept.add(id);
  }
  return kept;
}
interface Members {
  turns: Turn[]; roots: Set<string>; delegations: string[]; batches: string[]; units: string[]; replies: string[];
  cards: string[]; questions: string[]; inputs: string[]; batch?: string; rounds: string[]; seats: string[]; inbounds: string[]; deliveries: string[];
}
/** Every row of root `root`. A round's seat Turns have their own root, so they join the round's root. */
function members(state: CollaborationState, root: string): Members {
  const rounds = values(state.team.rounds).filter(round => round.root === root);
  const seats = rounds.flatMap(round => round.seats), roots = new Set([root, ...seats]);
  const turns = values(state.turns).filter(turn => roots.has(turn.root)), ids = new Set(turns.map(turn => turn.id));
  const delegations = values(state.delegations).filter(d => roots.has(d.root)).map(d => d.id), chained = new Set(delegations);
  const replies = Object.entries(state.replies).filter(([, reply]) => ids.has(reply.turnId)).map(([taskId]) => taskId);
  const batch = own(state.inputBatches, root);
  return {
    turns, roots, delegations, replies, rounds: rounds.map(round => round.id), seats,
    batches: values(state.batches).filter(row => row.delegationIds.some(id => chained.has(id))).map(row => row.id),
    units: values(state.units).filter(unit => roots.has(unit.root)).map(unit => unit.id),
    cards: values(state.cards).filter(card => ids.has(card.turnId)).map(card => card.id),
    questions: values(state.questions).filter(question => ids.has(question.turnId)).map(question => question.id),
    ...(batch ? { batch: batch.id } : {}), inputs: batch ? [...batch.inputIds] : [],
    // A filtered inbound has no root (#1229), so a root acknowledgement does not move it; it stays with its audit row.
    inbounds: values(state.channel?.inbounds).filter(row => row.root !== undefined && roots.has(row.root)).map(row => row.id),
    deliveries: values(state.channel?.deliveries).filter(row => ids.has(row.turnId)).map(row => row.id),
  };
}
/** The first reason that the root is still in use, or `undefined`. */
function protection(state: CollaborationState, m: Members, facts: RetentionFacts, window: Set<string>, now: number): string | undefined {
  for (const turn of m.turns) {
    if (!turn.conclusion) return 'A Turn of the root is not concluded';
    if (facts.hasIntent(turn.id) && !turn.reported) return 'A Turn of the root is not reported';
    if (turn.source === 'routine' && facts.occurrenceOpen(turn.id)) return 'A routine occurrence of the root is open';
  }
  for (const id of m.delegations) {
    const d = state.delegations[id]!;
    if (!d.verdict || d.lateTurnId || d.cancel && !d.cancel.delivered) return 'A delegation of the root is unresolved';
  }
  if (m.batches.some(id => !state.batches[id]!.released)) return 'A delegation batch of the root is not released';
  if (m.units.some(id => state.units[id]!.state === 'reserved')) return 'A budget unit of the root is reserved';
  for (const id of m.cards) {
    const card = state.cards[id]!;
    if (card.state === 'pending' || card.state === 'confirmed' && card.result === undefined && card.error === undefined || !card.decisionReported) {
      return 'A card of the root is not settled';
    }
  }
  if (m.questions.some(id => state.questions[id]!.answer === undefined)) return 'A question of the root is unanswered';
  const batch = m.batch === undefined ? undefined : state.inputBatches![m.batch]!;
  if (batch && (batch.state === 'open' || batch.revision !== 2)) return 'The input batch of the root is not settled';
  if (m.rounds.some(id => !state.team.rounds[id]!.closed)) return 'A round of the root is open';
  if (m.seats.some(id => !state.team.seats[id]?.released)) return 'A room seat of the root is not released';
  if (m.deliveries.some(id => OPEN_DELIVERY.has(state.channel!.deliveries[id]!.state))) return 'A delivery of the root is not settled';
  if (m.inbounds.some(id => { const reply = state.channel!.inbounds[id]!.reply; return !!reply?.token && reply.expiresAt > now; })) {
    return 'An inbound reply route of the root is live';
  }
  if (m.turns.some(turn => window.has(turn.id))) return 'The root is in the ContextPack window of its Bot';
  return undefined;
}
/** Moves rows of one map. */
function move<T>(store: RetentionStore, namespace: string, rows: Record<string, T> | undefined, ids: readonly string[]): number {
  if (!rows) return 0;
  for (const id of ids) { store.put(namespace, id, rows[id] as unknown as Json); delete rows[id]; }
  return ids.length;
}
/** Bytes of the state, for the result. */
const bytes = (state: CollaborationState) => Buffer.byteLength(JSON.stringify(state));

export function retainRoots(state: CollaborationState, input: RetentionInput, limits: RetentionLimits, facts: RetentionFacts,
  store: RetentionStore): RetentionResult {
  const now = time(input.now), retention = time(input.retentionMs);
  if (retention < MIN_TOMBSTONE_RETENTION_MS) throw new Error('Retention must be at least seven days');
  const expiresAt = time(now + retention);
  if (!Array.isArray(input.acknowledgedRoots)) throw new Error('Acknowledged roots must be an array');
  const roots = [...new Set(input.acknowledgedRoots)];
  if (roots.some(root => typeof root !== 'string' || !root)) throw new Error('Invalid acknowledged root');
  if (!Number.isSafeInteger(limits.contextTurnLimit) || limits.contextTurnLimit < 1) throw new Error('Invalid ContextPack limits');
  const result: RetentionResult = { archivedRoots: 0, alreadyArchivedRoots: 0, archivedRows: 0, archivedCommands: 0,
    expiredCommands: store.expire('commands', now), beforeBytes: bytes(state), afterBytes: 0 };
  // Decide every root on the state before this call, then move. A refusal throws before any move.
  const window = contextWindow(state, limits.contextTurnLimit), selected: Members[] = [];
  for (const root of roots) {
    const seat = own(state.team.seats, root);
    if (seat) {
      const roundRoot = state.team.rounds[seat.roundId]?.root ?? seat.roundId;
      throw new RetentionRefused('seat_root', root, `The Turn is a room seat of root ${roundRoot}`, roundRoot);
    }
    const m = members(state, root);
    if (!m.turns.length && !m.rounds.length && m.batch === undefined && !own(state.budgets, root)) {
      if (!store.isRetired('root', root)) throw new Error('Acknowledged root not found');
      result.alreadyArchivedRoots++; continue;
    }
    const reason = protection(state, m, facts, window, now);
    if (reason) throw new RetentionRefused('protected_root', root, reason);
    selected.push(m);
  }
  for (const m of selected) {
    const turnIds = m.turns.map(turn => turn.id), consumed = new Set(turnIds);
    result.archivedRows += move(store, 'turns', state.turns, turnIds) + move(store, 'schemas', state.schemas, turnIds.filter(id => own(state.schemas, id)))
      + move(store, 'budgets', state.budgets, [...m.roots].filter(id => own(state.budgets, id)))
      + move(store, 'delegations', state.delegations, m.delegations) + move(store, 'batches', state.batches, m.batches)
      + move(store, 'units', state.units, m.units) + move(store, 'replies', state.replies, m.replies)
      + move(store, 'cards', state.cards, m.cards) + move(store, 'questions', state.questions, m.questions)
      + move(store, 'inputs', state.inputs, m.inputs) + move(store, 'inputBatches', state.inputBatches, m.batch === undefined ? [] : [m.batch])
      + move(store, 'rounds', state.team.rounds, m.rounds) + move(store, 'seats', state.team.seats, m.seats)
      + move(store, 'roots', state.team.roots, [...m.roots].filter(id => own(state.team.roots, id)))
      + move(store, 'inbounds', state.channel?.inbounds, m.inbounds) + move(store, 'deliveries', state.channel?.deliveries, m.deliveries);
    // A rejection has no id. Its hash is its id; equal rows are equal evidence.
    const rejected = state.rejected.filter(row => row.consumedBy !== undefined && consumed.has(row.consumedBy));
    for (const row of rejected) store.put('rejected', hash(['rejected', row]), row as unknown as Json);
    state.rejected = state.rejected.filter(row => !rejected.includes(row));
    result.archivedRows += rejected.length;
    for (const id of turnIds) store.retire('turn', id);
    for (const id of m.inputs) store.retire('input', id);
    for (const id of m.rounds) store.retire('round', id);
    for (const root of m.roots) store.retire('root', root);
    result.archivedRoots++;
  }
  result.archivedRows += retainRootless(state, store);
  // A record moves when its root has moved, or when it has no root. It then answers replays until it expires.
  for (const [id, record] of Object.entries(state.commands ?? {})) {
    if (record.root !== undefined && !store.isRetired('root', record.root)) continue;
    store.put('commands', id, record as unknown as Json, expiresAt);
    delete state.commands![id];
    result.archivedCommands++;
  }
  result.afterBytes = bytes(state);
  return result;
}
/** Rows outside any root: audit lines, revoked push routes and settled persona deliveries. They stay as history. */
function retainRootless(state: CollaborationState, store: RetentionStore): number {
  let count = 0;
  if (state.audit.length) {
    store.put('audit', hash(['audit', state.revision ?? 0, state.audit]), state.audit);
    count += state.audit.length; state.audit = [];
  }
  const routes = state.channel?.pushRoutes ?? {}, used = new Set(values(state.channel?.deliveries).map(row => row.route.kind === 'push' ? row.route.pushRouteId : ''));
  count += move(store, 'pushRoutes', routes, Object.keys(routes).filter(id => routes[id]!.revokedAt !== undefined && !used.has(id)));
  // Keep pending work, the newest applied delivery of each Bot (it proves that a persona was applied) and failures of the current revision.
  const newest = new Map<string, number>();
  for (const op of state.team.homeOperations) if (op.status === 'applied') newest.set(op.botId, Math.max(newest.get(op.botId) ?? 0, op.sequence));
  const settled = state.team.homeOperations.filter(op => op.status === 'applied' ? newest.get(op.botId) !== op.sequence
    : op.status === 'failed' && op.request.payload.agentRef.profileRevision !== state.team.bots[op.botId]?.revision);
  for (const op of settled) store.put('homeOperations', String(op.sequence), op as unknown as Json);
  state.team.homeOperations = state.team.homeOperations.filter(op => !settled.includes(op));
  return count + settled.length;
}
