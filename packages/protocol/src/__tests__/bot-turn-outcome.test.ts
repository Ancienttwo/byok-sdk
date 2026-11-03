import { describe, expect, it } from 'vitest';
import { checkResultSchema, resultOutcomeMaxBytes, validateResultOutcome, type ResultSchema } from '../result-schema';
import { TerminalProjectionSelectionSchema } from '../terminal-projection';
import {
  botTurnOutcomeFragments as F, composeBotTurnOutcomeSchema, BotTurnOutcomeSchemaError, BOT_TURN_OUTCOME_LIMITS,
  BOT_TURN_OUTCOME_CONTRACT,
  type NonEmptyIds,
} from '../bot-turn-outcome';
import type { BotTurnOutcome, BotTurnOutcomeKind, CancelDelegationAction } from '../index';
import { worstCaseInstance } from './bot-outcome-fixtures';
// The witnesses repeat option ids, so their cases check the schema bound under a contract with no rules.
const SCHEMA_ONLY = 'example.schema-only.v1';
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
const mainBot = (zones: NonEmptyIds = timeZones, routineIds: NonEmptyIds = routines) =>
  composeBotTurnOutcomeSchema(mainBotFragments(zones, routineIds));
function mainBotFragments(zones: NonEmptyIds, routineIds: NonEmptyIds) {
  const withSlots = [...roster, ...botSlots] as unknown as NonEmptyIds;
  return {
    delegate: F.delegate({ to: withSlots }), ask_user: F.askUser(), confirmable_action: F.confirmableAction({ actions: confirmables }),
    create_routine: F.createRoutine({ localIds: routineSlots, timeZones: zones, targets: roster }),
    update_routine: F.updateRoutine({ routineIds, timeZones: zones }), cancel_routine: F.cancelRoutine({ routineIds }),
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
      expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, outcome).ok).toBe(true);
      expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: conversation() }, outcome).ok).toBe(false);
      expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: room() }, { speech: { kind: 'pass' }, ...outcome }).ok).toBe(false);
    }
    expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, {}).ok).toBe(true);
    for (const cancel_delegation of [
      [], [first, second, first], [{ delegationId: 'unknown' }], [{}],
      [{ delegationId: delegationIds[0], reason: 'stop' }], [{ delegationId: 1 }],
    ]) expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, { cancel_delegation }).ok).toBe(false);
  });

  it('bounds a Main Bot outcome with 24 open delegations and a full cancel array', () => {
    const delegationIds = Array.from({ length: 24 }, (_, i) => id('delegation', i)) as unknown as NonEmptyIds;
    const schema = composeBotTurnOutcomeSchema({
      ...mainBotFragments(timeZones, routines),
      cancel_delegation: F.cancelDelegation({ delegationIds }),
    });
    expect(checkResultSchema(schema).ok).toBe(true);
    const bound = resultOutcomeMaxBytes(schema)!;
    expect(bound).toBe(62085);
    expect(bound).toBeLessThanOrEqual(65536);
    const witness = worstCaseInstance(schema) as BotTurnOutcome;
    expect(witness.cancel_delegation).toHaveLength(2);
    expect(validateResultOutcome({ contract: SCHEMA_ONLY, schema }, witness).ok).toBe(true);
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
      expect(validateResultOutcome({ contract: SCHEMA_ONLY, schema }, witness).ok).toBe(true);
      expect(bytes(witness)).toBeLessThanOrEqual(bound);
    });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['daily', {}, true],
    ['weekly', { daysOfWeek: ['mon', 'fri'] }, true],
    ['all weekdays', { daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, true],
    ['monthly', { dayOfMonth: 31 }, true],
    ['yearly', { dayOfMonth: 31, month: 12 }, true],
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
  ])('matches the v3 three-branch schema under the contract: %s', (_name, dayFields, validDayFields) => {
    const schema = conversation();
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
    const v3Root = root(v3);
    expect(checkResultSchema(v3Root).ok).toBe(true);
    const create = (schedule: unknown) => ({ create_routine: [{ localId: routineSlots[0], schedule, prompt: 'check' }] });
    for (const minute of [0, 59, -1, 60, 1.5, '0', undefined]) {
      for (const hour of [0, 23, 24, undefined]) {
        for (const tz of ['UTC', 'Asia/Shanghai', 'Mars/Phobos']) {
          const schedule = {
            ...(minute === undefined ? {} : { minute }),
            ...(hour === undefined ? {} : { hour }), tz, ...dayFields,
          };
          const actual = validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, create(schedule)).ok;
          const reference = validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: v3Root }, { schedule }).ok;
          const expected = validDayFields && (minute === 0 || minute === 59)
            && (hour === 0 || hour === 23) && tz !== 'Mars/Phobos';
          const context = JSON.stringify(schedule);
          expect(actual, context).toBe(reference);
          expect(actual, context).toBe(expected);
        }
      }
    }
    for (const schedule of [null, [], 'daily']) {
      expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, create(schedule)).ok).toBe(false);
      expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: v3Root }, { schedule }).ok).toBe(false);
    }
  });

  it('leaves schedule field combinations to the contract: the schema alone admits them', () => {
    const outcome = { create_routine: [{ localId: routineSlots[0], schedule: { minute: 0, hour: 9, tz: 'UTC', month: 3 }, prompt: 'check' }] };
    expect(validateResultOutcome({ contract: SCHEMA_ONLY, schema: conversation() }, outcome).ok).toBe(true);
    expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: conversation() }, outcome)).toMatchObject({ ok: false, reason: 'contract-mismatch' });
  });

  it.each([
    { minute: '0' }, { minute: 1.5 }, { hour: 24 }, { dayOfMonth: 32 },
    { daysOfWeek: [] }, { daysOfWeek: ['MON'] }, { daysOfWeek: Array(8).fill('mon') },
    { tz: 'Mars/Phobos' }, { cron: '0 9 * * *' },
  ])('refuses invalid schedule fields %j', extra => {
    const schema = conversation();
    expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, { create_routine: [{ localId: routineSlots[0], schedule: { minute: 0, hour: 9, tz: 'UTC', ...extra }, prompt: 'check' }] }).ok).toBe(false);
  });

  it('enforces role, enum, action and speech boundaries', () => {
    for (const value of [
      { delegate: [{ to: 'unknown', request: 'check' }] },
      { delegate: Array(3).fill({ to: self, request: 'check' }) },
      { create_bot: [{ localId: botSlots[0], name: 'a', role: 'b', persona: 'c', model: models[0] }] },
      { ask_user: { question: 'why', answerKind: 'single_choice', options: [{ id: 'a', label: 'A' }] } },
      { confirmable_action: [{ action: 'send_email', summary: 'check', draft: { channel: 'sms', text: 'hi' } }] },
      { actions: [] }, { unknown: true },
    ]) expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: conversation() }, value).ok).toBe(false);
    for (const value of [{}, { speech: { kind: 'pass', text: 'x' } }, { speech: { kind: 'post' } }, { speech: { kind: 'pass' }, delegate: [] }]) {
      expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: room() }, value).ok).toBe(false);
    }
    expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: room() }, { speech: { kind: 'pass' } }).ok).toBe(true);
    expect(validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema: conversation() }, {}).ok).toBe(true);
  });

  it('refuses an oversized enum set as schema-over-budget', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => id('rtn', i)) as unknown as NonEmptyIds;
    expect(() => mainBot(timeZones, ids(22))).not.toThrow();
    expect(() => mainBot(timeZones, ids(96))).toThrow(expect.objectContaining({ code: 'schema-over-budget' }));
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

  it('refuses duplicate option ids and blank model text under the bot-turn-outcome contract only', () => {
    const contract = { contract: BOT_TURN_OUTCOME_CONTRACT, schema: conversation() };
    const ask = (question: string, options: { id: string; label: string }[]) => ({ ask_user: { question, answerKind: 'single_choice', options } });
    expect(validateResultOutcome(contract, ask('which', [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]))).toMatchObject({
      ok: false, reason: 'contract-mismatch', truncated: false,
      issues: [{ pointer: '/ask_user/options/1/id', keyword: 'duplicate-option-id', message: 'Duplicate option id' }] });
    const blank = { ...ask('\u3000', [{ id: 'a', label: 'A' }, { id: 'b', label: '\u00a0' }]), delegate: [{ to: self, request: ' ' }] };
    const refused = validateResultOutcome(contract, blank);
    expect(refused).toMatchObject({ ok: false, reason: 'contract-mismatch' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.issues).toHaveLength(3);
    expect(refused.issues).toEqual(expect.arrayContaining(['/ask_user/question', '/ask_user/options/1/label', '/delegate/0/request']
      .map(pointer => ({ pointer, keyword: 'blank-text', message: 'Blank text' }))));
    expect(validateResultOutcome(contract, { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { channel: 'sms', text: ' ' } }] }).ok).toBe(true);
    expect(validateResultOutcome({ contract: 'other.v1', schema: conversation() }, blank).ok).toBe(true);
  });

  const schedule = (extra: Record<string, unknown>) => ({ minute: 0, hour: 9, tz: 'UTC', ...extra });
  const routineAt = (extra: Record<string, unknown>) => ({ create_routine: [{ localId: routineSlots[0], schedule: schedule(extra), prompt: 'check' }] });
  const bot = (localId: string) => ({ localId, name: 'a', role: 'b', persona: 'c', model: models[0] });
  const delegationIds = [id('delegation', 0), id('delegation', 1)] as unknown as NonEmptyIds;
  const withCancel = () => composeBotTurnOutcomeSchema({ ...mainBotFragments(timeZones, routines), cancel_delegation: F.cancelDelegation({ delegationIds }) });
  it.each<[string, () => ResultSchema, unknown, string, string]>([
    ['self twice', conversation, { delegate: [{ to: self, request: 'a' }, { to: self, request: 'b' }] }, '/delegate/1/to', 'duplicate-target'],
    ['another Bot twice', conversation, { delegate: [{ to: team[0], request: 'a' }, { to: team[0], request: 'b' }] }, '/delegate/1/to', 'duplicate-target'],
    ['create_bot localId', mainBot, { create_bot: [bot(botSlots[0]), bot(botSlots[0])] }, '/create_bot/1/localId', 'duplicate-local-id'],
    ['cancel_routine id', conversation, { cancel_routine: [{ routineId: routines[0] }, { routineId: routines[0] }] }, '/cancel_routine/1/routineId', 'duplicate-id'],
    ['cancel_delegation id', withCancel, { cancel_delegation: [{ delegationId: delegationIds[0] }, { delegationId: delegationIds[0] }] },
      '/cancel_delegation/1/delegationId', 'duplicate-id'],
    ['room_call member', room, { speech: { kind: 'pass' }, room_call: { members: [self, self] } }, '/room_call/members/1', 'duplicate-member'],
    ['create_room member', mainBot, { create_room: [{ localId: roomSlots[0], name: 'R', members: [self, self] }] }, '/create_room/0/members/1', 'duplicate-member'],
    ['update_room member', mainBot, { update_room: [{ roomId: rooms[0], members: [self, self] }] }, '/update_room/0/members/1', 'duplicate-member'],
    ['create_room admin', mainBot, { create_room: [{ localId: roomSlots[0], name: 'R', members: [self], admin: team[0] }] }, '/create_room/0/admin', 'admin-not-member'],
    ['update_routine', conversation, { update_routine: [{ routineId: routines[0] }] }, '/update_routine/0', 'empty-update'],
    ['update_bot', mainBot, { update_bot: [{ botId: team[0] }] }, '/update_bot/0', 'empty-update'],
    ['update_room', mainBot, { update_room: [{ roomId: rooms[0] }] }, '/update_room/0', 'empty-update'],
    ['weekday and date', conversation, routineAt({ daysOfWeek: ['mon'], dayOfMonth: 1 }), '/create_routine/0/schedule', 'schedule-invalid'],
    ['repeated weekday', conversation, routineAt({ daysOfWeek: ['mon', 'mon'] }), '/create_routine/0/schedule', 'schedule-invalid'],
    ['April 31', conversation, routineAt({ dayOfMonth: 31, month: 4 }), '/create_routine/0/schedule', 'schedule-unreachable'],
    ['February 29', conversation, { update_routine: [{ routineId: routines[0], schedule: schedule({ dayOfMonth: 29, month: 2 }) }] },
      '/update_routine/0/schedule', 'schedule-beyond-horizon'],
  ])('refuses %s under the bot-turn-outcome contract', (_name, build, outcome, pointer, keyword) => {
    const schema = build();
    expect(validateResultOutcome({ contract: SCHEMA_ONLY, schema }, outcome).ok).toBe(true);
    const refused = validateResultOutcome({ contract: BOT_TURN_OUTCOME_CONTRACT, schema }, outcome);
    expect(refused).toMatchObject({ ok: false, reason: 'contract-mismatch' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.issues.map(issue => [issue.pointer, issue.keyword])).toEqual([[pointer, keyword]]);
  });
});
