import { afterEach, expect, it, vi } from 'vitest';
import { openHost, type TestHost } from './test-support';

let host: TestHost | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); });
async function running(key: string) {
  await vi.waitFor(() => expect(host!.adapter.sessions.has(host!.core.intent(key)!.taskId)).toBe(true), { timeout: 5000 });
  return host!.adapter.sessions.get(host!.core.intent(key)!.taskId)!;
}

it('settles a cancelled claimed task soon after its device terminal, without waiting for reconcileMs', async () => {
  host = await openHost({ reconcileMs: 60_000 });
  const first = await host.core.enqueue(host.intent('cancel'));
  const session = await running('cancel');
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(first.taskId)).toMatchObject({
    ownerDeviceId: host!.deviceId, claimedRuntime: 'pi',
  }), { timeout: 5000 });
  // Hold the device terminal until the Host cancel event and its drain are complete.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(session, 'interrupt').mockImplementation(async () => { session.interrupted = true; await gate; });
  try {
    const second = await host.core.enqueue(host.intent('behind'));
    await host.core.cancel('cancel');
    await vi.waitFor(async () => expect(await host!.server.tasks.attempt(first.taskId)).toMatchObject({ status: 'cancel_requested' }), { timeout: 5000 });
    await host.core.drain();
    expect(host.core.intent('cancel')).toMatchObject({ phase: 'inflight' });
    expect(host.core.intent('cancel')?.conclusion).toBeUndefined();
    expect(await host.server.tasks.offer(second.taskId)).toBeUndefined();
    release();
    await vi.waitFor(async () => expect(await host!.server.tasks.deviceTerminal(first.taskId)).toMatchObject({ envelope: { type: 'task.cancelled' } }), { timeout: 5000 });
    // No test drain here: only the core's own timers and hints may settle the intent.
    await vi.waitFor(() => expect(host!.core.intent('cancel')?.conclusion).toBe('cancelled'), { timeout: 5000 });
    await running('behind');
  } finally { release(); }
});

it('probes a cancelled task terminal without Host ledger writes until the terminal arrives', async () => {
  host = await openHost({ reconcileMs: 60_000 });
  const intent = await host.core.enqueue(host.intent('quiet'));
  const session = await running('quiet');
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(intent.taskId)).toMatchObject({ claimedRuntime: 'pi' }), { timeout: 5000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(session, 'interrupt').mockImplementation(async () => { session.interrupted = true; await gate; });
  try {
    await host.core.cancel('quiet');
    await host.core.drain();
    const transaction = vi.spyOn(host.ledger, 'transaction');
    const probe = vi.spyOn(host.server.tasks, 'deviceTerminal');
    await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    // Count writes only between later probes, after any hint drain of the cancel itself.
    transaction.mockClear();
    const seen = probe.mock.calls.length;
    await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThanOrEqual(seen + 2), { timeout: 5000 });
    expect(probe.mock.calls.every(([taskId]) => taskId === intent.taskId)).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(host!.core.intent('quiet')?.conclusion).toBe('cancelled'), { timeout: 5000 });
  } finally { release(); }
});

it('keeps probing after failed terminal reads and settles soon after the reads recover', async () => {
  let failing = false;
  let failures = 0;
  host = await openHost({ reconcileMs: 60_000, wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => {
      if (failing) { failures++; throw new Error('terminal read unavailable'); }
      return server.tasks.deviceTerminal(id);
    },
  } }) });
  const intent = await host.core.enqueue(host.intent('flaky'));
  const session = await running('flaky');
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(intent.taskId)).toMatchObject({ claimedRuntime: 'pi' }), { timeout: 5000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(session, 'interrupt').mockImplementation(async () => { session.interrupted = true; await gate; });
  try {
    await host.core.cancel('flaky');
    await host.core.drain();
    failing = true;
    await vi.waitFor(() => expect(failures).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    failing = false;
    release();
    await vi.waitFor(async () => expect(await host!.server.tasks.deviceTerminal(intent.taskId)).toMatchObject({ envelope: { type: 'task.cancelled' } }), { timeout: 5000 });
    // No test drain here: only the core's own timers and hints may settle the intent.
    await vi.waitFor(() => expect(host!.core.intent('flaky')?.conclusion).toBe('cancelled'), { timeout: 5000 });
  } finally { release(); }
});
