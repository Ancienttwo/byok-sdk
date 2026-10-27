import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { nextRoutineOccurrence } from '@byok-sdk/core';
import { hash as hostKey } from '@byok-sdk/example-host-execution-core';
import { openHost as openCore, policy } from '@byok-sdk/example-host-execution-core/test-support';
import { afterEach, expect, it, vi } from 'vitest';
import { BetaLedger, createBetaMcpServer, createRoutineTools, createTaskTools, retireRevokedRoutines, routineScheduleCalendar,
  type KeySpec } from './index';
import { call, cleanup, connect } from './tools.test-support';

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
type Client = Awaited<ReturnType<typeof connect>>;
const resultSchema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };
const schedule = { minute: 0, hour: 9, tz: 'Asia/Hong_Kong' };

/** The K4 test Host (embedded server, real daemon, stub Pi runtime) with the beta MCP endpoint on its own loopback origin. */
async function openRoutineHost() {
  const host = await openCore({ nextOccurrence: routineScheduleCalendar });
  cleanup.push(() => host.close());
  const root = mkdtempSync(join(tmpdir(), 'b4-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new BetaLedger(join(root, 'beta.sqlite'), 'tenant-b4', { tasks: host.server.tasks });
  let endpoint: ReturnType<typeof createBetaMcpServer> | undefined;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => endpoint!.fetch(request) });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  const core = host.core;
  endpoint = createBetaMcpServer({ ledger, origin, serverInfo: { name: 'B4 test host', version: '1' }, tools: [
    ...createTaskTools({ sdk: host.server, ledger, egressPolicy: policy, blobBaseUrl: origin }),
    ...createRoutineTools({ sdk: host.server, ledger, core, egressPolicy: policy, waitMs: 60_000, lateAfterMs: 60_000 }),
  ] });
  cleanup.push(async () => {
    endpoint!.close(); if ('closeAllConnections' in http) http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve())); ledger.close();
  });
  const spec = (rest: Partial<KeySpec> = {}): KeySpec => ({ label: 'Bot A', scopes: ['routines.read', 'routines.write'],
    deviceIds: [host.deviceId], runtimes: ['pi'], agentRef: { agentId: 'main', profileRevision: '1' }, ...rest });
  return { host, core, ledger, spec, url: new URL('/mcp', origin) };
}
async function refused(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(client, name, args); expect(result.isError).toBe(true); return result.value.code as string;
}
const routinesNow = async (client: Client) => (await call(client, 'byok_whoami')).value.quota.now.routines as number;

it('creates a routine on K4, runs one due occurrence on the real daemon, reports its outcome and cancels it', async () => {
  const { host, core, ledger, spec, url } = await openRoutineHost();
  const key = ledger.issueKey(spec());
  const client = await connect({ url }, key.token);
  expect((await client.listTools()).tools.map(tool => tool.name).sort())
    .toEqual(['byok_routine_cancel', 'byok_routine_create', 'byok_routine_list', 'byok_whoami']);
  // Mock only the wall clock, as K4's own routine tests do. Scans are forced with drain().
  const now = Date.now(); vi.setSystemTime(now);
  const firstAt = nextRoutineOccurrence(schedule, now - 1)!;
  const args = { localId: 'daily-report', schedule, task: { runtime: 'pi', instruction: 'Write the daily report.', resultSchema } };

  const created = await call(client, 'byok_routine_create', args);
  expect(created).toEqual({ isError: false, value: { routineId: expect.stringMatching(/^[a-f0-9]{64}$/), lifecycle: 'active',
    nextAt: new Date(firstAt).toISOString(), deduplicated: false } });
  const { routineId } = created.value;
  expect((await call(client, 'byok_routine_create', args)).value).toEqual({ ...created.value, deduplicated: true });
  expect(await refused(client, 'byok_routine_create', { ...args, task: { ...args.task, instruction: 'Something else.' } })).toBe('idempotency_conflict');
  expect(await routinesNow(client)).toBe(1);
  // The SDK holds one one-shot wake per routine slot: (routineId, version, t).
  await vi.waitFor(async () => expect((await host.server.wakes.pending()).map(wake => wake.dedupKey)).toContain(`${routineId}:1:${firstAt}`));
  const listed = (await call(client, 'byok_routine_list')).value;
  expect(listed).toEqual({ routines: [{ routineId, lifecycle: 'active', status: 'ok', nextAt: new Date(firstAt).toISOString(),
    localId: 'daily-report', createdAt: new Date(now).toISOString(), schedule, runtime: 'pi' }] });

  vi.setSystemTime(firstAt + 1);
  // A foreign wake makes the SDK wake loop read the moved clock; K4 ignores its key.
  await host.server.wakes.schedule({ dedupKey: 'b4-clock:1', availableAt: Date.now() });
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(1), { timeout: 5000 });
  const taskId = host.adapter.starts[0]!.manifest.taskId;
  const offer = await host.server.tasks.offer(taskId);
  expect(offer).toMatchObject({ type: 'task.offer', deviceId: host.deviceId, payload: {
    runtime: 'pi', instruction: 'Write the daily report.', agentRef: { agentId: 'main', profileRevision: '1' },
    terminalProjection: { mode: 'result-document', contract: 'byok-mcp-routine-v1', schema: resultSchema } } });
  host.adapter.sessions.get(taskId)!.finish({ text: 'Report sent.' });
  const secondAt = nextRoutineOccurrence(schedule, firstAt + 1)!;
  await vi.waitFor(async () => {
    await core.drain();
    expect((await call(client, 'byok_routine_list')).value.routines[0]).toEqual({ routineId, lifecycle: 'active', status: 'ok',
      nextAt: new Date(secondAt).toISOString(), localId: 'daily-report', createdAt: new Date(now).toISOString(), schedule, runtime: 'pi',
      lastOccurrence: { plannedAt: new Date(firstAt).toISOString(), trigger: 'scheduled', taskId, attempts: 1,
        conclusion: 'succeeded', document: { text: 'Report sent.' } } });
  }, { timeout: 5000 });

  // The next slot runs too. List reports the newest occurrence while it runs.
  vi.setSystemTime(secondAt + 1);
  await host.server.wakes.schedule({ dedupKey: 'b4-clock:2', availableAt: Date.now() });
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(2), { timeout: 5000 });
  const secondTask = host.adapter.starts[1]!.manifest.taskId;
  expect((await call(client, 'byok_routine_list')).value.routines[0].lastOccurrence)
    .toEqual({ plannedAt: new Date(secondAt).toISOString(), trigger: 'scheduled', taskId: secondTask, attempts: 1 });

  // Cancel stops new slots; the run that already started still finishes.
  expect((await call(client, 'byok_routine_cancel', { routineId })).value).toEqual({ routineId, state: 'completed' });
  expect((await call(client, 'byok_routine_cancel', { routineId })).value).toEqual({ routineId, state: 'completed' });
  expect(await routinesNow(client)).toBe(0);
  host.adapter.sessions.get(secondTask)!.finish({ text: 'Second report.' });
  await vi.waitFor(async () => {
    await core.drain();
    expect((await call(client, 'byok_routine_list')).value.routines[0].lastOccurrence)
      .toMatchObject({ taskId: secondTask, conclusion: 'succeeded', document: { text: 'Second report.' } });
  }, { timeout: 5000 });
  await vi.waitFor(async () => expect((await host.server.wakes.pending()).filter(wake => wake.dedupKey.startsWith(routineId))).toEqual([]));
  expect((await call(client, 'byok_routine_list')).value.routines[0]).toMatchObject({ routineId, lifecycle: 'completed', nextAt: null });
  // A retry of the original create reads the cancelled routine back; it never schedules again.
  expect((await call(client, 'byok_routine_create', args)).value).toEqual({ routineId, lifecycle: 'completed', nextAt: null, deduplicated: true });
  expect(core.ledger.snapshot().routines[hostKey(routineId)]?.lifecycle).toBe('completed');
  expect(host.adapter.starts).toHaveLength(2);
});

it('refuses bad or ungranted routines before admission, enforces the routine cap and hides foreign routines', async () => {
  const { core, ledger, spec, url } = await openRoutineHost();
  const client = await connect({ url }, ledger.issueKey(spec({ quota: { routines: 1 } })).token);
  const task = { runtime: 'pi', instruction: 'Check the build.' };
  const create = (localId: string, rest: Record<string, unknown> = {}) => call(client, 'byok_routine_create', { localId, schedule, task, ...rest });
  for (const bad of [{ schedule: { ...schedule, hour: 24 } }, { schedule: { ...schedule, tz: 'Mars/Olympus' } },
    { schedule: { ...schedule, month: 2, dayOfMonth: 29 } }, { task: { ...task, clientRequestId: 'run-1' } },
    { task: { ...task, workspace: 'repo-a' } }, { task: { ...task, toolsets: ['docs', 'docs'] } },
    { task: { ...task, resultSchema: { type: 'string' } } }, { task: { ...task, extra: true } }, { extra: true }]) {
    expect((await create('bad', bad)).value.code).toBe('invalid_input');
  }
  expect((await create('bad id with spaces')).value.code).toBe('invalid_input');
  expect((await create('codex', { task: { ...task, runtime: 'codex' } })).value.code).toBe('forbidden');
  expect(await routinesNow(client)).toBe(0);
  expect(Object.keys(core.ledger.snapshot().routines)).toEqual([]);

  const { routineId } = (await create('first')).value;
  expect((await create('second')).value).toEqual({ code: 'quota_exceeded', message: 'Routine slots are full', retryAfterSeconds: 1 });

  const other = await connect({ url }, ledger.issueKey(spec({ label: 'Bot B', agentRef: { agentId: 'other', profileRevision: '1' } })).token);
  const foreign = await call(other, 'byok_routine_cancel', { routineId });
  expect(foreign).toEqual({ isError: true, value: { code: 'not_found', message: 'Resource not found' } });
  expect(await call(other, 'byok_routine_cancel', { routineId: 'f'.repeat(64) })).toEqual(foreign);
  expect((await call(other, 'byok_routine_list')).value).toEqual({ routines: [] });
  expect(core.ledger.snapshot().routines[hostKey(routineId)]?.lifecycle).toBe('active');
  const tasksOnly = await connect({ url }, ledger.issueKey({ label: 'Bot C', scopes: ['tasks.read'], deviceIds: ['dev'], runtimes: ['pi'] }).token);
  expect((await tasksOnly.listTools()).tools.map(tool => tool.name).sort()).toEqual(['byok_runtimes', 'byok_task_list', 'byok_task_status', 'byok_whoami']);

  // Cancel frees the slot for a new routine.
  await call(client, 'byok_routine_cancel', { routineId });
  expect((await create('second')).value).toMatchObject({ lifecycle: 'active', deduplicated: false });
});

it('keeps a routine that K4 never committed reserved, schedules it on retry, and lets cancel retire it', async () => {
  const { host, core, ledger, spec, url } = await openRoutineHost();
  const client = await connect({ url }, ledger.issueKey(spec()).token);
  const args = (localId: string) => ({ localId, schedule, task: { runtime: 'pi', instruction: 'Summarize the inbox.' } });
  // A failure before K4's transaction, as when the Host calendar throws.
  vi.spyOn(core, 'addRoutine').mockRejectedValueOnce(new Error('calendar unavailable'));
  expect((await call(client, 'byok_routine_create', args('retry'))).value)
    .toEqual({ code: 'unavailable', message: 'The routine was admitted but not scheduled. Retry the same call.', retryAfterSeconds: 1 });
  expect((await call(client, 'byok_routine_list')).value.routines).toEqual([expect.objectContaining({ lifecycle: 'reserved', nextAt: null })]);
  expect(await routinesNow(client)).toBe(1);
  const retried = (await call(client, 'byok_routine_create', args('retry'))).value;
  expect(retried).toMatchObject({ lifecycle: 'active', nextAt: expect.any(String), deduplicated: true });
  expect(core.ledger.snapshot().routines[hostKey(retried.routineId)]?.definition.execution!.payload.terminalProjection).toEqual({ mode: 'none' });

  vi.spyOn(core, 'addRoutine').mockRejectedValueOnce(new Error('calendar unavailable'));
  const failed = await call(client, 'byok_routine_create', args('retire'));
  expect(failed.value.code).toBe('unavailable');
  const reserved = (await call(client, 'byok_routine_list')).value.routines.find((row: { localId: string }) => row.localId === 'retire');
  expect(reserved).toMatchObject({ lifecycle: 'reserved', nextAt: null });
  expect((await call(client, 'byok_routine_cancel', { routineId: reserved.routineId })).value).toEqual({ routineId: reserved.routineId, state: 'completed' });
  expect((await call(client, 'byok_routine_create', args('retire'))).value)
    .toEqual({ routineId: reserved.routineId, lifecycle: 'completed', nextAt: null, deduplicated: true });
  expect(core.ledger.snapshot().routines[hostKey(reserved.routineId)]).toBeUndefined();
  expect(await routinesNow(client)).toBe(1);

  // A cancel that lands while a retry selects its device also wins: the retry reads the released slot back.
  vi.spyOn(core, 'addRoutine').mockRejectedValueOnce(new Error('calendar unavailable'));
  expect((await call(client, 'byok_routine_create', args('race'))).value.code).toBe('unavailable');
  const race = (await call(client, 'byok_routine_list')).value.routines.find((row: { localId: string }) => row.localId === 'race');
  let release!: () => void; let selecting!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const selected = new Promise<void>(resolve => { selecting = resolve; });
  const list = host.server.machines.list.bind(host.server.machines);
  vi.spyOn(host.server.machines, 'list').mockImplementationOnce(async () => { selecting(); await gate; return list(); });
  const retry = call(client, 'byok_routine_create', args('race'));
  await selected;
  expect((await call(client, 'byok_routine_cancel', { routineId: race.routineId })).value).toEqual({ routineId: race.routineId, state: 'completed' });
  release();
  expect((await retry).value).toEqual({ routineId: race.routineId, lifecycle: 'completed', nextAt: null, deduplicated: true });
  expect(core.ledger.snapshot().routines[hostKey(race.routineId)]).toBeUndefined();

  // A crash after K4 completes the routine but before the slot release: the next list releases it.
  vi.spyOn(ledger, 'releaseRoutineSlot').mockImplementationOnce(() => { throw new Error('crashed before release'); });
  expect((await call(client, 'byok_routine_cancel', { routineId: retried.routineId })).value.code).toBe('unavailable');
  expect(core.ledger.snapshot().routines[hostKey(retried.routineId)]?.lifecycle).toBe('completed');
  expect(await routinesNow(client)).toBe(1);
  expect((await call(client, 'byok_routine_list')).value.routines.find((row: { localId: string }) => row.localId === 'retry'))
    .toMatchObject({ lifecycle: 'completed', nextAt: null });
  expect(await routinesNow(client)).toBe(0);
});

it('stops a revoked key\'s routines on K4, and finishes an interrupted retirement at startup', async () => {
  const { host, core, ledger, spec, url } = await openRoutineHost();
  const create = async (token: string, localId: string) => (await call(await connect({ url }, token), 'byok_routine_create',
    { localId, schedule, task: { runtime: 'pi', instruction: 'Rotate the logs.' } })).value.routineId as string;
  const state = (routineId: string) => core.ledger.snapshot().routines[hostKey(routineId)]?.lifecycle;
  const routineWakes = async (routineId: string) => (await host.server.wakes.pending()).filter(wake => wake.dedupKey.startsWith(routineId));
  const first = ledger.issueKey(spec());
  const routineId = await create(first.token, 'logs');
  expect(await routineWakes(routineId)).toHaveLength(1);
  ledger.revokeKey(first.key.keyId);
  await vi.waitFor(async () => {
    expect(state(routineId)).toBe('completed');
    expect(await routineWakes(routineId)).toEqual([]);
    expect(ledger.revokedRoutines()).toEqual([]);
  });

  // The revocation listener fails before K4 commits; startup retirement finishes it.
  const second = ledger.issueKey(spec({ label: 'Bot B' }));
  const otherId = await create(second.token, 'logs');
  vi.spyOn(core, 'lifecycle').mockRejectedValueOnce(new Error('Host stopped'));
  ledger.revokeKey(second.key.keyId);
  await vi.waitFor(() => expect(core.lifecycle).toHaveBeenCalledTimes(1));
  expect(state(otherId)).toBe('active');
  expect(ledger.revokedRoutines()).toEqual([otherId]);
  await retireRevokedRoutines(ledger, core);
  expect(state(otherId)).toBe('completed');
  expect(ledger.revokedRoutines()).toEqual([]);
  await vi.waitFor(async () => expect(await routineWakes(otherId)).toEqual([]));
});

it('reads the RoutineSchedule rule in its own time zone and refuses any other rule', () => {
  const definition = { id: 'r', version: 1, timeZone: 'Asia/Hong_Kong', rule: schedule, execution: {} as never, waitMs: 1, lateAfterMs: 1 };
  const after = Date.UTC(2026, 9, 20, 2);
  expect(routineScheduleCalendar(definition, after)).toBe(Date.UTC(2026, 9, 21, 1));
  expect(() => routineScheduleCalendar({ ...definition, timeZone: 'UTC' }, after)).toThrow('RoutineSchedule');
  expect(() => routineScheduleCalendar({ ...definition, rule: { anchorMs: 0, everyMs: 1 } }, after)).toThrow('RoutineSchedule');
});

it('retires every revoked-key routine before awaiting a slow wake cancellation', async () => {
  const { host, core, ledger, spec, url } = await openRoutineHost();
  const key = ledger.issueKey(spec());
  const client = await connect({ url }, key.token);
  const create = async (localId: string) => (await call(client, 'byok_routine_create',
    { localId, schedule, task: { runtime: 'pi', instruction: 'Rotate the logs.' } })).value.routineId as string;
  await create('first');
  const secondId = await create('second');
  const next = core.ledger.snapshot().routines[hostKey(secondId)]!.next!;
  let release!: () => void;
  let cancelling!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { cancelling = resolve; });
  const cancel = host.server.wakes.cancel.bind(host.server.wakes);
  vi.spyOn(host.server.wakes, 'cancel').mockImplementationOnce(async key => {
    cancelling();
    await gate;
    return cancel(key);
  });
  let consuming: Promise<void> | undefined;
  try {
    ledger.revokeKey(key.key.keyId);
    await entered;
    // Model a due wake delivered while the first routine's external cancellation stalls.
    // The real core records the occurrence synchronously, before waiting for its drain.
    vi.setSystemTime(next.availableAt);
    consuming = core.consume({ ...next, wakeId: 'revocation-race', deliveredAt: next.availableAt, delivery: 1 }, new AbortController().signal);
    expect(Object.values(core.ledger.snapshot().occurrences).filter(row => row.routineId === secondId)).toEqual([]);
    expect(core.ledger.snapshot().routines[hostKey(secondId)]?.lifecycle).toBe('completed');
  } finally {
    vi.useRealTimers();
    release();
    await consuming;
    await vi.waitFor(() => expect(ledger.revokedRoutines()).toEqual([]));
  }
});
