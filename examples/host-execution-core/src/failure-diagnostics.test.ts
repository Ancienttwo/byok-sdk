import { openHost } from './test-support';
import { afterEach, expect, it, vi } from 'vitest';
import { hostFailureSnapshot, withFailureSnapshot } from './failure-diagnostics';
afterEach(() => vi.restoreAllMocks());
it('does not collect a snapshot after successful observation', async () => {
  const snapshot = vi.fn();
  expect(await withFailureSnapshot(Promise.resolve(42), snapshot)).toBe(42);
  expect(snapshot).not.toHaveBeenCalled();
});
it('preserves the original error even when snapshot collection fails', async () => {
  const error = new Error('original assertion');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(withFailureSnapshot(Promise.reject(error), () => { throw new Error('must not be logged'); })).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith('[host-wait-failure]', '{"unavailable":"snapshot-failed"}');
});
it('bounds a stalled snapshot and preserves the original error', async () => {
  const error = new Error('original assertion');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(withFailureSnapshot(Promise.reject(error), () => new Promise(() => {}))).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith('[host-wait-failure]', '{"unavailable":"snapshot-deadline"}');
});

it('distinguishes delivered preparation from an unseen offer while active count remains zero', async () => {
  const host = await openHost();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prepare = host.adapter.prepare.bind(host.adapter);
  const entered = vi.spyOn(host.adapter, 'prepare').mockImplementation(async input => {
    await held;
    return prepare(input);
  });
  try {
    await host.core.enqueue(host.intent('held-preparation'));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const snapshot = await hostFailureSnapshot(host, 'held-preparation');
    // These older fields cannot tell undelivered work from pending preparation.
    expect(snapshot).toMatchObject({ server: { offer: true, attempt: true, deviceTerminal: false },
      daemon: { activeTaskCount: 0 }, sessionPresent: false });
    // The observer saw delivery, but prepare is held before any claim/start.
    expect(snapshot).toMatchObject({ server: { attemptStatus: 'offered', ownerPresent: false },
      localTask: { state: 'Offered', declined: false, delivery: null } });
    release();
    await vi.waitFor(() => expect(host.adapter.sessions.has(host.core.intent('held-preparation')!.taskId)).toBe(true), { timeout: 5000 });
    expect(await hostFailureSnapshot(host, 'held-preparation')).toMatchObject({
      server: { ownerPresent: true }, sessionPresent: true,
    });
  } finally { release(); await host.close(); }
});
