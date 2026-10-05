import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, type ByokServer, type ServerTaskEvent } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer } from './test-support';

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

describe('public task handle event retention', () => {
  let byok: ByokServer | undefined;
  let server: HttpServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    byok?.stop();
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
    await connectFakeDaemonLongPoll(started.baseUrl, byok, { productId: 'event-retention' });
    const handle = await byok.dispatch({ instruction: 'retention fixture' });
    // Pairing/dispatch use real local HTTP. Only the subsequent host-side
    // cancellation and relay reclamation run under controlled timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return handle;
  }

  it('ends live and retained readers, then returns empty reads after reclamation without recreating state', async () => {
    const handle = await dispatch();
    const live = collect(handle.events());
    await handle.cancel('done');
    const retained = await promptly(live);
    expect(retained).toMatchObject([
      { kind: 'state', state: 'Offered' },
      { kind: 'state', state: 'Cancelled' },
    ]);
    expect(await promptly(collect(handle.events()))).toEqual(retained);
    const durable = await handle.result();
    expect(durable.state).toBe('Cancelled');

    await vi.advanceTimersByTimeAsync(RETENTION_MS);
    // Scope the allocation observation to event reads. Any Map.set keyed by
    // this task would resurrect its reclaimed relay bookkeeping.
    const writes = vi.spyOn(Map.prototype, 'set');
    for (let i = 0; i < 20; i += 1) {
      expect(await promptly(collect(handle.events()))).toEqual([]);
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
    expect(await promptly(collect(handle.events()))).toEqual([
      { kind: 'error', reason: 'events_truncated' },
      expect.objectContaining({ kind: 'state', state: 'Cancelled' }),
    ]);
    await vi.advanceTimersByTimeAsync(RETENTION_MS);
    expect(await promptly(collect(handle.events()))).toEqual([]);
  });

  it('closes an active reader on stop and keeps subsequent event reads empty and allocation-free', async () => {
    const handle = await dispatch();
    const live = collect(handle.events());
    byok!.stop();
    expect(await promptly(live)).toEqual([expect.objectContaining({ kind: 'state', state: 'Offered' })]);
    const writes = vi.spyOn(Map.prototype, 'set');
    for (let i = 0; i < 20; i += 1) {
      expect(await promptly(collect(handle.events()))).toEqual([]);
    }
    expect(writes.mock.calls.filter(([key]) => key === handle.taskId)).toEqual([]);
    writes.mockRestore();
    byok!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
