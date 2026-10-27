import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskEventRelay } from '../relay';
import { createByokServer, type ByokServer, type ServerTaskEvent } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, TEST_AGENT_DISPATCH } from './test-support';

const RETENTION_MS = 100;

async function collect(events: AsyncIterable<ServerTaskEvent>): Promise<ServerTaskEvent[]> {
  const result: ServerTaskEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

// A bounded fake-time race makes the original hanging next() fail immediately
// without spending the test runner's timeout or leaving real timers behind.
async function promptly<T>(pending: Promise<T>): Promise<T | 'still waiting'> {
  const timeout = new Promise<'still waiting'>((resolve) => {
    setTimeout(() => resolve('still waiting'), 1);
  });
  const result = Promise.race([pending, timeout]);
  await vi.advanceTimersByTimeAsync(1);
  return result;
}

// An event read looks the task up in the store before its first entry, and
// that lookup can finish on the thread pool, so the first entry gets a plain
// await (the runner's timeout catches a hang there). After it the read only
// drains the relay, which is what `promptly` bounds.
async function opened(events: AsyncIterable<ServerTaskEvent>) {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  return { first: first.value as ServerTaskEvent, rest: { [Symbol.asyncIterator]: () => iterator } };
}

function expectFeedExpired(taskId: string) {
  return { name: 'TaskEventsUnavailableError', reason: 'feed_expired', taskId };
}

describe('public task handle event retention', () => {
  let byok: ByokServer | undefined;
  let server: HttpServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await byok?.close();
    vi.useRealTimers();
    if (server !== undefined) await stopServer(server);
    byok = undefined;
    server = undefined;
  });

  async function dispatch(bufferLimit = 1000) {
    byok = createByokServer({
      productId: 'event-retention',
      taskEventRetentionMs: RETENTION_MS,
      taskEventBufferLimit: bufferLimit,
    });
    const started = await startServer(byok);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, byok, { productId: 'event-retention' });
    const handle = await byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'retention fixture' });
    // Pairing/dispatch use real local HTTP. Only the subsequent host-side
    // cancellation and relay reclamation run under controlled timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return handle;
  }

  it('refuses a retention window a single timer cannot hold instead of reclaiming at once', () => {
    expect(() => new TaskEventRelay({ taskEventRetentionMs: 2_147_483_648 })).toThrow(/taskEventRetentionMs/);
    expect(() => new TaskEventRelay({ taskEventRetentionMs: 2_147_483_647 })).not.toThrow();
  });

  it('ends live and retained readers, then refuses reads after reclamation without recreating state', async () => {
    const handle = await dispatch();
    const live = await opened(handle.events());
    expect(live.first).toMatchObject({ kind: 'state', state: 'Offered' });
    await handle.cancel('done');
    const rest = await promptly(collect(live.rest));
    expect(rest).toMatchObject([{ kind: 'state', state: 'Cancelled' }]);
    const again = await opened(handle.events());
    expect(again.first).toEqual(live.first);
    expect(await promptly(collect(again.rest))).toEqual(rest);
    const durable = await handle.result();
    expect(durable.state).toBe('Cancelled');

    await vi.advanceTimersByTimeAsync(RETENTION_MS);
    // Scope the allocation observation to event reads. Any Map.set keyed by
    // this task would resurrect its reclaimed relay bookkeeping.
    const writes = vi.spyOn(Map.prototype, 'set');
    for (let i = 0; i < 20; i += 1) {
      await expect(collect(handle.events())).rejects.toMatchObject(expectFeedExpired(handle.taskId));
    }
    expect(writes.mock.calls.filter(([key]) => key === handle.taskId)).toEqual([]);
    writes.mockRestore();
    expect(await promptly(handle.result())).toEqual(durable);
    expect((await byok!.tasks.get(handle.taskId))?.result).toEqual(durable);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the bounded truncation marker before expiry', async () => {
    const handle = await dispatch(1);
    await handle.cancel();
    const read = await opened(handle.events());
    expect(read.first).toEqual({ kind: 'error', reason: 'events_truncated' });
    expect(await promptly(collect(read.rest))).toEqual([expect.objectContaining({ kind: 'state', state: 'Cancelled' })]);
    await vi.advanceTimersByTimeAsync(RETENTION_MS);
    await expect(collect(handle.events())).rejects.toMatchObject(expectFeedExpired(handle.taskId));
  });

  it('closes an active reader on stop and keeps subsequent event reads empty and allocation-free', async () => {
    const handle = await dispatch();
    const live = await opened(handle.events());
    expect(live.first).toMatchObject({ kind: 'state', state: 'Offered' });
    await byok!.close();
    expect(await promptly(collect(live.rest))).toEqual([]);
    const writes = vi.spyOn(Map.prototype, 'set');
    for (let i = 0; i < 20; i += 1) {
      expect(await promptly(collect(handle.events()))).toEqual([]);
    }
    expect(writes.mock.calls.filter(([key]) => key === handle.taskId)).toEqual([]);
    writes.mockRestore();
    await byok!.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
