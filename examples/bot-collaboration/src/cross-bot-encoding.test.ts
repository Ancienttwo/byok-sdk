import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as protocol from '@byok-sdk/protocol';
import { createByokServer } from '@byok-sdk/server';
import { openTeam, type TestTeam } from './team.test-support';
import { hash, HostLedger } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import { stateOf, type CollaborationState, type Turn } from './model';
import type { BotRoutine } from './routines';
import { routineViews } from './routines.test-support';
import { outcomeSchema, SYSTEM_PROMPT } from './schema';
import { botTurnInstruction } from './rules/context';
import { BOT_REPLY_MAX_BYTES, DEFAULT_INSTRUCTION_MAX_BYTES, minimumInstructionBytes, OPEN_DELEGATION_ENTRY_MAX_BYTES, OPEN_DELEGATIONS_MAX_BYTES } from './delegation';
import { botCompactVeto } from './compaction';

let root: string | undefined;
let fixture: TestTeam | undefined;
afterEach(async () => {
  await fixture?.close(); fixture = undefined;
  if (root) await rm(root, { recursive: true, force: true }); root = undefined;
});
/** Control characters and quotes: up to 6 JSON bytes per code point. */
const worst = (codePoints: number) => '"' + '\u0001'.repeat(codePoints - 1);
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Worst case of §3.7: 24 Bots, maximum names, full background and history, two 8 192-byte replies. */
function worstCase(request: string) {
  const state = stateOf({});
  const ids = Array.from({ length: 24 }, (_, i) => hash(['bot', i]));
  for (const [i, id] of ids.entries()) state.team.bots[id] = { id, name: worst(40), role: worst(80), persona: '', model: 'default',
    mainBot: i === 0, archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  const [, a, b, c] = ids as [string, string, string, string];
  state.team.notes = Array.from({ length: 20 }, (_, i) => ({ id: `note-${i}`, text: worst(300) }));
  for (let r = 0; r < 6; r++) state.team.rooms[`room-${r}`] = { id: `room-${r}`, name: worst(40), members: ids.slice(0, 12), mode: 'mention',
    announcement: worst(300), admin: ids[0], visibleFrom: {}, messages: [] };
  const routines = routineViews(a, 8, worst(500));
  for (const bot of [a, b]) for (let n = 0; n < 150; n++) {
    const id = `${bot}-old-${n}`;
    state.turns[id] = { id, root: id, botId: bot, source: 'user', request: worst(1000), hop: 0, status: 'succeeded', authority: 'owner', outcome: { delegate: [] } };
    state.cards[id] = { id, turnId: id, state: n % 2 ? 'pending' : 'confirmed', expiresAt: Date.UTC(2027, 0, 1),
      action: { action: 'send_message', summary: worst(300), draft: { text: worst(1000) } } };
    state.questions[id] = { id, turnId: id, value: { question: worst(400), answerKind: 'text' } };
    state.rejected.push({ botId: bot, taskId: id, action: 'delegate', reason: worst(200) });
  }
  const delegation = (id: string, to: string) => state.delegations[id] = { id, root: 'root', fromBotId: a, fromTurnId: 'origin', fromTaskId: 'task',
    index: 0, toBotId: to, request: worst(1000), hop: 1, chainTurnIds: [id], batch: 'task', status: 'resolved', revision: 3, verdict: 'answered', reply: `${id}-task` };
  const d1 = hash(['d', 1]), d2 = hash(['d', 2]);
  delegation(d1, b); delegation(d2, c);
  state.replies[`${d1}-task`] = { turnId: d1, messageId: 'm1', contentHash: 'h1', contentType: 'text/markdown', acceptedAt: 0, body: '😀'.repeat(BOT_REPLY_MAX_BYTES / 4) };
  state.replies[`${d2}-task`] = { turnId: d2, messageId: 'm2', contentHash: 'h2', contentType: 'text/markdown', acceptedAt: 0, body: '\n"'.repeat(BOT_REPLY_MAX_BYTES / 2) };
  const reply: Turn = { id: hash(['bot_reply', 'task']), root: 'root', botId: a, source: 'bot_reply', request: 'Delegation replies', hop: 0, status: 'queued', authority: 'owner',
    replies: [d1, d2].map((id, i) => ({ delegationId: id, from: i ? c : b, request: worst(1000), verdict: 'answered' as const, reason: 'continuation_refused', reply: `${id}-task`, continuationRefused: true as const })) };
  const botRequest: Turn = { id: d1, root: 'root', botId: b, source: 'bot_request', request, hop: 1, status: 'queued', authority: 'bot', delegationId: d1 };
  state.turns[reply.id] = reply; state.turns[botRequest.id] = botRequest;
  return { state, turns: [reply, botRequest], routines };
}
function check(state: CollaborationState, turn: Turn, instructionMaxBytes: number, routines: readonly BotRoutine[]) {
  const { instruction, context } = botTurnInstruction(state, turn, { turnLimit: 100, contextMaxBytes: 32_768, instructionMaxBytes }, routines);
  expect(bytes(instruction)).toBeLessThanOrEqual(instructionMaxBytes);
  expect(context.historyWindow.metadataOverBudget).toBe(false);
  expect(context.historyWindow.notice).toBe('Earlier history was omitted.');
  expect(context.historyWindow.omittedBackground).toBeGreaterThan(0);
  return instruction;
}

it('bounds every worst-case Cross-Bot instruction, never blocks it, and the real server accepts it', async () => {
  const minimum = minimumInstructionBytes(SYSTEM_PROMPT);
  expect(minimum).toBeLessThan(DEFAULT_INSTRUCTION_MAX_BYTES);
  // A real paired daemon gives the device its Agent capabilities.
  fixture = await openTeam();
  const server = fixture.server;
  for (const request of ['😀'.repeat(1000), worst(1000)]) {
    const { state, turns, routines } = worstCase(request);
    for (const budget of [DEFAULT_INSTRUCTION_MAX_BYTES, minimum]) {
      for (const turn of turns) {
        const instruction = check(state, turn, budget, routines);
        // Request text and bodies appear once as raw UTF-8, never JSON-escaped a second time.
        expect(instruction.split(turn.source === 'bot_request' ? request : '😀'.repeat(BOT_REPLY_MAX_BYTES / 4))).toHaveLength(2);
        const base = template(fixture.deviceId, turn.botId);
        await expect(server.executions.submit({ ...base, taskId: hash([turn.id, budget, request]), payload: { ...base.payload, instruction,
          terminalProjection: { mode: 'result-document', contract: protocol.BOT_TURN_OUTCOME_CONTRACT, schema: outcomeSchema(turn.botId, state, turn, ['default'], routines) } } })).resolves.toBeDefined();
      }
    }
    expect(bytes(turns[0]!.replies!.map(r => state.replies[r.reply!]!.body!).join(''))).toBe(2 * BOT_REPLY_MAX_BYTES);
  }
});

it('refuses an instructionMaxBytes below the computed minimum at construction', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cross-bot-minimum-'));
  const ledger = new HostLedger(path.join(root, 'host.sqlite'), 'minimum', { compactVeto: botCompactVeto });
  const server = createByokServer({ productId: 'minimum', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') }, wake: { consume: async () => {} } });
  try {
    const minimum = minimumInstructionBytes(SYSTEM_PROMPT);
    const options = { botId: 'main', execution: template('device'), connector: async () => null };
    expect(() => new BotCollaboration(server, ledger, { ...options, instructionMaxBytes: minimum - 1 })).toThrow(`instructionMaxBytes must be at least ${minimum}`);
    await new BotCollaboration(server, ledger, { ...options, instructionMaxBytes: minimum }).close();
  } finally { await server.close(); ledger.close(); }
});

it('measures the Main Bot schema with 24 delegate ids: eight routines fit; rooms on top exceed the cap and block, never cut', () => {
  const { state } = worstCase('x');
  const main = Object.values(state.team.bots)[0]!;
  const routines = routineViews(main.id, 8);
  const turn: Turn = { id: 'owner', root: 'owner', botId: main.id, source: 'user', request: 'x', hop: 0, status: 'queued', authority: 'owner' };
  const rooms = state.team.rooms;
  state.team.rooms = {};
  const schema = outcomeSchema(main.id, state, turn, ['default'], routines);
  expect(schema.properties!.delegate!.items!.properties!.to!.enum).toHaveLength(24);
  expect(schema.properties).toHaveProperty('create_bot');
  expect(Buffer.byteLength(JSON.stringify(schema))).toBe(14_820);
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(protocol.RESULT_SCHEMA_MAX_BYTES);
  expect(protocol.resultOutcomeMaxBytes(schema)).toBeLessThanOrEqual(protocol.RESULT_OUTCOME_MAX_BYTES);
  // update_room adds a room enum and members. The Host blocks such a Turn with a visible reason.
  state.team.rooms = { [Object.keys(rooms)[0]!]: Object.values(rooms)[0]! };
  let error: unknown;
  try { outcomeSchema(main.id, state, turn, ['default'], routines); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(protocol.BotTurnOutcomeSchemaError);
  expect(error).toMatchObject({ code: 'schema-over-budget', message: expect.stringMatching(/^schema is 17\d{3} bytes; cap 16384$/) });
});

it('bounds a Main Bot reply Turn that lists 24 worst-case open delegations, with the rest only counted', () => {
  const { state, turns: [reply], routines } = worstCase(worst(1000));
  const main = Object.values(state.team.bots)[0]!;
  const template = state.delegations[reply!.replies![0]!.delegationId]!;
  for (let n = 0; n < 25; n++) {
    const id = hash(['open', n]);
    state.delegations[id] = { ...template, id, request: worst(1000), status: 'waiting_device', verdict: undefined, reply: undefined };
  }
  const turn: Turn = { ...reply!, id: hash(['bot_reply', 'main']), botId: main.id };
  state.turns[turn.id] = turn;
  const minimum = minimumInstructionBytes(SYSTEM_PROMPT);
  check(state, turn, minimum, routines);
  const { context } = botTurnInstruction(state, turn, { turnLimit: 100, contextMaxBytes: 32_768, instructionMaxBytes: minimum }, routines);
  expect(context.openDelegations).toMatchObject({ omitted: 1 });
  expect(context.openDelegations!.items).toHaveLength(24);
  expect(bytes(JSON.stringify(context.openDelegations!.items[0]))).toBeLessThanOrEqual(OPEN_DELEGATION_ENTRY_MAX_BYTES);
  expect(bytes(`"openDelegations":${JSON.stringify(context.openDelegations)}`)).toBeLessThanOrEqual(OPEN_DELEGATIONS_MAX_BYTES);
});
