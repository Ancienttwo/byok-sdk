import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, RetiredIntentIdentityError, type LedgerDump } from './index';
import { hash, taskId, type IntentInput } from './model';
import { agentKey, enqueue, fifoHeads, settle } from './transitions';
import { template } from './test-support';

// #975 slice 1: a whole tenant moves to another, empty tenant for a topology switch.
const roots: string[] = [], ledgers: HostLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch { /* A discarded ledger is already closed. */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function file(): string { const root = mkdtempSync(join(tmpdir(), 'k4-switch-')); roots.push(root); return join(root, 'host.sqlite'); }
function open(filename: string, tenant: string): HostLedger { const ledger = new HostLedger(filename, tenant); ledgers.push(ledger); return ledger; }
const NOW = 100, RETENTION = MIN_TOMBSTONE_RETENTION_MS;
const input = (key: string): IntentInput => ({ key, source: 'user', execution: template('device'), waitUntil: 1000 });
/** A settled intent with its executions, as `retention.test.ts` seeds one. A routine seed uses the derived occurrence key. */
function seed(ledger: HostLedger, key: string, options: { routine?: boolean; generation?: number; ack?: boolean } = {}): string {
  const intentKey = options.routine ? `occurrence:${hash(['occurrence', key])}` : key;
  ledger.transaction(state => {
    const intent = enqueue(state, ledger.tenant, input(intentKey));
    for (let generation = 0; generation <= (options.generation ?? 0); generation++) {
      const id = taskId(intentKey, generation);
      state.executions[id] = { input: { ...intent.execution, taskId: id }, started: true, submission: 'delivered' };
      intent.generation = generation; intent.taskId = id;
    }
    intent.occurrence = hash(['occurrence', key]);
    state.occurrences[intent.occurrence] = { key: intent.occurrence, intentId: intent.id, routineId: 'routine', definitionVersion: 1,
      trigger: { kind: 'scheduled', plannedAt: 1 }, wakeKey: `routine:1:${key}`, recordedAt: 1, nextAt: null, attempts: 1 };
    state.slots[hash(`routine:1:${key}`)] = intent.occurrence;
    state.applied[intent.taskId] = true;
    settle(state, intent, 'succeeded');
    if (options.ack !== false) delete state.outbox[`projection:${hash(`intent:${intentKey}`)}`];
  });
  return intentKey;
}
const memoryRow = { deviceId: 'device', expiresAt: 9_000_000, intent: { intentId: 'memory-1', approvalRef: 'approval' } };
/** A tenant with every kind of stored row except memory: intent tombstones with and without expiry, application, slot and row
 * tombstones, application rows with no, a future and a passed expiry, open work and an unsent projection. */
function populate(ledger: HostLedger): { done: string; routine: string } {
  const done = seed(ledger, 'done', { generation: 1 }), routine = seed(ledger, 'nightly', { routine: true });
  seed(ledger, 'unacked', { ack: false });
  ledger.transaction((state, rows) => {
    enqueue(state, ledger.tenant, input('active'));
    state.application.collaboration = { version: 3, note: 'kept' };
    rows.put('commands', 'command-1', { disposition: 'applied' });
    rows.put('archive', 'turn-1', { text: 'later' }, 5_000_000);
    rows.put('archive', 'turn-0', { text: 'passed' }, 1);
    rows.retire('archive', 'gone');
  });
  ledger.compact({ now: NOW, tombstoneRetentionMs: RETENTION, acknowledgedIntentKeys: [done, routine] });
  return { done, routine };
}
/** Binds a dump to another tenant, as a switch import builds one: each intent queues under that tenant. */
function bind(dump: LedgerDump, tenant: string): LedgerDump {
  const bound = structuredClone(dump);
  for (const intent of Object.values(bound.body.intents)) intent.agent = agentKey(tenant, intent.execution);
  return bound;
}
/** A target tenant with the source's name in its own file. */
const twin = () => open(file(), 'source');
/** A load whose caller accepts any read-back. */
const accept = () => {};

it('loads a dump into an empty tenant so that its own dump is equal, with every expiry kept', () => {
  const source = open(file(), 'source');
  const { done, routine } = populate(source);
  const dump = source.dumpForSwitch();
  const expiresAt = NOW + RETENTION;
  expect(dump.tombstones).toEqual([
    { kind: 'application', identity: hash(taskId(done, 1)), expiresAt },
    { kind: 'application', identity: hash(taskId(routine, 0)), expiresAt },
    { kind: 'intent', identity: hash(done), expiresAt: null },
    { kind: 'intent', identity: hash(routine), expiresAt },
    { kind: 'row', identity: hash(['archive', 'gone']), expiresAt: null },
    { kind: 'slot', identity: hash('routine:1:done'), expiresAt },
    { kind: 'slot', identity: hash('routine:1:nightly'), expiresAt },
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.identity.localeCompare(b.identity)));
  expect(dump.rows).toEqual([
    { namespace: 'archive', id: 'turn-0', value: { text: 'passed' }, expiresAt: 1 },
    { namespace: 'archive', id: 'turn-1', value: { text: 'later' }, expiresAt: 5_000_000 },
    { namespace: 'commands', id: 'command-1', value: { disposition: 'applied' }, expiresAt: null },
  ]);
  expect(dump.memoryTombstones).toEqual([]);
  expect(dump.body).toEqual(source.snapshot());
  expect(Object.keys(dump.body.outbox)).toContain(`projection:${hash('intent:unacked')}`);

  const target = twin();
  target.loadForSwitch(structuredClone(dump), accept);
  expect(target.dumpForSwitch()).toEqual(dump);
  expect(target.hasTombstone('intent', done, NOW)).toBe(true);
  expect(target.hasTombstone('intent', routine, expiresAt - 1)).toBe(true);
  expect(target.hasTombstone('intent', routine, expiresAt)).toBe(false);
  expect(() => target.transaction(state => { enqueue(state, target.tenant, input(done)); })).toThrow(RetiredIntentIdentityError);
  expect(target.transaction((_state, rows) => [rows.get('commands', 'command-1'), rows.isRetired('archive', 'gone')]))
    .toEqual([{ disposition: 'applied' }, true]);
  expect(source.dumpForSwitch()).toEqual(dump);
});

it('loads only a dump bound to this tenant, so imported and new work share one FIFO', () => {
  const filename = file(), source = open(filename, 'source');
  populate(source);
  const dump = source.dumpForSwitch();
  // Each intent of a dump from another tenant would queue apart from the work this tenant admits.
  const other = open(filename, 'target'), empty = other.dumpForSwitch();
  expect(() => other.loadForSwitch(dump, accept)).toThrow('A switch dump intent must queue under this tenant');
  expect(other.dumpForSwitch()).toEqual(empty);

  other.loadForSwitch(bind(dump, 'target'), accept);
  const next = other.transaction(state => enqueue(state, other.tenant, input('next')));
  const open_ = Object.values(other.snapshot().intents).filter(intent => intent.phase !== 'settled');
  expect(open_.map(intent => intent.key).sort()).toEqual(['active', 'next']);
  expect(next.agent).toBe(other.snapshot().intents[hash('active')]!.agent);
  expect(fifoHeads(open_).map(intent => intent.key)).toEqual(['active']);
});

it('refuses a tenant that is not empty, or one with a core bound, and changes nothing', () => {
  const source = open(file(), 'source');
  populate(source);
  const dump = source.dumpForSwitch();
  const used: Array<[string, (ledger: HostLedger, filename: string) => void]> = [
    ['body', ledger => ledger.transaction(state => { state.application.x = 1; })],
    ['row', ledger => ledger.transaction((_state, rows) => rows.put('commands', 'c', {}))],
    ['row tombstone', ledger => ledger.transaction((_state, rows) => rows.retire('commands', 'c'))],
    ['memory tombstone', (ledger, filename) => {
      const db = new DatabaseSync(filename);
      db.prepare('INSERT INTO host_retired_memory_intent VALUES (?,?,?,?,?)').run(ledger.tenant, 'm', 'a', '{}', 1);
      db.close();
    }],
  ];
  for (const [what, use] of used) {
    const filename = file(), target = open(filename, 'source');
    use(target, filename);
    const before = target.dumpForSwitch();
    expect(() => target.loadForSwitch(dump, accept), what).toThrow('A switch dump loads only into an empty tenant');
    expect(target.dumpForSwitch(), what).toEqual(before);
  }
  const bound = twin();
  const stop = bound.onOutbox(() => {});
  expect(() => bound.loadForSwitch(dump, accept)).toThrow('Load a switch dump before any core is bound to this ledger');
  stop();
  bound.loadForSwitch(dump, accept);
  expect(bound.dumpForSwitch()).toEqual(dump);
});

it('dumps retired memory intents, and refuses to load any memory state', () => {
  const filename = file(), source = open(filename, 'source');
  populate(source);
  const db = new DatabaseSync(filename);
  db.prepare('INSERT INTO host_retired_memory_intent VALUES (?,?,?,?,?)').run('source', 'memory-1', hash(['device', 'approval']),
    JSON.stringify(memoryRow), 9_000_000);
  db.close();
  const dump = source.dumpForSwitch();
  expect(dump.memoryTombstones).toEqual([{ intentId: 'memory-1', approval: hash(['device', 'approval']), row: memoryRow, expiresAt: 9_000_000 }]);
  const target = twin(), empty = target.dumpForSwitch();
  expect(() => target.loadForSwitch(dump, accept)).toThrow('A switch dump carries no memory state');
  const live = structuredClone(dump);
  live.memoryTombstones = [];
  live.body.memory = { intents: { 'memory-1': memoryRow as never }, approvals: {}, projections: {} };
  expect(() => target.loadForSwitch(live, accept)).toThrow('A switch dump carries no memory state');
  expect(target.dumpForSwitch()).toEqual(empty);
  // An empty memory store, as a bound memory page leaves it, carries nothing.
  live.body.memory = { intents: {}, approvals: {}, projections: {} };
  target.loadForSwitch(live, accept);
  expect(target.snapshot().memory).toEqual({ intents: {}, approvals: {}, projections: {} });
});

it('rolls the whole load back when a write fails, and refuses a malformed dump before it writes', () => {
  const source = open(file(), 'source');
  populate(source);
  const dump = source.dumpForSwitch();
  const target = twin(), empty = target.dumpForSwitch();
  // The body and the first rows are written before the duplicate key fails.
  const duplicate = structuredClone(dump);
  duplicate.rows.push(duplicate.rows[0]!);
  expect(() => target.loadForSwitch(duplicate, accept)).toThrow();
  expect(target.dumpForSwitch()).toEqual(empty);

  const stale = `host-scan:${hash('target')}:1`;
  const malformed: Array<[string, (dump: LedgerDump) => void, string | (new () => Error)]> = [
    ['version', d => { (d as { version: number }).version = 2; }, 'Unsupported switch dump version'],
    ['body version', d => { (d.body as { version: number }).version = 2; }, 'Unsupported Host ledger version'],
    ['rows', d => { (d as { rows: unknown }).rows = {}; }, 'Invalid switch dump rows'],
    ['kind', d => { (d.tombstones[0] as { kind: string }).kind = 'memory'; }, 'Invalid switch dump tombstone kind'],
    ['identity', d => { d.tombstones[0]!.identity = ''; }, 'Invalid switch dump tombstone identity'],
    ['expiry', d => { d.rows[0]!.expiresAt = 1.5; }, 'Time must be a nonnegative safe integer'],
    ['missing expiry', d => { delete (d.rows[0] as { expiresAt?: number | null }).expiresAt; }, 'Time must be a nonnegative safe integer'],
    ['namespace', d => { d.rows[0]!.namespace = 'n'.repeat(129); }, 'Invalid application row namespace'],
    ['value', d => { d.rows[0]!.value = undefined as never; }, 'Invalid switch dump row value'],
    // A body intent that its own tombstones retired, and a derived occurrence key outside its occurrence.
    ['retired intent', d => { d.tombstones.push({ kind: 'intent', identity: hash('active'), expiresAt: null }); }, RetiredIntentIdentityError],
    ['occurrence key', d => {
      // Its occurrence names this intent, but the key names another occurrence.
      const intent = d.body.intents[hash('unacked')]!, key = `occurrence:${hash('other')}`;
      d.body.intents[hash(key)] = { ...intent, id: hash(key), key };
      delete d.body.intents[hash('unacked')];
      d.body.occurrences[intent.occurrence!]!.intentId = hash(key);
    }, RetiredIntentIdentityError],
    ['occurrence owner', d => {
      // The key names its occurrence, but that occurrence names another intent.
      const owner = d.body.intents[hash('unacked')]!, occurrence = owner.occurrence!, key = `occurrence:${occurrence}`;
      d.body.intents[hash(key)] = { ...owner, id: hash(key), key };
    }, RetiredIntentIdentityError],
    // Scan wake keys of another tenant: the current wake, a pending schedule and a pending cancel.
    ['scan wake', d => { d.body.scanWake = { dedupKey: stale, availableAt: 1 }; }, 'A switch dump scan wake must name this tenant'],
    ['scan schedule', d => { d.body.outbox[`schedule:${stale}`] = { kind: 'schedule', input: { dedupKey: stale, availableAt: 1 } }; },
      'A switch dump scan wake must name this tenant'],
    ['scan cancel', d => { d.body.outbox[`cancel:${stale}`] = { kind: 'cancel-wake', key: stale }; }, 'A switch dump scan wake must name this tenant'],
  ];
  for (const [what, change, error] of malformed) {
    const bad = structuredClone(dump);
    change(bad);
    expect(() => target.loadForSwitch(bad, accept), what).toThrow(error as never);
    expect(target.dumpForSwitch(), what).toEqual(empty);
  }
  // A scan wake of this tenant loads.
  const own = structuredClone(dump), key = `host-scan:${hash('source')}:1`;
  own.body.scanWake = { dedupKey: key, availableAt: 1 };
  own.body.outbox[`schedule:${key}`] = { kind: 'schedule', input: { dedupKey: key, availableAt: 1 } };
  target.loadForSwitch(own, accept);
  expect(target.dumpForSwitch()).toEqual(own);
});

it('discards every row of one tenant and closes that ledger, leaving other tenants of the file', () => {
  const filename = file(), source = open(filename, 'source');
  populate(source);
  const dump = source.dumpForSwitch(), bound = bind(dump, 'imported');
  const imported = open(filename, 'imported');
  imported.loadForSwitch(bound, accept);
  const stop = imported.onOutbox(() => {});
  expect(() => imported.discard()).toThrow('Close the core bound to this ledger before discarding it');
  expect(imported.dumpForSwitch()).toEqual(bound);
  stop();
  imported.discard();
  expect(() => imported.snapshot()).toThrow('database is not open');
  const db = new DatabaseSync(filename);
  for (const table of ['host_ledger', 'host_retired_identity', 'host_retired_memory_intent', 'host_application_row']) {
    expect(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tenant='imported'`).get(), table).toEqual({ n: 0 });
  }
  db.close();
  expect(source.dumpForSwitch()).toEqual(dump);
  // Reopening the tenant id creates an empty tenant, which a dump can load into again.
  const reopened = open(filename, 'imported');
  expect(reopened.dumpForSwitch()).toEqual(open(file(), 'new').dumpForSwitch());
  reopened.loadForSwitch(bound, accept);
  expect(reopened.dumpForSwitch()).toEqual(bound);
});

it('checks the read-back inside the load transaction, and leaves the tenant empty when the check throws', () => {
  const source = open(file(), 'source');
  populate(source);
  const dump = source.dumpForSwitch();
  const refused = twin();
  let seen: LedgerDump | undefined;
  expect(() => refused.loadForSwitch(dump, readBack => { seen = readBack; throw new Error('read-back differs'); })).toThrow('read-back differs');
  // The check saw the rows as written, which a later dump reads the same way.
  expect(seen).toEqual(dump);
  expect(refused.dumpForSwitch()).toEqual(twin().dumpForSwitch());
  expect(() => refused.loadForSwitch(dump, undefined as never)).toThrow('A switch load needs a read-back check');
  refused.loadForSwitch(dump, readBack => { expect(readBack).toEqual(dump); });
  expect(refused.dumpForSwitch()).toEqual(dump);
});

