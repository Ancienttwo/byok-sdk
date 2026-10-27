import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, TASK_STATES, type TaskState } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { serverTenantId } from '../stores';
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
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
} from './test-support';

/**
 * Issue #415: `stats()` re-reads only tasks still in flight, its counts
 * match the full-history projection `tasks.list()` reports at quiescence.
 * Task counts come directly from stores while dispatch facts remain readable
 * from immutable offer receipts.
 *
 * Store reads are counted at the kernel surface the façade calls, by wrapping
 * the one `createByokCloud` it constructs.
 */
const kernelCalls = vi.hoisted(() => ({
  countTaskAttempts: 0, listTaskAttempts: 0, readApprovalTimeline: 0,
  rawTasks: undefined as import('@byok-sdk/cloud').TaskAttemptStore | undefined,
  afterCount: undefined as (() => Promise<void>) | undefined,
  beforeApproval: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@byok-sdk/cloud', async (importOriginal) => {
  const original = await importOriginal<typeof import('@byok-sdk/cloud')>();
  return {
    ...original,
    createInMemoryCloudStores: (...args: Parameters<typeof original.createInMemoryCloudStores>) => {
      const composition = original.createInMemoryCloudStores(...args);
      kernelCalls.rawTasks = composition.stores.tasks;
      return composition;
    },
    createByokCloud: (...args: Parameters<typeof original.createByokCloud>) => {
      const cloud = original.createByokCloud(...args);
      return {
        ...cloud,
        countTaskAttempts: async (...call: Parameters<typeof cloud.countTaskAttempts>) => {
          kernelCalls.countTaskAttempts += 1;
          const counts = await cloud.countTaskAttempts(...call);
          const hook = kernelCalls.afterCount;
          kernelCalls.afterCount = undefined;
          await hook?.();
          return counts;
        },
        listTaskAttempts: (...call: Parameters<typeof cloud.listTaskAttempts>) => {
          kernelCalls.listTaskAttempts += 1;
          return cloud.listTaskAttempts(...call);
        },
        readApprovalTimeline: async (...call: Parameters<typeof cloud.readApprovalTimeline>) => {
          kernelCalls.readApprovalTimeline += 1;
          const hook = kernelCalls.beforeApproval;
          kernelCalls.beforeApproval = undefined;
          await hook?.();
          return cloud.readApprovalTimeline(...call);
        },
      };
    },
  };
});

const PRODUCT_ID = 'stats-counts';
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
    countTaskAttempts: kernelCalls.countTaskAttempts - before.countTaskAttempts,
    listTaskAttempts: kernelCalls.listTaskAttempts - before.listTaskAttempts,
    readApprovalTimeline: kernelCalls.readApprovalTimeline - before.readApprovalTimeline,
  };
}

async function runToTerminal(
  byok: ByokServer,
  daemon: FakeLongPollDaemon,
  outcome: 'complete' | 'fail' | 'cancel',
): Promise<string> {
  const handle = await byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: `to ${outcome}` });
  await nextEnvelope(daemon);
  await claimAndStart(byok, daemon, handle);
  if (outcome === 'cancel') {
    await handle.cancel('stop');
    await nextEnvelope(daemon); // task.cancel
  } else {
    const terminal =
      outcome === 'complete'
        ? createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'sess' }, { taskId: handle.taskId })
        : createEnvelope('task.fail', { agentRef: TEST_AGENT_REF, reason: 'broke', retryable: false }, { taskId: handle.taskId });
    expect(await sendOne(daemon, terminal)).toMatchObject({ status: 200, body: { accepted: 1 } });
  }
  return handle.taskId;
}

/** One task in each live state: Offered, Running, AwaitApproval. */
async function leaveLiveTasks(byok: ByokServer, daemon: FakeLongPollDaemon): Promise<void> {
  const running = await byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'keep running' });
  await nextEnvelope(daemon);
  await claimAndStart(byok, daemon, running);
  const paused = await byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'needs approval' });
  await nextEnvelope(daemon);
  await claimAndStart(byok, daemon, paused);
  await moveToAwaitApproval(byok, daemon, paused);
  await byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'never claimed' });
  await nextEnvelope(daemon);
}

describe('store-aggregated stats()', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    kernelCalls.afterCount = undefined;
    kernelCalls.beforeApproval = undefined;
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
      // The 200-task history test exercises stats cost, with >600 messages.
      rateLimit: { messagesPerSecond: 2_000, burst: 2_000 },
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
    const small = await statsReads(started.byok);
    expect(small.stats.taskCountsByState).toEqual(await fullScanCounts(started.byok));
    expect(small.stats.taskCountsByState).toMatchObject({ Offered: 1, Running: 1, AwaitApproval: 1, Complete: 0, Failed: 0, Cancelled: 0 });

    for (let index = 0; index < 200; index += 1) {
      await runToTerminal(started.byok, daemon, (['complete', 'fail', 'cancel'] as const)[index % 3]!);
    }

    const large = await statsReads(started.byok);
    expect(large.stats.taskCountsByState).toEqual(await fullScanCounts(started.byok));
    expect(large.stats.taskCountsByState).toMatchObject({ Complete: 67, Failed: 67, Cancelled: 66 });
    // One aggregate + one active page, at zero and 200 terminal tasks alike.
    expect(small.countTaskAttempts).toBe(1);
    expect(small.listTaskAttempts).toBe(1);
    expect(large.countTaskAttempts).toBe(1);
    expect(large.listTaskAttempts).toBe(1);
    expect(small.readApprovalTimeline).toBe(3);
    expect(large.readApprovalTimeline).toBe(3);
  }, 20_000);

  it('projects every state and host cancellation from the same authority as tasks.list', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    await leaveLiveTasks(started.byok, daemon);
    const claimed = await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'claimed only' });
    await nextEnvelope(daemon);
    const claim = createEnvelope('task.claim', { agentRef: TEST_AGENT_REF, deviceId: daemon.deviceId }, { taskId: claimed.taskId });
    expect(await sendOne(daemon, claim))
      .toEqual({ status: 200, body: { accepted: 1, outcomes: [{ id: claim.id, outcome: 'accepted' }] } });
    const complete = await runToTerminal(started.byok, daemon, 'complete');
    await started.byok.tasks.cancel(complete, 'too late');
    expect(await started.byok.tasks.get(complete)).toMatchObject({ state: 'Complete' });
    await runToTerminal(started.byok, daemon, 'fail');
    const ownedCancel = await runToTerminal(started.byok, daemon, 'cancel');
    const lateComplete = createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'late', sessionRef: 'late' }, { taskId: ownedCancel });
    expect(await sendOne(daemon, lateComplete))
      .toEqual({ status: 200, body: { accepted: 1, outcomes: [{ id: lateComplete.id, outcome: 'accepted' }] } });
    const unowned = await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'cancel before claim' });
    await nextEnvelope(daemon);
    await unowned.cancel('stop');
    await nextEnvelope(daemon);
    const counts = (await started.byok.stats()).taskCountsByState;
    expect(counts).toEqual({ Offered: 1, Claimed: 1, Running: 1, AwaitApproval: 1, Complete: 1, Failed: 1, Cancelled: 2 });
    expect(counts).toEqual(await fullScanCounts(started.byok));
  });

  it('sees authoritative writes that never passed through facade decorators', async () => {
    const started = await start();
    const tasks = kernelCalls.rawTasks!;
    const tenant = serverTenantId(PRODUCT_ID);
    await tasks.open(tenant, { taskId: 'external', deviceId: 'device' });
    expect((await started.byok.stats()).taskCountsByState.Offered).toBe(1);
    await tasks.recordStatus(tenant, { taskId: 'external', status: 'complete' });
    expect((await started.byok.stats()).taskCountsByState).toMatchObject({ Offered: 0, Complete: 1 });
  });

  it('walks every active page when more than 100 attempts remain in flight', async () => {
    const started = await start();
    for (let index = 0; index < 205; index += 1) {
      await kernelCalls.rawTasks!.open(serverTenantId(PRODUCT_ID), { taskId: `external-${index}`, deviceId: 'device' });
    }
    const reads = await statsReads(started.byok);
    expect(reads.stats.taskCountsByState.Offered).toBe(205);
    expect(reads.countTaskAttempts).toBe(1);
    expect(reads.listTaskAttempts).toBe(3);
    expect(reads.readApprovalTimeline).toBe(205);
    expect(reads.stats.taskCountsByState).toEqual(await fullScanCounts(started.byok));
  });

  it('can omit a task settling between reads, without subtracting or counting it twice', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    const handle = await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'race' });
    await nextEnvelope(daemon);
    await claimAndStart(started.byok, daemon, handle);
    kernelCalls.afterCount = async () => {
      const complete = createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'race-session' }, { taskId: handle.taskId });
      expect(await sendOne(daemon, complete)).toEqual({ status: 200, body: { accepted: 1, outcomes: [{ id: complete.id, outcome: 'accepted' }] } });
    };
    const counts = (await started.byok.stats()).taskCountsByState;
    expect(Object.values(counts)).toEqual(Array(TASK_STATES.length).fill(0));
    expect((await started.byok.stats()).taskCountsByState).toEqual(await fullScanCounts(started.byok));
  });

  it('counts a new active task created after the aggregate exactly once', async () => {
    const started = await start();
    kernelCalls.afterCount = async () => {
      await kernelCalls.rawTasks!.open(serverTenantId(PRODUCT_ID), { taskId: 'new', deviceId: 'device' });
    };
    const counts = (await started.byok.stats()).taskCountsByState;
    expect(counts.Offered).toBe(1);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('counts a walked task once when it settles during approval reads', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    const handle = await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'race' });
    await nextEnvelope(daemon);
    await claimAndStart(started.byok, daemon, handle);
    kernelCalls.beforeApproval = async () => {
      const complete = createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'race-session' }, { taskId: handle.taskId });
      expect(await sendOne(daemon, complete)).toEqual({ status: 200, body: { accepted: 1, outcomes: [{ id: complete.id, outcome: 'accepted' }] } });
    };
    const counts = (await started.byok.stats()).taskCountsByState;
    expect(counts).toMatchObject({ Running: 1, Complete: 0 });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect((await started.byok.stats()).taskCountsByState).toEqual(await fullScanCounts(started.byok));
  });

  it('reads SQLite aggregate counts after restart without a startup history scan', async (context) => {
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
    expect(reads.countTaskAttempts).toBe(1);
    expect(reads.listTaskAttempts).toBe(1);
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
    const handle = await first.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'resume', sessionRef: 'requested-session' });
    await nextEnvelope(daemon);
    expect(await first.byok.tasks.get(handle.taskId)).toMatchObject({ createdAt: openedAt, sessionRef: 'requested-session' });

    vi.setSystemTime(new Date('2026-10-13T00:00:02.000Z'));
    await claimAndStart(first.byok, daemon, handle);
    expect(await sendOne(daemon, createEnvelope('task.fail', { agentRef: TEST_AGENT_REF, reason: 'failed', retryable: false }, { taskId: handle.taskId })))
      .toMatchObject({ status: 200, body: { accepted: 1 } });
    expect(await first.byok.tasks.get(handle.taskId)).toMatchObject({ state: 'Failed', createdAt: openedAt, sessionRef: 'requested-session' });

    await stopServer(server!);
    server = undefined;
    await first.byok.close();
    byok = undefined;
    const second = await start(storage);
    expect(await second.byok.tasks.get(handle.taskId)).toMatchObject({ state: 'Failed', createdAt: openedAt, sessionRef: 'requested-session' });
  });
});
