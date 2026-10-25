import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash, type HostJobHandler, type HostJobResult, type HostJobRoutineDefinition, type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { createDefinition, routineCalendar } from '@byok-sdk/example-bot-collaboration/routines';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { TEST_HOST } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { hostedRoutineCommands, hostJobRowKey, loadSlice, writeSlice } from './routines';
import { HostedRoutineScheduler } from './scheduler';
import { HostedOutboxSender, type SenderOptions } from './sender';
import { HOST_JOB_EXECUTION_UNSUPPORTED, HostedCollaborationStore, inSchema, lockScope } from './store';

// #793 S14: summary-only Host job routines on H, the cases of K4 host-jobs.test.ts on Postgres.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const table = (name: string) => `"${opened!.store.schema}".${name}`;
const query = <T extends object>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);

const DAILY = { minute: 0, hour: 9, tz: 'UTC' };
const slotAfter = (after: number) => routineCalendar({ rule: DAILY, timeZone: 'UTC' } as unknown as RoutineDefinition, after)!;
/** The K8 calendar takes epoch times in [2000, 2200). */
const NOW = Date.UTC(2026, 0, 1);
const FIRST = slotAfter(NOW - 1), SECOND = slotAfter(FIRST);
const LEASE = 20_000, BACKOFF = 5_000;
const definition = (id: string, version = 1): HostJobRoutineDefinition => ({ id, version, timeZone: 'UTC', rule: DAILY as never, waitMs: 60_000,
  lateAfterMs: 60_000, hostJob: { type: 'watchlist', input: { list: 'abc' } } });
const keyOf = (id: string, plannedAt: number, version = 1) => hash([id, version, { kind: 'scheduled', plannedAt }]);

type OccurrenceRow = { job: unknown; execution_superseded: boolean; conclusion: string | null };
type JobRow = { next_at: string; tries: number; last_error: string | null; settled_at: string | null };

describe.skipIf(POSTGRES_URL === undefined)('H Host job routines on real Postgres (#793 S14)', () => {
  // One schema for each test, because a scheduler or sender pass covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  let clock = NOW;
  beforeEach(() => { clock = NOW; });
  /** A store on the test schema with `handler` as the `watchlist` Host job. */
  const jobStore = (handler?: HostJobHandler) => new HostedCollaborationStore(opened!.pool, opened!.store.schema,
    { host: TEST_HOST, ...(handler ? { hostJobs: { watchlist: handler } } : {}) });
  const sender = (store: HostedCollaborationStore, options: Partial<SenderOptions> = {}) => new HostedOutboxSender(opened!.pool, store,
    { projections: { deliver: async () => {} }, now: () => clock, leaseMs: LEASE, hostJobTimeoutMs: 10_000, backoffMs: BACKOFF, ...options });
  const fire = (store: HostedCollaborationStore) => new HostedRoutineScheduler(opened!.pool, store, { now: () => clock }).run();

  /** A seeded scope with the Host job routine `id`, added at `NOW`. */
  async function scoped(store: HostedCollaborationStore, id = 'watch'): Promise<string> {
    const scope = `tenant:${randomUUID()}`;
    await store.seed(scope, state => seedCollaboration(state));
    await store.bindDevice(scope, 'device');
    await store.addHostJobRoutine(scope, definition(id), NOW);
    return scope;
  }
  const occurrence = async (scope: string, key: string) => (await query<OccurrenceRow>(`SELECT job, execution_superseded, conclusion
    FROM ${table('occurrence')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]))[0];
  const jobRow = async (scope: string, key: string) => (await query<JobRow>(`SELECT next_at::text, tries, last_error, settled_at::text
    FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'host_job'`, [storedKey(scope), hostJobRowKey(key)]))[0];
  const routine = async (scope: string, id: string) => (await query<{ definition: RoutineDefinition; pending: RoutineDefinition | null;
    lifecycle: string; next_at: string | null }>(`SELECT definition, pending, lifecycle, next_at::text FROM ${table('routine')} WHERE scope = $1 AND id = $2`,
  [storedKey(scope), storedKey(id)]))[0];

  it('fires a due Host job with a job row, runs it once through the sender, and stores its summary', async () => {
    const handler = vi.fn<HostJobHandler>(async () => ({ summary: { events: 2 } }));
    const store = jobStore(handler), scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    expect(await fire(store)).toEqual({ fired: 1, fenced: [], failed: [] });
    expect(await occurrence(scope, key)).toEqual({ job: {}, execution_superseded: false, conclusion: null });
    expect(await jobRow(scope, key)).toEqual({ next_at: '0', tries: 0, last_error: null, settled_at: null });
    expect(await routine(scope, 'watch')).toMatchObject({ next_at: String(SECOND) });
    expect(await sender(store).run()).toEqual({ steps: 1, failed: [] });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toEqual({ type: 'watchlist', input: { list: 'abc' }, occurrenceKey: key, routineId: 'watch', definitionVersion: 1,
      trigger: { kind: 'scheduled', plannedAt: FIRST }, attempt: 1, signal: expect.any(AbortSignal) });
    expect(await occurrence(scope, key)).toEqual({ job: { summary: { events: 2 } }, execution_superseded: false, conclusion: 'succeeded' });
    expect(await jobRow(scope, key)).toEqual({ next_at: String(FIRST + LEASE), tries: 1, last_error: null, settled_at: String(FIRST) });
    expect(await query(`SELECT 1 FROM ${table('intent')}`, [])).toEqual([]);
    // The slot is fired once: a second pass finds it not due, and the settled row is not run again.
    expect(await fire(store)).toEqual({ fired: 0, fenced: [], failed: [] });
    expect(await sender(store).run()).toEqual({ steps: 0, failed: [] });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps a Host job out of Bot policy, and Host code out of Bot routines', async () => {
    const store = jobStore(() => ({ summary: null })), scope = await scoped(store, 'nightly');
    const bot = await inSchema(opened!.pool, store.schema, async client => {
      await lockScope(client, storedKey(scope));
      const slice = await loadSlice(client, storedKey(scope)), commands = hostedRoutineCommands(slice, NOW);
      const created = createDefinition(commands.list(), 'main', 'task', 0, { localId: 'r', schedule: DAILY, prompt: 'Daily report' }, 'bot');
      commands.create(created);
      await writeSlice(client, storedKey(scope), slice);
      return created;
    });
    await expect(store.setRoutineLifecycle(scope, 'main', 'nightly', 'paused', NOW)).rejects.toThrow('Routine is unavailable to this Bot');
    await expect(store.commit(scope, { scope, commandId: randomUUID(), command: { kind: 'end_routine', botId: 'main', routineId: 'nightly' } }, () => NOW))
      .rejects.toThrow('No open Bot routine has this id');
    await expect(store.setHostJobLifecycle(scope, bot.id, 'paused', NOW)).rejects.toThrow('No Host job routine has this id');
    await expect(store.addHostJobRoutine(scope, { ...bot, id: 'other' } as never, NOW)).rejects.toThrow('Host code adds only Host job routines');
    const { hostJob: _job, ...rest } = definition('execution');
    await expect(store.addHostJobRoutine(scope, { ...rest, execution: template('device') } as never, NOW)).rejects.toThrow();
    await expect(store.addHostJobRoutine(scope, { ...definition('missing'), hostJob: { type: 'missing', input: null } }, NOW))
      .rejects.toThrow('Host job handler not registered');
    await expect(store.addHostJobRoutine(scope, { ...definition('lossy'), hostJob: { type: 'watchlist', input: { bad: undefined } as never } }, NOW))
      .rejects.toThrow('Routine input and Host job summary must be JSON');
    expect((await query<{ id: string }>(`SELECT id FROM ${table('routine')} WHERE scope = $1 ORDER BY ordinal`, [storedKey(scope)])).map(row => JSON.parse(row.id)))
      .toEqual(['nightly', bot.id]);
    // The sync builds the Bot routine views without the Host job.
    await store.sync(scope, { ...SYNC_OPTIONS, now: NOW, history: undefined });
  });

  it('keeps the occurrence pending after a handler throw, waits backoffMs, and retries with the same occurrence key', async () => {
    let fail = true;
    const runs: { key: string; attempt: number }[] = [];
    const store = jobStore(run => {
      runs.push({ key: run.occurrenceKey, attempt: run.attempt });
      if (fail) throw new Error('Host source unavailable');
      return { summary: { recovered: true } };
    });
    const scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    expect(await sender(store).run()).toEqual({ steps: 1, failed: [{ scope, id: ['host_job', key], error: new Error('Host source unavailable') }] });
    expect(await occurrence(scope, key)).toMatchObject({ job: {}, conclusion: null });
    expect(await jobRow(scope, key)).toEqual({ next_at: String(FIRST + BACKOFF), tries: 1, last_error: 'Host source unavailable', settled_at: null });
    expect(await sender(store).run()).toEqual({ steps: 0, failed: [] });
    fail = false;
    clock = FIRST + BACKOFF;
    expect(await sender(store).run()).toEqual({ steps: 1, failed: [] });
    expect(runs).toEqual([{ key, attempt: 1 }, { key, attempt: 2 }]);
    expect(await occurrence(scope, key)).toMatchObject({ job: { summary: { recovered: true } }, conclusion: 'succeeded' });
    expect(await jobRow(scope, key)).toMatchObject({ tries: 2, last_error: null, settled_at: String(FIRST + BACKOFF) });
  });

  it.each([
    ['missing summary', {}, 'Host job result requires a summary'],
    ['non-JSON summary', { summary: { bad: undefined } }, 'Routine input and Host job summary must be JSON'],
  ] as const)('rejects a %s and commits no result', async (_name, result, error) => {
    const store = jobStore(() => result as unknown as HostJobResult), scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    expect((await sender(store).run()).failed).toEqual([{ scope, id: ['host_job', key], error: new Error(error) }]);
    expect(await occurrence(scope, key)).toMatchObject({ job: {}, conclusion: null });
    expect(await jobRow(scope, key)).toMatchObject({ last_error: error, settled_at: null });
  });

  it('concludes a result that carries execution as failed with its summary, and promotes nothing (owner Q4 A)', async () => {
    const store = jobStore(() => ({ summary: { escalate: true }, execution: template('device') }));
    const scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    expect(await sender(store).run()).toEqual({ steps: 1, failed: [{ scope, id: ['host_job', key], error: new Error(HOST_JOB_EXECUTION_UNSUPPORTED) }] });
    expect(await occurrence(scope, key)).toMatchObject({ job: { summary: { escalate: true } }, conclusion: 'failed' });
    expect(await jobRow(scope, key)).toMatchObject({ tries: 1, last_error: HOST_JOB_EXECUTION_UNSUPPORTED, settled_at: String(FIRST) });
    expect(await query(`SELECT 1 FROM ${table('intent')}`, [])).toEqual([]);
  });

  it('marks a pending Host job superseded at the next slot, and still concludes its execution result as failed', async () => {
    let allowOld = false;
    const store = jobStore(run => {
      if (run.trigger.plannedAt === FIRST) {
        if (!allowOld) throw new Error('old job pending');
        return { summary: 'late escalation', execution: template('device') };
      }
      return { summary: 'newer check done' };
    });
    const scope = await scoped(store), old = keyOf('watch', FIRST), newer = keyOf('watch', SECOND);
    clock = FIRST;
    await fire(store);
    await sender(store).run();
    clock = SECOND;
    await fire(store);
    expect(await occurrence(scope, old)).toMatchObject({ job: {}, execution_superseded: true, conclusion: null });
    allowOld = true;
    await sender(store).run();
    expect(await occurrence(scope, newer)).toMatchObject({ job: { summary: 'newer check done' }, execution_superseded: false, conclusion: 'succeeded' });
    expect(await occurrence(scope, old)).toMatchObject({ job: { summary: 'late escalation' }, execution_superseded: true, conclusion: 'failed' });
  });

  it('aborts a handler that outlasts hostJobTimeoutMs and keeps its occurrence pending', async () => {
    let signal: AbortSignal | undefined;
    const store = jobStore(run => { signal = run.signal; return new Promise(() => {}); }), scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    expect((await sender(store, { hostJobTimeoutMs: 20 }).run()).failed).toEqual([{ scope, id: ['host_job', key], error: new Error('Host job timed out') }]);
    expect(signal?.aborted).toBe(true);
    expect(await occurrence(scope, key)).toMatchObject({ conclusion: null });
    expect(await jobRow(scope, key)).toMatchObject({ last_error: 'Host job timed out', settled_at: null });
  });

  it('runs once when two senders take one row: the lease holds the second', async () => {
    let release!: () => void, calls = 0;
    const store = jobStore(() => { calls++; return new Promise(resolve => { release = () => resolve({ summary: 'done' }); }); });
    const scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    const first = sender(store).run();
    await expect.poll(() => calls).toBe(1);
    expect(await sender(store).run()).toEqual({ steps: 0, failed: [] });
    release();
    expect(await first).toEqual({ steps: 1, failed: [] });
    expect(calls).toBe(1);
    expect(await occurrence(scope, key)).toMatchObject({ conclusion: 'succeeded' });
  });

  it('runs a Host job again when an earlier claim\'s lease passed with no settle, and ignores that claim\'s late settle', async () => {
    const releases: (() => void)[] = [], attempts: number[] = [];
    const store = jobStore(run => {
      attempts.push(run.attempt);
      return new Promise(resolve => { releases.push(() => resolve({ summary: { attempt: run.attempt } })); });
    });
    const scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    const first = sender(store).run();
    await expect.poll(() => attempts).toEqual([1]);
    clock = FIRST + LEASE;
    const second = sender(store).run();
    await expect.poll(() => attempts).toEqual([1, 2]);
    releases[1]!();
    expect(await second).toEqual({ steps: 1, failed: [] });
    releases[0]!();
    expect(await first).toEqual({ steps: 0, failed: [] });
    expect(await occurrence(scope, key)).toMatchObject({ job: { summary: { attempt: 2 } }, conclusion: 'succeeded' });
    expect(await jobRow(scope, key)).toMatchObject({ tries: 2, settled_at: String(FIRST + LEASE) });
  });

  it('reports a missing handler after a restart and keeps the work pending for repair', async () => {
    const scope = await scoped(jobStore(() => ({ summary: null }))), key = keyOf('watch', FIRST);
    clock = FIRST;
    const restarted = jobStore();
    await fire(restarted);
    expect((await sender(restarted).run()).failed).toEqual([{ scope, id: ['host_job', key], error: new Error('Host job handler not registered') }]);
    expect(await jobRow(scope, key)).toMatchObject({ tries: 1, last_error: 'Host job handler not registered', settled_at: null });
    expect(await occurrence(scope, key)).toMatchObject({ conclusion: null });
  });

  it('switches a staged version once the old Host job concludes', async () => {
    let release!: () => void;
    const store = jobStore(() => new Promise(resolve => { release = () => resolve({ summary: 'v1' }); }));
    const scope = await scoped(store);
    clock = FIRST;
    await fire(store);
    const running = sender(store).run();
    await expect.poll(() => release).toBeTypeOf('function');
    await store.updateHostJobRoutine(scope, { ...definition('watch', 2), hostJob: { type: 'watchlist', input: { list: 'xyz' } } }, FIRST);
    expect(await routine(scope, 'watch')).toMatchObject({ definition: { version: 1 }, pending: { version: 2 } });
    release();
    await running;
    expect(await routine(scope, 'watch')).toMatchObject({ definition: { version: 2, hostJob: { input: { list: 'xyz' } } }, pending: null });
  });

  it('pauses future slots and lets the admitted Host job finish, then completes the routine for good', async () => {
    const handler = vi.fn<HostJobHandler>(() => ({ summary: null }));
    const store = jobStore(handler), scope = await scoped(store), key = keyOf('watch', FIRST);
    clock = FIRST;
    await fire(store);
    await store.setHostJobLifecycle(scope, 'watch', 'paused', FIRST);
    expect(await sender(store).run()).toEqual({ steps: 1, failed: [] });
    expect(await occurrence(scope, key)).toMatchObject({ conclusion: 'succeeded' });
    clock = SECOND;
    expect(await fire(store)).toEqual({ fired: 0, fenced: [], failed: [] });
    await store.setHostJobLifecycle(scope, 'watch', 'completed', SECOND);
    await expect(store.setHostJobLifecycle(scope, 'watch', 'active', SECOND)).rejects.toThrow('cannot resume');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a Host job timeout that is not a positive integer, and, with Host job handlers, a lease that is not longer', () => {
    const store = jobStore(() => ({ summary: null }));
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => sender(store, { hostJobTimeoutMs: bad })).toThrow('The outbox lease must be longer than the Host job timeout');
    expect(() => sender(store, { hostJobTimeoutMs: LEASE })).toThrow('The outbox lease must be longer than the Host job timeout');
    expect(() => sender(store, { hostJobTimeoutMs: LEASE - 1 })).not.toThrow();
    expect(() => sender(jobStore(), { hostJobTimeoutMs: LEASE })).not.toThrow();
  });
});
