import { afterEach, expect, it, vi } from 'vitest';
import {
  HostExecutionCore,
  MIN_TOMBSTONE_RETENTION_MS,
  hash,
  type HostJobRoutineDefinition,
  type HostJobResult,
  type RoutineDefinition,
} from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from './test-support';

let host: TestHost;
afterEach(async () => { vi.useRealTimers(); await host?.close(); vi.restoreAllMocks(); });
const rows = () => Object.values(host.ledger.snapshot().occurrences);
const definition = (id: string, at = Date.now() + 60_000): HostJobRoutineDefinition => ({
  id, version: 1, timeZone: 'UTC', rule: { anchorMs: at, everyMs: 86_400_000 },
  hostJob: { type: 'watchlist', input: { list: 'abc' } }, waitMs: 60_000, lateAfterMs: 1000,
});
const wake = (id: string, at: number) => ({ wakeId: 'delivery', dedupKey: `${id}:1:${at}`, availableAt: at,
  deliveredAt: Date.now(), delivery: 1 });
const signal = () => new AbortController().signal;

it('runs a registered async Host job through the real wake scheduler, records summary, and deduplicates replay', async () => {
  const handler = vi.fn(async () => ({ summary: { events: 2 } }));
  host = await openHost({ hostJobs: { watchlist: handler } });
  await host.core.addRoutine(definition('watch', Date.now() + 30));
  await vi.waitFor(() => expect(rows()[0]?.conclusion).toBe('succeeded'));
  const occurrence = rows()[0]!;
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0]).toEqual([expect.objectContaining({ occurrenceKey: occurrence.key,
    type: 'watchlist', input: { list: 'abc' }, routineId: 'watch', attempt: 1 })]);
  expect(occurrence).toMatchObject({ job: { attempts: 1, summary: { events: 2 } }, attempts: 0 });
  expect(occurrence.intentId).toBeUndefined();
  expect(host.ledger.snapshot().intents).toEqual({}); expect(host.ledger.snapshot().executions).toEqual({});
  expect(host.adapter.starts).toEqual([]);
  await host.core.consume(wake('watch', occurrence.trigger.plannedAt), signal());
  expect(handler).toHaveBeenCalledTimes(1);
  expect(rows()[0]?.slotReplayCount).toBe(1);
  await host.restartCore();
  expect(rows()[0]?.job?.summary).toEqual({ events: 2 });
  expect(handler).toHaveBeenCalledTimes(1);
});

it('pauses future slots, recovers a missing reservation, resumes, and completes', async () => {
  const handler = vi.fn(() => ({ summary: null }));
  host = await openHost({ hostJobs: { watchlist: handler } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('lifecycle', at));
  await host.core.lifecycle('lifecycle', 'paused');
  await host.core.consume(wake('lifecycle', at), signal());
  expect(handler).not.toHaveBeenCalled();
  expect(host.ledger.snapshot().ignoredWakes?.at(-1)?.reason).toBe('inactive_routine');
  await host.core.lifecycle('lifecycle', 'active');
  await host.server.wakes.cancel(`lifecycle:1:${at}`);
  await host.restartCore();
  expect((await host.server.wakes.pending()).some(row => row.dedupKey === `lifecycle:1:${at}`)).toBe(true);
  await host.core.consume(wake('lifecycle', at), signal());
  expect(handler).toHaveBeenCalledTimes(1);
  await host.core.lifecycle('lifecycle', 'completed');
  await host.core.consume(wake('lifecycle', at + 86_400_000), signal());
  expect(handler).toHaveBeenCalledTimes(1);
  await expect(host.core.lifecycle('lifecycle', 'active')).rejects.toThrow('cannot resume');
});

it('retains a rejected handler in the outbox and retries after reopening with the same occurrence key', async () => {
  let fail = true;
  const keys: string[] = [];
  host = await openHost({ hostJobs: { watchlist: run => {
    keys.push(run.occurrenceKey);
    if (fail) throw new Error('Host source unavailable');
    return { summary: { recovered: true } };
  } } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('recover', at));
  await expect(host.core.consume(wake('recover', at), signal())).rejects.toThrow('Wake dispatch failed');
  expect(rows()[0]?.conclusion).toBeUndefined();
  expect(Object.values(host.ledger.snapshot().outbox)).toContainEqual({ kind: 'host-job', occurrenceKey: keys[0], lastError: 'Host source unavailable' });
  fail = false;
  await host.restartCore();
  expect(keys).toEqual([keys[0], keys[0]]);
  expect(rows()[0]).toMatchObject({ conclusion: 'succeeded', job: { attempts: 2, summary: { recovered: true } } });
  expect(host.adapter.starts).toEqual([]);
});

it('serializes concurrent replays while an async handler is in flight', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const handler = vi.fn(async () => { await held; return { summary: 'done' }; });
  host = await openHost({ hostJobs: { watchlist: handler } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('concurrent', at));
  const first = host.core.consume(wake('concurrent', at), signal());
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  const second = host.core.consume(wake('concurrent', at), signal());
  release(); await Promise.all([first, second]);
  expect(handler).toHaveBeenCalledTimes(1); expect(rows()).toHaveLength(1);
  expect(rows()[0]?.slotReplayCount).toBe(1);
});

it('lets admitted Host work finish after pause and promotes only on the Host decision', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  host = await openHost({ hostJobs: { watchlist: async () => {
    await held;
    return { summary: { escalate: true }, execution: template(host.deviceId) };
  } } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('promote', at));
  const consume = host.core.consume(wake('promote', at), signal());
  await vi.waitFor(() => expect(rows()[0]?.job?.attempts).toBe(1));
  const pause = host.core.lifecycle('promote', 'paused');
  release(); await Promise.all([consume, pause]);
  const row = rows()[0]!;
  expect(row.job?.summary).toEqual({ escalate: true });
  expect(row.intentId).toBeDefined();
  const intent = host.ledger.snapshot().intents[row.intentId!]!;
  expect(intent.retryUntil).toBeUndefined();
  await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true));
  host.adapter.sessions.get(intent.taskId)!.finish({ text: 'Host requested analysis' });
  await vi.waitFor(async () => { await host.core.drain(); expect(rows()[0]?.conclusion).toBe('succeeded'); });
  expect(host.adapter.starts).toHaveLength(1);
});

it('concludes a result with execution as failed, with its summary and no intent, when the Host sets hostJobExecution fail', async () => {
  const handler = vi.fn(() => ({ summary: { escalate: true }, execution: template(host.deviceId) }));
  host = await openHost({ hostJobs: { watchlist: handler }, hostJobExecution: 'fail' });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('no-promote', at));
  await expect(host.core.consume(wake('no-promote', at), signal())).rejects.toThrow('Wake dispatch failed');
  expect(rows()[0]).toMatchObject({ conclusion: 'failed', job: { attempts: 1, summary: { escalate: true } } });
  expect(rows()[0]?.intentId).toBeUndefined();
  expect(host.ledger.snapshot().intents).toEqual({});
  expect(Object.values(host.ledger.snapshot().outbox).filter(row => row.kind === 'host-job')).toEqual([]);
  // No retry: a later drain runs nothing.
  await host.core.drain();
  expect(handler).toHaveBeenCalledTimes(1);
  expect(host.adapter.starts).toEqual([]);
  expect(() => new HostExecutionCore(host.server, host.ledger, { hostJobExecution: 'drop' as never })).toThrow('Invalid hostJobExecution');
});

it.each([
  ['missing summary', {}],
  ['non-JSON summary', { summary: { bad: undefined } }],
  ['invalid execution', { summary: 'not committed', execution: {} }],
] as const)('rejects %s without committing a result or intent', async (_name, result) => {
  host = await openHost({ hostJobs: { watchlist: () => result as unknown as HostJobResult } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('invalid', at));
  await expect(host.core.consume(wake('invalid', at), signal())).rejects.toThrow('Wake dispatch failed');
  expect(rows()[0]?.job?.summary).toBeUndefined();
  expect(rows()[0]?.conclusion).toBeUndefined(); expect(rows()[0]?.intentId).toBeUndefined();
  expect(host.ledger.snapshot().intents).toEqual({});
  expect(Object.values(host.ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'host-job', lastError: expect.any(String) }));
});

it('rejects ambiguous definitions, missing registrations and lossy JSON inputs before admission', async () => {
  host = await openHost({ hostJobs: { watchlist: () => ({ summary: null }) } });
  const valid = definition('invalid-definition');
  for (const input of [
    { ...valid, execution: template(host.deviceId) },
    { ...valid, hostJob: undefined },
    { ...valid, hostJob: { type: 'missing', input: null } },
    { ...valid, hostJob: { type: 'watchlist', input: { bad: undefined } } },
    { ...valid, id: 'host-scan:reserved' },
  ]) await expect(host.core.addRoutine(input as RoutineDefinition)).rejects.toThrow();
  expect(host.ledger.snapshot().routines).toEqual({});
});

it('reports a missing handler after restart and preserves pending work for repair', async () => {
  host = await openHost({ hostJobs: { watchlist: () => { throw new Error('hold'); } } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('registration', at));
  await expect(host.core.consume(wake('registration', at), signal())).rejects.toThrow();
  const core = new HostExecutionCore(host.server, host.ledger);
  try {
    await expect(core.recover()).rejects.toThrow('Wake dispatch failed');
    expect(Object.values(host.ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'host-job', lastError: 'Host job handler not registered' }));
    expect(rows()[0]?.conclusion).toBeUndefined();
  } finally { await core.close(); }
});

it('compacts only acknowledged settled Host occurrences and retains slot replay evidence', async () => {
  const handler = vi.fn(() => ({ summary: { events: 0 } }));
  host = await openHost({ hostJobs: { watchlist: handler } });
  const at = Date.now() + 60_000;
  await host.core.addRoutine(definition('compact-job', at));
  const delivered = wake('compact-job', at);
  await host.core.consume(delivered, signal());
  const occurrence = rows()[0]!;
  const options = { acknowledgedIntentKeys: [], acknowledgedOccurrenceKeys: [occurrence.key], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS };
  const before = host.ledger.snapshot();
  expect(() => host.ledger.compact({ ...options, acknowledgedOccurrenceKeys: [occurrence.key, 'unknown'] })).toThrow();
  expect(host.ledger.snapshot()).toEqual(before);
  expect(host.ledger.compact(options).occurrences).toBe(1);
  expect(rows()).toEqual([]);
  expect(host.ledger.hasTombstone('slot', delivered.dedupKey, options.now)).toBe(true);
  await host.core.consume(delivered, signal());
  expect(handler).toHaveBeenCalledTimes(1);
});

it('audits stale scan wakes separately from unknown keys', async () => {
  host = await openHost();
  for (const key of [`host-scan:${hash(host.ledger.tenant)}:old`, 'unregistered']) {
    await host.core.consume({ ...wake('ignored', Date.now()), dedupKey: key }, signal());
  }
  expect(host.ledger.snapshot().ignoredWakes?.map(row => row.reason)).toEqual(['stale_scan', 'unknown_key']);
});

it('keeps the later-slot execution cutoff after that Host-only occurrence is compacted', async () => {
  let allowOld = false;
  const at = Date.now() + 60_000;
  host = await openHost({ hostJobs: { watchlist: run => {
    if (run.trigger.plannedAt === at) {
      if (!allowOld) throw new Error('old job pending');
      return { summary: 'late escalation', execution: template(host.deviceId) };
    }
    return { summary: 'newer check done' };
  } } });
  await host.core.addRoutine(definition('cutoff', at));
  vi.setSystemTime(at);
  await expect(host.core.consume(wake('cutoff', at), signal())).rejects.toThrow();
  vi.setSystemTime(at + 86_400_000);
  await expect(host.core.consume(wake('cutoff', at + 86_400_000), signal())).rejects.toThrow();
  const newer = rows().find(row => row.trigger.plannedAt > at)!;
  expect(newer.conclusion).toBe('succeeded');
  host.ledger.compact({ acknowledgedIntentKeys: [], acknowledgedOccurrenceKeys: [newer.key],
    now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  allowOld = true;
  await host.core.recover();
  expect(rows()[0]?.conclusion).toBe('superseded');
  expect(host.adapter.starts).toEqual([]);
});
