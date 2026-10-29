import { afterEach, expect, vi } from 'vitest';
import { hash, taskId } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { stateOf } from './model';
import { createDefinition } from './routines';
import { occurrenceView, routineVectors, routineView, type RoutineSubject } from './routine-vectors.test-support';

// #793 D2f-1: the routine vectors on the K8 L Host. Only the Bot Host and its K4 core read the test clock.
const opened: Array<{ fixture: TestHost; bot: BotCollaboration }> = [];
afterEach(async () => {
  for (const { fixture, bot } of opened.splice(0).reverse()) { await bot.close(); await fixture.close(); }
});

async function ledgerSubject(): Promise<RoutineSubject> {
  let clock = Date.now(), bot: BotCollaboration | undefined;
  const fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', execution: template(fixture.deviceId), connector: async () => null,
    now: () => clock });
  opened.push({ fixture, bot });
  const host = bot, ledger = () => fixture.ledger.snapshot();
  const intentOf = (key: string) => ledger().intents[hash(key)];
  return {
    now: () => clock,
    at: now => { clock = now; },
    change: edit => { fixture.ledger.transaction(s => { edit(stateOf(s.application)); }); },
    addRoutine: async (owner, schedule) => {
      const definition = createDefinition(Object.values(ledger().routines), owner, taskId(`seed:${owner}`, 0), 0,
        { localId: 'new_routine_1', schedule, prompt: 'Daily report' }, 'bot');
      await host.core.addRoutine(definition);
      return definition.id;
    },
    input: (key, request) => host.input(key, request),
    start: async turnId => {
      // K4 must see the device claim before the clock moves, or the wait limit expires the Turn.
      await vi.waitFor(async () => {
        await host.drain();
        expect(ledger().executions[intentOf(turnId)!.taskId]?.started).toBe(true);
      }, { timeout: 10_000 });
    },
    finish: async (turnId, document) => {
      fixture.adapter.sessions.get(intentOf(turnId)!.taskId)!.finish(document);
      await vi.waitFor(async () => { await host.drain(); expect(intentOf(turnId)!.conclusion).toBeDefined(); }, { timeout: 10_000 });
    },
    fire: async id => {
      const next = ledger().routines[hash(id)]!.next!;
      await host.consume({ wakeId: `delivery:${next.dedupKey}`, dedupKey: next.dedupKey, availableAt: next.availableAt, deliveredAt: clock, delivery: 1 },
        new AbortController().signal);
    },
    sync: () => host.drain(),
    cancelTurn: turnId => host.cancelTurn(turnId),
    update: action => host.updateRoutine(action),
    lifecycle: (id, value) => host.setRoutineLifecycle(id, value),
    end: id => host.endRoutine(id),
    routine: id => { const row = ledger().routines[hash(id)]; return row && routineView(row); },
    reserved: async id => (await fixture.server.wakes.pending()).filter(wake => wake.dedupKey.startsWith(`${id}:`)).map(wake => wake.availableAt),
    occurrences: id => {
      const state = ledger();
      return Object.values(state.occurrences).filter(row => row.routineId === id).sort((a, b) => a.trigger.plannedAt - b.trigger.plannedAt)
        .map(row => occurrenceView(row, row.intentId === undefined ? undefined : state.intents[row.intentId]));
    },
    intent: key => {
      const state = ledger(), row = state.intents[hash(key)];
      return row && { key: row.key, source: row.source, waitUntil: row.waitUntil, retryUntil: row.retryUntil ?? null, conclusion: row.conclusion ?? null,
        tried: row.attempts > 0, instruction: row.execution.payload.instruction as string };
    },
    state: () => host.snapshot(),
  };
}
routineVectors('L BotCollaboration', ledgerSubject);
