import { afterEach, expect, it, vi } from 'vitest';
import {
  MIN_TOMBSTONE_RETENTION_MS,
  hash,
  concludeOccurrence,
  promoteOccurrence,
  type OccurrenceHook,
  type OccurrenceTransaction,
  type AgentRoutineDefinition,
  type Conclusion,
  type HostJobRoutineDefinition,
  type HostOccurrenceRoutineDefinition,
  type HostOccurrenceRun,
  type RoutineDefinition,
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
const occurrences = (id: string) => Object.values(host.ledger.snapshot().occurrences).filter(row => row.routineId === id)
  .sort((a, b) => a.trigger.plannedAt - b.trigger.plannedAt);
const deliver = (dedupKey: string, availableAt: number) => host.core.consume(
  { wakeId: `delivery:${dedupKey}`, dedupKey, availableAt, deliveredAt: clock, delivery: 1 }, new AbortController().signal);
const turn = (id: string, version: number, anchorMs: number, prompt = 'check'): HostOccurrenceRoutineDefinition => ({ id, version, timeZone: 'UTC',
  rule: { anchorMs, everyMs: 2 * MINUTE }, hostOccurrence: { type: 'turn', input: { prompt } }, waitMs: 10 * MINUTE, lateAfterMs: 1000 });
// Writes a Host turn for the occurrence. The Host promotes or concludes it later.
const recordTurn: OccurrenceHook = (run, tx) => {
  tx.application[run.occurrenceKey] = { prompt: (run.input as { prompt: string }).prompt, version: run.definitionVersion };
};
async function promote(occurrenceKey: string): Promise<void> {
  host.ledger.transaction(state => { promoteOccurrence(state, host.ledger.tenant, occurrenceKey, template(host.deviceId)); });
  await host.core.drain();
}
async function conclude(occurrenceKey: string, conclusion: Conclusion): Promise<void> {
  host.ledger.transaction(state => concludeOccurrence(state, occurrenceKey, conclusion));
  await host.core.drain();
}
async function succeed(key: string): Promise<void> {
  const taskId = host.core.intent(key)!.taskId;
  await vi.waitFor(() => expect(host.adapter.sessions.has(taskId)).toBe(true), { timeout: 5000 });
  host.adapter.sessions.get(taskId)!.finish({ text: key });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(key)?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
}

it('runs the hook in the occurrence commit once per slot, then promotes it to intent occurrence:<key> that settles back', async () => {
  const hook = vi.fn(recordTurn);
  await open({ occurrenceHooks: { turn: hook } });
  const at = clock + MINUTE;
  await host.core.addRoutine(turn('daily', 1, at));
  clock = at; await deliver(`daily:1:${at}`, at);
  const [occurrence] = occurrences('daily');
  expect(hook).toHaveBeenCalledTimes(1);
  expect(hook.mock.calls[0]![0]).toEqual({ type: 'turn', input: { prompt: 'check' }, occurrenceKey: occurrence!.key, routineId: 'daily',
    definitionVersion: 1, trigger: { kind: 'scheduled', plannedAt: at } });
  expect(occurrence).toMatchObject({ hook: {}, attempts: 0, nextAt: at + 2 * MINUTE });
  expect(occurrence!.intentId).toBeUndefined();
  expect(occurrence!.conclusion).toBeUndefined();
  expect(host.ledger.snapshot().application[occurrence!.key]).toEqual({ prompt: 'check', version: 1 });
  expect(host.ledger.snapshot().intents).toEqual({});
  expect(routine('daily').next?.dedupKey).toBe(`daily:1:${at + 2 * MINUTE}`);
  // A replay does not call the hook again, also after a restart.
  await deliver(`daily:1:${at}`, at);
  await host.restartCore();
  await deliver(`daily:1:${at}`, at);
  expect(hook).toHaveBeenCalledTimes(1);
  expect(occurrences('daily')).toHaveLength(1);
  expect(occurrences('daily')[0]!.slotReplayCount).toBe(2);

  await promote(occurrence!.key);
  const key = `occurrence:${occurrence!.key}`;
  // The waiting deadline counts from the occurrence admission. The next slot is the retry cutoff.
  expect(host.core.intent(key)).toMatchObject({ source: 'routine', occurrence: occurrence!.key, waitUntil: at + 10 * MINUTE,
    retryUntil: at + 2 * MINUTE });
  await succeed(key);
  expect(occurrences('daily')[0]).toMatchObject({ intentId: hash(key), conclusion: 'succeeded', attempts: 1 });
  expect(Object.values(host.ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'projection', id: `intent:${key}`,
    value: expect.objectContaining({ occurrenceKey: occurrence!.key, conclusion: 'succeeded' }) }));
  expect(() => host.ledger.transaction(state => promoteOccurrence(state, host.ledger.tenant, occurrence!.key, template(host.deviceId))))
    .toThrow('already promoted or concluded');
});

it('marks an unpromoted occurrence superseded by a newer slot and settles its late promotion at once', async () => {
  await open({ occurrenceHooks: { turn: recordTurn } });
  const at = clock + MINUTE;
  await host.core.addRoutine(turn('keep', 1, at));
  clock = at; await deliver(`keep:1:${at}`, at);
  clock = at + 2 * MINUTE; await deliver(`keep:1:${at + 2 * MINUTE}`, at + 2 * MINUTE);
  const [old, newer] = occurrences('keep');
  expect(old).toMatchObject({ hook: { executionSuperseded: true } });
  expect(old!.conclusion).toBeUndefined();
  expect(newer!.hook).toEqual({});
  // The promotion commit itself settles the intent. No scan or retry cutoff is involved.
  const intent = host.ledger.transaction(state => promoteOccurrence(state, host.ledger.tenant, old!.key, template(host.deviceId)));
  expect(intent).toMatchObject({ key: `occurrence:${old!.key}`, phase: 'settled', conclusion: 'superseded' });
  expect(occurrences('keep')[0]!.conclusion).toBe('superseded');
  await host.core.drain();
  expect(host.ledger.snapshot().executions[intent.taskId]?.submission).toBe('reserved');
  // A Host decision that needs no execution concludes the occurrence directly.
  await conclude(newer!.key, 'cancelled');
  expect(occurrences('keep')[1]).toMatchObject({ conclusion: 'cancelled' });
  expect(occurrences('keep')[1]!.intentId).toBeUndefined();
  expect(host.adapter.starts).toEqual([]);
});

it('rolls back the occurrence, slot and Host state when the hook throws or returns a thenable', async () => {
  let mode: 'async' | 'throw' | 'ok' = 'async';
  let late: OccurrenceTransaction['publish'] | undefined;
  const hook = vi.fn((run: HostOccurrenceRun, tx: OccurrenceTransaction) => {
    (run.input as { prompt: string }).prompt = 'changed by the hook'; // The run holds copies, not the definition.
    tx.application[run.occurrenceKey] = 'hook state';
    tx.publish(`turn:${run.occurrenceKey}`, 'hook projection');
    late = tx.publish;
    if (mode === 'async') return Promise.reject(new Error('async hook'));
    if (mode === 'throw') throw new Error('Host state refused the turn');
  });
  await open({ occurrenceHooks: { turn: hook } });
  const at = clock + MINUTE;
  await host.core.addRoutine(turn('strict', 1, at));
  const before = host.ledger.snapshot();
  clock = at;
  await expect(deliver(`strict:1:${at}`, at)).rejects.toThrow('Occurrence hook must be synchronous');
  mode = 'throw';
  await expect(deliver(`strict:1:${at}`, at)).rejects.toThrow('Host state refused the turn');
  // Nothing from either commit persists: no occurrence, slot, Host state, projection or next reservation.
  expect(host.ledger.snapshot()).toEqual(before);
  mode = 'ok';
  await deliver(`strict:1:${at}`, at);
  expect(hook).toHaveBeenCalledTimes(3);
  const [occurrence] = occurrences('strict');
  expect(host.ledger.snapshot().application).toEqual({ [occurrence!.key]: 'hook state' });
  expect(host.ledger.snapshot().outbox[`projection:${hash(`turn:${occurrence!.key}`)}`]).toMatchObject({ value: 'hook projection' });
  expect(routine('strict')).toMatchObject({ definition: turn('strict', 1, at), next: { dedupKey: `strict:1:${at + 2 * MINUTE}` } });
  expect(() => late!('after-commit', null)).toThrow('Occurrence transaction is closed');
});

it('compacts settled Host occurrences, keeps slot replay evidence, and refuses an open one', async () => {
  const hook = vi.fn(recordTurn);
  await open({ occurrenceHooks: { turn: hook } });
  const at = clock + MINUTE;
  await host.core.addRoutine(turn('tidy', 1, at));
  clock = at; await deliver(`tidy:1:${at}`, at);
  const [concluded] = occurrences('tidy');
  const options = { acknowledgedIntentKeys: [] as string[], acknowledgedOccurrenceKeys: [concluded!.key], now: clock,
    tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS };
  expect(() => host.ledger.compact(options)).toThrow('Only settled Host-only occurrences can be compacted');
  await conclude(concluded!.key, 'succeeded');
  expect(host.ledger.compact(options).occurrences).toBe(1);
  expect(occurrences('tidy')).toEqual([]);
  expect(host.ledger.hasTombstone('slot', `tidy:1:${at}`, clock)).toBe(true);
  await deliver(`tidy:1:${at}`, at);
  expect(hook).toHaveBeenCalledTimes(1);
  // A promoted occurrence is compacted through its intent.
  clock = at + 2 * MINUTE; await deliver(`tidy:1:${at + 2 * MINUTE}`, at + 2 * MINUTE);
  const [promoted] = occurrences('tidy');
  await promote(promoted!.key);
  const key = `occurrence:${promoted!.key}`;
  expect(() => host.ledger.compact({ ...options, acknowledgedOccurrenceKeys: [promoted!.key] })).toThrow('Only settled Host-only occurrences');
  await succeed(key);
  await host.core.flushProjections(async () => {});
  expect(host.ledger.compact({ ...options, acknowledgedIntentKeys: [key], acknowledgedOccurrenceKeys: [] }))
    .toMatchObject({ compactedIntents: 1, occurrences: 1 });
  expect(occurrences('tidy')).toEqual([]);
  expect(Object.keys(host.ledger.snapshot().application)).toHaveLength(2);
});

it('promotes or concludes only an open Host occurrence', async () => {
  await open({ hostJobs: { watchlist: () => { throw new Error('hold'); } }, occurrenceHooks: { turn: recordTurn } });
  const at = clock + MINUTE;
  const job: HostJobRoutineDefinition = { id: 'job', version: 1, timeZone: 'UTC', rule: { anchorMs: at, everyMs: 2 * MINUTE },
    hostJob: { type: 'watchlist', input: null }, waitMs: 10 * MINUTE, lateAfterMs: 1000 };
  const agent: AgentRoutineDefinition = { id: 'agent', version: 1, timeZone: 'UTC', rule: { anchorMs: at, everyMs: 2 * MINUTE },
    execution: template(host.deviceId), waitMs: 10 * MINUTE, lateAfterMs: 1000 };
  await host.core.addRoutine(job);
  await host.core.addRoutine(agent);
  await host.core.addRoutine(turn('hook', 1, at));
  clock = at;
  await host.offline();
  for (const id of ['agent', 'hook']) await deliver(`${id}:1:${at}`, at);
  // The failing job stays pending. Later drains would fail too, so the checks below call the transitions directly.
  await expect(deliver(`job:1:${at}`, at)).rejects.toThrow('Wake dispatch failed');
  const [pendingJob] = occurrences('job'), [agentRun] = occurrences('agent'), [hooked] = occurrences('hook');
  const tenant = host.ledger.tenant;
  // A Host job occurrence belongs to its handler, and an Agent occurrence already has its intent.
  for (const key of [pendingJob!.key, agentRun!.key, 'unknown']) {
    expect(() => host.ledger.transaction(state => promoteOccurrence(state, tenant, key, template(host.deviceId)))).toThrow('Host occurrence not found');
    expect(() => host.ledger.transaction(state => concludeOccurrence(state, key, 'cancelled'))).toThrow('Host occurrence not found');
  }
  expect(() => host.ledger.transaction(state => concludeOccurrence(state, hooked!.key, 'done' as Conclusion))).toThrow('Invalid occurrence conclusion');
  expect(() => host.ledger.transaction(state => promoteOccurrence(state, tenant, hooked!.key, { ...template(host.deviceId), deviceId: '' })))
    .toThrow('complete fresh execution template');
  expect(occurrences('hook')[0]!.intentId).toBeUndefined();
  expect(occurrences('hook')[0]!.conclusion).toBeUndefined();
  expect(occurrences('job')[0]!.intentId).toBeUndefined();
});

it('validates the destination kind, the hook registration and its input, and keeps the hook type across versions', async () => {
  await open({ hostJobs: { watchlist: () => ({ summary: null }) }, occurrenceHooks: { turn: recordTurn, digest: recordTurn } });
  const valid = turn('kinds', 1, clock + MINUTE);
  for (const [input, message] of [
    [{ ...valid, execution: template(host.deviceId) }, 'exactly one of execution, hostJob or hostOccurrence'],
    [{ ...valid, hostJob: { type: 'watchlist', input: null } }, 'exactly one of execution, hostJob or hostOccurrence'],
    [{ ...valid, hostOccurrence: undefined }, 'exactly one of execution, hostJob or hostOccurrence'],
    [{ ...valid, hostOccurrence: { type: 'missing', input: null } }, 'Occurrence hook not registered'],
    [{ ...valid, hostOccurrence: { type: 'turn', input: { bad: undefined } } }, 'must be JSON'],
  ] as const) await expect(host.core.addRoutine(input as unknown as RoutineDefinition)).rejects.toThrow(message);
  expect(host.ledger.snapshot().routines).toEqual({});
  await host.core.addRoutine(valid);
  await expect(host.core.updateRoutine({ ...valid, version: 2, hostOccurrence: { type: 'digest', input: null } })).rejects.toThrow('occurrence hook type');
  const { hostOccurrence: _hook, ...schedule } = valid;
  await expect(host.core.updateRoutine({ ...schedule, version: 2, execution: template(host.deviceId) })).rejects.toThrow('destination');
  await host.core.updateRoutine(turn('kinds', 2, clock + 3 * MINUTE, 'v2'));
  expect(routine('kinds').definition).toEqual(turn('kinds', 2, clock + 3 * MINUTE, 'v2'));
});

it('switches a staged version only after the Host concludes the open occurrence', async () => {
  await open({ occurrenceHooks: { turn: recordTurn } });
  const at = clock + MINUTE;
  await host.core.addRoutine(turn('switch', 1, at));
  clock = at; await deliver(`switch:1:${at}`, at);
  const v2 = turn('switch', 2, at + 5 * MINUTE, 'v2');
  await host.core.updateRoutine(v2);
  await host.core.drain();
  expect(routine('switch')).toMatchObject({ definition: { version: 1 }, pending: v2 });
  await conclude(occurrences('switch')[0]!.key, 'cancelled');
  expect(routine('switch')).toMatchObject({ definition: v2, next: { dedupKey: `switch:2:${at + 5 * MINUTE}` } });
  expect(routine('switch').pending).toBeUndefined();
});

it('runs an Agent routine, a Host job routine and a Host occurrence routine side by side in one core', async () => {
  const job = vi.fn(() => ({ summary: { checked: true } }));
  const hook = vi.fn(recordTurn);
  await open({ hostJobs: { watchlist: job }, occurrenceHooks: { turn: hook } });
  const at = clock + MINUTE;
  const rule = { anchorMs: at, everyMs: 2 * MINUTE };
  await host.core.addRoutine({ id: 'agent', version: 1, timeZone: 'UTC', rule, execution: template(host.deviceId), waitMs: 10 * MINUTE, lateAfterMs: 1000 });
  await host.core.addRoutine({ id: 'job', version: 1, timeZone: 'UTC', rule, hostJob: { type: 'watchlist', input: { list: 'abc' } },
    waitMs: 10 * MINUTE, lateAfterMs: 1000 });
  await host.core.addRoutine(turn('hook', 1, at));
  clock = at;
  for (const id of ['agent', 'job', 'hook']) await deliver(`${id}:1:${at}`, at);
  expect(occurrences('job')[0]).toMatchObject({ conclusion: 'succeeded', job: { summary: { checked: true } } });
  const [hooked] = occurrences('hook');
  expect(host.ledger.snapshot().application[hooked!.key]).toEqual({ prompt: 'check', version: 1 });
  // The promoted Host occurrence joins the same Agent FIFO behind the Agent routine occurrence.
  await promote(hooked!.key);
  for (const key of [occurrences('agent')[0]!.key, hooked!.key].map(occurrenceKey => `occurrence:${occurrenceKey}`)) await succeed(key);
  expect(occurrences('agent')[0]!.conclusion).toBe('succeeded');
  expect(occurrences('hook')[0]!.conclusion).toBe('succeeded');
  expect(job).toHaveBeenCalledTimes(1);
  expect(hook).toHaveBeenCalledTimes(1);
  expect(host.adapter.starts).toHaveLength(2);
  for (const id of ['agent', 'job', 'hook']) expect(routine(id).next?.dedupKey).toBe(`${id}:1:${at + 2 * MINUTE}`);
  expect(host.ledger.snapshot().ignoredWakes).toBeUndefined();
});
