import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HostExecutionCore,
  HostLedger,
  hash,
  IGNORED_WAKE_AUDIT_LIMIT,
  recordOccurrence,
  nextIntervalOccurrence,
  type ExecutionServer,
  type Routine,
} from '@byok-sdk/server/execution-core';
import { template } from './test-support';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('durably audits an unknown wake without copying its key or payload or creating execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wake-audit-')); roots.push(root);
  const file = join(root, 'host.sqlite');
  const ledger = new HostLedger(file, 'tenant');
  const submit = vi.fn();
  const core = new HostExecutionCore({ executions: { submit }, wakes: {} } as unknown as ExecutionServer, ledger, { now: () => 1000 });
  const key = 'host-job:watchlist:private-name';
  try {
    await core.consume({ wakeId: 'private-id', dedupKey: key, availableAt: 900, deliveredAt: 1000, delivery: 1, payload: 'private-payload' }, new AbortController().signal);
    const state = ledger.snapshot();
    expect(state.ignoredWakes).toEqual([{ at: 1000, reason: 'unknown_key', wakeKeyHash: hash(key) }]);
    expect(state.intents).toEqual({}); expect(state.occurrences).toEqual({}); expect(submit).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain('private-');
    ledger.transaction(current => { current.scanWake = { dedupKey: 'host-scan:current', availableAt: 1000 }; });
    await core.consume({ ...wake('host-scan:current') }, new AbortController().signal);
    expect(ledger.snapshot().ignoredWakes).toEqual(state.ignoredWakes);
    expect(ledger.snapshot().scanWake).toBeNull();
  } finally { await core.close(); ledger.close(); }
  const reopened = new HostLedger(file, 'tenant');
  try { expect(reopened.snapshot().ignoredWakes).toEqual([{ at: 1000, reason: 'unknown_key', wakeKeyHash: hash(key) }]); }
  finally { reopened.close(); }
});


const wake = (dedupKey: string) => ({ wakeId: 'wake', dedupKey, availableAt: 1000, deliveredAt: 1000, delivery: 1 });
const routine = (): Routine => ({ definition: { id: 'routine', version: 1, timeZone: 'UTC', rule: { anchorMs: 1000, everyMs: 1000 },
  execution: template('device'), waitMs: 1000, lateAfterMs: 100 }, lifecycle: 'active', status: 'ok',
  next: { dedupKey: 'routine:1:1000', availableAt: 1000 } });

it.each([
  ['missing_routine', undefined, 'absent:1:1000'],
  ['inactive_routine', { ...routine(), lifecycle: 'paused' }, 'routine:1:1000'],
  ['inactive_routine', { ...routine(), lifecycle: 'completed' }, 'routine:1:1000'],
  ['reservation_mismatch', { ...routine(), next: null }, 'routine:1:1000'],
  ['reservation_mismatch', routine(), 'routine:1:999'],
] as const)('audits %s without creating an occurrence', (reason, value, key) => {
  const ledger = new HostLedger(':memory:', 'tenant');
  try {
    ledger.transaction(state => {
      if (value) state.routines[hash('routine')] = structuredClone(value);
      recordOccurrence(state, 'tenant', wake(key), 1000, nextIntervalOccurrence);
    });
    expect(ledger.snapshot().ignoredWakes).toEqual([{ at: 1000, reason, wakeKeyHash: hash(key) }]);
    expect(ledger.snapshot().intents).toEqual({}); expect(ledger.snapshot().occurrences).toEqual({});
  } finally { ledger.close(); }
});

it('bounds observations in delivery order, including repeat ignored deliveries, without making them dedup authority', () => {
  const ledger = new HostLedger(':memory:', 'tenant');
  try {
    ledger.transaction(state => {
      for (let at = 0; at < IGNORED_WAKE_AUDIT_LIMIT + 3; at++) recordOccurrence(state, 'tenant', wake('unknown'), at, nextIntervalOccurrence);
      recordOccurrence(state, 'tenant', wake('routine:1:1000'), 1000, nextIntervalOccurrence);
      state.routines[hash('routine')] = routine();
      recordOccurrence(state, 'tenant', wake('routine:1:1000'), 1000, nextIntervalOccurrence);
    });
    const state = ledger.snapshot();
    expect(state.ignoredWakes).toHaveLength(IGNORED_WAKE_AUDIT_LIMIT);
    expect(state.ignoredWakes?.[0]?.at).toBe(4);
    expect(Object.values(state.occurrences)).toHaveLength(1);
    expect(Object.values(state.intents)).toHaveLength(1);
  } finally { ledger.close(); }
});

it('preserves committed slot replay after completion and rejects changed reserved time or payload', () => {
  const ledger = new HostLedger(':memory:', 'tenant');
  try {
    ledger.transaction(state => {
      state.routines[hash('routine')] = routine();
      recordOccurrence(state, 'tenant', wake('routine:1:1000'), 1000, nextIntervalOccurrence);
      state.routines[hash('routine')]!.lifecycle = 'completed';
      state.routines[hash('routine')]!.next = null;
      recordOccurrence(state, 'tenant', wake('routine:1:1000'), 1100, nextIntervalOccurrence);
    });
    expect(Object.values(ledger.snapshot().occurrences)).toHaveLength(1);
    expect(Object.values(ledger.snapshot().occurrences)[0]?.slotReplayCount).toBe(1);
    expect(ledger.snapshot().ignoredWakes).toBeUndefined();
    ledger.transaction(state => { state.routines[hash('routine')] = { ...routine(), next: { dedupKey: 'routine:1:2000', availableAt: 2000 } }; });
    for (const altered of [{ ...wake('routine:1:2000'), availableAt: 1999 }, { ...wake('routine:1:2000'), availableAt: 2000, payload: 'changed' }]) {
      expect(() => ledger.transaction(state => recordOccurrence(state, 'tenant', altered, 2000, nextIntervalOccurrence))).toThrow('Wake differs from the routine reservation');
    }
    expect(ledger.snapshot().ignoredWakes).toBeUndefined();
  } finally { ledger.close(); }
});
