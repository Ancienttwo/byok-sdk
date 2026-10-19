import { describe, expect, it } from 'vitest';
import { checkResultSchema, resultOutcomeMaxBytes, validateResultOutcome, type ResultSchema } from '../result-schema';
import { TerminalProjectionSelectionSchema } from '../terminal-projection';
import {
  botTurnOutcomeFragments as F, composeBotTurnOutcomeSchema, BotTurnOutcomeSchemaError, BOT_TURN_OUTCOME_LIMITS,
  type NonEmptyIds, type RoutineScheduleShape,
} from '../bot-turn-outcome';
import type { BotTurnOutcome, BotTurnOutcomeKind, CancelDelegationAction } from '../index';
import { worstCaseInstance } from './bot-outcome-fixtures';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
// Host context. Ids are 64 ASCII characters, the idMaxLength worst case.
const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(64 - prefix.length - 1, '0')}`;
const self = id('agt', 0);
const team = Array.from({ length: 11 }, (_, i) => id('agt', i + 1));
const routines = Array.from({ length: 8 }, (_, i) => id('rtn', i)) as unknown as NonEmptyIds;
const rooms = Array.from({ length: 4 }, (_, i) => id('room', i)) as unknown as NonEmptyIds;
const models = ['pi/xai/grok-4', 'pi/deepseek/deepseek-chat', 'pi/openai/gpt-5', 'pi/anthropic/claude-sonnet-5-5', 'pi/zai/glm-5'] as const;
const timeZones = ['Asia/Shanghai', 'UTC'] as const;
const roster = [self, ...team] as unknown as NonEmptyIds;

// Host-defined drafts. Each must stay inside confirmableDraftMaxBytes.
const addr = { type: 'string', minLength: 3, maxLength: 254 } as const;
const sendEmailDraft: ResultSchema = {
  type: 'object', additionalProperties: false, required: ['to', 'subject', 'body'],
  properties: {
    to: { type: 'array', minItems: 1, maxItems: 3, items: addr },
    subject: { type: 'string', minLength: 1, maxLength: 120 },
    body: { type: 'string', minLength: 1, maxLength: 1_800 },
  },
};
const sendMessageDraft: ResultSchema = {
  type: 'object', additionalProperties: false, required: ['channel', 'text'],
  properties: { channel: { enum: ['telegram', 'slack', 'sms'] }, text: { type: 'string', minLength: 1, maxLength: 2_700 } },
};
const confirmables = [
  { action: 'send_email', draft: sendEmailDraft },
  { action: 'send_message', draft: sendMessageDraft },
] as const;

const team1 = team as unknown as NonEmptyIds;
const botSlots = ['new_bot_1', 'new_bot_2', 'new_bot_3'] as const;
const routineSlots = ['new_routine_1'] as const;
const roomSlots = ['new_room_1'] as const;
const conversation = () => composeBotTurnOutcomeSchema({
  delegate: F.delegate({ to: roster }), ask_user: F.askUser(), confirmable_action: F.confirmableAction({ actions: confirmables }),
  create_routine: F.createRoutine({ localIds: routineSlots, timeZones }),
  update_routine: F.updateRoutine({ routineIds: routines, timeZones }), cancel_routine: F.cancelRoutine({ routineIds: routines }),
});
const mainBot = (zones: NonEmptyIds = timeZones, routineIds: NonEmptyIds = routines, scheduleShape: RoutineScheduleShape = 'checked') =>
  composeBotTurnOutcomeSchema(mainBotFragments(zones, routineIds, scheduleShape));
function mainBotFragments(zones: NonEmptyIds, routineIds: NonEmptyIds, scheduleShape: RoutineScheduleShape = 'checked') {
  const withSlots = [...roster, ...botSlots] as unknown as NonEmptyIds;
  return {
    delegate: F.delegate({ to: withSlots }), ask_user: F.askUser(), confirmable_action: F.confirmableAction({ actions: confirmables }),
    create_routine: F.createRoutine({ localIds: routineSlots, timeZones: zones, targets: roster, scheduleShape }),
    update_routine: F.updateRoutine({ routineIds, timeZones: zones, scheduleShape }), cancel_routine: F.cancelRoutine({ routineIds }),
    create_bot: F.createBot({ localIds: botSlots, models }), update_bot: F.updateBot({ botIds: team1, models }),
    delete_bot: F.deleteBot({ botIds: team1 }), create_room: F.createRoom({ localIds: roomSlots, members: withSlots }),
    update_room: F.updateRoom({ roomIds: rooms, members: withSlots }), team_note: F.teamNote(),
  };
}
const room = () => composeBotTurnOutcomeSchema({ speech: F.speech(), room_call: F.roomCall({ members: roster }) }, ['speech']);


describe('Bot turn outcome fragments', () => {
  it('admits at most two cancel requests for Host-listed delegations', () => {
    const delegationIds = [id('delegation', 0), id('delegation', 1)] as const;
    const kind: BotTurnOutcomeKind = 'cancel_delegation';
    const first: CancelDelegationAction = { delegationId: delegationIds[0] };
    const second: CancelDelegationAction = { delegationId: delegationIds[1] };
    const schema = composeBotTurnOutcomeSchema({ [kind]: F.cancelDelegation({ delegationIds }) });
    expect(BOT_TURN_OUTCOME_LIMITS.cancelDelegationMaxItems).toBe(2);
    expect(checkResultSchema(schema).ok).toBe(true);
    expect(TerminalProjectionSelectionSchema.safeParse({ mode: 'result-document', contract: 'bot-turn-outcome.v1', schema }).success).toBe(true);
    for (const cancel_delegation of [[first], [first, second]]) {
      const outcome: BotTurnOutcome = { cancel_delegation };
      expect(validateResultOutcome(schema, outcome).ok).toBe(true);
      expect(validateResultOutcome(conversation(), outcome).ok).toBe(false);
      expect(validateResultOutcome(room(), { speech: { kind: 'pass' }, ...outcome }).ok).toBe(false);
    }
    expect(validateResultOutcome(schema, {}).ok).toBe(true);
    for (const cancel_delegation of [
      [], [first, second, first], [{ delegationId: 'unknown' }], [{}],
      [{ delegationId: delegationIds[0], reason: 'stop' }], [{ delegationId: 1 }],
    ]) expect(validateResultOutcome(schema, { cancel_delegation }).ok).toBe(false);
  });

  it('bounds a Main Bot outcome with 24 open delegations and a full cancel array', () => {
    const delegationIds = Array.from({ length: 24 }, (_, i) => id('delegation', i)) as unknown as NonEmptyIds;
    expect(() => composeBotTurnOutcomeSchema({
      ...mainBotFragments(timeZones, routines),
      cancel_delegation: F.cancelDelegation({ delegationIds }),
    })).toThrow(expect.objectContaining({ code: 'schema-over-budget' }));
    const schema = composeBotTurnOutcomeSchema({
      ...mainBotFragments(timeZones, routines, 'flat'),
      cancel_delegation: F.cancelDelegation({ delegationIds }),
    });
    expect(checkResultSchema(schema).ok).toBe(true);
    const bound = resultOutcomeMaxBytes(schema)!;
    expect(bound).toBe(62085);
    expect(bound).toBeLessThanOrEqual(65536);
    const witness = worstCaseInstance(schema) as BotTurnOutcome;
    expect(witness.cancel_delegation).toHaveLength(2);
    expect(validateResultOutcome(schema, witness).ok).toBe(true);
    expect(bytes(witness)).toBeLessThanOrEqual(bound);
  });

  it.each([['conversation', conversation, 43261], ['main', mainBot, 61895], ['room', room, 16710]] as const)
    ('admits the %s variant and its largest witness', (_name, build, expectedBound) => {
      const schema = build();
      expect(checkResultSchema(schema).ok).toBe(true);
      expect(TerminalProjectionSelectionSchema.safeParse({ mode: 'result-document', contract: 'bot-turn-outcome.v1', schema }).success).toBe(true);
      const bound = resultOutcomeMaxBytes(schema)!;
      expect(bound).toBe(expectedBound);
      expect(bound).toBeLessThanOrEqual(65536);
      const witness = worstCaseInstance(schema);
      expect(validateResultOutcome(schema, witness).ok).toBe(true);
      expect(bytes(witness)).toBeLessThanOrEqual(bound);
    });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['daily', {}, true],
    ['weekly', { daysOfWeek: ['mon', 'fri'] }, true],
    ['all weekdays', { daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, true],
    ['duplicate weekdays', { daysOfWeek: ['mon', 'mon'] }, true],
    ['monthly', { dayOfMonth: 31 }, true],
    ['yearly', { dayOfMonth: 31, month: 12 }, true],
    ['calendar checks stay with Host', { dayOfMonth: 31, month: 4 }, true],
    ['February 29 stays with Host', { dayOfMonth: 29, month: 2 }, true],
    ['weekday and date', { daysOfWeek: ['mon'], dayOfMonth: 1 }, false],
    ['weekday and month', { daysOfWeek: ['mon'], month: 2 }, false],
    ['all day selectors', { daysOfWeek: ['mon'], dayOfMonth: 1, month: 2 }, false],
    ['month without date', { month: 2 }, false],
    ['empty weekdays', { daysOfWeek: [] }, false],
    ['too many weekdays', { daysOfWeek: Array(8).fill('mon') }, false],
    ['unknown weekday', { daysOfWeek: ['MON'] }, false],
    ['numeric weekday', { daysOfWeek: [1] }, false],
    ['weekday string', { daysOfWeek: 'mon' }, false],
    ['date below range', { dayOfMonth: 0 }, false],
    ['date above range', { dayOfMonth: 32 }, false],
    ['fractional date', { dayOfMonth: 1.5 }, false],
    ['month below range', { dayOfMonth: 1, month: 0 }, false],
    ['month above range', { dayOfMonth: 1, month: 13 }, false],
    ['month string', { dayOfMonth: 1, month: '2' }, false],
    ['unknown field', { cron: '0 9 * * *' }, false],
  ])('matches the v3 three-branch schema: %s', (_name, dayFields, validDayFields) => {
    const checked = F.createRoutine({ localIds: routineSlots, timeZones }).items!.properties!.schedule!;
    const time: Record<string, ResultSchema> = {
      minute: { type: 'integer', minimum: 0, maximum: 59 },
      hour: { type: 'integer', minimum: 0, maximum: 23 },
      tz: { enum: ['Asia/Shanghai', 'UTC'] },
    };
    // Independent v3 reference: each closed branch repeats its field schemas.
    const v3: ResultSchema = { oneOf: [
      { type: 'object', additionalProperties: false, required: ['minute', 'hour', 'tz'], properties: { ...time } },
      { type: 'object', additionalProperties: false, required: ['minute', 'hour', 'tz', 'daysOfWeek'], properties: {
        ...time, daysOfWeek: { type: 'array', minItems: 1, maxItems: 7, items: { enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
      } },
      { type: 'object', additionalProperties: false, required: ['minute', 'hour', 'tz', 'dayOfMonth'], properties: {
        ...time, dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 }, month: { type: 'integer', minimum: 1, maximum: 12 },
      } },
    ] };
    const root = (schedule: ResultSchema): ResultSchema => ({
      type: 'object', additionalProperties: false, required: ['schedule'], properties: { schedule },
    });
    const checkedRoot = root(checked), v3Root = root(v3);
    expect(checkResultSchema(checkedRoot).ok).toBe(true);
    expect(checkResultSchema(v3Root).ok).toBe(true);
    for (const minute of [0, 59, -1, 60, 1.5, '0', undefined]) {
      for (const hour of [0, 23, 24, undefined]) {
        for (const tz of ['UTC', 'Asia/Shanghai', 'Mars/Phobos']) {
          const schedule = {
            ...(minute === undefined ? {} : { minute }),
            ...(hour === undefined ? {} : { hour }), tz, ...dayFields,
          };
          const outcome = { schedule };
          const actual = validateResultOutcome(checkedRoot, outcome).ok;
          const reference = validateResultOutcome(v3Root, outcome).ok;
          const expected = validDayFields && (minute === 0 || minute === 59)
            && (hour === 0 || hour === 23) && tz !== 'Mars/Phobos';
          const context = JSON.stringify(schedule);
          expect(actual, context).toBe(reference);
          expect(actual, context).toBe(expected);
        }
      }
    }
    for (const schedule of [null, [], 'daily']) {
      expect(validateResultOutcome(checkedRoot, { schedule }).ok).toBe(false);
      expect(validateResultOutcome(v3Root, { schedule }).ok).toBe(false);
    }
  });

  it('keeps checked field combinations in the schema and leaves flat combinations to the Host', () => {
    for (const extra of [{ daysOfWeek: ['mon'], dayOfMonth: 1 }, { month: 3 }]) {
      for (const shape of ['checked', 'flat'] as const) {
        const schema = composeBotTurnOutcomeSchema({ create_routine: F.createRoutine({ localIds: routineSlots, timeZones, scheduleShape: shape }) });
        const outcome = { create_routine: [{ localId: routineSlots[0], schedule: { minute: 0, hour: 9, tz: 'UTC', ...extra }, prompt: 'check' }] };
        expect(validateResultOutcome(schema, outcome).ok).toBe(shape === 'flat');
      }
    }
  });

  it.each([
    { minute: '0' }, { minute: 1.5 }, { hour: 24 }, { dayOfMonth: 32 },
    { daysOfWeek: [] }, { daysOfWeek: ['MON'] }, { daysOfWeek: Array(8).fill('mon') },
    { tz: 'Mars/Phobos' }, { cron: '0 9 * * *' },
  ])('refuses invalid schedule fields %j', extra => {
    const schema = conversation();
    expect(validateResultOutcome(schema, { create_routine: [{ localId: routineSlots[0], schedule: { minute: 0, hour: 9, tz: 'UTC', ...extra }, prompt: 'check' }] }).ok).toBe(false);
  });

  it('enforces role, enum, action and speech boundaries', () => {
    for (const value of [
      { delegate: [{ to: 'unknown', request: 'check' }] },
      { delegate: Array(3).fill({ to: self, request: 'check' }) },
      { create_bot: [{ localId: botSlots[0], name: 'a', role: 'b', persona: 'c', model: models[0] }] },
      { ask_user: { question: 'why', answerKind: 'single_choice', options: [{ id: 'a', label: 'A' }] } },
      { confirmable_action: [{ action: 'send_email', summary: 'check', draft: { channel: 'sms', text: 'hi' } }] },
      { actions: [] }, { unknown: true },
    ]) expect(validateResultOutcome(conversation(), value).ok).toBe(false);
    for (const value of [{}, { speech: { kind: 'pass', text: 'x' } }, { speech: { kind: 'post' } }, { speech: { kind: 'pass' }, delegate: [] }]) {
      expect(validateResultOutcome(room(), value).ok).toBe(false);
    }
    expect(validateResultOutcome(room(), { speech: { kind: 'pass' } }).ok).toBe(true);
    expect(validateResultOutcome(conversation(), {}).ok).toBe(true);
  });

  it('uses flat only after a schema byte error and still refuses an oversized enum set', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => id('rtn', i)) as unknown as NonEmptyIds;
    expect(() => mainBot(timeZones, ids(8))).not.toThrow();
    expect(() => mainBot(timeZones, ids(22))).toThrow(expect.objectContaining({ code: 'schema-over-budget' }));
    expect(() => mainBot(timeZones, ids(22), 'flat')).not.toThrow();
    expect(() => mainBot(timeZones, ids(96), 'flat')).toThrow(expect.objectContaining({ code: 'schema-over-budget' }));
  });

  it('keeps subset, schema, outcome and draft budget failures distinct', () => {
    const check = (build: () => unknown, code: string) => {
      expect(build).toThrow(BotTurnOutcomeSchemaError);
      expect(build).toThrow(expect.objectContaining({ code }));
    };
    check(() => composeBotTurnOutcomeSchema({ team_note: { type: 'string', pattern: 'x' } as ResultSchema }), 'not-subset');
    check(() => composeBotTurnOutcomeSchema({ team_note: { type: 'string', maxLength: 11000 } }), 'over-budget');
    check(() => composeBotTurnOutcomeSchema({ team_note: { type: 'object' } }), 'over-budget');
    for (const draft of [{ type: 'object' }, { type: 'string', maxLength: 3000 }] as const) {
      check(() => F.confirmableAction({ actions: [{ action: 'send', draft }] }), 'draft-over-budget');
    }
    expect(() => F.confirmableAction({ actions: [{ action: 'send', draft: { const: { message: 'hi' } } }] })).not.toThrow();
  });
});
