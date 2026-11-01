import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createByokServer, type ByokServer, type ServerTaskEvent } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, TEST_AGENT_DISPATCH } from './test-support';

async function collect(events: AsyncIterable<ServerTaskEvent>): Promise<ServerTaskEvent[]> {
  const result: ServerTaskEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('task event read lifetime', () => {
  let byok: ByokServer | undefined;
  let server: HttpServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await byok?.close();
    if (server !== undefined) await stopServer(server);
    byok = undefined;
    server = undefined;
  });

  async function dispatch() {
    byok = createByokServer({ productId: 'event-retention' });
    const started = await startServer(byok);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, byok, { productId: 'event-retention' });
    return byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'retention fixture' });
  }

  it('ends a live reader at the terminal and keeps the terminal task readable, holding nothing per task between reads', async () => {
    const handle = await dispatch();
    const live = handle.events()[Symbol.asyncIterator]();
    expect((await live.next()).value).toMatchObject({ kind: 'state', state: 'Offered' });
    await handle.cancel('done');
    expect((await live.next()).value).toMatchObject({ kind: 'state', state: 'Cancelled' });
    expect(await live.next()).toEqual({ value: undefined, done: true });

    // No retention window: a later read is the same projection of the stores.
    const writes = vi.spyOn(Map.prototype, 'set');
    for (let i = 0; i < 20; i += 1) {
      expect(await collect(handle.events())).toEqual([expect.objectContaining({ kind: 'state', state: 'Cancelled' })]);
    }
    // Each read watches its task while it runs and stops watching when it ends.
    const watched = writes.mock.calls.filter(([key]) => key === handle.taskId).length;
    expect(watched).toBe(20);
    writes.mockRestore();
    const durable = await handle.result();
    expect(durable.state).toBe('Cancelled');
    expect((await byok!.tasks.get(handle.taskId))?.result).toEqual(durable);
  });

  it('closes an active reader on stop and keeps later event reads empty', async () => {
    const handle = await dispatch();
    const live = handle.events()[Symbol.asyncIterator]();
    expect((await live.next()).value).toMatchObject({ kind: 'state', state: 'Offered' });
    const pending = live.next();
    await byok!.close();
    expect(await pending).toEqual({ value: undefined, done: true });
    for (let i = 0; i < 3; i += 1) expect(await collect(handle.events())).toEqual([]);
    await expect(handle.result()).rejects.toThrow(/server closed/);
  });
});
