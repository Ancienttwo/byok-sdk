import { afterEach, expect, it, vi } from 'vitest';
import {
  hash,
  nextIntervalOccurrence,
  type OutcomeTransaction,
  type AgentRoutineDefinition,
  type Json,
} from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from './test-support';

const MINUTE = 60_000;
let host: TestHost;
let clock = 0;
let apply: (tx: OutcomeTransaction) => void = () => {};
afterEach(async () => { await host?.close(); vi.restoreAllMocks(); apply = () => {}; });
async function open(options: Parameters<typeof openHost>[0] = {}): Promise<void> {
  // Only the core reads this clock. The SDK keeps real time, so no routine wake becomes due in the SDK during a test.
  clock = Date.now();
  host = await openHost({ ...options, now: () => clock, applyOutcome: (_document, tx) => apply(tx) });
}
const routine = (id: string) => host.ledger.snapshot().routines[hash(id)];
const wakeKeys = async () => (await host.server.wakes.pending()).map(wake => wake.dedupKey);
const agent = (id: string, version: number, anchorMs: number): AgentRoutineDefinition => ({ id, version, timeZone: 'UTC',
  rule: { anchorMs, everyMs: 2 * MINUTE }, execution: template(host.deviceId), waitMs: 10 * MINUTE, lateAfterMs: 1000 });
/** Runs one Bot turn whose outcome transaction calls `commands`. */
async function outcome(key: string, commands: (tx: OutcomeTransaction) => void): Promise<void> {
  apply = commands;
  await host.core.enqueue(host.intent(key));
  const taskId = host.core.intent(key)!.taskId;
  await vi.waitFor(() => expect(host.adapter.sessions.has(taskId)).toBe(true), { timeout: 5000 });
  host.adapter.sessions.get(taskId)!.finish({ text: key });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(key)?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
}

it('runs routine commands in the outcome commit with the addRoutine, updateRoutine and lifecycle rules', async () => {
  await open();
  const at = clock + MINUTE;
  const v1 = agent('outcome', 1, at), v2 = agent('outcome', 2, at + 30_000);
  await outcome('create', tx => {
    tx.routines.create(v1);
    tx.routines.create(v1); // The same definition is idempotent.
    const [copy] = tx.routines.list();
    copy!.lifecycle = 'paused'; // A listed row is a copy.
    tx.application.listed = tx.routines.list().map(row => ({ id: row.definition.id, lifecycle: row.lifecycle })) as Json;
  });
  expect(routine('outcome')).toMatchObject({ definition: v1, lifecycle: 'active', next: { dedupKey: `outcome:1:${at}` } });
  expect(host.ledger.snapshot().application.listed).toEqual([{ id: 'outcome', lifecycle: 'active' }]);
  expect(await wakeKeys()).toContain(`outcome:1:${at}`);

  await outcome('update', tx => {
    tx.routines.update(v2); // No occurrence is unsettled, so the version switches in this commit.
    tx.routines.update(v2);
  });
  expect(routine('outcome')).toMatchObject({ definition: v2, next: { dedupKey: `outcome:2:${at + 30_000}` } });
  expect(routine('outcome')!.pending).toBeUndefined();
  expect(await wakeKeys()).toEqual(expect.arrayContaining([`outcome:2:${at + 30_000}`]));
  expect(await wakeKeys()).not.toContain(`outcome:1:${at}`);

  await outcome('pause', tx => tx.routines.lifecycle('outcome', 'paused'));
  expect(routine('outcome')).toMatchObject({ lifecycle: 'paused', next: null });
  expect(await wakeKeys()).not.toContain(`outcome:2:${at + 30_000}`);
});

it('leaves the ledger unchanged when the Host catches a refused command, and commits the rest of the outcome', async () => {
  let calendarDown = false;
  await open({ nextOccurrence: (definition, after) => {
    if (calendarDown && definition.version === 1) throw new Error('calendar offline');
    return nextIntervalOccurrence(definition, after);
  } });
  const at = clock + MINUTE;
  const v1 = agent('guarded', 1, at);
  await host.core.addRoutine(v1);
  await host.core.lifecycle('guarded', 'paused');
  calendarDown = true;
  const before = host.ledger.snapshot();
  const refusals: string[] = [];
  const attempt = (work: () => void) => {
    try { work(); } catch (error) { refusals.push(error instanceof Error ? error.message : String(error)); }
  };
  await outcome('refused', tx => {
    attempt(() => tx.routines.lifecycle('guarded', 'active')); // The resume plan fails after the lifecycle checks.
    attempt(() => tx.routines.update({ ...v1, version: 3 }));
    attempt(() => tx.routines.create({ ...v1, version: 2 }));
    attempt(() => tx.routines.create(agent('new', 1, at)));
    attempt(() => tx.routines.lifecycle('missing', 'paused'));
    tx.application.refusals = refusals;
  });
  const after = host.ledger.snapshot();
  expect(after.application.refusals).toEqual(['calendar offline', 'Routine version conflict; supply max(current, pending) + 1',
    'Routine definition is immutable in addRoutine; use updateRoutine for the next version', 'calendar offline', 'Routine not found']);
  expect(after.routines).toEqual(before.routines);
  expect(Object.keys(after.outbox).filter(key => key.startsWith('schedule:') || key.startsWith('cancel:')))
    .toEqual(Object.keys(before.outbox).filter(key => key.startsWith('schedule:') || key.startsWith('cancel:')));
  expect(after.occurrences).toEqual(before.occurrences);
  calendarDown = false;
  await host.core.lifecycle('guarded', 'active');
  expect(routine('guarded')).toMatchObject({ lifecycle: 'active', next: { dedupKey: `guarded:1:${at}` } });
});
