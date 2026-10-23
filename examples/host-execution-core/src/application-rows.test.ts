import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, type ApplicationRows } from './index';

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
  for (const use of [() => kept!.put('turns', 'a', 1), () => kept!.delete('turns', 'a'), () => kept!.retire('turns', 'a'), () => kept!.isRetired('turns', 'a')]) {
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
