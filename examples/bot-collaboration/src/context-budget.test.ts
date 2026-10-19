import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from '@byok-sdk/protocol';
import { createByokServer } from '@byok-sdk/server';
import { HostLedger } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { stateOf } from './model';
import { contextPack } from './schema';
import { createRoutine, updateRoutine } from './routines';

let root: string | undefined;
let ledger: HostLedger | undefined;
let server: ReturnType<typeof createByokServer> | undefined;
let bot: BotCollaboration | undefined;
afterEach(async () => {
  await bot?.close(); await server?.close(); ledger?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined; ledger = undefined; server = undefined; bot = undefined;
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function setup(options: Partial<BotOptions> = {}) {
  root = await mkdtemp(path.join(tmpdir(), 'bot-context-'));
  ledger = new HostLedger(path.join(root, 'host.sqlite'), 'context-test');
  server = createByokServer({ productId: 'context-test', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') }, wake: { consume: async () => {} } });
  bot = new BotCollaboration(server, ledger, { botId: 'main', execution: template('device'), connector: async () => null, ...options });
}

it('selects a declared recent window, summarizes outcomes and includes only current routine definitions', () => {
  const state = stateOf({});
  for (let n = 0; n < 20; n++) state.turns[`turn-${n}`] = { id: `turn-${n}`, root: 'root', source: 'user', request: `request-${n}`,
    hop: 0, status: 'succeeded', outcome: { delegate: [{ to: 'main', request: 'full-document-must-stay-out' }] } };
  state.rejected.push({ taskId: 'old', action: 'delegate', reason: 'seen', consumedBy: 'old-turn' }, { taskId: 'new', action: 'delegate', reason: 'unseen' });
  const routine = createRoutine(state, 'main', 'seed', 0, { localId: 'new_routine_1', schedule: { minute: 0, hour: 9, tz: 'UTC' }, prompt: 'old-definition' }, Date.UTC(2026, 9, 19, 8));
  updateRoutine(state, 'main', { routineId: routine.id, prompt: 'current-definition' }, Date.UTC(2026, 9, 19, 8));
  const context = contextPack(state, 3);
  expect(context.historyWindow).toEqual({ turnLimit: 3, omittedTurns: 17 });
  expect(context.turns.map(t => t.id)).toEqual(['turn-17', 'turn-18', 'turn-19']);
  expect(context.turns.every(t => t.outcomeSummary.includes('delegate'))).toBe(true);
  expect(JSON.stringify(context)).not.toContain('full-document-must-stay-out');
  expect(context.rejectedActions.map(r => r.reason)).toEqual(['unseen']);
  expect(context.routines[0]!.definition!.prompt).toBe('current-definition');
  expect(JSON.stringify(context)).not.toContain('old-definition');
  expect(context.routines[0]).not.toHaveProperty('versions');
});

it('blocks an oversized UTF-8 ContextPack with a readable reason and no retry spin or execution', async () => {
  vi.useFakeTimers();
  await setup({ contextMaxBytes: 1024 });
  const submit = vi.spyOn(server!.executions, 'submit');
  const id = await bot!.input('too-large', '😀'.repeat(1024));
  expect(bot!.snapshot().turns[id]).toMatchObject({ status: 'blocked', blockedReason: expect.stringContaining('budget is 1024 bytes') });
  expect(bot!.core.intent(id)).toBeUndefined();
  expect(submit).not.toHaveBeenCalled();
  expect(Object.values(ledger!.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'projection', value: expect.objectContaining({ turnId: id, reason: expect.stringContaining('ContextPack') }) }));
  const transactions = vi.spyOn(ledger!, 'transaction');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transactions).not.toHaveBeenCalled();
});

it('blocks a schema still above its cap after flat fallback without dropping authorized ids', async () => {
  await setup();
  const compose = vi.spyOn(protocol, 'composeBotTurnOutcomeSchema').mockImplementation(() => {
    throw new protocol.BotTurnOutcomeSchemaError('schema-over-budget', 'still too large');
  });
  const id = await bot!.input('schema-cap', 'request');
  expect(compose).toHaveBeenCalled();
  for (const [fragments] of compose.mock.calls) {
    expect(fragments.create_routine!.items!.properties!.localId!.enum).toEqual(['new_routine_1']);
  }
  expect(compose.mock.calls.some(([fragments]) => fragments.create_routine!.items!.properties!.schedule!.oneOf === undefined)).toBe(true);
  expect(bot!.snapshot().turns[id]).toMatchObject({ status: 'blocked', blockedReason: expect.stringContaining('after flat fallback') });
  expect(bot!.core.intent(id)).toBeUndefined();
});

it('reserves rejected feedback in frozen input and releases it when the execution never starts', async () => {
  await setup();
  ledger!.transaction(s => { stateOf(s.application).rejected.push({ taskId: 'prior', action: 'delegate', reason: 'not-yet-seen' }); });
  const first = await bot!.input('first-reader', 'read feedback');
  const task = bot!.core.intent(first)!.taskId;
  const frozen = structuredClone(ledger!.snapshot().executions[task]!.input);
  expect(String(frozen.payload.instruction)).toContain('not-yet-seen');
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBe(first);
  await bot!.drain();
  expect(ledger!.snapshot().executions[task]!.input).toEqual(frozen);
  await bot!.cancelTurn(first);
  expect(bot!.core.intent(first)!.conclusion).toBe('cancelled');
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBeUndefined();
  const next = await bot!.input('next-reader', 'read feedback');
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBe(next);
});

it('reduces older history with an explicit notice when the current request fits', () => {
  const state = stateOf({});
  for (let n = 0; n < 2; n++) state.turns[`large-${n}`] = { id: `large-${n}`, root: 'root', source: 'user',
    request: 'x'.repeat(18_000), hop: 0, status: 'succeeded' };
  const context = contextPack(state, 12);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(32 * 1024);
  expect(context.historyWindow.omittedTurns).toBe(1);
  expect(context.turns.map(turn => turn.id)).toEqual(['large-1']);
});

it('cannot admit an unchanged oversized request by aging it out of the history window', async () => {
  await setup();
  const oversized = await bot!.input('oversized-current', 'x'.repeat(40_000));
  expect(bot!.snapshot().turns[oversized]!.status).toBe('blocked');
  for (let n = 0; n < 13; n++) await bot!.input(`short-${n}`, 'short');
  expect(bot!.snapshot().turns[oversized]!.status).toBe('blocked');
  expect(bot!.core.intent(oversized)).toBeUndefined();
});

it('cancels a blocked turn before admission without an intent or repeat publication', async () => {
  vi.useFakeTimers();
  await setup({ contextMaxBytes: 1 });
  const id = await bot!.input('cancel-before-admission', 'request');
  await bot!.cancelTurn(id);
  expect(bot!.snapshot().turns[id]).toMatchObject({ status: 'failed', conclusion: 'cancelled', reported: true });
  expect(bot!.core.intent(id)).toBeUndefined();
  await bot!.core.flushProjections(async () => {});
  await bot!.cancelTurn(id);
  expect(Object.values(ledger!.snapshot().outbox).filter(row => row.kind === 'projection')).toEqual([]);
  const transactions = vi.spyOn(ledger!, 'transaction');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transactions).not.toHaveBeenCalled();
});

it('settles a blocked routine occurrence on cancellation so a pending version can activate', async () => {
  vi.useFakeTimers();
  await setup({ contextMaxBytes: 512 });
  const id = ledger!.transaction(s => createRoutine(stateOf(s.application), 'main', 'blocked-routine', 0,
    { localId: 'new_routine_1', schedule: { minute: 0, hour: 9, tz: 'UTC' }, prompt: '😀'.repeat(500) }, Date.now()).id);
  await bot!.drain();
  const slot = bot!.snapshot().routines[id]!.armed!;
  vi.setSystemTime(slot.at);
  await bot!.consume({ wakeId: 'blocked-slot', dedupKey: slot.key, availableAt: slot.at, deliveredAt: slot.at, delivery: 1 }, new AbortController().signal);
  const turn = Object.values(bot!.snapshot().turns)[0]!;
  expect(turn.status).toBe('blocked');
  await bot!.updateRoutine({ routineId: id, prompt: 'short' });
  expect(bot!.snapshot().routines[id]!.pending).toBe(2);
  await bot!.cancelTurn(turn.id);
  expect(bot!.snapshot().occurrences[slot.key]!.settled).toBe(true);
  expect(bot!.snapshot().routines[id]).toMatchObject({ current: 2, pending: null, inflight: [] });
  expect(bot!.core.intent(turn.id)).toBeUndefined();
});
