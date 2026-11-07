import { afterEach, expect, it, vi } from 'vitest';
import type { AgentExecutionInput } from '@byok-sdk/cloud';
import { HostLedger, hash, occurrenceIntentKey, setLifecycle, type ExecutionTemplate, type Routine } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { botCompactVeto } from './compaction';
import { DEFAULT_DREAM_MAX_DURATION_MS, DREAM_WAIT_MS, dreamPolicy, reconcileDreamRoutines, syncDreams } from './dream';
import { DEFAULT_INSTRUCTION_MAX_BYTES } from './delegation';
import { BotCollaboration, type BotOptions } from './host';
import { stateOf } from './model';
import { BOT_DREAM, botRoutines, routineCalendar } from './routines';
import { deliverRoutine, routineOf, seedRoutine } from './routines.test-support';
import { TENANT_A, createHarness } from '../../../packages/cloud/src/__tests__/support/harness';
import { seedCollaboration } from './commit-vectors.test-support';

let fixture: TestHost | undefined, bot: BotCollaboration | undefined, clock = 0;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = fixture = undefined; });
const ZONE = 'Asia/Hong_Kong';
const WINDOW_START = Date.UTC(2026, 0, 1), WINDOW_END = WINDOW_START + 1000;
function offlineDream(nativeSessions?: boolean, harnessOnly = false): AgentExecutionInput {
  const ledger = new HostLedger(':memory:', TENANT_A), models = { default: template('device') }, policy = dreamPolicy({ timeZone: ZONE, nativeSessions })!;
  ledger.transaction(s => {
    const state = stateOf(s.application); seedCollaboration(state); state.turns.t1!.status = 'succeeded';
    if (harnessOnly) {
      const { runtime: _runtime, ...payload } = state.team.bots.main!.execution.payload;
      state.team.bots.main!.execution.payload = { ...payload, harnessId: 'test-harness' };
    }
    reconcileDreamRoutines(s, policy, models, WINDOW_START);
    const routine = Object.values(s.routines)[0]!, key = 'dream-key';
    s.occurrences[key] = { key, routineId: routine.definition.id, definitionVersion: 1, trigger: { kind: 'scheduled', plannedAt: WINDOW_END },
      wakeKey: 'wake', recordedAt: WINDOW_END, nextAt: null, hook: {}, attempts: 0 };
    state.dreams!.open[key] = { botId: 'main', windowEnd: WINDOW_END };
    syncDreams(s, { tenant: TENANT_A, policy, models, instructionMaxBytes: DEFAULT_INSTRUCTION_MAX_BYTES, now: WINDOW_END, refused: () => false, historyMode: false });
  });
  const execution = ledger.snapshot().intents[hash(occurrenceIntentKey('dream-key'))]!.execution as AgentExecutionInput;
  ledger.close(); return execution;
}
it('freezes the default native session request with the dream window', () => {
  expect(offlineDream().payload.nativeSessions).toEqual({ fromMs: WINDOW_START, toMs: WINDOW_END, ifAdvertised: true });
});
it('promotes a harness-only Bot template with the native session request', () => {
  expect(offlineDream(true, true).payload).toMatchObject({ harnessId: 'test-harness', nativeSessions: { fromMs: WINDOW_START, toMs: WINDOW_END, ifAdvertised: true } });
});
async function open(rest: Partial<BotOptions> = {}): Promise<BotCollaboration> {
  fixture ??= await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
  clock ||= Date.now();
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', execution: template(fixture.deviceId), connector: async () => null,
    now: () => clock, dreaming: { timeZone: ZONE }, ...rest });
  await bot.recover();
  return bot;
}
const dreamRoutines = (state = 'open') => Object.values(bot!.ledger.snapshot().routines).filter(row => row.definition.hostOccurrence?.type === BOT_DREAM
  && (state === 'all' || row.lifecycle !== 'completed'));
const only = () => { const [routine, ...rest] = dreamRoutines(); expect(rest).toEqual([]); return routine!; };
const record = (botId = 'main') => bot!.snapshot().dreams?.bots[botId];
const intentOf = (routine: Routine) => Object.values(bot!.ledger.snapshot().occurrences).filter(row => row.routineId === routine.definition.id).at(-1)!.key;
/** Moves the clock to the dream slot and delivers it. Returns the K4 intent key of the occurrence. */
async function due(): Promise<string> {
  const routine = only();
  clock = routine.next!.availableAt;
  await deliverRoutine(bot!, routine.definition.id, clock);
  return occurrenceIntentKey(intentOf(routine));
}
const session = async (key: string) => {
  await vi.waitFor(async () => {
    await bot!.drain();
    // K4 must observe the claim before a test moves the clock, or the wait limit expires the work.
    expect(fixture!.ledger.snapshot().executions[bot!.core.intent(key)!.taskId]?.started).toBe(true);
    expect(fixture!.adapter.sessions.has(bot!.core.intent(key)!.taskId)).toBe(true);
  }, { timeout: 5000 });
  return fixture!.adapter.sessions.get(bot!.core.intent(key)!.taskId)!;
};
async function finish(key: string, document: unknown = {}) {
  await (await session(key)).finish(document);
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.core.intent(key)?.conclusion).toBeDefined(); }, { timeout: 5000 });
}
/** One completed Turn of the Main Bot. */
async function completedTurn(text: string) {
  const turn = await bot!.input(text, text);
  await finish(turn, {});
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[turn]?.status).toBe('succeeded'); }, { timeout: 5000 });
}

it('keeps one dream routine per unarchived Bot: created, ended on archive, restored by recover, and hidden from Bot routines', async () => {
  await open({ team: 'external', persona: 'external' });
  const member = (id: string) => ({ id, name: id, role: 'r', persona: '', model: 'default', mainBot: false, profileRevision: '1' });
  await bot!.applyTeam({ revision: 1, bots: [{ ...member('main'), mainBot: true }, member('other')] });
  const owners = () => dreamRoutines().map(row => (row.definition.hostOccurrence!.input as { owner: string }).owner).sort();
  expect(owners()).toEqual(['main', 'other']);
  expect(dreamRoutines()[0]!.definition).toMatchObject({ timeZone: ZONE, rule: { minute: 0, hour: 3, tz: ZONE }, waitMs: DREAM_WAIT_MS });
  expect(botRoutines(dreamRoutines())).toEqual([]);
  await bot!.applyTeam({ revision: 2, bots: [{ ...member('main'), mainBot: true }] });
  expect(owners()).toEqual(['main']);
  const ended = only().definition.id;
  bot!.ledger.transaction(s => setLifecycle(s, ended, 'completed', clock, routineCalendar));
  await bot!.recover();
  expect(owners()).toEqual(['main']);
  expect(only().definition.id).not.toBe(ended);
});

it('stores the local time zone at creation, and moves a routine only to an explicit zone', async () => {
  await open({ dreaming: {} });
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(only().definition.timeZone).toBe(local);
  await bot!.close();
  await open({ dreaming: { timeZone: ZONE } });
  expect((only().pending ?? only().definition).timeZone).toBe(ZONE);
});

it('dreaming: false ends the routines and adds none', async () => {
  await open();
  expect(dreamRoutines()).toHaveLength(1);
  await bot!.close();
  await open({ dreaming: false });
  expect(dreamRoutines()).toEqual([]);
  expect(dreamRoutines('all')).toHaveLength(1);
});

it('offers a fresh writer with agentMemory none, keeps the Host out of its intent, and skips a day with no new Turn', async () => {
  await open();
  const fromMs = record()!.since;
  await completedTurn('The release moved to Friday');
  const key = await due(), intent = bot!.core.intent(key)!;
  expect(intent).toMatchObject({ source: 'routine' });
  const { payload, ...execution } = intent.execution as ExecutionTemplate;
  expect(execution).toEqual({ deviceId: fixture!.deviceId });
  expect(payload).toMatchObject({ agentMemory: 'none', session: { mode: 'fresh' }, agentRef: { agentId: 'main' }, terminalProjection: { mode: 'none' },
    limits: { maxDurationMs: DEFAULT_DREAM_MAX_DURATION_MS }, nativeSessions: { fromMs, toMs: clock, ifAdvertised: true } });
  for (const field of ['agentMemoryCommit', 'homeAccess', 'messageEgress', 'requiredToolsets', 'preparation', 'harnessId']) expect(payload).not.toHaveProperty(field);
  expect(bot!.ledger.snapshot().intents[intent.id]!.execution.payload.nativeSessions).toEqual(payload.nativeSessions);
  expect(payload.instruction).toContain('The release moved to Friday');
  await expect(bot!.cancelHostIntent(key)).rejects.toMatchObject({ code: 'unknown_intent' });
  await expect(bot!.failStuckIntent(key)).rejects.toMatchObject({ code: 'not_stuck' });
  await expect(bot!.enqueueHostIntent({ key, source: 'bot', execution: template(fixture!.deviceId), waitUntil: clock + 1000 }, 'any')).rejects.toThrow();
  await finish(key, undefined);
  expect(record()).toMatchObject({ since: clock, last: { outcome: 'succeeded', template: 'default', fallback: true } });
  await due();
  expect(record()?.last).toMatchObject({ outcome: 'skipped', reason: 'no_new_turns' });
  expect(Object.values(bot!.ledger.snapshot().occurrences).at(-1)).toMatchObject({ conclusion: 'cancelled' });

  // A Turn that user input overtook stays ahead of the mark until it ends, so no dream loses it.
  const busy = await bot!.input('busy', 'Busy fact');
  await session(busy);
  const routine = await seedRoutine(bot!, 'late-routine', 'Late routine fact', { minute: 0, hour: 2, tz: ZONE });
  clock = routineOf(bot!, routine).next!.availableAt;
  await deliverRoutine(bot!, routine, clock);
  const late = Object.values(bot!.snapshot().turns).find(turn => turn.source === 'routine')!.id;
  const user = await bot!.input('user', 'User fact');
  await finish(busy, {});
  await finish(user, {});
  await session(late);
  const partial = await due();
  const { instruction: first } = bot!.core.intent(partial)!.execution.payload as { instruction: string };
  expect(first).toContain('Busy fact');
  expect(first).not.toContain('User fact');
  await finish(late, {});
  await finish(partial, undefined);
  expect(record()?.throughTurn).toBe(busy);
  const rest = (bot!.core.intent(await due())!.execution.payload as { instruction: string }).instruction;
  expect(rest).toContain('Late routine fact');
  expect(rest).toContain('User fact');
  expect(rest).not.toContain('Busy fact');
});

it('omits native sessions when disabled', async () => {
  expect(offlineDream(false).payload).not.toHaveProperty('nativeSessions');
});

it('omits native sessions from the cloud offer when the device does not advertise them', async () => {
  const execution = offlineDream();
  const harness = createHarness(), device = await harness.pairDevice(TENANT_A);
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [
    'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection', 'agent-memory-selection',
  ] });
  await harness.cloud.submitAgentExecution(TENANT_A, { ...execution, deviceId: device.deviceId, taskId: 'dream' });
  expect((await harness.cloud.readTaskOffer(TENANT_A, 'dream'))!.payload).not.toHaveProperty('nativeSessions');
  expect(execution.payload.nativeSessions).toMatchObject({ ifAdvertised: true });
});

it('takes the first listed template on the Bot device, falls back to the Bot template, and skips without one', async () => {
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
  const own = template(fixture.deviceId), cheap = { ...own, payload: { ...own.payload, limits: { maxTokens: 7 } } };
  await open({ models: { default: own, far: template('other-device'), cheap }, dreaming: { timeZone: ZONE, models: ['gone', 'far', 'cheap'] } });
  await completedTurn('one');
  const first = await due();
  expect(bot!.core.intent(first)!.execution.payload).toMatchObject({ limits: { maxTokens: 7, maxDurationMs: DEFAULT_DREAM_MAX_DURATION_MS } });
  // The stub device declines `maxTokens`, and a dream that did not succeed keeps its window.
  await vi.waitFor(async () => { await bot!.drain(); expect(record()?.last).toMatchObject({ template: 'cheap', fallback: false, outcome: 'declined' }); }, { timeout: 5000 });
  await bot!.setModels({ default: own });
  const second = await due();
  expect(bot!.core.intent(second)!.execution.payload.instruction).toContain('one');
  await finish(second, undefined);
  expect(record()?.last).toMatchObject({ template: 'default', fallback: true, outcome: 'succeeded' });
  await completedTurn('three');
  await bot!.setModels({ far: template('other-device') });
  await due();
  expect(record()?.last).toMatchObject({ outcome: 'skipped', reason: 'model_unavailable' });
});

it('queues behind user Turns, and a newer slot supersedes a queued dream', async () => {
  await open();
  await completedTurn('history');
  const running = await bot!.input('busy', 'busy');
  await session(running);
  const dream = await due();
  const later = await bot!.input('later', 'later');
  const sequence = (key: string) => bot!.core.intent(key)!.sequence;
  expect(sequence(later)).toBeLessThan(sequence(dream));
  expect(bot!.core.intent(dream)).toMatchObject({ phase: 'queued' });
  const next = await due();
  expect(next).not.toBe(dream);
  expect(bot!.core.intent(dream)).toMatchObject({ conclusion: 'superseded' });
  await bot!.drain();
  expect(record()?.last).toMatchObject({ outcome: 'superseded' });
  bot!.ledger.transaction(s => { stateOf(s.application).team.bots.main!.archived = true; });
  await bot!.drain();
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.core.intent(next)).toMatchObject({ conclusion: 'cancelled' }); });
  await bot!.drain();
  expect(record()?.last).toMatchObject({ outcome: 'cancelled', template: 'default' });
});

it('reads an external history with the dream key, fits the instruction limit, and skips a day whose read fails', async () => {
  const reads: string[] = [];
  const row = { id: 'cloud-1', root: 'cloud-1', source: 'user' as const, request: `Injected fact ${'x'.repeat(100_000)}`, hop: 0, status: 'succeeded' as const, outcomeSummary: [] };
  let fail = false;
  await open({ history: async ({ turnId }) => {
    if (!turnId.startsWith('occurrence:')) return [];
    reads.push(turnId);
    if (fail) throw new Error('offline');
    return [row];
  } });
  await completedTurn('one');
  const key = await due();
  const { instruction } = bot!.core.intent(key)!.execution.payload as { instruction: string };
  expect(reads).toContain(key);
  expect(instruction).toContain('Injected fact');
  expect(Buffer.byteLength(instruction, 'utf8')).toBeLessThanOrEqual(DEFAULT_INSTRUCTION_MAX_BYTES);
  await finish(key, undefined);
  await completedTurn('two');
  fail = true;
  await due();
  expect(record()?.last).toMatchObject({ outcome: 'skipped', reason: 'history_unavailable' });
});
