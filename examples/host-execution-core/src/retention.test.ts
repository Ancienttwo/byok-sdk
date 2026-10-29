import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CompactVetoError,
  HostLedger,
  MIN_TOMBSTONE_RETENTION_MS,
  RetiredIntentIdentityError,
  HostExecutionCore,
  hash,
  project,
  taskId,
  enqueue,
  settle,
  recordOccurrence,
  nextIntervalOccurrence,
  type ExecutionServer,
  type IntentInput,
} from '@byok-sdk/server/execution-core';
import { openHost, template } from './test-support';
import type { DueWake } from '@byok-sdk/server';

const roots: string[] = [], ledgers: HostLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open(tenant = 'test', filename?: string) {
  if (!filename) { const root = mkdtempSync(join(tmpdir(), 'k4-retention-')); roots.push(root); filename = join(root, 'host.sqlite'); }
  const ledger = new HostLedger(filename, tenant); ledgers.push(ledger); return { ledger, filename };
}
function input(key: string): IntentInput { return { key, source: 'user', execution: template('device'), waitUntil: 1000 }; }
function seed(ledger: HostLedger, key: string, options: { ack?: boolean; occurrence?: boolean; routine?: boolean; generation?: number } = {}): string {
  // A routine seed uses the core-derived identity `occurrence:<occurrence key>`.
  const intentKey = options.routine ? `occurrence:${hash(['occurrence', key])}` : key;
  ledger.transaction(state => {
    const intent = enqueue(state, ledger.tenant, input(intentKey));
    for (let generation = 0; generation <= (options.generation ?? 0); generation++) {
      const id = taskId(intentKey, generation);
      state.executions[id] = { input: { ...intent.execution, taskId: id }, started: true, submission: 'delivered',
        terminal: { recordedAt: '2026-01-01T00:00:00Z', envelope: { v: 1, id: '00000000-0000-4000-8000-000000000001',
          ts: '2026-01-01T00:00:00Z', type: 'task.complete', task_id: id, seq: 1,
          payload: { summary: '', sessionRef: 'session', document: { text: 'o'.repeat(1024) } } } } };
      intent.generation = generation; intent.taskId = id;
    }
    if (options.occurrence || options.routine) {
      intent.occurrence = hash(['occurrence', key]);
      state.occurrences[intent.occurrence] = { key: intent.occurrence, intentId: intent.id, routineId: 'routine', definitionVersion: 1,
        trigger: { kind: 'scheduled', plannedAt: 1 }, wakeKey: `routine:1:${key}`, recordedAt: 1, nextAt: null, attempts: 1 };
      state.slots[hash(`routine:1:${key}`)] = intent.occurrence;
    }
    state.applied[intent.taskId] = true;
    settle(state, intent, 'succeeded');
    if (options.ack !== false) delete state.outbox[`projection:${hash(`intent:${intentKey}`)}`];
  });
  return intentKey;
}
const policy = { now: 100, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS };

it('compacts all selected generations while preserving unsettled evidence, every other outbox and business state', () => {
  const { ledger } = open(); seed(ledger, 'done', { occurrence: true, generation: 2 }); seed(ledger, 'unacked', { ack: false });
  ledger.transaction(state => {
    enqueue(state, ledger.tenant, input('active'));
    state.application.result = { retained: true };
    project(state, 'custom', { retained: 'unacknowledged' });
    state.outbox.wake = { kind: 'schedule', input: { dedupKey: 'next', availableAt: 1000 } };
  });
  const before = ledger.snapshot();
  const result = ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] });
  const after = ledger.snapshot();
  expect(result).toMatchObject({ compactedIntents: 1, executions: 3, occurrences: 1 });
  expect(result.afterBytes).toBeLessThan(result.beforeBytes);
  expect(after.intents[hash('done')]).toBeUndefined();
  for (let i = 0; i <= 2; i++) expect(after.executions[taskId('done', i)]).toBeUndefined();
  expect(after.outbox).toEqual(before.outbox); expect(after.application).toEqual(before.application);
  for (const key of ['active', 'unacked']) {
    expect(after.intents[hash(key)]).toEqual(before.intents[hash(key)]);
    expect(after.executions[taskId(key, 0)]).toEqual(before.executions[taskId(key, 0)]);
  }
  expect(after.occurrences).toEqual({}); expect(after.slots).toEqual({});
  expect(ledger.hasTombstone('application', taskId('done', 2), policy.now)).toBe(true);
});

it('rejects unsettled/unacknowledged/unknown selections and rolls back earlier selections and tombstones', () => {
  const { ledger } = open(); seed(ledger, 'done'); seed(ledger, 'unacked', { ack: false });
  ledger.transaction(state => enqueue(state, ledger.tenant, input('active')));
  const before = ledger.snapshot();
  for (const key of ['active', 'unacked', 'missing']) {
    expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: ['done', key] })).toThrow();
    expect(ledger.snapshot()).toEqual(before); expect(ledger.hasTombstone('intent', 'done', policy.now)).toBe(false);
  }
});

it('runs the registered compact veto in the compaction transaction for every caller', () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-veto-')); roots.push(root);
  const seen: string[] = [];
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'test', { compactVeto: (state, key) => {
    seen.push(key);
    return key === 'kept' || key.startsWith('occurrence:') ? 'Still in use' : undefined;
  } });
  ledgers.push(ledger);
  seed(ledger, 'done'); seed(ledger, 'kept'); seed(ledger, 'other');
  const before = ledger.snapshot();
  const refused = (() => { try { ledger.compact({ ...policy, acknowledgedIntentKeys: ['done', 'kept'] }); } catch (error) { return error; } })();
  expect(refused).toBeInstanceOf(CompactVetoError);
  expect(refused).toMatchObject({ code: 'compact_vetoed', intentKey: 'kept', message: 'Compaction refused: Still in use' });
  expect(ledger.snapshot()).toEqual(before); expect(ledger.hasTombstone('intent', 'done', policy.now)).toBe(false);
  // An acknowledged occurrence asks for its derived intent identity, before K4 checks the occurrence.
  expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: [], acknowledgedOccurrenceKeys: ['o1'] })).toThrow(CompactVetoError);
  expect(seen.at(-1)).toBe('occurrence:o1');
  expect(ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] })).toMatchObject({ compactedIntents: 1 });
  // An already compacted key has no intent, so the veto does not see it again.
  seen.length = 0;
  expect(ledger.compact({ ...policy, acknowledgedIntentKeys: ['done', 'other'] })).toMatchObject({ compactedIntents: 1, alreadyCompactedIntents: 1 });
  expect(seen).toEqual(['other']);
  expect(ledger.compactVeto).toBeTypeOf('function');
  expect(() => new HostLedger(':memory:', 'test', { compactVeto: 'no' as never })).toThrow('The compact veto must be a function');
});

it('refuses a compact veto that changes the ledger or returns no reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-veto-')); roots.push(root);
  let veto: (state: { application: Record<string, unknown> }) => unknown = () => undefined;
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'test', { compactVeto: state => veto(state) as string | undefined });
  ledgers.push(ledger);
  seed(ledger, 'done');
  const before = ledger.snapshot();
  veto = state => { state.application.changed = true; return undefined; };
  expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] })).toThrow('A compact veto must not change the ledger');
  veto = () => '';
  expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] })).toThrow('A compact veto returns a reason or undefined');
  expect(ledger.snapshot()).toEqual(before); expect(ledger.hasTombstone('intent', 'done', policy.now)).toBe(false);
});

it('rolls back SQL failures and refuses malformed occurrence associations', () => {
  const { ledger, filename } = open(); seed(ledger, 'done', { occurrence: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec("CREATE TRIGGER fail_retirement BEFORE INSERT ON host_retired_identity WHEN NEW.kind='intent' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    const before = ledger.snapshot();
    expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] })).toThrow('injected failure');
    expect(ledger.snapshot()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM host_retired_identity').get()?.n).toBe(0);
    db.exec('DROP TRIGGER fail_retirement');
  } finally { db.close(); }
  ledger.transaction(state => { state.occurrences[state.intents[hash('done')]!.occurrence!]!.intentId = 'other'; });
  const before = ledger.snapshot();
  expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] })).toThrow('association');
  expect(ledger.snapshot()).toEqual(before);
  ledger.transaction(state => {
    const done = state.intents[hash('done')]!;
    state.occurrences[done.occurrence!]!.intentId = done.id;
    enqueue(state, ledger.tenant, input('other')).occurrence = done.occurrence;
  });
  const shared = ledger.snapshot();
  expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: ['done'] })).toThrow('association');
  expect(ledger.snapshot()).toEqual(shared);
});

it('keeps replay tombstones to the exact boundary and permanently rejects reuse across reopen and expiry', async () => {
  let { ledger, filename } = open(); seed(ledger, '1', { occurrence: true });
  ledger.compact({ ...policy, acknowledgedIntentKeys: ['1', '1'] });
  expect(ledger.compact({ ...policy, acknowledgedIntentKeys: ['1'] }).alreadyCompactedIntents).toBe(1);
  ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1); ledger = open('test', filename).ledger;
  const expires = policy.now + policy.tombstoneRetentionMs;
  expect(ledger.hasTombstone('slot', 'routine:1:1', expires - 1)).toBe(true);
  expect(ledger.hasTombstone('slot', 'routine:1:1', expires)).toBe(false);
  const core = new HostExecutionCore({} as ExecutionServer, ledger, { now: () => expires - 1 });
  const drain = vi.spyOn(core, 'drain'); const before = ledger.snapshot();
  await core.consume({ wakeId: 'wake', dedupKey: 'routine:1:1', availableAt: 1, deliveredAt: expires - 1, delivery: 2 }, new AbortController().signal);
  expect(drain).not.toHaveBeenCalled(); expect(ledger.snapshot()).toEqual(before); await core.close();
  expect(ledger.compact({ ...policy, now: expires, acknowledgedIntentKeys: [] }).expiredTombstones).toBe(2);
  expect(ledger.hasTombstone('application', taskId('1', 0), expires)).toBe(false);
  expect(ledger.hasTombstone('intent', '1', expires)).toBe(true);
  expect(() => ledger.transaction(state => enqueue(state, ledger.tenant, input('1')))).toThrow(RetiredIntentIdentityError);
  expect(ledger.snapshot()).toEqual(before);
});

it('reports retired identity reuse with a stable code and rolls back the whole attempted transaction', () => {
  const { ledger } = open(); seed(ledger, 'retired');
  ledger.compact({ ...policy, acknowledgedIntentKeys: ['retired'] });
  const before = ledger.snapshot();
  let rejection: unknown;
  try {
    ledger.transaction(state => {
      state.application.changed = true;
      enqueue(state, ledger.tenant, input('fresh'));
      enqueue(state, ledger.tenant, input('retired'));
    });
  } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toBeInstanceOf(RetiredIntentIdentityError);
  expect(rejection).toMatchObject({ name: 'RetiredIntentIdentityError', code: 'retired_intent_identity' });
  expect(ledger.snapshot()).toEqual(before);
  expect(ledger.hasTombstone('intent', 'retired', policy.now)).toBe(true);
  expect(ledger.transaction(state => enqueue(state, ledger.tenant, input('fresh'))).key).toBe('fresh');
});

it('expires routine occurrence identities with their slot while caller identities stay permanent', () => {
  const { ledger, filename } = open();
  const routine = seed(ledger, 'tick', { routine: true }); seed(ledger, 'chat');
  const expires = policy.now + policy.tombstoneRetentionMs;
  expect(ledger.compact({ ...policy, acknowledgedIntentKeys: [routine, 'chat'] }).compactedIntents).toBe(2);
  const db = new DatabaseSync(filename);
  try {
    const identities = () => db.prepare("SELECT identity, expires_at FROM host_retired_identity WHERE kind='intent' ORDER BY expires_at").all();
    expect(identities()).toEqual([{ identity: hash('chat'), expires_at: null }, { identity: hash(routine), expires_at: expires }]);
    expect(ledger.compact({ ...policy, acknowledgedIntentKeys: [routine] }).alreadyCompactedIntents).toBe(1);
    expect(ledger.hasTombstone('intent', routine, expires - 1)).toBe(true);
    expect(ledger.hasTombstone('intent', routine, expires)).toBe(false);
    // Routine slot, application and intent rows expire together; the caller key keeps its permanent row.
    expect(ledger.compact({ ...policy, now: expires, acknowledgedIntentKeys: [] }).expiredTombstones).toBe(4);
    expect(identities()).toEqual([{ identity: hash('chat'), expires_at: null }]);
  } finally { db.close(); }
  expect(() => ledger.compact({ ...policy, now: expires, acknowledgedIntentKeys: [routine] })).toThrow('not found');
  const before = ledger.snapshot();
  expect(() => ledger.transaction(state => enqueue(state, ledger.tenant, { ...input(routine), source: 'routine' }))).toThrow(RetiredIntentIdentityError);
  expect(ledger.snapshot()).toEqual(before);
});

it('admits the derived occurrence key shape only together with its occurrence', () => {
  const { ledger } = open(); const before = ledger.snapshot();
  for (const key of [`occurrence:${'a'.repeat(64)}`, `occurrence:${hash('never recorded')}`]) {
    expect(() => ledger.transaction(state => enqueue(state, ledger.tenant, { ...input(key), source: 'routine' }))).toThrow(RetiredIntentIdentityError);
    expect(() => ledger.transaction(state => { enqueue(state, ledger.tenant, input(key)).occurrence = key.slice('occurrence:'.length); })).toThrow(RetiredIntentIdentityError);
  }
  expect(ledger.snapshot()).toEqual(before);
  expect(ledger.transaction(state => enqueue(state, ledger.tenant, input('occurrence:caller-key'))).key).toBe('occurrence:caller-key');
  const linked = seed(ledger, 'linked', { routine: true });
  expect(ledger.snapshot().intents[hash(linked)]?.occurrence).toBe(hash(['occurrence', 'linked']));
});

it.each([['scheduled', 60 * 86_400_000], ['catch_up', 1000]] as const)(
  'reserves past a slot delivered before the Host clock reaches it, so a late %s redelivery stays closed', (_kind, lateAfterMs) => {
  const { ledger } = open(); const slot = 3_000_000, everyMs = 300_000;
  const wake = { wakeId: 'wake', dedupKey: `tick:1:${slot}`, availableAt: slot, deliveredAt: slot, delivery: 1 };
  ledger.transaction(state => {
    state.routines[hash('tick')] = { definition: { id: 'tick', version: 1, timeZone: 'UTC', rule: { anchorMs: 0, everyMs },
      execution: template('device'), waitMs: 1000, lateAfterMs }, lifecycle: 'active', status: 'ok', next: { dedupKey: wake.dedupKey, availableAt: slot } };
    recordOccurrence(state, ledger.tenant, wake, slot - 1, nextIntervalOccurrence); // The SDK scheduler clock leads by 1 ms.
  });
  expect(ledger.snapshot().routines[hash('tick')]!.next).toEqual({ dedupKey: `tick:1:${slot + everyMs}`, availableAt: slot + everyMs });
  const recorded = Object.values(ledger.snapshot().intents)[0]!;
  ledger.transaction(state => { settle(state, state.intents[recorded.id]!, 'succeeded'); delete state.outbox[`projection:${hash(`intent:${recorded.key}`)}`]; });
  const expiry = slot + policy.tombstoneRetentionMs;
  ledger.compact({ ...policy, now: slot, acknowledgedIntentKeys: [recorded.key] });
  ledger.compact({ ...policy, now: expiry, acknowledgedIntentKeys: [] });
  // A redelivery after expiry (for example after the SDK collects its delivered row) must not open the slot again.
  ledger.transaction(state => recordOccurrence(state, ledger.tenant, wake, expiry + 1, nextIntervalOccurrence));
  expect(ledger.snapshot().intents).toEqual({});
  expect(ledger.snapshot().ignoredWakes).toEqual([{ at: expiry + 1, reason: 'reservation_mismatch', wakeKeyHash: hash(wake.dedupKey) }]);
});

it('isolates retirement and expiration by tenant in a shared database', () => {
  const { ledger, filename } = open('a'); const other = open('b', filename).ledger;
  seed(ledger, 'same', { occurrence: true }); seed(other, 'same', { occurrence: true });
  ledger.compact({ ...policy, acknowledgedIntentKeys: ['same'] });
  expect(other.hasTombstone('intent', 'same', policy.now)).toBe(false);
  other.compact({ ...policy, now: policy.now + 100, acknowledgedIntentKeys: ['same'] });
  ledger.compact({ ...policy, now: policy.now + policy.tombstoneRetentionMs + 1000, acknowledgedIntentKeys: [] });
  expect(other.hasTombstone('slot', 'routine:1:same', policy.now + 100)).toBe(true);
});

it('adds retirement storage to a version-1 ledger without changing its existing JSON', () => {
  const { ledger, filename } = open(); seed(ledger, 'existing'); const before = ledger.snapshot();
  ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1);
  const db = new DatabaseSync(filename);
  try { db.exec('DROP TABLE host_retired_identity'); } finally { db.close(); }
  const reopened = open('test', filename).ledger;
  expect(reopened.snapshot()).toEqual(before);
  expect(reopened.compact({ ...policy, acknowledgedIntentKeys: ['existing'] }).compactedIntents).toBe(1);
});

it('does not recreate a completed routine or reapply its SDK terminal on replay before or after expiry', async () => {
  let now = Date.now(); const slot = now + 100; let delivered: DueWake | undefined;
  const applyOutcome = vi.fn((_document, tx) => { tx.application.count = Number(tx.application.count ?? 0) + 1; });
  const host = await openHost({ now: () => now, nextOccurrence: (_definition, after) => after < slot ? slot : null,
    applyOutcome, consume: async (wake, _signal, next) => { if (!wake.dedupKey.startsWith('host-scan:')) delivered = wake; await next(); } });
  try {
    now = slot; // The injected Host clock must reach the delivered SDK slot too.
    await host.core.addRoutine(host.routine('retention'));
    await vi.waitFor(() => expect(Object.values(host.ledger.snapshot().occurrences)).toHaveLength(1));
    const occurrence = Object.values(host.ledger.snapshot().occurrences)[0]!;
    const intent = host.ledger.snapshot().intents[occurrence.intentId!]!;
    await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true));
    await host.adapter.sessions.get(intent.taskId)!.finish({ text: 'retained by the SDK' });
    await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(intent.key)?.conclusion).toBe('succeeded'); });
    await host.core.flushProjections(async () => {});
    expect(await host.server.tasks.deviceTerminal(intent.taskId)).toBeDefined();
    host.ledger.compact({ ...policy, now, acknowledgedIntentKeys: [intent.key] });
    const read = vi.spyOn(host.server.tasks, 'deviceTerminal'); const submitted = host.adapter.starts.length;
    expect(delivered?.dedupKey).toBe(occurrence.wakeKey);
    await host.core.consume(delivered!, new AbortController().signal);
    now += MIN_TOMBSTONE_RETENTION_MS;
    host.ledger.compact({ ...policy, now, acknowledgedIntentKeys: [] });
    await host.core.consume(delivered!, new AbortController().signal); await host.core.drain();
    expect(read).not.toHaveBeenCalled(); expect(applyOutcome).toHaveBeenCalledTimes(1);
    expect(host.ledger.snapshot().application.count).toBe(1);
    expect(host.ledger.snapshot().occurrences).toEqual({}); expect(host.adapter.starts).toHaveLength(submitted);
    await expect(host.core.enqueue({ ...input(intent.key), source: intent.source, execution: intent.execution as IntentInput['execution'], waitUntil: intent.waitUntil, retry: intent.retry })).rejects.toMatchObject({ name: 'RetiredIntentIdentityError', code: 'retired_intent_identity' });
  } finally { await host.close(); }
});

it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid time %s without changes', value => {
  const { ledger } = open(); seed(ledger, 'done'); const before = ledger.snapshot();
  expect(() => ledger.compact({ ...policy, now: value, acknowledgedIntentKeys: ['done'] })).toThrow();
  expect(() => ledger.compact({ ...policy, tombstoneRetentionMs: value, acknowledgedIntentKeys: ['done'] })).toThrow();
  expect(ledger.snapshot()).toEqual(before);
});

it('rejects retention below seven days and overflow, and bounds the hot body independently of removed history', () => {
  const { ledger } = open();
  seed(ledger, 'a'); seed(ledger, 'b'); const before = ledger.snapshot();
  // JavaScript callers must not accidentally select character keys from a string.
  expect(() => ledger.compact({ ...policy, acknowledgedIntentKeys: 'ab' as unknown as string[] })).toThrow('array');
  expect(ledger.snapshot()).toEqual(before);
  ledger.compact({ ...policy, acknowledgedIntentKeys: ['a', 'b'] });
  expect(() => ledger.compact({ ...policy, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS - 1, acknowledgedIntentKeys: [] })).toThrow('seven days');
  expect(() => ledger.compact({ ...policy, now: Number.MAX_SAFE_INTEGER, acknowledgedIntentKeys: [] })).toThrow();
  for (let batch = 0; batch < 2; batch++) {
    const keys = Array.from({ length: 20 }, (_, i) => `${batch}-${i}`);
    for (const key of keys) seed(ledger, key);
    const result = ledger.compact({ ...policy, acknowledgedIntentKeys: keys });
    expect(result.afterBytes).toBeLessThan(250);
    expect(ledger.snapshot().executions).toEqual({}); expect(ledger.snapshot().applied).toEqual({});
  }
});
