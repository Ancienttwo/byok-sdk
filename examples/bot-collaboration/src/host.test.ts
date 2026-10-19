import { afterEach, expect, it, vi } from 'vitest';
import { HostLedger } from '@byok-sdk/example-host-execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import type { ExecutionServer } from '@byok-sdk/example-host-execution-core';
import { BotCollaboration, type BotOptions } from './host';
import { contextPack } from './schema';
import { stateOf } from './model';
import { createRoutine } from './routines';

let fixture: TestHost;
let bot: BotCollaboration;
let extra: HostLedger | undefined;
afterEach(async () => { await bot?.close(); extra?.close(); extra = undefined; await fixture?.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup(rest: Partial<BotOptions> = {}, wrap?: (server: ExecutionServer) => ExecutionServer) {
  fixture = await openHost({
    consume: (wake, signal) => bot.consume(wake, signal),
    agentMessage: { consume: async () => ({ outcome: 'accepted' }) },
  });
  const base = template(fixture.deviceId);
  const options: BotOptions = { botId: 'main', execution: { ...base, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'k8a' }, payload: {
    ...base.payload, messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
  } }, connector: async id => ({ ok: true, externalId: id }), ...rest };
  bot = new BotCollaboration(wrap?.(fixture.server) ?? fixture.server, fixture.ledger, options);
  return options;
}
async function running(id: string) {
  await vi.waitFor(() => expect(fixture.adapter.sessions.has(bot.core.intent(id)!.taskId)).toBe(true), { timeout: 5000 });
  return fixture.adapter.sessions.get(bot.core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  (await running(id)).finish(document);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}

it('runs submit_result -> self delegation -> confirmation -> connector -> action_result through the real SDK and daemon', async () => {
  const connector = vi.fn(async (id: string) => ({ ok: true, externalId: id }));
  const options = await setup({ connector });
  const root = await bot.input('long-task', 'Prepare a message');
  await finish(root, { delegate: [{ to: 'main', request: 'Prepare the final draft' }] });
  const child = Object.values(bot.snapshot().turns).find(t => t.source === 'continuation')!;
  expect(bot.snapshot().budgets[root]).toEqual({ continuation: 1, delegation: 0 });
  expect(child.hop).toBe(0);
  await finish(child.id, { confirmable_action: [{ action: 'send_message', summary: 'Send draft', draft: { text: 'Hello' } }] });
  const card = Object.values(bot.snapshot().cards)[0]!;
  expect(card.state).toBe('pending');
  expect(connector).not.toHaveBeenCalled();
  const offer = await fixture.server.tasks.offer(bot.core.intent(child.id)!.taskId);
  expect(offer?.payload).toMatchObject({ terminalProjection: { contract: 'bot-turn-outcome.v1' } });
  if (!offer || !('instruction' in offer.payload)) throw new Error('Expected an instruction offer');
  expect(String(offer?.payload.instruction)).toContain('ContextPack:');
  expect(String(offer?.payload.instruction)).toContain('four continuations');
  expect(offer?.payload).not.toHaveProperty('requiredToolsets');
  await bot.decide(card.id, 'confirmed');
  expect(bot.snapshot().cards[card.id]).toMatchObject({ state: 'confirmed', result: { ok: true, externalId: card.id } });
  const result = Object.values(bot.snapshot().turns).find(t => t.source === 'action_result')!;
  await finish(result.id);
  await bot.decide(card.id, 'confirmed');
  await bot.close();
  extra = new HostLedger(`${fixture.root}/host.sqlite`, fixture.ledger.tenant);
  bot = new BotCollaboration(fixture.server, extra, options);
  await bot.recover();
  expect(connector).toHaveBeenCalledTimes(1);
  expect(fixture.adapter.starts).toHaveLength(3);
  expect(Object.keys(fixture.ledger.snapshot().applied)).toHaveLength(3);
});

it('returns ask_user answers and keeps rejected and expired cards free of connector calls', async () => {
  let now = Date.now();
  const connector = vi.fn(async () => ({ ok: true }));
  await setup({ now: () => now, connector });
  const root = await bot.input('questions', 'Ask me');
  await finish(root, { ask_user: { question: 'Choose', answerKind: 'single_choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    confirmable_action: [{ action: 'send_message', summary: 'Reject this', draft: { text: 'a' } }] });
  const question = Object.values(bot.snapshot().questions)[0]!;
  await expect(bot.answer(question.id, 'invalid')).rejects.toThrow('Invalid answer');
  await bot.answer(question.id, 'a');
  const answer = Object.values(bot.snapshot().turns).find(t => t.source === 'answer')!;
  await finish(answer.id, { confirmable_action: [{ action: 'send_message', summary: 'Expire this', draft: { text: 'b' } }] });
  const cards = Object.values(bot.snapshot().cards);
  await bot.decide(cards[0]!.id, 'rejected');
  now += 86_400_001;
  await expect(bot.decide(cards[1]!.id, 'confirmed')).rejects.toThrow('Card expired');
  expect(bot.snapshot().cards[cards[0]!.id]!.state).toBe('rejected');
  expect(bot.snapshot().cards[cards[1]!.id]!.state).toBe('expired');
  expect(connector).not.toHaveBeenCalled();
});

it('caps self continuations at four and includes policy rejection in the next frozen ContextPack', async () => {
  await setup();
  const root = await bot.input('budget', 'Work');
  let id = root;
  for (let i = 0; i < 5; i++) {
    await finish(id, { delegate: [{ to: 'main', request: `step ${i}` }] });
    if (i < 4) id = Object.values(bot.snapshot().turns).filter(t => t.source === 'continuation').at(-1)!.id;
  }
  expect(bot.snapshot().budgets[root]).toEqual({ continuation: 4, delegation: 0 });
  expect(Object.values(bot.snapshot().turns)).toHaveLength(5);
  expect(contextPack(bot.snapshot()).rejectedActions).toContainEqual(expect.objectContaining({ action: 'delegate', reason: 'Continuation budget is 4' }));
  const next = await bot.input('next', 'What happened?');
  const offer = await fixture.server.tasks.offer(bot.core.intent(next)!.taskId);
  if (!offer || !('instruction' in offer.payload)) throw new Error('Expected an instruction offer');
  expect(String(offer?.payload.instruction)).toContain('Continuation budget is 4');
  await finish(next);
});

it('reports a failed continuation and a failed confirmed connector result', async () => {
  await setup({ connector: async () => { throw new Error('provider refused'); } });
  const root = await bot.input('failure', 'Work');
  await finish(root, { delegate: [{ to: 'main', request: 'continue' }], confirmable_action: [{ action: 'send_message', summary: 'send', draft: { text: 'x' } }] });
  const child = Object.values(bot.snapshot().turns).find(t => t.source === 'continuation')!;
  (await running(child.id)).fail();
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[child.id]?.status).toBe('failed'); }, { timeout: 5000 });
  const projections = Object.values(fixture.ledger.snapshot().outbox).filter(o => o.kind === 'projection');
  expect(projections).toContainEqual(expect.objectContaining({ id: `bot-turn:${child.id}`, value: expect.objectContaining({ status: 'failed' }) }));
  const card = Object.values(bot.snapshot().cards)[0]!;
  await bot.decide(card.id, 'confirmed');
  const result = Object.values(bot.snapshot().turns).find(t => t.source === 'action_result')!;
  expect(result.request).toContain('provider refused');
  await finish(result.id);
});

it('runs a real scheduled wake and returns the routine result to its owner', async () => {
  // Set Date before startup so presence and deadlines never see a rollback.
  // Real timers, sockets, and the result helper stay live.
  vi.useFakeTimers({ toFake: ['Date'] });
  const minute = Math.ceil(Date.now() / 60_000) * 60_000;
  vi.setSystemTime(minute - 30_000);
  await setup();
  const root = await bot.input('routine', 'Create my daily routine');
  const date = new Date(minute);
  await finish(root, { create_routine: [{ localId: 'new_routine_1', schedule: { hour: date.getUTCHours(), minute: date.getUTCMinutes(), tz: 'UTC' }, prompt: 'Daily report' }] });
  vi.setSystemTime(minute + 1);
  // Re-arm the real timer after the synthetic Date jump. No wake row is removed.
  await fixture.server.wakes.cancel('clock-rearm-no-row');
  await vi.waitFor(async () => { await bot.drain(); expect(Object.values(bot.snapshot().turns).some(t => t.source === 'routine')).toBe(true); }, { timeout: 5000 });
  const routineTurn = Object.values(bot.snapshot().turns).find(t => t.source === 'routine')!;
  await finish(routineTurn.id);
  expect(Object.values(bot.snapshot().occurrences)[0]).toMatchObject({ decision: 'run', settled: true, definition: { prompt: 'Daily report', target: 'main' } });
  expect(Object.values(fixture.ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'projection', id: `bot-turn:${routineTurn.id}`, value: expect.objectContaining({ owner: 'main', source: 'routine', status: 'succeeded' }) }));
  const routine = Object.values(bot.snapshot().routines)[0]!;
  const emptyUpdate = await bot.input('empty-update', 'No changes');
  await finish(emptyUpdate, { update_routine: [{ routineId: routine.id }] });
  expect(bot.snapshot().routines[routine.id]!.current).toBe(1);
  expect(bot.snapshot().rejected).toContainEqual(expect.objectContaining({ action: 'update_routine', reason: 'An update must change schedule or prompt' }));
  const update = await bot.input('update-routine', 'Change the report');
  await finish(update, { update_routine: [{ routineId: routine.id, prompt: 'New daily report' }] });
  expect(bot.snapshot().routines[routine.id]).toMatchObject({ current: 2, pending: null, armed: { version: 2 } });
  const cancelTurn = await bot.input('cancel-routine', 'Stop the daily routine');
  await finish(cancelTurn, { cancel_routine: [{ routineId: routine.id }] });
  expect(bot.snapshot().routines[routine.id]).toMatchObject({ lifecycle: 'completed', armed: null });
  expect((await fixture.server.wakes.pending()).filter(w => w.dedupKey.startsWith(routine.id))).toEqual([]);
});

it('settles old work before switching pending version, including pause and resume', async () => {
  let now = Date.now();
  await setup({ now: () => now });
  const schedule = { hour: 9, minute: 0, tz: 'UTC' };
  const routineId = fixture.ledger.transaction(s => createRoutine(stateOf(s.application), 'main', 'seed', 0,
    { localId: 'new_routine_1', schedule, prompt: 'v1 prompt' }, now).id);
  await bot.drain();
  const oldSlot = bot.snapshot().routines[routineId]!.armed!;
  now = oldSlot.at;
  await bot.consume({ wakeId: 'manual', dedupKey: oldSlot.key, availableAt: oldSlot.at, deliveredAt: now, delivery: 1 }, new AbortController().signal);
  const old = Object.values(bot.snapshot().turns).find(t => t.source === 'routine')!;
  await running(old.id);
  await bot.updateRoutine({ routineId, prompt: 'v2 prompt' });
  await bot.setRoutineLifecycle(routineId, 'paused');
  await bot.setRoutineLifecycle(routineId, 'active');
  expect(bot.snapshot().routines[routineId]).toMatchObject({ current: 1, pending: 2, armed: { version: 1 } });
  await finish(old.id);
  expect(bot.snapshot().routines[routineId]).toMatchObject({ current: 2, pending: null, inflight: [], armed: { version: 2 } });
  const stored = bot.snapshot().occurrences[oldSlot.key]!;
  expect(stored.definition?.prompt).toBe('v1 prompt');
  await bot.consume({ wakeId: 'manual', dedupKey: oldSlot.key, availableAt: oldSlot.at, deliveredAt: now + 120_000, delivery: 2 }, new AbortController().signal);
  expect(bot.snapshot().occurrences[oldSlot.key]).toEqual(stored);
});

it('puts an invalid routine action in ContextPack and still applies a valid self delegation', async () => {
  await setup();
  const root = await bot.input('bad-schedule', 'Create a report');
  await finish(root, { create_routine: [{ localId: 'new_routine_1', schedule: { hour: 9, minute: 0, dayOfMonth: 31, month: 4, tz: 'UTC' }, prompt: 'Impossible date' }],
    delegate: [{ to: 'main', request: 'Explain the refusal' }] });
  expect(Object.values(bot.snapshot().routines)).toEqual([]);
  expect(bot.snapshot().rejected).toContainEqual(expect.objectContaining({ action: 'create_routine', reason: expect.stringContaining('schedule_unreachable') }));
  const child = Object.values(bot.snapshot().turns).find(t => t.source === 'continuation')!;
  await running(child.id);
  const offer = await fixture.server.tasks.offer(bot.core.intent(child.id)!.taskId);
  if (!offer || !('instruction' in offer.payload)) throw new Error('Expected an instruction offer');
  expect(String(offer.payload.instruction)).toContain('schedule_unreachable');
  await finish(child.id);
});

it('replays a committed confirmation with the same connector key after restart', async () => {
  const keys: string[] = [];
  const options = await setup({ connector: async id => { keys.push(id); return { externalId: id }; } });
  const root = await bot.input('replay', 'Send');
  await finish(root, { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
  const card = Object.values(bot.snapshot().cards)[0]!;
  await bot.close();
  // Crash boundary: confirmation committed, connector result not committed.
  fixture.ledger.transaction(s => { stateOf(s.application).cards[card.id]!.state = 'confirmed'; });
  options.connector = async id => { keys.push(id); return { externalId: id }; };
  extra = new HostLedger(`${fixture.root}/host.sqlite`, fixture.ledger.tenant);
  bot = new BotCollaboration(fixture.server, extra, options);
  await bot.recover();
  const result = Object.values(bot.snapshot().turns).find(t => t.source === 'action_result')!;
  await finish(result.id);
  await bot.recover();
  expect(keys).toEqual([card.id]);
  expect(bot.snapshot().cards[card.id]).toMatchObject({ state: 'confirmed', result: { externalId: card.id } });
});

it('serializes a blocked cancel before resume schedules the same future key', async () => {
  let release!: () => void;
  let entered!: () => void;
  const cancelled = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let intercept = false;
  const calls: string[] = [];
  await setup({}, server => ({ ...server, wakes: { ...server.wakes,
    cancel: async key => {
      if (intercept && !key.startsWith('host-scan:')) { calls.push('cancel'); entered(); await blocked; intercept = false; }
      return server.wakes.cancel(key);
    },
    schedule: async input => { if (!input.dedupKey.startsWith('host-scan:')) calls.push('schedule'); return server.wakes.schedule(input); },
  } }));
  const id = fixture.ledger.transaction(s => createRoutine(stateOf(s.application), 'main', 'ordered', 0,
    { localId: 'new_routine_1', schedule: { hour: 9, minute: 0, tz: 'UTC' }, prompt: 'run' }, Date.now()).id);
  await bot.drain();
  const original = bot.snapshot().routines[id]!.armed!;
  intercept = true;
  const pause = bot.setRoutineLifecycle(id, 'paused');
  await cancelled;
  const resume = bot.setRoutineLifecycle(id, 'active');
  expect(calls).toEqual(['schedule', 'cancel']);
  release(); await Promise.all([pause, resume]);
  expect(calls).toEqual(['schedule', 'cancel', 'schedule']);
  expect(bot.snapshot().routines[id]!.armed!.key).toBe(original.key);
  expect((await fixture.server.wakes.pending()).map(w => w.dedupKey)).toContain(original.key);
});

it('reports a missing outcome as failure and exposes cancellation through the serial Host entrypoint', async () => {
  await setup();
  const missing = await bot.input('missing-outcome', 'Return a result');
  (await running(missing)).finish({}, false);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[missing]?.status).toBe('failed'); }, { timeout: 5000 });
  const cancelled = await bot.input('cancel-turn', 'Stop this work');
  await running(cancelled);
  await vi.waitFor(async () => expect(await fixture.server.tasks.attempt(bot.core.intent(cancelled)!.taskId))
    .toMatchObject({ claimedRuntime: 'pi', ownerDeviceId: fixture.deviceId }), { timeout: 5000 });
  await bot.cancelTurn(cancelled);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[cancelled]).toMatchObject({ status: 'failed', conclusion: 'cancelled' }); }, { timeout: 5000 });
});

it('drains immediate real SDK terminals to a fixed point without stranding a continuation', async () => {
  await setup({}, server => ({ ...server, executions: { submit: async input => {
    const result = await server.executions.submit(input);
    await vi.waitFor(() => expect(fixture.adapter.sessions.has(input.taskId)).toBe(true), { timeout: 5000 });
    fixture.adapter.sessions.get(input.taskId)!.finish({ delegate: [{ to: 'main', request: 'Continue this bounded chain' }] });
    await vi.waitFor(async () => expect(await server.tasks.deviceTerminal(input.taskId)).toBeDefined(), { timeout: 5000 });
    return result;
  } } }));
  const root = await bot.input('immediate-chain', 'Work through this chain');
  expect(Object.values(bot.snapshot().turns)).toHaveLength(5);
  expect(Object.values(bot.snapshot().turns).every(turn => turn.status === 'succeeded')).toBe(true);
  expect(bot.snapshot().budgets[root]).toEqual({ continuation: 4, delegation: 0 });
  expect(fixture.adapter.starts).toHaveLength(5);
  expect(bot.snapshot().rejected).toContainEqual(expect.objectContaining({ action: 'delegate', reason: 'Continuation budget is 4' }));
});

it('rejects duplicate targets and option ids without consuming a second continuation', async () => {
  await setup();
  const root = await bot.input('duplicate-actions', 'Choose');
  await finish(root, { delegate: [{ to: 'main', request: 'one' }, { to: 'main', request: 'two' }],
    ask_user: { question: 'Choose', answerKind: 'single_choice', options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] } });
  expect(bot.snapshot().budgets[root]).toEqual({ continuation: 1, delegation: 0 });
  expect(Object.values(bot.snapshot().questions)).toEqual([]);
  expect(bot.snapshot().rejected).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'delegate', reason: 'Duplicate delegation target' }),
    expect.objectContaining({ action: 'ask_user', reason: 'Duplicate option id' }),
  ]));
  const child = Object.values(bot.snapshot().turns).find(t => t.source === 'continuation')!;
  await finish(child.id);
});

it('gives a user answer a new stable continuation budget', async () => {
  await setup();
  const root = await bot.input('answer-budget', 'Ask a question');
  await finish(root, { ask_user: { question: 'Continue?', answerKind: 'text' } });
  fixture.ledger.transaction(s => { stateOf(s.application).budgets[root]!.continuation = 4; });
  const question = Object.values(bot.snapshot().questions)[0]!;
  await bot.answer(question.id, 'Yes');
  await bot.answer(question.id, 'Yes');
  const answer = Object.values(bot.snapshot().turns).find(t => t.source === 'answer')!;
  expect(answer.root).toBe(answer.id);
  expect(bot.core.intent(answer.id)?.source).toBe('user');
  await finish(answer.id, { delegate: [{ to: 'main', request: 'Continue after the answer' }] });
  expect(bot.snapshot().budgets[root]!.continuation).toBe(4);
  expect(bot.snapshot().budgets[answer.id]!.continuation).toBe(1);
  expect(Object.values(bot.snapshot().turns).filter(t => t.source === 'answer')).toHaveLength(1);
  const child = Object.values(bot.snapshot().turns).find(t => t.source === 'continuation')!;
  await finish(child.id);
});

it('replays the same connector key after an external effect and a failed SQLite result commit', async () => {
  const effects = new Map<string, string>();
  const calls: string[] = [];
  const options = await setup({ connector: async id => {
    calls.push(id);
    if (!effects.has(id)) effects.set(id, `external-${effects.size + 1}`);
    return { externalId: effects.get(id)! };
  } });
  const root = await bot.input('effect-before-crash', 'Send');
  await finish(root, { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
  const card = Object.values(bot.snapshot().cards)[0]!;
  const transaction = fixture.ledger.transaction.bind(fixture.ledger);
  const fault = vi.spyOn(fixture.ledger, 'transaction').mockImplementation(apply => transaction(state => {
    const value = apply(state);
    if (stateOf(state.application).cards[card.id]?.result !== undefined) throw new Error('result commit lost');
    return value;
  }));
  await expect(bot.decide(card.id, 'confirmed')).rejects.toThrow('result commit lost');
  fault.mockRestore();
  expect(effects.size).toBe(1);
  expect(bot.snapshot().cards[card.id]).toMatchObject({ state: 'confirmed' });
  expect(bot.snapshot().cards[card.id]!.result).toBeUndefined();
  await bot.close();
  extra = new HostLedger(`${fixture.root}/host.sqlite`, fixture.ledger.tenant);
  bot = new BotCollaboration(fixture.server, extra, options);
  await bot.recover();
  expect(calls).toEqual([card.id, card.id]);
  expect(effects.size).toBe(1);
  const result = Object.values(bot.snapshot().turns).find(t => t.source === 'action_result')!;
  expect(result.request).toContain('external-1');
  await finish(result.id);
});

it('delivers rejected feedback to the Bot once while preserving the first frozen ContextPack', async () => {
  await setup();
  const root = await bot.input('feedback-root', 'Create a report');
  await finish(root, { create_routine: [{ localId: 'new_routine_1', schedule: { hour: 9, minute: 0, dayOfMonth: 31, month: 4, tz: 'UTC' }, prompt: 'invalid' }],
    delegate: [{ to: 'main', request: 'Explain the refusal' }] });
  const child = Object.values(bot.snapshot().turns).find(t => t.source === 'continuation')!;
  const task = bot.core.intent(child.id)!.taskId;
  const frozen = structuredClone(fixture.ledger.snapshot().executions[task]!.input);
  const firstContext = JSON.parse(String(frozen.payload.instruction).split('\n\nContextPack:\n')[1]!);
  expect(firstContext.rejectedActions[0].reason).toContain('schedule_unreachable');
  expect(bot.snapshot().rejected[0]!.consumedBy).toBe(child.id);
  await finish(child.id);
  await vi.waitFor(() => expect(fixture.daemon.status().activeTaskCount).toBe(0), { timeout: 5000 });
  fixture.ledger.transaction(s => { stateOf(s.application).rejected.push({ taskId: 'new-policy', action: 'delegate', reason: 'new-feedback' }); });
  const next = await bot.input('feedback-next', 'What changed?');
  const input = fixture.ledger.snapshot().executions[bot.core.intent(next)!.taskId]!.input;
  const nextContext = JSON.parse(String(input.payload.instruction).split('\n\nContextPack:\n')[1]!);
  expect(nextContext.rejectedActions.map((r: { reason: string }) => r.reason)).toEqual(['new-feedback']);
  expect(fixture.ledger.snapshot().executions[task]!.input).toEqual(frozen);
  await finish(next);
});
