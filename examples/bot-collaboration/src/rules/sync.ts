import { BOT_TURN_OUTCOME_CONTRACT, BotTurnOutcomeSchemaError, type ResultSchema } from '@byok-sdk/protocol';
import { json, type Turn } from './turn';
import { BOT_REPLY_MAX_BYTES, type IntentFacts, type Publish } from './delegation';
import { CurrentRequestTooLargeError } from './history';
import { outcomeSchema, promptActions, type ContextBot, type ContextRoutine, type ContextState, type CheckedOffer } from './schema';
import { botTurnInstruction, type BotHistoryState, type ContextTurn, type InstructionLimits } from './context';
import { admitBotToolsets } from './team';
import type { RoomMessage, Seat } from './rooms';

/**
 * The per-Turn step of a Host sync as a pure rule (#793 D2b Q2). L and H run the same step, so a frozen offer is the same in both.
 * The rule changes the state and publishes projections. The store writes what the returned step asks for in the same transaction.
 */

/** A new offer waits this long for a device. */
export const OFFER_WAIT_MS = 300_000;
/**
 * The execution fields that a freeze reads. `E` is the Host's execution template type, so the rule keeps every other field.
 * Rules do not import K4 types.
 */
export interface FreezeExecution {
  readonly agentMessageContext?: { readonly freshnessCursor?: string };
  readonly payload: { readonly requiredToolsets?: readonly string[]; readonly messageEgress?: { readonly maxBytes: number } };
}
export interface SyncBot<E extends FreezeExecution> extends ContextBot { readonly revision: string; readonly execution: E }
/** The rows that the sync step reads and changes. */
export interface SyncState<E extends FreezeExecution> extends ContextState, BotHistoryState {
  readonly turns: Readonly<Record<string, Turn>>;
  team: Omit<ContextState['team'], 'bots' | 'homeOperations'> & {
    bots: Readonly<Record<string, SyncBot<E>>>; seats: Record<string, Seat>;
    homeOperations: ReadonlyArray<{ readonly sequence: number; readonly botId: string; readonly status: string; readonly error?: string;
      readonly request: { readonly payload: { readonly agentRef: { readonly profileRevision: string } } } }>;
  };
  schemas: Record<string, ResultSchema>; audit: string[];
}
/** Store facts by Turn id. */
/**
 * The code of a Turn that the sync holds because its Bot's device has no active binding (#956, §55a). It is the code of H's
 * `DeviceBindingError`, so a reader matches one string.
 */
export const DEVICE_NOT_BOUND = 'device_not_bound';
/** The code of a Turn that the sync holds because its Bot's device is frozen for an owner switch (#957, §4.1). */
export const DEVICE_SWITCHING = 'device_switching';
/** Why a Host refuses a Bot's device: never bound, revoked, bound to another mode, or frozen for an owner switch. */
export type DeviceRefusal = 'unbound' | 'revoked' | 'mode' | 'switching';
/** The hold code of each refusal, and the projection id prefix of each hold code. */
const HOLD_CODE = { unbound: DEVICE_NOT_BOUND, revoked: DEVICE_NOT_BOUND, mode: DEVICE_NOT_BOUND, switching: DEVICE_SWITCHING } as const;
const HOLD_PROJECTION = { [DEVICE_NOT_BOUND]: 'held', [DEVICE_SWITCHING]: 'held-switching' } as const;
export interface SyncFacts extends Pick<IntentFacts, 'intent'> {
  /**
   * The current execution of the Turn's intent started. This is not `IntentFacts.started`, which counts every generation.
   * The store writes the execution row with the intent, so an intent always has one.
   */
  executionStarted(turnId: string): boolean;
  /**
   * The Turn's identity can never run again. `result_retired`: the store compacted the intent before this sync saw its result,
   * or the occurrence of a routine Turn. `turn_retired`: retention retired the Turn id.
   */
  retired(turnId: string): 'result_retired' | 'turn_retired' | undefined;
  /**
   * The Host's binding check of the device of the Bot's current execution template, which a freeze would use (#956).
   * A refusal holds that Bot's Turns that have no intent, and the rest of the scope syncs. Absent: no check.
   */
  deviceRefusal?(botId: string): DeviceRefusal | undefined;
}
export interface SyncOptions<R extends ContextRoutine> {
  now: number;
  /** The model names of the Host's execution templates. */
  models: readonly string[];
  readOnlyToolsets: readonly string[];
  limits: InstructionLimits;
  /** History mode: a Bot Turn freezes only with its history from the external authority, read before this transaction. */
  historyMode: boolean;
  /** The history row of this Turn, in history mode. */
  history?: { readonly rows: readonly ContextTurn[]; readonly digest: string };
  /** Room history mode (#883): a seat Turn freezes only with its room messages from the external authority, read before this transaction. */
  roomHistoryMode?: boolean;
  /** The room messages of this seat Turn, in room history mode. */
  roomHistory?: { readonly rows: readonly RoomMessage[]; readonly digest: string };
  routines: readonly R[];
  /** The Host's outcome offer (#881), checked by `outcomeOffer`. Absent: every action, the default time zones and `send_message`. */
  offer?: CheckedOffer;
}
/**
 * What the store writes for one Turn:
 * - `freeze`: store this intent input.
 * - `routine`: a routine Turn joins the FIFO as its occurrence intent, with this execution. Its wait counts from the occurrence record.
 * - `cancel`: the Bot is archived, so cancel the intent, which has not started.
 * - `ended`: the Turn has no intent and is concluded. A routine Turn concludes its open occurrence.
 */
export type SyncStep<E> =
  | { kind: 'freeze'; input: { key: string; source: 'user' | 'bot'; waitUntil: number; execution: E } }
  | { kind: 'routine'; execution: E }
  | { kind: 'cancel' }
  | { kind: 'ended' };

/** Blocks a Turn that cannot freeze. A blocked seat is released. */
function blockTurn(state: Pick<SyncState<FreezeExecution>, 'team'>, turn: Turn, reason: string, publish: Publish): void {
  if (turn.blockedReason !== reason) publish(`blocked:${turn.id}`, { owner: turn.botId, turnId: turn.id, reason });
  const seat = state.team.seats[turn.id];
  if (seat) { seat.status = 'blocked'; seat.released = true; seat.reason = reason; }
  turn.status = 'blocked'; turn.blockedReason = reason;
}

/** Syncs one Turn with its intent: freezes the offer of a Turn without an intent, or settles the Turn of a concluded intent. */
export function syncTurn<E extends FreezeExecution, R extends ContextRoutine>(state: SyncState<E>, turn: Turn, facts: SyncFacts,
  options: SyncOptions<R>, publish: Publish): SyncStep<E> | undefined {
  const intent = facts.intent(turn.id), bot = state.team.bots[turn.botId];
  if (intent) {
    if (!intent.conclusion) return bot?.archived && !facts.executionStarted(turn.id) ? { kind: 'cancel' } : undefined;
    // Work that never started did not consume its rejected actions.
    if (intent.conclusion !== 'succeeded' && !facts.executionStarted(turn.id)) {
      for (const rejection of state.rejected) if (rejection.consumedBy === turn.id) delete rejection.consumedBy;
    }
    turn.status = intent.conclusion === 'succeeded' ? 'succeeded' : 'failed';
    turn.conclusion = intent.conclusion;
    if (!turn.reported) {
      publish(`bot-turn:${turn.id}`, json({ owner: turn.botId, ...turn }));
      turn.reported = true;
    }
    return undefined;
  }
  // #816: the store compacted the intent before this sync saw its result. #798: retention retired this Turn id.
  // Either identity can never run again. The rule does not know the intent's conclusion, so the Turn fails, and every reader of
  // `turn.conclusion` can settle. This runs before the archive check: the work may have run, so the Turn is not `cancelled`.
  const retired = turn.conclusion ? undefined : facts.retired(turn.id);
  if (retired) {
    turn.status = 'failed'; turn.conclusion = 'failed';
    // The seat facts no longer see the intent, so release the seat here, as for a failed conclusion. Its round moves on.
    const seat = state.team.seats[turn.id];
    if (seat && !seat.released) { seat.status = 'failed'; seat.released = true; seat.reason = retired; }
    state.audit.push(`Turn ${retired === 'result_retired' ? 'result retired before sync' : 'identity retired'}: ${turn.id}`);
    publish(`bot-turn:${turn.id}`, json({ owner: turn.botId, ...turn, reason: retired }));
    turn.reported = true;
    return undefined;
  }
  // An archived Bot never starts this Turn. A concluded Turn keeps its conclusion.
  if (!turn.conclusion && bot?.archived) { turn.status = 'failed'; turn.conclusion = 'cancelled'; }
  if (turn.conclusion) return { kind: 'ended' };
  if (turn.source === 'room_slot' && state.team.seats[turn.id]?.status === 'blocked') return undefined;
  // #956: a Turn whose Bot's device is refused waits, before the profile check, since a refused device may never apply a
  // profile. Each hold code has its own projection id with a fixed body, so a projection id never changes value (#957: a
  // switch hold is `held-switching:<turnId>`). It is published when the code changes. The reason is audited.
  const refusal = bot && facts.deviceRefusal?.(turn.botId);
  if (refusal) {
    const code = HOLD_CODE[refusal];
    if (turn.held !== code) {
      turn.held = code;
      state.audit.push(`Turn held ${code} ${refusal}: ${turn.id}`);
      publish(`${HOLD_PROJECTION[code]}:${turn.id}`, { owner: turn.botId, turnId: turn.id, code });
    }
    return undefined;
  }
  delete turn.held;
  if (!bot || bot.readyRevision !== bot.revision) {
    const failed = state.team.homeOperations.find(op => op.botId === turn.botId
      && op.request.payload.agentRef.profileRevision === bot?.revision && op.status === 'failed');
    if (failed) {
      turn.profileFailure = { sequence: failed.sequence, revision: failed.request.payload.agentRef.profileRevision,
        reason: failed.error ?? 'Persona delivery failed' };
      publish(`persona-turn-failed:${turn.id}:${failed.sequence}`, json({ owner: turn.botId, turnId: turn.id,
        status: 'blocked', recoverable: true, ...turn.profileFailure }));
    }
    return undefined;
  }
  delete turn.profileFailure;
  // Phase 2 of a history-mode sync: a Bot Turn freezes only with the history read before this transaction.
  const history = options.historyMode && turn.source !== 'room_slot' ? options.history : undefined;
  if (options.historyMode && turn.source !== 'room_slot' && !history) return undefined;
  const room = options.roomHistoryMode && turn.source === 'room_slot' ? options.roomHistory : undefined;
  if (options.roomHistoryMode && turn.source === 'room_slot' && !room) return undefined;
  let schema: ResultSchema, frozen: ReturnType<typeof botTurnInstruction>;
  try {
    schema = outcomeSchema(turn.botId, state, turn, options.models, options.routines, options.offer);
    frozen = botTurnInstruction(state, turn, options.limits, options.routines, history?.rows, room?.rows, promptActions(schema, options.offer));
  } catch (error) {
    if (error instanceof BotTurnOutcomeSchemaError && error.code === 'schema-over-budget') {
      blockTurn(state, turn, `Outcome schema over budget after flat fallback: ${error.message}`, publish);
    } else if (error instanceof CurrentRequestTooLargeError) blockTurn(state, turn, error.message, publish);
    else throw error;
    return undefined;
  }
  state.schemas[turn.id] = schema;
  const base = bot.execution;
  admitBotToolsets(base, options.readOnlyToolsets);
  const { messageEgress: egress, ...roomPayload } = base.payload;
  // A delegated reply is capped at BOT_REPLY_MAX_BYTES, and its cursor is B's Turn.
  const chain = turn.delegationId && egress ? {
    agentMessageContext: { ...base.agentMessageContext!, freshnessCursor: turn.id },
    payload: { ...base.payload, messageEgress: { ...egress, maxBytes: Math.min(egress.maxBytes, BOT_REPLY_MAX_BYTES) } },
  } : undefined;
  const execution = turn.source === 'room_slot' ? { ...base, agentMessageContext: undefined, payload: roomPayload } : { ...base, ...chain };
  // The offer keeps every template field, and sets the frozen instruction and result contract.
  const offer = { ...execution, payload: { ...execution.payload, instruction: frozen.instruction,
    terminalProjection: { mode: 'result-document' as const, contract: BOT_TURN_OUTCOME_CONTRACT, schema } } } as unknown as E;
  for (const rejection of frozen.context.rejectedActions) rejection.consumedBy = turn.id;
  const read = history ?? room;
  if (read) turn.historyDigest = read.digest;
  delete turn.blockedReason;
  turn.status = 'processing';
  if (turn.source === 'routine') return { kind: 'routine', execution: offer };
  return { kind: 'freeze', input: { key: turn.id, source: turn.source === 'user' || turn.source === 'answer' ? 'user' : 'bot',
    waitUntil: options.now + OFFER_WAIT_MS, execution: offer } };
}
