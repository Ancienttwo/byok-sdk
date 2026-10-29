import { afterEach, expect, it, vi } from 'vitest';
import { HostLedger, project } from '@byok-sdk/server/execution-core';
import { openHost, type TestHost } from './test-support';

let host: TestHost | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); });
async function running(key: string) {
  await vi.waitFor(() => expect(host!.adapter.sessions.has(host!.core.intent(key)!.taskId)).toBe(true), { timeout: 5000 });
  return host!.adapter.sessions.get(host!.core.intent(key)!.taskId)!;
}

it('settles from terminal events and notifies after commit under 100ms without a host-scan wake', async () => {
  let notify!: (at: number) => void;
  const notified = new Promise<number>(resolve => { notify = resolve; });
  host = await openHost({ reconcileMs: 60_000, onOutbox: () => {
    expect(host!.core.intent('event')?.conclusion).toBe('succeeded');
    expect(Object.values(host!.ledger.snapshot().outbox).some(row => row.kind === 'projection')).toBe(true);
    notify(performance.now());
  } });
  const schedule = vi.spyOn(host.server.wakes, 'schedule');
  const observer = host.server.events.subscribe()[Symbol.asyncIterator]();
  try {
    await host.core.enqueue(host.intent('event'));
    const session = await running('event');
    const terminalAt = (async () => { for (;;) { const next = await observer.next(); if (!next.done && next.value.kind === 'task.state' && next.value.state === 'Complete') return performance.now(); } })();
    session.finish({ text: 'event' });
    const [started, finished] = await Promise.all([terminalAt, notified]);
    expect(finished - started).toBeLessThan(100);
    expect(schedule.mock.calls.filter(([input]) => input.dedupKey.startsWith('host-scan:'))).toHaveLength(0);
  } finally { await observer.return?.(); }
});

it('allows a postcommit callback to flush projections and enqueue follow-up work reentrantly', async () => {
  let done!: () => void;
  const followed = new Promise<void>(resolve => { done = resolve; });
  let forwarded = false;
  host = await openHost({ reconcileMs: 60_000, onOutbox: async () => {
    await host!.core.flushProjections(async () => {});
    if (!forwarded) { forwarded = true; await host!.core.enqueue(host!.intent('write')); done(); }
  } });
  await host.core.enqueue(host.intent('plan'));
  (await running('plan')).finish({ text: 'plan' });
  await followed;
  expect(host.core.intent('plan')?.conclusion).toBe('succeeded');
  expect(host.core.intent('write')?.phase).toBe('inflight');
});

it('retains durable scans for recovered work when the new process has no event hint', async () => {
  let events = true;
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  host = await openHost({ reconcileMs: 20, wrapServer: server => events ? server : { ...server, events: undefined }, onOutbox: () => notify() });
  await host.core.enqueue(host.intent('recovered'));
  const session = await running('recovered');
  const schedule = vi.spyOn(host.server.wakes, 'schedule');
  events = false;
  await host.restartCore();
  expect(schedule.mock.calls.some(([input]) => input.dedupKey.startsWith('host-scan:'))).toBe(true);
  session.finish({ text: 'recovered' });
  await notified;
  expect(host.core.intent('recovered')?.conclusion).toBe('succeeded');
});

it('notifies only committed new projections and supports listener removal', () => {
  const ledger = new HostLedger(':memory:', 'notifications');
  const seen: string[] = [];
  const remove = ledger.onOutbox(() => {
    // Nested transaction proves the writer transaction committed before notification.
    ledger.transaction(state => { state.application.notified = true; });
    seen.push('committed');
  });
  try {
    expect(() => ledger.transaction(state => { project(state, 'rolled-back', null); throw new Error('rollback'); })).toThrow('rollback');
    expect(seen).toEqual([]);
    ledger.transaction(state => project(state, 'one', null));
    ledger.transaction(state => project(state, 'one', null));
    expect(seen).toEqual(['committed']);
    remove(); ledger.transaction(state => project(state, 'two', null));
    expect(seen).toEqual(['committed']);
  } finally { ledger.close(); }
});

it('retains a failed callback outbox and re-notifies on recovery, then closes idle subscription', async () => {
  let failing = true;
  let notified!: () => void;
  const recovered = new Promise<void>(resolve => { notified = resolve; });
  host = await openHost({ onOutbox: () => { if (failing) throw new Error('offline Host'); notified(); } });
  await host.core.enqueue(host.intent('callback'));
  (await running('callback')).finish({ text: 'callback' });
  await vi.waitFor(() => expect(Object.values(host!.ledger.snapshot().outbox).find(row => row.kind === 'projection')?.lastError).toBe('offline Host'));
  failing = false;
  await host.restartCore();
  await recovered;
  await host.core.close(); // Must not wait forever for an idle event queue.
});

it('uses a local fallback when terminal notifications are dropped, without durable polling rows', async () => {
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  host = await openHost({ reconcileMs: 20, onOutbox: () => notify(), wrapServer: server => ({ ...server, events: {
    subscribe: () => ({ [Symbol.asyncIterator]() {
      const source = server.events!.subscribe()[Symbol.asyncIterator]();
      return {
        async next() { for (;;) { const item = await source.next(); if (item.done || item.value.kind !== 'task.state') return item; } },
        return: () => source.return!(),
      };
    } }),
  } }) });
  const schedule = vi.spyOn(host.server.wakes, 'schedule');
  await host.core.enqueue(host.intent('dropped'));
  (await running('dropped')).finish({ text: 'dropped' });
  await notified;
  expect(host.core.intent('dropped')?.conclusion).toBe('succeeded');
  expect(schedule.mock.calls.filter(([input]) => input.dedupKey.startsWith('host-scan:'))).toHaveLength(0);
});

it('suppresses queued notifications after core close while preserving their durable projection', async () => {
  const notification = vi.fn();
  host = await openHost({ onOutbox: notification });
  host.ledger.transaction(state => project(state, 'shutdown', null));
  await host.core.close();
  expect(notification).not.toHaveBeenCalled();
  expect(Object.values(host.ledger.snapshot().outbox).some(row => row.kind === 'projection')).toBe(true);
});

it('external close aborts and joins a running Host callback before the ledger can be closed', async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let signal!: AbortSignal;
  let readAfterGate = false;
  host = await openHost({ onOutbox: async cancellation => {
    signal = cancellation; began(); await gate;
    host!.ledger.snapshot(); readAfterGate = true;
  } });
  host.ledger.transaction(state => project(state, 'join', null));
  await started;
  let closed = false;
  const closing = host.core.close().then(() => { closed = true; });
  try {
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
  } finally { release(); await closing; }
  expect(readAfterGate).toBe(true);
});

it('a Host callback can close its own core without waiting on itself', async () => {
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  host = await openHost({ onOutbox: async () => { await host!.core.close(); done(); } });
  host.ledger.transaction(state => project(state, 'self-close', null));
  await finished;
  await host.core.close(); // External close still joins the completed callback.
});
