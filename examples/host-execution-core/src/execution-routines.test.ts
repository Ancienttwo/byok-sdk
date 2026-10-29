import { afterEach, expect, it, vi } from 'vitest';
import {
  HostExecutionCore,
  hash,
  type OutcomeTransaction,
  type HostJobRoutineDefinition,
  type Json,
  type RoutineDefinition,
} from '@byok-sdk/server/execution-core';
import { openHost, type TestHost } from './test-support';

// #954: `HostOptions.executionRoutines: 'refuse'` is for a Host that has no owner for an occurrence intent (K8 L).
const HOUR = 3_600_000, DAY = 86_400_000;
const REFUSED = 'Execution routines are refused by this Host';
let host: TestHost | undefined;
let apply: (tx: OutcomeTransaction) => void = () => {};
afterEach(async () => { await host?.close(); host = undefined; apply = () => {}; });
async function open(executionRoutines?: 'allow' | 'refuse'): Promise<TestHost> {
  host = await openHost({ ...(executionRoutines ? { executionRoutines } : {}), hostJobs: { digest: () => ({ summary: {} }) },
    applyOutcome: (_document, tx) => apply(tx) });
  return host;
}
// The slot is an hour away, so the SDK delivers no routine wake during a test.
const rule = () => ({ anchorMs: Date.now() + HOUR, everyMs: DAY });
const execution = (id: string, version = 1): RoutineDefinition => host!.routine(id, { version, rule: rule() });
const job = (id: string): HostJobRoutineDefinition => ({ id, version: 1, timeZone: 'UTC', rule: rule(), waitMs: 60_000, lateAfterMs: 1000,
  hostJob: { type: 'digest', input: {} } });
const routine = (id: string) => host!.ledger.snapshot().routines[hash(id)];
/** Runs one Agent turn whose outcome transaction calls `commands`. */
async function outcome(key: string, commands: (tx: OutcomeTransaction) => void): Promise<void> {
  apply = commands;
  await host!.core.enqueue(host!.intent(key));
  const taskId = host!.core.intent(key)!.taskId;
  await vi.waitFor(() => expect(host!.adapter.sessions.has(taskId)).toBe(true), { timeout: 5000 });
  host!.adapter.sessions.get(taskId)!.finish({ text: key });
  await vi.waitFor(async () => { await host!.core.drain(); expect(host!.core.intent(key)?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
}

it('refuses an execution routine in addRoutine, updateRoutine and the outcome commit, and writes no routine row', async () => {
  await open('refuse');
  await expect(host!.core.addRoutine(execution('exec'))).rejects.toThrow(REFUSED);
  expect(routine('exec')).toBeUndefined();
  // A malformed definition keeps its own error.
  await expect(host!.core.addRoutine({ ...job('both'), execution: execution('both').execution } as never))
    .rejects.toThrow('Supply exactly one of execution, hostJob or hostOccurrence');

  await host!.core.addRoutine(job('job'));
  const before = routine('job');
  await expect(host!.core.updateRoutine({ ...execution('job', 2) })).rejects.toThrow(REFUSED);
  expect(routine('job')).toEqual(before);

  await outcome('refused', tx => {
    try { tx.routines.create(execution('from-outcome')); } catch (error) { tx.application.refusal = (error as Error).message as Json; }
  });
  expect(host!.ledger.snapshot().application.refusal).toBe(REFUSED);
  expect(routine('from-outcome')).toBeUndefined();
});

it('refuses at construction a ledger with an open execution routine, current or pending, and opens once it is completed', async () => {
  // Default `allow`: the routine is created as before.
  await open();
  await host!.core.addRoutine(execution('exec'));
  expect(routine('exec')!.definition.execution).toBeDefined();
  const refuse = () => new HostExecutionCore(host!.server, host!.ledger, { executionRoutines: 'refuse' });
  expect(refuse).toThrow('Execution routine exec is refused by this Host');

  await host!.core.lifecycle('exec', 'completed');
  await host!.core.addRoutine(job('job'));
  host!.ledger.transaction(state => { state.routines[hash('job')]!.pending = execution('job', 2); });
  expect(refuse).toThrow('Execution routine job is refused by this Host');

  await host!.core.lifecycle('job', 'completed');
  const core = refuse();
  await core.close();
  expect(() => new HostExecutionCore(host!.server, host!.ledger, { executionRoutines: 'yes' as never })).toThrow('Invalid executionRoutines');
});
