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
    ownerDeviceId: host!.deviceId, claimedExecutor: { id: 'pi' },
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
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(intent.taskId)).toMatchObject({ claimedExecutor: { id: 'pi' } }), { timeout: 5000 });
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
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(intent.taskId)).toMatchObject({ claimedExecutor: { id: 'pi' } }), { timeout: 5000 });
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

it('settles a claimed intent that cloud abandoned without a device terminal, and releases the Agent FIFO (#2335)', async () => {
  host = await openHost({ reconcileMs: 60_000 });
  const first = await host.core.enqueue(host.intent('abandoned'));
  await running('abandoned');
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(first.taskId)).toMatchObject({ ownerDeviceId: host!.deviceId }), { timeout: 5000 });
  const second = await host.core.enqueue(host.intent('behind'));
  await host.server.tasks.abandon(first.taskId, 'operator');
  expect(await host.server.tasks.attempt(first.taskId)).toMatchObject({ status: 'cancelled', terminalCause: 'operator', ownerDeviceId: host.deviceId });
  await vi.waitFor(async () => { await host!.core.drain(); expect(host!.core.intent('abandoned')?.conclusion).toBe('cancelled'); }, { timeout: 5000 });
  expect(await host.server.tasks.deviceTerminal(first.taskId)).toBeUndefined();
  await vi.waitFor(async () => expect(await host!.server.tasks.offer(second.taskId)).toBeDefined(), { timeout: 5000 });
});

it('settles a claimed intent whose device was revoked, without a device terminal (#2335)', async () => {
  host = await openHost({ reconcileMs: 60_000 });
  const intent = await host.core.enqueue(host.intent('revoked'));
  await running('revoked');
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(intent.taskId)).toMatchObject({ ownerDeviceId: host!.deviceId }), { timeout: 5000 });
  await host.server.devices.revoke(host.deviceId);
  expect(await host.server.tasks.attempt(intent.taskId)).toMatchObject({ status: 'cancelled', terminalCause: 'device_revoked', ownerDeviceId: host.deviceId });
  await vi.waitFor(async () => { await host!.core.drain(); expect(host!.core.intent('revoked')?.conclusion).toBe('cancelled'); }, { timeout: 5000 });
  expect(await host.server.tasks.deviceTerminal(intent.taskId)).toBeUndefined();
});

it('finishes a device task.cancelled whose receipt lands between the terminal read and the attempt read (#2335)', async () => {
  // Cloud stores the device's receipt, then the cancelled status with the device's reason as `terminalCause`.
  let landing: string | undefined, landed = false;
  host = await openHost({ reconcileMs: 60_000, wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => id !== landing ? server.tasks.deviceTerminal(id)
      : landed ? { envelope: { task_id: id, type: 'task.cancelled', payload: { reason: 'stopped on the device' } }, recordedAt: 'now' } as never : undefined,
    attempt: async id => {
      const attempt = await server.tasks.attempt(id);
      if (id !== landing || !attempt) return attempt;
      landed = true;
      return { ...attempt, status: 'cancelled', terminalCause: 'stopped on the device' };
    },
  } }) });
  const intent = await host.core.enqueue(host.intent('landing'));
  await running('landing');
  await vi.waitFor(async () => expect(await host!.server.tasks.attempt(intent.taskId)).toMatchObject({ ownerDeviceId: host!.deviceId }), { timeout: 5000 });
  landing = intent.taskId;
  await vi.waitFor(async () => { await host!.core.drain(); expect(host!.core.intent('landing')?.conclusion).toBe('cancelled'); }, { timeout: 5000 });
  expect(host.ledger.snapshot().executions[intent.taskId]?.terminal).toMatchObject({ envelope: { type: 'task.cancelled' } });
});
