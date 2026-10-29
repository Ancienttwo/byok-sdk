import { afterEach, expect, it, vi } from 'vitest';
import {
  hash,
  nextIntervalOccurrence,
  type AgentRoutineDefinition,
  type HostJobRoutineDefinition,
  type HostJobRun,
} from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from './test-support';

const MINUTE = 60_000;
let host: TestHost;
let clock = 0;
afterEach(async () => { await host?.close(); vi.restoreAllMocks(); });
async function open(options: Parameters<typeof openHost>[0] = {}): Promise<void> {
  // Only the core reads this clock. The SDK keeps real time, so no routine wake becomes due in the SDK during a test.
  clock = Date.now();
  host = await openHost({ ...options, now: () => clock });
}
const routine = (id: string) => host.ledger.snapshot().routines[hash(id)]!;
const occurrences = (id: string) => Object.values(host.ledger.snapshot().occurrences).filter(row => row.routineId === id);
const intentKey = (occurrenceKey: string) => {
  const state = host.ledger.snapshot();
  return state.intents[state.occurrences[occurrenceKey]!.intentId!]!.key;
};
const wakeKeys = async () => (await host.server.wakes.pending()).map(wake => wake.dedupKey);
const deliver = (dedupKey: string, availableAt: number) => host.core.consume(
  { wakeId: `delivery:${dedupKey}`, dedupKey, availableAt, deliveredAt: clock, delivery: 1 }, new AbortController().signal);
const agent = (id: string, version: number, anchorMs: number): AgentRoutineDefinition => ({ id, version, timeZone: 'UTC',
  rule: { anchorMs, everyMs: 2 * MINUTE }, execution: template(host.deviceId), waitMs: 10 * MINUTE, lateAfterMs: 1000 });
async function cancelled(key: string): Promise<void> {
  await host.core.cancel(key);
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(key)?.conclusion).toBe('cancelled'); }, { timeout: 5000 });
}

it('switches at once without unsettled work, ignores exact replays, and audits the old wake', async () => {
  await open();
  const at = clock + MINUTE;
  const v1 = agent('swap', 1, at), v2 = agent('swap', 2, at + 30_000);
  await host.core.addRoutine(v1);
  expect(await wakeKeys()).toContain(`swap:1:${at}`);
  await host.core.updateRoutine(v2);
  expect(routine('swap')).toMatchObject({ definition: v2, next: { dedupKey: `swap:2:${at + 30_000}`, availableAt: at + 30_000 } });
  expect(routine('swap').pending).toBeUndefined();
  expect(await wakeKeys()).toContain(`swap:2:${at + 30_000}`);
  expect(await wakeKeys()).not.toContain(`swap:1:${at}`);
  await host.core.updateRoutine(v2);
  expect(routine('swap').definition).toEqual(v2);
  await deliver(`swap:1:${at}`, at);
  expect(occurrences('swap')).toEqual([]);
  expect(host.ledger.snapshot().ignoredWakes?.at(-1)).toMatchObject({ reason: 'reservation_mismatch', wakeKeyHash: hash(`swap:1:${at}`) });
});

it('stages a version behind unsettled work, stops the old chain, and switches after all work settles', async () => {
  await open();
  const at = clock + MINUTE;
  const v1 = agent('stage', 1, at), v2 = agent('stage', 2, at + 5 * MINUTE);
  await host.core.addRoutine(v1);
  clock = at; await deliver(`stage:1:${at}`, at);
  await host.core.updateRoutine(v2);
  expect(routine('stage')).toMatchObject({ definition: v1, pending: v2, next: { dedupKey: `stage:1:${at + 2 * MINUTE}` } });
  // The reserved old slot still records an occurrence, but it reserves no later old slot.
  clock = at + 2 * MINUTE; await deliver(`stage:1:${at + 2 * MINUTE}`, at + 2 * MINUTE);
  expect(occurrences('stage').map(row => row.definitionVersion)).toEqual([1, 1]);
  expect(routine('stage')).toMatchObject({ definition: v1, pending: v2, next: null });
  const [first, second] = occurrences('stage');
  for (const occurrence of [first!, second!]) {
    const key = intentKey(occurrence.key);
    const taskId = host.core.intent(key)!.taskId;
    await vi.waitFor(() => expect(host.adapter.sessions.has(taskId)).toBe(true), { timeout: 5000 });
    host.adapter.sessions.get(taskId)!.finish({ text: `settled ${occurrence.trigger.plannedAt}` });
    await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(key)?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
    if (occurrence === first) expect(routine('stage')).toMatchObject({ definition: v1, pending: v2 });
  }
  expect(routine('stage')).toMatchObject({ definition: v2, next: { dedupKey: `stage:2:${at + 5 * MINUTE}` } });
  expect(routine('stage').pending).toBeUndefined();
  expect(await wakeKeys()).toContain(`stage:2:${at + 5 * MINUTE}`);
});

it('defers the switch while an old slot is due but undelivered', async () => {
  await open(); await host.offline();
  const at = clock + MINUTE;
  const v1 = agent('due', 1, at), v2 = agent('due', 2, at + 5 * MINUTE);
  await host.core.addRoutine(v1);
  clock = at + 1;
  await host.core.updateRoutine(v2);
  await host.core.drain();
  expect(routine('due')).toMatchObject({ definition: v1, pending: v2, next: { dedupKey: `due:1:${at}` } });
  await deliver(`due:1:${at}`, at);
  const [late] = occurrences('due');
  expect(late).toMatchObject({ definitionVersion: 1, nextAt: null });
  expect(routine('due')).toMatchObject({ definition: v1, pending: v2, next: null });
  await cancelled(intentKey(late!.key));
  expect(routine('due')).toMatchObject({ definition: v2, next: { dedupKey: `due:2:${at + 5 * MINUTE}` } });
});

it('keeps a staged version through pause, resumes on the current version while work is unsettled, and switches when due', async () => {
  const scheduled: string[] = [];
  await open({ wrapServer: server => ({ ...server, wakes: { ...server.wakes, schedule: input => {
    scheduled.push(input.dedupKey);
    return server.wakes.schedule(input);
  } } }) });
  await host.offline();
  const at = clock + MINUTE;
  const v1 = agent('pause', 1, at), v2 = agent('pause', 2, at + 5 * MINUTE);
  await host.core.addRoutine(v1);
  clock = at; await deliver(`pause:1:${at}`, at);
  const [first] = occurrences('pause');
  await host.core.updateRoutine(v2);
  await host.core.lifecycle('pause', 'paused');
  expect(routine('pause')).toMatchObject({ lifecycle: 'paused', definition: v1, pending: v2, next: null });
  expect(await wakeKeys()).not.toContain(`pause:1:${at + 2 * MINUTE}`);
  await host.core.lifecycle('pause', 'active');
  expect(routine('pause')).toMatchObject({ lifecycle: 'active', definition: v1, pending: v2, next: { dedupKey: `pause:1:${at + 2 * MINUTE}` } });
  await host.core.lifecycle('pause', 'paused');
  await cancelled(intentKey(first!.key));
  expect(routine('pause')).toMatchObject({ lifecycle: 'paused', definition: v1, pending: v2 });
  scheduled.length = 0;
  await host.core.lifecycle('pause', 'active');
  expect(routine('pause')).toMatchObject({ lifecycle: 'active', definition: v2, next: { dedupKey: `pause:2:${at + 5 * MINUTE}` } });
  expect(routine('pause').pending).toBeUndefined();
  // Resume switches in its own commit; no old-version wake reaches the SDK first.
  expect(scheduled.filter(key => key.startsWith('pause:'))).toEqual([`pause:2:${at + 5 * MINUTE}`]);
});

it('gives the old chain no refill from recover() or a same-definition addRoutine() while a version is staged', async () => {
  let gap = false;
  // An injected calendar can report no slot for the current version. Recovery then refreshes the routine.
  await open({ nextOccurrence: (definition, after) => gap && definition.version === 1 ? null : nextIntervalOccurrence(definition, after) });
  await host.offline();
  const at = clock + MINUTE;
  const v1 = agent('gap', 1, at), v2 = agent('gap', 2, at + 5 * MINUTE);
  await host.core.addRoutine(v1);
  gap = true;
  clock = at; await deliver(`gap:1:${at}`, at);
  const [first] = occurrences('gap');
  expect(routine('gap')).toMatchObject({ status: 'no_occurrence_within_horizon', next: null });
  await host.core.updateRoutine(v2);
  gap = false;
  await host.restartCore();
  await host.core.addRoutine(v1);
  expect(routine('gap')).toMatchObject({ definition: v1, pending: v2, next: null });
  await cancelled(intentKey(first!.key));
  expect(routine('gap')).toMatchObject({ definition: v2, next: { dedupKey: `gap:2:${at + 5 * MINUTE}` } });
});

it('drops a staged version when resume completes the current version', async () => {
  await open(); await host.offline();
  const at = clock + MINUTE;
  const v1 = { ...agent('ending', 1, at), endAt: at + 3 * MINUTE }, v2 = { ...agent('ending', 2, at), endAt: at + 60 * MINUTE };
  await host.core.addRoutine(v1);
  clock = at; await deliver(`ending:1:${at}`, at);
  await host.core.updateRoutine(v2);
  await host.core.lifecycle('ending', 'paused');
  clock = at + 4 * MINUTE;
  await host.core.lifecycle('ending', 'active');
  expect(routine('ending')).toMatchObject({ lifecycle: 'completed', definition: v1 });
  expect(routine('ending').pending).toBeUndefined();
});

it('refuses a wrong version, a changed destination or Host job type, and an unknown or completed routine', async () => {
  const handler = () => ({ summary: null });
  await open({ hostJobs: { watchlist: handler, digest: handler } });
  const at = clock + MINUTE;
  const v1 = agent('rules', 1, at), v2 = { ...v1, version: 2, waitMs: 5 * MINUTE };
  await host.core.addRoutine(v1);
  clock = at + 1; // The due old slot keeps the next version staged.
  await expect(host.core.updateRoutine({ ...v1, version: 3 })).rejects.toThrow('version conflict');
  await expect(host.core.updateRoutine({ ...v1, waitMs: 5 * MINUTE })).rejects.toThrow('version conflict');
  await host.core.updateRoutine(v2);
  await host.core.updateRoutine(v2);
  await host.core.updateRoutine(v1);
  expect(routine('rules')).toMatchObject({ definition: v1, pending: v2 });
  await expect(host.core.updateRoutine({ ...v2, waitMs: 7 * MINUTE })).rejects.toThrow('version conflict');
  const job: HostJobRoutineDefinition = { id: 'rules', version: 3, timeZone: 'UTC', rule: v1.rule,
    hostJob: { type: 'watchlist', input: null }, waitMs: MINUTE, lateAfterMs: 1000 };
  await expect(host.core.updateRoutine(job)).rejects.toThrow('destination');
  await host.core.addRoutine({ ...job, id: 'jobs', version: 1 });
  await expect(host.core.updateRoutine({ ...job, id: 'jobs', version: 2, hostJob: { type: 'digest', input: null } })).rejects.toThrow('Host job type');
  await expect(host.core.updateRoutine({ ...v1, id: 'missing', version: 2 })).rejects.toThrow('Routine not found');
  await host.core.lifecycle('rules', 'completed');
  expect(routine('rules').pending).toBeUndefined();
  await expect(host.core.updateRoutine(v2)).rejects.toThrow('completed');
  await host.core.updateRoutine(v1);
  expect(routine('rules')).toMatchObject({ lifecycle: 'completed', definition: v1 });
});

it('keeps a staged version across restart and recover(), then switches after settlement', async () => {
  await open(); await host.offline();
  const at = clock + MINUTE;
  const v1 = agent('restart', 1, at), v2 = agent('restart', 2, at + 5 * MINUTE);
  await host.core.addRoutine(v1);
  clock = at; await deliver(`restart:1:${at}`, at);
  const [first] = occurrences('restart');
  await host.core.updateRoutine(v2);
  await host.restartCore();
  expect(routine('restart')).toMatchObject({ definition: v1, pending: v2, next: { dedupKey: `restart:1:${at + 2 * MINUTE}` } });
  expect(await wakeKeys()).toContain(`restart:1:${at + 2 * MINUTE}`);
  await cancelled(intentKey(first!.key));
  expect(routine('restart')).toMatchObject({ definition: v2, next: { dedupKey: `restart:2:${at + 5 * MINUTE}` } });
  expect(await wakeKeys()).not.toContain(`restart:1:${at + 2 * MINUTE}`);
});

it('upgrades a Host job routine only after its admitted job succeeds, also while that job keeps failing', async () => {
  let failing = true;
  const handler = vi.fn(({ input }: HostJobRun) => {
    if (failing) throw new Error('feed unavailable');
    return { summary: input };
  });
  await open({ hostJobs: { watchlist: handler } });
  const at = clock + MINUTE;
  const job = (version: number, list: string, anchorMs: number): HostJobRoutineDefinition => ({ id: 'watch', version, timeZone: 'UTC',
    rule: { anchorMs, everyMs: 2 * MINUTE }, hostJob: { type: 'watchlist', input: { list } }, waitMs: MINUTE, lateAfterMs: 1000 });
  await host.core.addRoutine(job(1, 'abc', at));
  clock = at;
  await expect(deliver(`watch:1:${at}`, at)).rejects.toThrow('Wake dispatch failed');
  // The failed job stays admitted. The staged version waits for it.
  await expect(host.core.updateRoutine(job(2, 'xyz', at + 5 * MINUTE))).rejects.toThrow('Wake dispatch failed');
  expect(routine('watch')).toMatchObject({ definition: job(1, 'abc', at), pending: job(2, 'xyz', at + 5 * MINUTE) });
  failing = false;
  await host.core.drain();
  // The admitted occurrence runs with the version that admitted it.
  expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ input: { list: 'abc' }, definitionVersion: 1 }));
  expect(occurrences('watch')[0]).toMatchObject({ conclusion: 'succeeded', job: { summary: { list: 'abc' } } });
  expect(routine('watch')).toMatchObject({ definition: job(2, 'xyz', at + 5 * MINUTE), next: { dedupKey: `watch:2:${at + 5 * MINUTE}` } });
  clock = at + 5 * MINUTE;
  await deliver(`watch:2:${at + 5 * MINUTE}`, at + 5 * MINUTE);
  expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ input: { list: 'xyz' }, definitionVersion: 2 }));
});
