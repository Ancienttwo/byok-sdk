import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { HostLedger, readHostLedger, type HostLedgerRead } from '../../execution-core/index';

const roots: string[] = [], ledgers: HostLedger[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) { fs.chmodSync(root, 0o755); fs.rmSync(root, { recursive: true, force: true }); }
});
function rootDir() { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'k4-read-'))); roots.push(root); return root; }
function open(filename: string, tenant: string, options?: ConstructorParameters<typeof HostLedger>[2]) {
  const ledger = new HostLedger(filename, tenant, options); ledgers.push(ledger); return ledger;
}
function set(ledger: HostLedger, value: number) { ledger.transaction(state => { state.application.n = value; }); }
/** Name, size, mtime and content hash of every file in a directory. */
function listing(root: string) {
  return fs.readdirSync(root).sort().map(name => {
    const file = join(root, name), stat = fs.statSync(file);
    return [name, stat.size, stat.mtimeMs, createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  });
}
const sql = (file: string, statements: string) => { const db = new DatabaseSync(file); try { db.exec(statements); } finally { db.close(); } };
const tenants = (read: HostLedgerRead) => { if (read.kind !== 'ok') throw new Error(`Expected ok, got ${JSON.stringify(read)}`); return read.tenants; };
const posix = process.platform !== 'win32';

it('reports an absent file without creating it', () => {
  const root = rootDir();
  expect(readHostLedger(join(root, 'host.sqlite'))).toEqual({ kind: 'absent', reason: 'no_file' });
  expect(fs.readdirSync(root)).toEqual([]);
});

it('reports a database without the host_ledger table as absent', () => {
  const root = rootDir(), file = join(root, 'host.sqlite'), other = join(root, 'other.sqlite');
  open(file, 'a').close(); ledgers.pop();
  sql(file, 'DROP TABLE host_ledger');
  sql(other, 'PRAGMA user_version=1');
  expect(readHostLedger(file)).toEqual({ kind: 'absent', reason: 'no_table' });
  expect(readHostLedger(other)).toEqual({ kind: 'absent', reason: 'no_table' });
});

it('reports a database with unrelated tables and no host_ledger as absent', () => {
  const file = join(rootDir(), 'other.sqlite');
  sql(file, 'CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
  expect(readHostLedger(file)).toEqual({ kind: 'absent', reason: 'no_table' });
});

it('reads every tenant ordered by tenant, with only the application, intents and executions of each', () => {
  const file = join(rootDir(), 'host.sqlite');
  set(open(file, 'b'), 2); set(open(file, 'a'), 1);
  expect(tenants(readHostLedger(file))).toEqual([
    { tenant: 'a', ok: true, state: { application: { n: 1 }, intents: {}, executions: {} } },
    { tenant: 'b', ok: true, state: { application: { n: 2 }, intents: {}, executions: {} } },
  ]);
});

it('reports a malformed row and still returns the valid rows', () => {
  const file = join(rootDir(), 'host.sqlite');
  set(open(file, 'good'), 1);
  const valid = JSON.stringify({ application: {}, intents: {}, executions: {} });
  sql(file, `INSERT INTO host_ledger VALUES ('bad-json', '{'), ('bad-shape', '{"application":{},"intents":[],"executions":{}}'),
    (X'07', '${valid}')`);
  const rows = tenants(readHostLedger(file));
  // SQLite orders text before a blob tenant, which TEXT affinity keeps as a blob.
  expect(rows.map(row => [row.tenant, row.ok, row.ok ? undefined : row.code])).toEqual([
    ['bad-json', false, 'corrupt_row'], ['bad-shape', false, 'corrupt_row'], ['good', true, undefined], [null, false, 'corrupt_row'],
  ]);
  expect(rows.find(row => row.tenant === 'good')).toEqual({ tenant: 'good', ok: true, state: { application: { n: 1 }, intents: {}, executions: {} } });
});

it('reads uncheckpointed WAL commits without changing the database, WAL or SHM', () => {
  const root = rootDir(), file = join(root, 'host.sqlite');
  const ledger = open(file, 'a');
  set(ledger, 1); set(ledger, 2);
  expect(fs.statSync(file + '-wal').size).toBeGreaterThan(0);
  const before = listing(root);
  expect(tenants(readHostLedger(file))[0]).toMatchObject({ tenant: 'a', state: { application: { n: 2 } } });
  expect(listing(root)).toEqual(before);
});

it.runIf(posix)('reads a WAL beside no SHM in a read-only directory, creating nothing', () => {
  const source = join(rootDir(), 'host.sqlite'), root = rootDir(), file = join(root, 'host.sqlite');
  set(open(source, 'a'), 3);
  fs.copyFileSync(source, file); fs.copyFileSync(source + '-wal', file + '-wal');
  fs.chmodSync(root, 0o555);
  const before = listing(root);
  expect(tenants(readHostLedger(file))[0]).toMatchObject({ tenant: 'a', state: { application: { n: 3 } } });
  expect(listing(root)).toEqual(before);
});

it('returns retryable or a consistent cross-tenant state while real writers commit to the WAL', () => {
  const file = join(rootDir(), 'host.sqlite');
  const a = open(file, 'a'), b = open(file, 'b');
  set(a, 0); set(b, 0);
  let n = 0, bPending = false, commitDuringCopy = false, committedDuringCopy = false;
  const copy = fs.copyFileSync.bind(fs);
  vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
    copy(source, destination, flags);
    // Tenant b commits after the main file is copied and before its WAL is.
    if (commitDuringCopy && String(source) === file) { commitDuringCopy = false; committedDuringCopy = true; set(b, n); bPending = false; }
  });
  const state = (read: HostLedgerRead) => tenants(read).map(row => row.ok ? row.state.application.n : row);
  for (let i = 0; i < 12; i++) {
    set(a, ++n); bPending = true;
    commitDuringCopy = i % 3 === 0; committedDuringCopy = false;
    const read = readHostLedger(file);
    if (committedDuringCopy) expect(read).toMatchObject({ kind: 'retryable', code: 'snapshot_changed' });
    else expect(state(read)).toEqual([n, n - 1]);
    if (bPending) { set(b, n); bPending = false; }
    expect(state(readHostLedger(file))).toEqual([n, n]);
  }
});

it('reports a potentially hot rollback journal as retryable', () => {
  const file = join(rootDir(), 'host.sqlite');
  open(file, 'a').close(); ledgers.pop();
  const journal = Buffer.alloc(1024); Buffer.from('d9d505f920a163d7', 'hex').copy(journal);
  fs.writeFileSync(file + '-journal', journal);
  expect(readHostLedger(file)).toMatchObject({ kind: 'retryable', code: 'hot_journal' });
});

it('reads a ledger that also holds another layer format', () => {
  const file = join(rootDir(), 'host.sqlite');
  set(open(file, 'a', { expectedFormats: { k8: 3 } }), 1);
  expect(tenants(readHostLedger(file))).toMatchObject([{ tenant: 'a', ok: true, state: { application: { n: 1 } } }]);
});

it('refuses a ledger without K4 format 1', () => {
  const root = rootDir(), file = join(root, 'host.sqlite'), unversioned = join(root, 'old.sqlite');
  open(file, 'a').close(); ledgers.pop();
  sql(file, "UPDATE host_store_format SET version=2 WHERE owner='k4'");
  sql(unversioned, "CREATE TABLE host_ledger (tenant TEXT PRIMARY KEY, body TEXT NOT NULL); INSERT INTO host_ledger VALUES ('a', '{}')");
  expect(readHostLedger(file)).toMatchObject({ kind: 'unreadable', code: 'format_unsupported' });
  expect(readHostLedger(unversioned)).toMatchObject({ kind: 'unreadable', code: 'format_unsupported' });
});

it('reports a path that is not a ledger file as unreadable', () => {
  const root = rootDir(), junk = join(root, 'junk'), damaged = join(root, 'damaged.sqlite');
  fs.writeFileSync(junk, 'not a database '.repeat(10));
  open(damaged, 'a').close(); ledgers.pop();
  const bytes = fs.readFileSync(damaged); bytes.fill(0xff, 100, 112); fs.writeFileSync(damaged, bytes);
  expect(readHostLedger(root)).toMatchObject({ kind: 'unreadable', code: 'not_a_file' });
  expect(readHostLedger(junk)).toMatchObject({ kind: 'unreadable', code: 'not_sqlite' });
  expect(readHostLedger(damaged)).toMatchObject({ kind: 'unreadable', code: 'corrupt' });
});

it.runIf(posix && process.getuid?.() !== 0)('reports a ledger it cannot read as unreadable', () => {
  const file = join(rootDir(), 'host.sqlite');
  open(file, 'a').close(); ledgers.pop();
  fs.chmodSync(file, 0o000);
  try { expect(readHostLedger(file)).toMatchObject({ kind: 'unreadable', code: 'open_failed' }); }
  finally { fs.chmodSync(file, 0o644); }
});
