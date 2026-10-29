import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, type ApplicationRows } from '../../execution-core/index';

const roots: string[] = [], ledgers: HostLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open(tenant = 'test', filename?: string) {
  if (!filename) { const root = mkdtempSync(join(tmpdir(), 'k4-rows-')); roots.push(root); filename = join(root, 'host.sqlite'); }
  const ledger = new HostLedger(filename, tenant); ledgers.push(ledger); return { ledger, filename };
}
const read = (ledger: HostLedger, namespace: string, id: string) => ledger.transaction((_state, rows) => rows.get(namespace, id));

it('stores application rows by namespace and id in the body transaction, and returns copies', () => {
  const { ledger } = open();
  ledger.transaction((state, rows) => {
    state.application.count = 1;
    rows.put('turns', 'a', { status: 'settled', tags: ['x'] });
    rows.put('turns', 'b', 1);
    rows.put('commands', 'a', null);
  });
  expect(ledger.snapshot().application).toEqual({ count: 1 });
  expect(read(ledger, 'turns', 'a')).toEqual({ status: 'settled', tags: ['x'] });
  expect(read(ledger, 'commands', 'a')).toBeNull();
  expect(read(ledger, 'turns', 'missing')).toBeUndefined();
  ledger.transaction((_state, rows) => {
    const row = rows.get('turns', 'a') as { tags: string[] };
    row.tags.push('changed');
    expect(rows.get('turns', 'a')).toEqual({ status: 'settled', tags: ['x'] });
    rows.put('turns', 'b', 2);
    expect(rows.delete('turns', 'a')).toBe(true);
    expect(rows.delete('turns', 'a')).toBe(false);
  });
  expect(read(ledger, 'turns', 'a')).toBeUndefined();
  expect(read(ledger, 'turns', 'b')).toBe(2);
});

it('rolls back row writes with the body, and closes the port when apply returns or throws', async () => {
  const { ledger } = open();
  let kept: ApplicationRows | undefined;
  expect(() => ledger.transaction((state, rows) => {
    state.application.lost = true; rows.put('turns', 'a', 1); rows.retire('turns', 'a'); kept = rows;
    throw new Error('injected failure');
  })).toThrow('injected failure');
  expect(ledger.snapshot().application).toEqual({});
  expect(read(ledger, 'turns', 'a')).toBeUndefined();
  expect(ledger.transaction((_state, rows) => rows.isRetired('turns', 'a'))).toBe(false);
  expect(() => kept!.get('turns', 'a')).toThrow('The application row port is closed');
  ledger.transaction((_state, rows) => { kept = rows; });
  for (const use of [() => kept!.put('turns', 'a', 1), () => kept!.delete('turns', 'a'), () => kept!.expire('turns', 1), () => kept!.retire('turns', 'a'), () => kept!.isRetired('turns', 'a')]) {
    expect(use).toThrow('The application row port is closed');
  }
  // An asynchronous apply is refused, and a write after its first await meets a closed port.
  let late: Promise<unknown> | undefined;
  expect(() => ledger.transaction((_state, rows) => {
    late = (async () => { await Promise.resolve(); rows.put('turns', 'late', 1); })();
    return late;
  })).toThrow('Host transactions must be synchronous');
  await expect(late).rejects.toThrow('The application row port is closed');
  expect(read(ledger, 'turns', 'late')).toBeUndefined();
});

it('refuses a nested transaction or compact inside apply, and keeps the outer transaction intact', () => {
  const { ledger } = open();
  const nested = 'cannot start a transaction within a transaction';
  ledger.transaction((state, rows) => {
    rows.put('turns', 'outer', 1);
    expect(() => ledger.transaction((_state, inner) => { inner.put('turns', 'inner', 2); })).toThrow(nested);
    expect(() => ledger.compact({ acknowledgedIntentKeys: [], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toThrow(nested);
    rows.put('turns', 'after', 3);
    state.application.kept = true;
  });
  expect(ledger.snapshot().application).toEqual({ kept: true });
  expect(ledger.transaction((_state, rows) => ['outer', 'inner', 'after'].map(id => rows.get('turns', id)))).toEqual([1, undefined, 3]);
  // A nested call that apply does not catch rolls the outer transaction back, and the ledger stays usable.
  expect(() => ledger.transaction((_state, rows) => { rows.put('turns', 'lost', 1); ledger.transaction(() => undefined); })).toThrow(nested);
  expect(read(ledger, 'turns', 'lost')).toBeUndefined();
  ledger.transaction((_state, rows) => rows.put('turns', 'next', 1));
  expect(read(ledger, 'turns', 'next')).toBe(1);
});

it('keeps tenants apart, and keeps a retired identity after a row delete and a compaction', () => {
  const { ledger, filename } = open('one');
  const other = open('two', filename).ledger;
  ledger.transaction((_state, rows) => { rows.put('turns', 'a', 'one'); rows.retire('turns', 'a'); });
  expect(read(other, 'turns', 'a')).toBeUndefined();
  expect(other.transaction((_state, rows) => rows.isRetired('turns', 'a'))).toBe(false);
  ledger.transaction((_state, rows) => {
    expect(rows.delete('turns', 'a')).toBe(true);
    rows.retire('turns', 'a');
    expect(rows.isRetired('turns', 'a')).toBe(true);
    expect(rows.isRetired('turns', 'b')).toBe(false);
    expect(rows.isRetired('other', 'a')).toBe(false);
  });
  ledger.compact({ acknowledgedIntentKeys: [], now: Date.now() + 365 * 86_400_000, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  expect(ledger.transaction((_state, rows) => rows.isRetired('turns', 'a'))).toBe(true);
  // A row tombstone is not an intent tombstone.
  expect(ledger.hasTombstone('intent', 'a', 0)).toBe(false);
});

it('expires rows of one namespace at their time, and keeps rows without an expiry', () => {
  const { ledger } = open();
  ledger.transaction((_state, rows) => {
    rows.put('commands', 'old', 1, 100); rows.put('commands', 'new', 2, 200); rows.put('commands', 'kept', 3);
    rows.put('turns', 'old', 4, 100);
  });
  expect(ledger.transaction((_state, rows) => rows.expire('commands', 99))).toBe(0);
  expect(ledger.transaction((_state, rows) => rows.expire('commands', 100))).toBe(1);
  expect(ledger.transaction((_state, rows) => [rows.get('commands', 'old'), rows.get('commands', 'new'), rows.get('commands', 'kept'), rows.get('turns', 'old')]))
    .toEqual([undefined, 2, 3, 4]);
  // A put without an expiry clears the old one.
  ledger.transaction((_state, rows) => rows.put('commands', 'new', 5));
  expect(ledger.transaction((_state, rows) => rows.expire('commands', 1_000_000))).toBe(0);
  expect(read(ledger, 'commands', 'new')).toBe(5);
  for (const expiresAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => ledger.transaction((_state, rows) => rows.put('commands', 'bad', 1, expiresAt))).toThrow('Time must be a nonnegative safe integer');
  }
  expect(() => ledger.transaction((_state, rows) => rows.expire('', 1))).toThrow('Invalid application row namespace');
  expect(() => ledger.transaction((_state, rows) => rows.expire('commands', -1))).toThrow('Time must be a nonnegative safe integer');
});

it('refuses an invalid namespace, id or value and writes nothing', () => {
  const { ledger } = open();
  const invalid: Array<[(rows: ApplicationRows) => unknown, string]> = [
    [rows => rows.put('', 'a', 1), 'Invalid application row namespace'],
    [rows => rows.put('n'.repeat(129), 'a', 1), 'Invalid application row namespace'],
    [rows => rows.get(1 as never, 'a'), 'Invalid application row namespace'],
    [rows => rows.put('turns', '', 1), 'Invalid application row id'],
    [rows => rows.retire('turns', 'i'.repeat(1025)), 'Invalid application row id'],
    [rows => rows.put('turns', 'a', undefined as never), 'An application row must be JSON'],
  ];
  for (const [use, message] of invalid) {
    expect(() => ledger.transaction((state, rows) => { state.application.lost = true; use(rows); })).toThrow(message);
  }
  expect(ledger.snapshot().application).toEqual({});
  expect(ledger.transaction((_state, rows) => [rows.get('turns', 'a'), rows.get('n'.repeat(128), 'i'.repeat(1024))])).toEqual([undefined, undefined]);
});
