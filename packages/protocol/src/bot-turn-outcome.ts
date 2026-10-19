import {
  RESULT_OUTCOME_MAX_BYTES, RESULT_SCHEMA_MAX_BYTES, checkResultSchema, type ResultSchema,
  resultOutcomeMaxBytes,
} from './result-schema';

export const BOT_TURN_OUTCOME_CONTRACT = 'bot-turn-outcome.v1';

/** Code-point and item caps for Bot turn outcomes. */
export const BOT_TURN_OUTCOME_LIMITS = Object.freeze({
  delegateMaxItems: 2,
  delegateRequestMaxLength: 1_000,
  cancelDelegationMaxItems: 2,
  askUserQuestionMaxLength: 400,
  askUserOptionsMaxItems: 6,
  askUserOptionIdMaxLength: 24,
  askUserOptionLabelMaxLength: 80,
  confirmableActionMaxItems: 1,
  confirmableSummaryMaxLength: 300,
  confirmableDraftMaxBytes: 16_384,
  createRoutineMaxItems: 1,
  updateRoutineMaxItems: 1,
  cancelRoutineMaxItems: 2,
  routinePromptMaxLength: 500,
  postTextMaxLength: 2_730,
  roomCallMembersMaxItems: 4,
  createBotMaxItems: 3,
  updateBotMaxItems: 1,
  deleteBotMaxItems: 1,
  botNameMaxLength: 40,
  botRoleMaxLength: 80,
  botPersonaMaxLength: 300,
  createRoomMaxItems: 1,
  updateRoomMaxItems: 1,
  roomNameMaxLength: 40,
  roomMembersMaxItems: 12,
  roomAnnouncementMaxLength: 300,
  teamNoteMaxLength: 300,
});
const L = BOT_TURN_OUTCOME_LIMITS;

export type NonEmptyIds = readonly [string, ...string[]];
const text = (maxLength: number): ResultSchema =>
  ({ type: 'string', minLength: 1, maxLength });
const oneOfIds = (ids: NonEmptyIds): ResultSchema => ({ enum: [...ids] });
const closed = (properties: Record<string, ResultSchema>, required: string[]): ResultSchema =>
  ({ type: 'object', additionalProperties: false, required, properties });
const list = (items: ResultSchema, maxItems: number): ResultSchema =>
  ({ type: 'array', minItems: 1, maxItems, items });

/** ISO 8601 order, Monday first. Equal to core's list. A server test checks parity. */
export const ROUTINE_DAYS_OF_WEEK = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const);
export type RoutineDayOfWeek = (typeof ROUTINE_DAYS_OF_WEEK)[number];
const integer = (minimum: number, maximum: number): ResultSchema => ({ type: 'integer', minimum, maximum });

export type BotTurnOutcomeSchemaErrorCode = 'not-subset' | 'schema-over-budget' | 'over-budget' | 'draft-over-budget';

export class BotTurnOutcomeSchemaError extends Error {
  constructor(readonly code: BotTurnOutcomeSchemaErrorCode, message: string) {
    super(message); this.name = 'BotTurnOutcomeSchemaError';
  }
}

/**
 * `checked` (default): field types, ranges and enums sit once in the outer
 * properties; each oneOf branch lists only its allowed names and required
 * fields, with additionalProperties false. An instance matches exactly one
 * branch: daysOfWeek and dayOfMonth never appear together; month needs
 * dayOfMonth. `flat`: the same outer object without the oneOf; the Host then
 * refuses those two combinations at apply time. Use `flat` only under the
 * schema budget rule of composeBotTurnOutcomeSchema. Neither form sees
 * duplicate days, a day the month never has (Apr 31), or Feb 29.
 */
export type RoutineScheduleShape = 'checked' | 'flat';
function schedule(timeZones: NonEmptyIds, shape: RoutineScheduleShape): ResultSchema {
  const fields = {
    minute: integer(0, 59), hour: integer(0, 23),
    daysOfWeek: { type: 'array', minItems: 1, maxItems: 7, items: { enum: [...ROUTINE_DAYS_OF_WEEK] } } as ResultSchema,
    dayOfMonth: integer(1, 31), month: integer(1, 12), tz: oneOfIds(timeZones),
  };
  const outer: ResultSchema = {
    description: 'Local time in tz. No day field: every day. daysOfWeek: those days only. dayOfMonth: that day of each month, or of month only.',
    ...closed(fields, ['minute', 'hour', 'tz']),
  };
  if (shape === 'flat') return outer;
  // The outer object already requires minute, hour and tz; a branch adds only its own day field.
  const only = (names: string[], required: string[]): ResultSchema =>
    ({ additionalProperties: false, ...(required.length ? { required } : {}), properties: Object.fromEntries(names.map(n => [n, {}])) });
  return { ...outer, oneOf: [
    only(['minute', 'hour', 'tz'], []),
    only(['minute', 'hour', 'daysOfWeek', 'tz'], ['daysOfWeek']),
    only(['minute', 'hour', 'dayOfMonth', 'month', 'tz'], ['dayOfMonth']),
  ] };
}
function roomFields(members: NonEmptyIds): Record<string, ResultSchema> {
  return {
    name: text(L.roomNameMaxLength),
    members: { type: 'array', minItems: 1, maxItems: L.roomMembersMaxItems, items: oneOfIds(members) },
    admin: oneOfIds(members), mode: { enum: ['mention', 'admin'] }, announcement: text(L.roomAnnouncementMaxLength),
  };
}

/**
 * Every id is a Host-filled enum. New objects use Host-offered localId slots
 * (e.g. "new_bot_1"), so a same-outcome reference is also an enum member.
 */
export const botTurnOutcomeFragments = {
  /** `to` lists this Bot first: delegating to yourself is a continuation. */
  delegate(o: { to: NonEmptyIds }): ResultSchema {
    return list(closed({ to: oneOfIds(o.to), request: text(L.delegateRequestMaxLength) }, ['to', 'request']), L.delegateMaxItems);
  },
  /** Owner-authorized Main Bot turns only. The Host lists open delegations. */
  cancelDelegation(o: { delegationIds: NonEmptyIds }): ResultSchema {
    return list(closed({ delegationId: oneOfIds(o.delegationIds) }, ['delegationId']), L.cancelDelegationMaxItems);
  },
  askUser(): ResultSchema {
    const question = text(L.askUserQuestionMaxLength);
    const option = closed({ id: text(L.askUserOptionIdMaxLength), label: text(L.askUserOptionLabelMaxLength) }, ['id', 'label']);
    return { oneOf: [
      closed({ question, answerKind: { const: 'text' } }, ['question', 'answerKind']),
      closed({ question, answerKind: { const: 'single_choice' },
        options: { type: 'array', minItems: 2, maxItems: L.askUserOptionsMaxItems, items: option } }, ['question', 'answerKind', 'options']),
    ] };
  },
  /** One branch per Host action; each draft needs a finite bound of at most confirmableDraftMaxBytes. */
  confirmableAction(o: { actions: readonly [{ action: string; draft: ResultSchema }, ...{ action: string; draft: ResultSchema }[]] }): ResultSchema {
    for (const { action, draft } of o.actions) {
      const bound = resultOutcomeMaxBytes(draft);
      if (bound === null || bound > L.confirmableDraftMaxBytes) {
        throw new BotTurnOutcomeSchemaError('draft-over-budget', `draft for ${action} is ${bound ?? 'unbounded'}; cap ${L.confirmableDraftMaxBytes}`);
      }
    }
    const branches = o.actions.map(({ action, draft }) =>
      closed({ action: { const: action }, summary: text(L.confirmableSummaryMaxLength), draft }, ['action', 'summary', 'draft']));
    return list(branches.length === 1 ? branches[0]! : { oneOf: branches }, L.confirmableActionMaxItems);
  },
  /** `targets` only for a Main Bot: the Bot itself first, then team Bots. Omitted means the Bot itself. */
  createRoutine(o: { localIds: NonEmptyIds; timeZones: NonEmptyIds; targets?: NonEmptyIds; scheduleShape?: RoutineScheduleShape }): ResultSchema {
    return list(closed({
      localId: oneOfIds(o.localIds), schedule: schedule(o.timeZones, o.scheduleShape ?? 'checked'), prompt: text(L.routinePromptMaxLength),
      ...(o.targets ? { target: oneOfIds(o.targets) } : {}),
    }, ['localId', 'schedule', 'prompt']), L.createRoutineMaxItems);
  },
  updateRoutine(o: { routineIds: NonEmptyIds; timeZones: NonEmptyIds; scheduleShape?: RoutineScheduleShape }): ResultSchema {
    return list(closed({ routineId: oneOfIds(o.routineIds), schedule: schedule(o.timeZones, o.scheduleShape ?? 'checked'), prompt: text(L.routinePromptMaxLength) },
      ['routineId']), L.updateRoutineMaxItems);
  },
  cancelRoutine(o: { routineIds: NonEmptyIds }): ResultSchema {
    return list(closed({ routineId: oneOfIds(o.routineIds) }, ['routineId']), L.cancelRoutineMaxItems);
  },
  /** Room turns only. Exactly one of post or pass. */
  speech(): ResultSchema {
    return { oneOf: [
      closed({ kind: { const: 'post' }, text: text(L.postTextMaxLength) }, ['kind', 'text']),
      closed({ kind: { const: 'pass' } }, ['kind']),
    ] };
  },
  roomCall(o: { members: NonEmptyIds }): ResultSchema {
    return closed({ members: { type: 'array', minItems: 1, maxItems: L.roomCallMembersMaxItems, items: oneOfIds(o.members) } }, ['members']);
  },
  createBot(o: { localIds: NonEmptyIds; models: NonEmptyIds }): ResultSchema {
    return list(closed({
      localId: oneOfIds(o.localIds), name: text(L.botNameMaxLength), role: text(L.botRoleMaxLength),
      persona: text(L.botPersonaMaxLength), model: oneOfIds(o.models),
    }, ['localId', 'name', 'role', 'persona', 'model']), L.createBotMaxItems);
  },
  updateBot(o: { botIds: NonEmptyIds; models: NonEmptyIds }): ResultSchema {
    return list(closed({
      botId: oneOfIds(o.botIds), name: text(L.botNameMaxLength), role: text(L.botRoleMaxLength),
      persona: text(L.botPersonaMaxLength), model: oneOfIds(o.models),
    }, ['botId']), L.updateBotMaxItems);
  },
  deleteBot(o: { botIds: NonEmptyIds }): ResultSchema {
    return list(closed({ botId: oneOfIds(o.botIds) }, ['botId']), L.deleteBotMaxItems);
  },
  /** `members`: team Bot ids plus the create_bot localId slots of this outcome. */
  createRoom(o: { localIds: NonEmptyIds; members: NonEmptyIds }): ResultSchema {
    return list(closed({ localId: oneOfIds(o.localIds), ...roomFields(o.members) }, ['localId', 'name', 'members']), L.createRoomMaxItems);
  },
  updateRoom(o: { roomIds: NonEmptyIds; members: NonEmptyIds }): ResultSchema {
    return list(closed({ roomId: oneOfIds(o.roomIds), ...roomFields(o.members) }, ['roomId']), L.updateRoomMaxItems);
  },
  teamNote(): ResultSchema {
    return closed({ text: text(L.teamNoteMaxLength) }, ['text']);
  },
};

export type BotTurnOutcomeKind =
  | 'delegate' | 'cancel_delegation' | 'ask_user' | 'confirmable_action' | 'create_routine' | 'update_routine' | 'cancel_routine'
  | 'speech' | 'room_call' | 'create_bot' | 'update_bot' | 'delete_bot' | 'create_room' | 'update_room' | 'team_note';

/**
 * Host composition: pick fragments, freeze the result in the offer. Refuses a
 * schema outside the K7 subset ('not-subset'), a schema above
 * RESULT_SCHEMA_MAX_BYTES ('schema-over-budget'), or one whose largest
 * instance could exceed RESULT_OUTCOME_MAX_BYTES ('over-budget').
 *
 * Schema budget rule, before the offer is frozen: only 'schema-over-budget'
 * allows the Host to rebuild the routine fragments with scheduleShape 'flat'.
 * If the schema is still over, the Host blocks the turn with a visible reason
 * or runs its defined batch selection. It never drops authorized ids from an
 * enum silently.
 */
export function composeBotTurnOutcomeSchema(
  fragments: BotTurnOutcomeFragments,
  required: readonly BotTurnOutcomeKind[] = [],
): ResultSchema {
  const schema: ResultSchema = {
    type: 'object', additionalProperties: false,
    description: `${BOT_TURN_OUTCOME_CONTRACT}: actions for the Host. Omit a field for no action of that kind; {} means no actions.`,
    ...(required.length ? { required: [...required] } : {}),
    properties: fragments,
  };
  const admitted = checkResultSchema(schema);
  if (!admitted.ok && admitted.reason === 'over-cap') {
    throw new BotTurnOutcomeSchemaError('schema-over-budget', `schema is ${admitted.bytes} bytes; cap ${RESULT_SCHEMA_MAX_BYTES}`);
  }
  if (!admitted.ok) throw new BotTurnOutcomeSchemaError('not-subset', JSON.stringify(admitted.issues));
  const bound = resultOutcomeMaxBytes(admitted.canonical);
  if (bound === null || bound > RESULT_OUTCOME_MAX_BYTES) {
    throw new BotTurnOutcomeSchemaError('over-budget', `largest outcome is ${bound ?? 'unbounded'} bytes; cap ${RESULT_OUTCOME_MAX_BYTES}`);
  }
  return admitted.canonical;
}

export type BotTurnOutcomeFragments = Partial<Readonly<Record<BotTurnOutcomeKind, ResultSchema>>>;

export interface DelegateAction { readonly to: string; readonly request: string }
export interface CancelDelegationAction { readonly delegationId: string }
export type AskUserAction =
  | { readonly question: string; readonly answerKind: 'text' }
  | { readonly question: string; readonly answerKind: 'single_choice';
      readonly options: readonly { readonly id: string; readonly label: string }[] };
export interface ConfirmableAction<Draft = unknown> { readonly action: string; readonly summary: string; readonly draft: Draft }
/**
 * No day field: every day. daysOfWeek and dayOfMonth never appear together;
 * month needs dayOfMonth. Under the 'flat' shape the schema does not enforce
 * this; the Host narrows to this type only after checkRoutineSchedule passes.
 */
export type RoutineScheduleFields =
  | { readonly minute: number; readonly hour: number; readonly tz: string }
  | { readonly minute: number; readonly hour: number; readonly daysOfWeek: readonly RoutineDayOfWeek[]; readonly tz: string }
  | { readonly minute: number; readonly hour: number; readonly dayOfMonth: number; readonly month?: number; readonly tz: string };
export interface CreateRoutineAction { readonly localId: string; readonly schedule: RoutineScheduleFields; readonly prompt: string; readonly target?: string }
export interface UpdateRoutineAction { readonly routineId: string; readonly schedule?: RoutineScheduleFields; readonly prompt?: string }
export interface CancelRoutineAction { readonly routineId: string }
export type RoomSpeech = { readonly kind: 'post'; readonly text: string } | { readonly kind: 'pass' };
export interface RoomCallAction { readonly members: readonly string[] }
export interface CreateBotAction { readonly localId: string; readonly name: string; readonly role: string; readonly persona: string; readonly model: string }
export interface UpdateBotAction { readonly botId: string; readonly name?: string; readonly role?: string; readonly persona?: string; readonly model?: string }
export interface DeleteBotAction { readonly botId: string }
export interface RoomFields {
  readonly name: string; readonly members: readonly string[]; readonly admin?: string;
  readonly mode?: 'mention' | 'admin'; readonly announcement?: string;
}
export interface CreateRoomAction extends RoomFields { readonly localId: string }
export interface UpdateRoomAction extends Partial<RoomFields> { readonly roomId: string }
export interface TeamNoteAction { readonly text: string }

/** Shape of a document that passed a schema composed from these fragments. */
export interface BotTurnOutcome {
  readonly delegate?: readonly DelegateAction[];
  readonly cancel_delegation?: readonly CancelDelegationAction[];
  readonly ask_user?: AskUserAction;
  readonly confirmable_action?: readonly ConfirmableAction[];
  readonly create_routine?: readonly CreateRoutineAction[];
  readonly update_routine?: readonly UpdateRoutineAction[];
  readonly cancel_routine?: readonly CancelRoutineAction[];
  readonly speech?: RoomSpeech;
  readonly room_call?: RoomCallAction;
  readonly create_bot?: readonly CreateBotAction[];
  readonly update_bot?: readonly UpdateBotAction[];
  readonly delete_bot?: readonly DeleteBotAction[];
  readonly create_room?: readonly CreateRoomAction[];
  readonly update_room?: readonly UpdateRoomAction[];
  readonly team_note?: TeamNoteAction;
}
