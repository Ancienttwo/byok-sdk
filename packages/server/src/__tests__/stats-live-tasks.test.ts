import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, TASK_STATES, type TaskState } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { LiveTaskIndex } from '../live-tasks';
import { isSqliteAvailable } from '../sqlite-support';
import {
  claimAndStart,
  connectFakeDaemonLongPoll,
  moveToAwaitApproval,
  nextEnvelope,
  sendOne,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
} from './test-support';

/**
 * Issue #388 item 3: `stats()` re-reads only tasks still in flight, its counts
 * match the full-history projection `tasks.list()` reports, and the per-task
 * live-task bookkeeping is reclaimed at terminal while dispatch facts remain
 * readable from immutable offer receipts.
 *
 * Store reads are counted at the kernel surface the façade calls, by wrapping
 * the one `createByokCloud` it constructs.
 */
const kernelCalls = vi.hoisted(() => ({ listTaskAttempts: 0, readApprovalTimeline: 0 }));
vi.mock('@byok-sdk/cloud', async (importOriginal) => {
  const original = await importOriginal<typeof import('@byok-sdk/cloud')>();
  return {
    ...original,
    createByokCloud: (...args: Parameters<typeof original.createByokCloud>) => {
      const cloud = original.createByokCloud(...args);
      return {
        ...cloud,
        listTaskAttempts: (...call: Parameters<typeof cloud.listTaskAttempts>) => {
          kernelCalls.listTaskAttempts += 1;
          return cloud.listTaskAttempts(...call);
        },
        readApprovalTimeline: (...call: Parameters<typeof cloud.readApprovalTimeline>) => {
          kernelCalls.readApprovalTimeline += 1;
          return cloud.readApprovalTimeline(...call);
        },
      };
    },
  };
});

const PRODUCT_ID = 'stats-live-tasks';
const SHORT_HOLD_MS = 200;

/** Today's definition of the counts: every task `tasks.list()` projects, counted by state. */
async function fullScanCounts(byok: ByokServer): Promise<Record<TaskState, number>> {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
  let cursor: string | undefined;
  do {
    const page = await byok.tasks.list({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    for (const task of page.tasks) counts[task.state] += 1;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return counts;
}

/** The read cost of one `stats()` call, at the kernel surface. */
async function statsReads(byok: ByokServer) {
  const before = { ...kernelCalls };
  const stats = await byok.stats();
  return {
    stats,
    listTaskAttempts: kernelCalls.listTaskAttempts - before.listTaskAttempts,
    readApprovalTimeline: kernelCalls.readApprovalTimeline - before.readApprovalTimeline,
  };
}

async function runToTerminal(
  byok: ByokServer,
  daemon: FakeLongPollDaemon,
  outcome: 'complete' | 'fail' | 'cancel',
): Promise<string> {
  const handle = await byok.dispatch({ deviceId: daemon.deviceId, instruction: `to ${outcome}` });
  await nextEnvelope(daemon);
  await claimAndStart(byok, daemon, handle);
  if (outcome === 'cancel') {
    await handle.cancel('stop');
    await nextEnvelope(daemon); // task.cancel
  } else {
    const terminal =
      outcome === 'complete'
        ? createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess' }, { taskId: handle.taskId })
        : createEnvelope('task.fail', { reason: 'broke', retryable: false }, { taskId: handle.taskId });
    expect(await sendOne(daemon, terminal)).toEqual({ status: 200, body: { accepted: 1 } });
  }
  return handle.taskId;
}

/** One task in each live state: Offered, Running, AwaitApproval. */
async function leaveLiveTasks(byok: ByokServer, daemon: FakeLongPollDaemon): Promise<void> {
  const running = await byok.dispatch({ deviceId: daemon.deviceId, instruction: 'keep running' });
  await nextEnvelope(daemon);
  await claimAndStart(byok, daemon, running);
  const paused = await byok.dispatch({ deviceId: daemon.deviceId, instruction: 'needs approval' });
  await nextEnvelope(daemon);
  await claimAndStart(byok, daemon, paused);
  await moveToAwaitApproval(byok, daemon, paused);
  await byok.dispatch({ deviceId: daemon.deviceId, instruction: 'never claimed' });
  await nextEnvelope(daemon);
}

describe('stats() over live tasks only', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (server) await stopServer(server);
    server = undefined;
    await byok?.close();
    byok = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function start(storage?: { kind: 'sqlite'; path: string }) {
    const instance = createByokServer({
      productId: PRODUCT_ID,
      longPollHoldMs: SHORT_HOLD_MS,
      ...(storage === undefined ? {} : { storage }),
    });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('matches the full-scan counts while its reads stay flat as terminal tasks accumulate', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    await leaveLiveTasks(started.byok, daemon);
    for (const outcome of ['complete', 'fail', 'cancel'] as const) await runToTerminal(started.byok, daemon, outcome);

    const small = await statsReads(started.byok);
    expect(small.stats.taskCountsByState).toEqual(await fullScanCounts(started.byok));
    expect(small.stats.taskCountsByState).toMatchObject({ Offered: 1, Running: 1, AwaitApproval: 1, Complete: 1, Failed: 1, Cancelled: 1 });

    for (let index = 0; index < 9; index += 1) {
      await runToTerminal(started.byok, daemon, (['complete', 'fail', 'cancel'] as const)[index % 3]!);
    }

    const large = await statsReads(started.byok);
    expect(large.stats.taskCountsByState).toEqual(await fullScanCounts(started.byok));
    expect(large.stats.taskCountsByState).toMatchObject({ Complete: 4, Failed: 4, Cancelled: 4 });
    // No history walk at all, and one approval-timeline read per LIVE task, at 3 and at 12 terminal tasks alike.
    expect(small.listTaskAttempts).toBe(0);
    expect(large.listTaskAttempts).toBe(0);
    expect(small.readApprovalTimeline).toBe(3);
    expect(large.readApprovalTimeline).toBe(3);
  });

  it('drops live task IDs when a task turns terminal, so bookkeeping does not grow with completed tasks', async () => {
    const opened = vi.spyOn(LiveTaskIndex.prototype, 'opened');
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const live = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'still live', sessionRef: 'sess-live' });
    await nextEnvelope(daemon);
    // The server's own index, captured as the receiver of its first opened call.
    const tracked = opened.mock.contexts[0] as LiveTaskIndex;
    expect(tracked.size).toBe(1);
    expect((await started.byok.tasks.get(live.taskId))?.sessionRef).toBe('sess-live');

    for (let completed = 1; completed <= 8; completed += 1) {
      await runToTerminal(started.byok, daemon, 'complete');
      expect(tracked.size).toBe(1);
    }
    expect((await started.byok.stats()).taskCountsByState.Complete).toBe(8);
  });

  it('accounts a SQLite file\'s history once at open and matches the full scan after restart', async (context) => {
    if (!isSqliteAvailable()) context.skip();
    const root = mkdtempSync(join(tmpdir(), 'byok-stats-'));
    roots.push(root);
    const storage = { kind: 'sqlite' as const, path: join(root, 'server.sqlite') };

    const first = await start(storage);
    const daemon = await connectFakeDaemonLongPoll(first.baseUrl, first.byok, { productId: PRODUCT_ID });
    await leaveLiveTasks(first.byok, daemon);
    for (const outcome of ['complete', 'fail', 'cancel', 'complete'] as const) {
      await runToTerminal(first.byok, daemon, outcome);
    }
    await stopServer(server!);
    server = undefined;
    await first.byok.close();
    byok = undefined;

    const second = await start(storage);
    const reads = await statsReads(second.byok);
    expect(reads.stats.taskCountsByState).toEqual(await fullScanCounts(second.byok));
    expect(reads.stats.taskCountsByState).toMatchObject({ Offered: 1, Complete: 2, Failed: 1, Cancelled: 1 });
    expect(Object.values(reads.stats.taskCountsByState).reduce((sum, count) => sum + count, 0)).toBe(7);
    expect(reads.listTaskAttempts).toBe(0);
    expect(reads.readApprovalTimeline).toBe(3);
  });

  it('keeps immutable offer facts after terminal cleanup and SQLite restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const openedAt = '2026-10-13T00:00:00.000Z';
    vi.setSystemTime(new Date(openedAt));
    const root = mkdtempSync(join(tmpdir(), 'byok-snapshot-'));
    roots.push(root);
    const storage = { kind: 'sqlite' as const, path: join(root, 'server.sqlite') };
    const first = await start(storage);
    const daemon = await connectFakeDaemonLongPoll(first.baseUrl, first.byok, { productId: PRODUCT_ID });
    const handle = await first.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'resume', sessionRef: 'requested-session' });
    await nextEnvelope(daemon);
    expect(await first.byok.tasks.get(handle.taskId)).toMatchObject({ createdAt: openedAt, sessionRef: 'requested-session' });

    vi.setSystemTime(new Date('2026-10-13T00:00:02.000Z'));
    await claimAndStart(first.byok, daemon, handle);
    expect(await sendOne(daemon, createEnvelope('task.fail', { reason: 'failed', retryable: false }, { taskId: handle.taskId })))
      .toEqual({ status: 200, body: { accepted: 1 } });
    expect(await first.byok.tasks.get(handle.taskId)).toMatchObject({ state: 'Failed', createdAt: openedAt, sessionRef: 'requested-session' });

    await stopServer(server!);
    server = undefined;
    await first.byok.close();
    byok = undefined;
    const second = await start(storage);
    expect(await second.byok.tasks.get(handle.taskId)).toMatchObject({ state: 'Failed', createdAt: openedAt, sessionRef: 'requested-session' });
  });
});

describe('LiveTaskIndex', () => {
  const attempt = (taskId: string, status: 'offered' | 'running' | 'complete' | 'failed', cancelled = false) =>
    ({
      tenantId: 'tenant',
      taskId,
      deviceId: 'device',
      status,
      ...(cancelled ? { cancellation: { requestedAt: '2026-10-13T00:00:00.000Z' } } : {}),
      updatedAt: '2026-10-13T00:00:00.000Z',
    }) as never;

  it('counts each task once when it leaves the live set, whatever reports it', () => {
    const index = new LiveTaskIndex();
    index.seed(attempt('old-done', 'complete'));
    index.seed(attempt('old-live', 'running'));
    index.opened(attempt('new', 'offered'));
    expect(index.liveTaskIds().sort()).toEqual(['new', 'old-live']);

    index.observe(attempt('new', 'running', true));
    index.observe(attempt('new', 'complete', true)); // a second report of the same terminal
    index.opened(attempt('new', 'complete', true)); // a replayed create of a terminal task
    index.observe(attempt('old-live', 'failed'));
    index.observe(attempt('old-done', 'complete')); // already counted by seed

    expect(index.size).toBe(0);
    expect(index.terminalCount('Cancelled')).toBe(1);
    expect(index.terminalCount('Failed')).toBe(1);
    expect(index.terminalCount('Complete')).toBe(1);
  });
});
