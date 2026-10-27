import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, SqliteSchemaError, WakeHookMissingError, type DueWake } from '../index';

const childFixture = fileURLToPath(new URL('./fixtures/wake-owner.mjs', import.meta.url));
describe('file-backed wake authority and adoption', { timeout: 20000 }, () => {
  const roots: string[] = [], children: ChildProcess[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function file() { const root = mkdtempSync(join(tmpdir(), 'byok-wakes-')); roots.push(root); return join(root, 'server.sqlite'); }
  function open(path: string, consume: (wake: DueWake, signal: AbortSignal) => Promise<void> = async () => {}) {
    return createByokServer({ productId: 'wake-file', storage: { kind: 'sqlite', path }, wake: { consume } });
  }
  function child(path: string, mode: 'schedule' | 'reopen') {
    const processChild = spawn(process.execPath, ['--no-warnings', childFixture, path, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(processChild);
    const line = new Promise<{ kind: string; wake?: DueWake; name?: string; code?: string }>((resolve, reject) => {
      let buffer = '', stderr = '';
      // The unchanged EXCLUSIVE-open path can take multiple busy waits
      // (12.2s measured). Keep the existing ownership suite's 20s bound.
      const timeout = setTimeout(() => reject(new Error(`wake child did not report: ${stderr}`)), 20000);
      processChild.stderr!.on('data', chunk => { stderr += chunk; });
      processChild.stdout!.on('data', chunk => {
        buffer += chunk;
        const end = buffer.indexOf('\n'); if (end === -1) return;
        clearTimeout(timeout); resolve(JSON.parse(buffer.slice(0, end)));
      });
      processChild.once('error', error => { clearTimeout(timeout); reject(error); });
      processChild.once('exit', code => { clearTimeout(timeout); reject(new Error(`wake child exited ${code}: ${stderr}`)); });
    });
    return { processChild, line };
  }
  async function cleanClose(processChild: ChildProcess) {
    const exit = once(processChild, 'exit');
    processChild.stdin!.write('close\n');
    let timer!: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wake child did not exit after close')), 10000); })]);
      expect(result).toEqual([0, null]);
    } finally { clearTimeout(timer); }
  }
  it('SIGKILL replays committed delivery as #2 while the Host occurrence ledger remains one execution', async () => {
    const path = file(); const first = child(path, 'schedule'); const a = await first.line;
    expect(a).toMatchObject({ kind: 'delivery', wake: { dedupKey: 'occurrence', delivery: 1, payload: 'host-reference' } });
    const exit = once(first.processChild, 'exit'); first.processChild.kill('SIGKILL'); await exit;
    const second = child(path, 'reopen'); const b = await second.line;
    expect(b).toMatchObject({ kind: 'delivery', wake: { wakeId: a.wake!.wakeId, availableAt: a.wake!.availableAt, delivery: 2 } });
    await cleanClose(second.processChild);
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('SELECT state, deliveries FROM wake').get()).toEqual({ state: 'queued', deliveries: 2 }); } finally { db.close(); }
    const ledger = new DatabaseSync(`${path}.host`, { readOnly: true });
    try { expect(ledger.prepare('SELECT * FROM occurrence').all()).toEqual([{ dedup_key: 'occurrence', execution_id: 'execution-one' }]); } finally { ledger.close(); }
  });
  it('a second process gets SqliteOwnershipError without delivering', async () => {
    const path = file(); const owner = child(path, 'schedule'); await owner.line;
    const contender = child(path, 'reopen');
    expect(await contender.line).toEqual({ kind: 'refused', name: 'SqliteOwnershipError', code: 'SQLITE_DATABASE_OWNED' });
    await cleanClose(owner.processChild);
  });
  it('close aborts an unfinished delivery, rejects hook writes, and reopen delivers #2', async () => {
    const path = file(); let delivered!: () => void; const begun = new Promise<void>(r => { delivered = r; });
    let late: Promise<unknown> | undefined; let signal!: AbortSignal;
    const first = open(path, async (_, current) => {
      signal = current;
      current.addEventListener('abort', () => { late = first.wakes.schedule({ dedupKey: 'late', availableAt: Date.now() }).catch(error => error); });
      delivered(); await new Promise(() => {});
    });
    await first.wakes.schedule({ dedupKey: 'close', availableAt: Date.now() - 1 }); await begun;
    await first.close(); expect(signal.aborted).toBe(true); expect(late).toBeDefined(); expect((await late as Error).name).toBe('WakeClosedError');
    let recovered!: (wake: DueWake) => void; const replay = new Promise<DueWake>(r => { recovered = r; });
    const second = open(path, async wake => { recovered(wake); });
    try { expect(await replay).toMatchObject({ dedupKey: 'close', delivery: 2 }); } finally { await second.close(); }
  });
  it('missing hook rejects queued reopen and releases ownership; done-only reopen needs no hook', async () => {
    const path = file(); const first = open(path);
    await first.wakes.schedule({ dedupKey: 'future', availableAt: Date.now() + 86400000 }); await first.close();
    expect(() => createByokServer({ productId: 'wake-file', storage: { kind: 'sqlite', path } })).toThrow(WakeHookMissingError);
    const next = open(path); expect((await next.wakes.pending())[0]).toMatchObject({ dedupKey: 'future', deliveries: 0 });
    expect(await next.wakes.cancel('future')).toBe(true); await next.close();
    const noHook = createByokServer({ productId: 'wake-file', storage: { kind: 'sqlite', path } }); await noHook.close();
  });
  async function legacy4(path: string) {
    await open(path).close();
    const db = new DatabaseSync(path);
    try {
      db.exec("DROP TABLE wake; UPDATE byok_sqlite_meta SET value = '4' WHERE key = 'schema_version'; INSERT INTO request_receipt VALUES ('product:wake-file', 'preserved', '{\"exact\":true}', '2026-01-01T00:00:00.000Z')");
    } finally { db.close(); }
  }
  it('refuses v4 without changing receipts, claim columns or creating a wake authority', async () => {
    const path = file(); await legacy4(path);
    const before = new DatabaseSync(path, { readOnly: true });
    const receipt = before.prepare('SELECT * FROM request_receipt').all();
    const columns = before.prepare('PRAGMA table_info(task_attempt)').all(); before.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '4', requiredVersion: '6' }));
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('4');
      expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'wake'").get()).toBeUndefined();
      expect(after.prepare('SELECT * FROM request_receipt').all()).toEqual(receipt);
      expect(after.prepare('PRAGMA table_info(task_attempt)').all()).toEqual(columns);
    } finally { after.close(); }
  });
  it('refuses a current database with missing wake authority and old target-v4 selectors', async () => {
    const path = file(); await open(path).close();
    expect(() => createByokServer({ productId: 'wake-file', storage: { kind: 'sqlite', path, ...{ migration: 'v3-to-v4' } } })).toThrow('migration selectors are not supported');
    const db = new DatabaseSync(path); db.exec('DROP TABLE wake'); db.close();
    expect(() => open(path)).toThrow(SqliteSchemaError);
    const check = new DatabaseSync(path, { readOnly: true });
    try { expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'wake'").get()).toBeUndefined(); } finally { check.close(); }
  });
});
