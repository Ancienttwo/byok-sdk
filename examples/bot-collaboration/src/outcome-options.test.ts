import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as protocol from '@byok-sdk/protocol';
import { canonical, HostLedger, type ExecutionServer } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { addTurn, stateOf, type CollaborationState } from './model';
import { CONFIRMABLE_MAX, DEFAULT_CONFIRMABLE, outcomeOffer, outcomeSchema, TIME_ZONES_MAX, type OutcomeOffer } from './schema';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { routineViews } from './routines.test-support';
import { roomFields } from './rules/rooms';

/** #881: the Host's outcome offer narrows the frozen schema of new Turns. */
type Schema = protocol.ResultSchema;
const keys = (schema: Schema) => Object.keys(schema.properties ?? {});
const schedule = (schema: Schema, action: string) => schema.properties![action]!.items!.properties!.schedule!;
const zones = (schema: Schema, action: string) => schedule(schema, action).properties!.tz!.enum;
/** A local team state whose Main Bot has one owner Turn `t1`. */
function ownerState(): { state: CollaborationState; turn: ReturnType<typeof addTurn> } {
  const state = stateOf({});
  state.team.bots.main = { id: 'main', name: 'Main Bot', role: 'Team owner', persona: '', model: 'default', mainBot: true, archived: false,
    revision: '1', readyRevision: '1', execution: template('device') };
  return { state, turn: addTurn(state, { id: 't1', root: 't1', source: 'user', request: 'Work', botId: 'main', hop: 0, authority: 'owner' }) };
}
const DRAFT: Schema = { type: 'object', additionalProperties: false, required: ['symbol'], properties: { symbol: { type: 'string', minLength: 1, maxLength: 12 } } };

it('keeps the default schema byte for byte without an offer or with an empty one', () => {
  const { state, turn } = ownerState();
  expect(canonical(outcomeSchema('main', state, turn, ['default'], [], outcomeOffer({})))).toBe(canonical(outcomeSchema('main', state, turn)));
  expect(canonical(outcomeSchema('main', state, turn, ['default'], [], outcomeOffer({ actions: {} })))).toBe(canonical(outcomeSchema('main', state, turn)));
});

it('offers only the allowed actions of each Turn kind, and the frozen schema refuses the others', () => {
  const { state, turn } = ownerState();
  const offer = outcomeOffer({ actions: { turn: ['delegate'], main: ['team_note'] } });
  const owner = outcomeSchema('main', state, turn, ['default'], [], offer);
  expect(keys(owner)).toEqual(['delegate', 'team_note']);
  // A Bot Turn without owner authority gets only the `turn` list.
  expect(keys(outcomeSchema('main', state, { ...turn, authority: 'bot' }, ['default'], [], offer))).toEqual(['delegate']);
  expect(protocol.validateResultOutcome(owner, { delegate: [{ to: 'main', request: 'Look' }] }).ok).toBe(true);
  expect(protocol.validateResultOutcome(owner, { ask_user: [{ question: 'Why?', answerKind: 'text' }] }).ok).toBe(false);
  // An empty list removes every action of that kind.
  expect(keys(outcomeSchema('main', state, turn, ['default'], [], outcomeOffer({ actions: { turn: [], main: [] } })))).toEqual([]);
});

it('offers new_bot_* room members only when the Main Bot list offers create_bot', () => {
  const { state, turn } = ownerState();
  state.team.rooms.r = { id: 'r', ...roomFields(state.team, { name: 'Room', members: ['main'] }), messages: [] };
  const members = (schema: Schema, action: string) => schema.properties![action]!.items!.properties!.members!.items!.enum;
  const all = outcomeSchema('main', state, turn, ['default'], [], outcomeOffer({ actions: { main: ['create_bot', 'create_room', 'update_room'] } }));
  expect(members(all, 'create_room')).toEqual(['main', 'new_bot_1', 'new_bot_2', 'new_bot_3']);
  const rooms = outcomeSchema('main', state, turn, ['default'], [], outcomeOffer({ actions: { main: ['create_room', 'update_room'] } }));
  expect(members(rooms, 'create_room')).toEqual(['main']);
  expect(members(rooms, 'update_room')).toEqual(['main']);
  expect(protocol.validateResultOutcome(rooms, { create_room: [{ localId: 'new_room_1', name: 'Room', members: ['new_bot_1'] }] }).ok).toBe(false);
});

it('offers the Host time zones in create_routine and update_routine', () => {
  const offer = outcomeOffer({ timeZones: ['Asia/Shanghai', 'Asia/Hong_Kong'] });
  const schema = outcomeSchema('main', stateOf({}), undefined, ['default'], routineViews('main', 1, 'report'), offer);
  for (const action of ['create_routine', 'update_routine']) expect(zones(schema, action), action).toEqual(['Asia/Shanghai', 'Asia/Hong_Kong']);
  const routine = (tz: string) => ({ create_routine: [{ localId: 'new_routine_1', schedule: { minute: 0, hour: 9, tz }, prompt: 'Brief' }] });
  expect(protocol.validateResultOutcome(schema, routine('Asia/Shanghai')).ok).toBe(true);
  expect(protocol.validateResultOutcome(schema, routine('UTC')).ok).toBe(false);
});

it('offers the Host confirmable actions, so the connector gets only those', () => {
  const schema = outcomeSchema('main', stateOf({}), undefined, ['default'], [], outcomeOffer({ confirmable: [{ action: 'place_order', draft: DRAFT }] }));
  const action = (name: string) => ({ confirmable_action: [{ action: name, summary: 'Buy', draft: { symbol: 'ACME' } }] });
  expect(protocol.validateResultOutcome(schema, action('place_order')).ok).toBe(true);
  expect(protocol.validateResultOutcome(schema, action('send_message')).ok).toBe(false);
});

it.each<[string, OutcomeOffer, string]>([
  ['an unknown Turn action', { actions: { turn: ['speech' as never] } }, 'Unknown Turn action: speech'],
  ['a Main Bot action in the Turn list', { actions: { turn: ['team_note' as never] } }, 'Unknown Turn action: team_note'],
  ['a duplicate action', { actions: { main: ['team_note', 'team_note'] } }, 'Each Main Bot action must be distinct'],
  ['an invalid time zone', { timeZones: ['Mars/Olympus'] }, 'Invalid time zone Mars/Olympus'],
  ['no time zone', { timeZones: [] }, `An offer has 1 to ${TIME_ZONES_MAX} time zones`],
  ['too many time zones', { timeZones: ['UTC', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/Chicago'] },
    `An offer has 1 to ${TIME_ZONES_MAX} time zones`],
  ['a duplicate time zone', { timeZones: ['UTC', 'UTC'] }, 'Each time zone must be distinct'],
  ['no confirmable action', { confirmable: [] }, 'An offer has at least one confirmable action'],
  ['too many confirmable actions', { confirmable: Array.from({ length: CONFIRMABLE_MAX + 1 }, (_, n) => ({ action: `a${n}`, draft: DRAFT })) },
    `An offer has at most ${CONFIRMABLE_MAX} confirmable actions`],
  ['a duplicate confirmable action', { confirmable: [{ action: 'a', draft: DRAFT }, { action: 'a', draft: DRAFT }] }, 'Each confirmable action must be distinct'],
  ['an unbounded draft', { confirmable: [{ action: 'a', draft: { type: 'string' } }] }, 'draft for a is unbounded'],
])('refuses %s', (_name, offer, message) => {
  expect(() => outcomeOffer(offer)).toThrow(message);
});

const LONG_ZONES = ['America/Argentina/ComodRivadavia', 'America/North_Dakota/New_Salem', 'America/Argentina/Buenos_Aires',
  'America/Argentina/Rio_Gallegos', 'America/Indiana/Indianapolis', 'America/Kentucky/Louisville', 'America/North_Dakota/Beulah',
  'America/Argentina/Catamarca'];

it('keeps both bounds with eight long time zones at the eight-routine limit', () => {
  const offer = outcomeOffer({ timeZones: LONG_ZONES });
  const schema = outcomeSchema('main', stateOf({}), undefined, ['default'], routineViews('main', 8, 'report'), offer);
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(protocol.RESULT_SCHEMA_MAX_BYTES);
  expect(protocol.resultOutcomeMaxBytes(schema)).toBeLessThanOrEqual(protocol.RESULT_OUTCOME_MAX_BYTES);
  expect(zones(schema, 'update_routine')).toEqual(offer.timeZones);
  // The checked schedule shape still fits; the flat fallback is not needed.
  expect(schedule(schema, 'update_routine').oneOf).toBeDefined();
});

it('keeps both bounds with the most confirmable actions, eight long time zones and the eight-routine limit', () => {
  // `send_message` drafts with 64-byte action names, the frame of the CONFIRMABLE_MAX comment.
  const confirmable = Array.from({ length: CONFIRMABLE_MAX }, (_, n) => ({ action: `confirm_${n}`.padEnd(64, '_'), draft: DEFAULT_CONFIRMABLE[0].draft }));
  const schema = outcomeSchema('main', stateOf({}), undefined, ['default'], routineViews('main', 8, 'report'), outcomeOffer({ timeZones: LONG_ZONES, confirmable }));
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(protocol.RESULT_SCHEMA_MAX_BYTES);
  // The figure of the CONFIRMABLE_MAX comment.
  expect(Buffer.byteLength(JSON.stringify(schema))).toBe(11_564);
  expect(protocol.resultOutcomeMaxBytes(schema)).toBeLessThanOrEqual(protocol.RESULT_OUTCOME_MAX_BYTES);
  expect(schema.properties!.confirmable_action!.items!.oneOf).toHaveLength(CONFIRMABLE_MAX);
  expect(schedule(schema, 'update_routine').oneOf).toBeDefined();
});

const server = {
  executions: { submit: async () => ({}) },
  tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: async () => undefined },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
} as unknown as ExecutionServer;
let root: string | undefined, ledger: HostLedger | undefined, bot: BotCollaboration | undefined;
afterEach(async () => {
  await bot?.close(); ledger?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = ledger = bot = undefined;
});
function open(outcome?: OutcomeOffer): BotCollaboration {
  root ??= mkdtempSync(join(tmpdir(), 'k8-outcome-'));
  ledger ??= new HostLedger(join(root, 'host.sqlite'), 'tenant', { compactVeto: botCompactVeto });
  return new BotCollaboration(server as never, ledger, { botId: 'main', execution: template('device'), connector: async () => null, ...(outcome ? { outcome } : {}) });
}

it('freezes the offer of BotOptions.outcome, and a new offer changes only Turns frozen after it', async () => {
  expect(() => open({ timeZones: ['Mars/Olympus'] })).toThrow('Invalid time zone Mars/Olympus');
  expect(() => open({ confirmable: [{ action: 'a', draft: { type: 'object' } }] })).toThrow(protocol.BotTurnOutcomeSchemaError);
  bot = open({ actions: { turn: ['delegate', 'ask_user'], main: [] } });
  const first = await bot.input('k1', 'Hello');
  expect(keys(bot.snapshot().schemas[first]!)).toEqual(['delegate', 'ask_user']);
  await bot.close(); bot = undefined;
  bot = open({ actions: { turn: ['delegate'], main: [] } });
  const second = await bot.input('k2', 'Hello again');
  expect({ first: keys(bot.snapshot().schemas[first]!), second: keys(bot.snapshot().schemas[second]!) })
    .toEqual({ first: ['delegate', 'ask_user'], second: ['delegate'] });
});
