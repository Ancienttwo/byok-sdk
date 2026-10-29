import { afterEach, expect, it, vi } from 'vitest';
import {
  HostLedger,
  OutboxFullError,
  HostExecutionCore,
  enqueue,
  hash,
  project,
  type ExecutionServer,
} from '@byok-sdk/server/execution-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { template } from './test-support';

const roots: string[] = [];
const ledgers: HostLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('rejects projection overflow and rolls back the whole transaction', () => {
  const ledger = new HostLedger(':memory:', 'test', { projectionOutboxLimits: { maxCount: 1 } });
  ledgers.push(ledger);
  ledger.transaction(state => project(state, 'first', 'retained'));
  const before = ledger.snapshot();
  let rejection: unknown;
  try { ledger.transaction(state => { state.application.changed = true; project(state, 'second', 'private-payload'); }); }
  catch (error) { rejection = error; }
  expect(rejection).toMatchObject({ name: 'OutboxFullError', code: 'outbox_full' });
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toBeInstanceOf(OutboxFullError);
  expect(String(rejection)).not.toContain('private-payload');
  expect(ledger.snapshot()).toEqual(before);
});

it('counts exact UTF-8 payload bytes, permits replay, and copies its configuration', () => {
  const value = '😀漢';
  const bytes = Buffer.byteLength(JSON.stringify([`projection:${hash('unicode')}`, { kind: 'projection', id: 'unicode', value }]), 'utf8');
  const limits = { maxCount: 1, maxBytes: bytes };
  const ledger = new HostLedger(':memory:', 'test', { projectionOutboxLimits: limits }); ledgers.push(ledger);
  limits.maxCount = 100; limits.maxBytes = 1_000_000;
  ledger.transaction(state => project(state, 'unicode', value));
  expect(ledger.projectionOutboxUsage()).toEqual({ count: 1, bytes });
  ledger.transaction(state => project(state, 'unicode', value));
  expect(() => ledger.transaction(state => project(state, 'another', ''))).toThrow(OutboxFullError);
  const smaller = new HostLedger(':memory:', 'test', { projectionOutboxLimits: { maxBytes: bytes - 1 } }); ledgers.push(smaller);
  expect(() => smaller.transaction(state => project(state, 'unicode', value))).toThrow(OutboxFullError);
  expect(smaller.projectionOutboxUsage()).toEqual({ count: 0, bytes: 0 });
});

it.each([{}, { maxCount: -1 }, { maxCount: 0.5 }, { maxBytes: Infinity }, { maxBytes: NaN }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }])('rejects invalid limits %j', limits => {
  expect(() => new HostLedger(':memory:', 'test', { projectionOutboxLimits: limits })).toThrow();
});

it('keeps omitted limits unlimited and permits zero limits for control-only transactions', () => {
  const unlimited = new HostLedger(':memory:', 'test'); ledgers.push(unlimited);
  unlimited.transaction(state => { for (let i = 0; i < 10; i++) project(state, String(i), 'payload'); });
  expect(unlimited.projectionOutboxUsage().count).toBe(10);
  const zero = new HostLedger(':memory:', 'test', { projectionOutboxLimits: { maxCount: 0, maxBytes: 0 } }); ledgers.push(zero);
  zero.transaction(state => { state.application.control = true; state.outbox.cancel = { kind: 'cancel-wake', key: 'wake' }; });
  expect(() => zero.transaction(state => project(state, 'blocked', null))).toThrow(OutboxFullError);
  expect(zero.snapshot().application.control).toBe(true);
});

it('allows non-growing recovery and failed upload diagnostics after reopening over limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-projection-')); roots.push(root);
  const filename = join(root, 'host.sqlite');
  const original = new HostLedger(filename, 'test');
  original.transaction(state => { project(state, 'first', '😀'.repeat(10)); project(state, 'second', 'value'); });
  original.close();
  const ledger = new HostLedger(filename, 'test', { projectionOutboxLimits: { maxCount: 1, maxBytes: 1 } }); ledgers.push(ledger);
  const usage = ledger.projectionOutboxUsage();
  ledger.transaction(state => { state.application.control = true; project(state, 'first', '😀'.repeat(10)); });
  expect(() => ledger.transaction(state => project(state, 'third', 'value'))).toThrow(OutboxFullError);
  const core = new HostExecutionCore({} as ExecutionServer, ledger);
  try {
    await core.flushProjections(async () => { throw new Error('temporary upload failure'); });
    expect(ledger.projectionOutboxUsage()).toEqual(usage);
    expect(Object.values(ledger.snapshot().outbox).every(row => row.lastError === 'temporary upload failure')).toBe(true);
    ledger.transaction(state => project(state, 'first', '😀'.repeat(10))); // Replay clears only diagnostics.
    expect(ledger.projectionOutboxUsage()).toEqual(usage);
    const delivered: string[] = [];
    await core.flushProjections(async id => { delivered.push(id); });
    expect(delivered).toEqual(['first', 'second']);
    expect(ledger.projectionOutboxUsage()).toEqual({ count: 0, bytes: 0 });
    expect(() => ledger.transaction(state => project(state, 'new', 'value'))).toThrow(OutboxFullError);
  } finally { await core.close(); }
});

it('propagates capacity refusal from settlement, rolls back outcome state, and retries after flush', async () => {
  const ledger = new HostLedger(':memory:', 'test', { projectionOutboxLimits: { maxCount: 2 } }); ledgers.push(ledger);
  const input = { key: 'work', source: 'user' as const, execution: template('device'), waitUntil: 10_000 };
  const intent = ledger.transaction(state => {
    const row = enqueue(state, ledger.tenant, input); row.phase = 'inflight';
    state.executions[row.taskId]!.submission = 'delivered';
    project(state, 'existing', 'retained');
    return row;
  });
  const terminal = { recordedAt: '2026-01-01T00:00:00Z', envelope: { type: 'task.complete', task_id: intent.taskId, payload: { document: { text: 'result' } } } };
  const attempt = { taskId: intent.taskId, deviceId: 'device', agentRef: input.execution.payload.agentRef };
  const schedule = vi.fn(async () => {});
  const server = { tasks: { offer: async () => undefined, deviceTerminal: async () => terminal, attempt: async () => attempt },
    wakes: { schedule, cancel: async () => {} } } as unknown as ExecutionServer;
  const core = new HostExecutionCore(server, ledger, { now: () => 100, applyOutcome: (_document, tx) => {
    tx.application.result = 'changed'; tx.publish('custom', 'private-payload');
  } });
  try {
    const wake = { dedupKey: 'host-scan:previous', availableAt: 100 };
    ledger.transaction(state => { state.scanWake = wake; });
    await expect(core.consume(wake as Parameters<typeof core.consume>[0], new AbortController().signal)).rejects.toBeInstanceOf(OutboxFullError);
    expect(ledger.snapshot().scanWake?.dedupKey).not.toBe(wake.dedupKey);
    expect(ledger.snapshot().scanWake).not.toBeNull();
    expect(schedule).toHaveBeenCalled();
    const state = ledger.snapshot();
    expect(state.application).toEqual({}); expect(state.applied).toEqual({});
    expect(state.executions[intent.taskId]!.terminal).toBeUndefined();
    expect(state.intents[intent.id]!.conclusion).toBeUndefined();
    expect(state.outbox[`projection:${hash('custom')}`]).toBeUndefined();
    expect(state.outbox[`intent:${intent.id}`]).toBeDefined();
    await core.flushProjections(async () => {});
    await core.drain();
    expect(ledger.snapshot().application.result).toBe('changed');
    expect(ledger.snapshot().applied[intent.taskId]).toBe(true);
    expect(ledger.snapshot().executions[intent.taskId]!.terminal).toEqual(terminal);
    expect(core.intent('work')?.conclusion).toBe('succeeded');
    expect(ledger.projectionOutboxUsage().count).toBe(2);
  } finally { await core.close(); }
});

it.each([false, true])('restores expiry wake coverage under capacity pressure (schedule failure=%s)', async scheduleFails => {
  const ledger = new HostLedger(':memory:', 'test', { projectionOutboxLimits: { maxCount: 0 } }); ledgers.push(ledger);
  const wake = { dedupKey: 'host-scan:expiry', availableAt: 100 };
  const intent = ledger.transaction(state => {
    state.scanWake = wake;
    return enqueue(state, ledger.tenant, { key: 'expired', source: 'user', execution: template('device'), waitUntil: 50 });
  });
  const scheduleError = new Error('schedule unavailable');
  const schedule = vi.fn(async () => { if (scheduleFails) throw scheduleError; });
  let now = 100;
  const core = new HostExecutionCore({ wakes: { schedule, cancel: async () => {} } } as unknown as ExecutionServer, ledger, { now: () => now, reconcileMs: 2500 });
  try {
    let rejection: unknown;
    try { await core.consume(wake as Parameters<typeof core.consume>[0], new AbortController().signal); } catch (error) { rejection = error; }
    if (scheduleFails) {
      expect(rejection).toBeInstanceOf(AggregateError);
      expect((rejection as AggregateError).errors).toEqual([expect.any(OutboxFullError), scheduleError]);
      expect(Object.values(ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'schedule', lastError: 'schedule unavailable' }));
    } else expect(rejection).toBeInstanceOf(OutboxFullError);
    expect(schedule).toHaveBeenCalledOnce();
    expect(ledger.snapshot().scanWake).toEqual(expect.objectContaining({ availableAt: 2600 }));
    if (!scheduleFails) {
      const next = ledger.snapshot().scanWake!; now = next.availableAt;
      await expect(core.consume(next as Parameters<typeof core.consume>[0], new AbortController().signal)).rejects.toBeInstanceOf(OutboxFullError);
      expect(ledger.snapshot().scanWake?.availableAt).toBe(now + 2500);
    }
    expect(core.intent('expired')?.conclusion).toBeUndefined();
    expect(ledger.snapshot().outbox[`intent:${intent.id}`]).toBeDefined();
  } finally { await core.close(); }
});
