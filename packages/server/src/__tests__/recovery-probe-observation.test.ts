import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';

// Importing the standalone probe does not run its OS-enrollment CLI. These
// checks use the actual SQLite server, without pairing or touching Keychain.
const probeUrl = new URL('./recovery-probe/probe.mjs', import.meta.url).href;
const { createObservedServer } = await import(probeUrl);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function options() {
  const root = mkdtempSync(join(tmpdir(), 'byok-probe-owner-'));
  roots.push(root);
  return { productId: 'probe-owner', storage: { kind: 'sqlite', path: join(root, 'server.sqlite') } };
}

it('reads the real owner while a second reader is excluded, then invalidates the captured handle on close', async () => {
  const input = options();
  const prepare = DatabaseSync.prototype.prepare;
  const observed = await createObservedServer(input);
  expect(DatabaseSync.prototype.prepare).toBe(prepare);
  const reader = new DatabaseSync(input.storage.path, { readOnly: true });
  try {
    expect(() => reader.prepare('SELECT COUNT(*) AS n FROM task_attempt').get()).toThrow(/locked/);
    expect(observed.select('SELECT COUNT(*) AS n FROM task_attempt')).toEqual([{ n: 0 }]);
  } finally { reader.close(); await observed.byok.close(); }
  expect(() => observed.select('SELECT 1')).toThrow('owner handle is closed');
  const released = new DatabaseSync(input.storage.path, { readOnly: true });
  try { expect(released.prepare('SELECT COUNT(*) AS n FROM task_attempt').get()).toEqual({ n: 0 }); }
  finally { released.close(); }
});

it('refuses a live observation inside an uncommitted owner transaction', async () => {
  const observed = await createObservedServer(options());
  try {
    observed.select('BEGIN');
    expect(() => observed.select('SELECT 1')).toThrow('observe committed state');
  } finally { await observed.byok.close(); }
});

it('restores the native method when server construction fails', async () => {
  const input = options();
  const foreign = new DatabaseSync(input.storage.path);
  foreign.exec('CREATE TABLE not_byok (id INTEGER)');
  foreign.close();
  const prepare = DatabaseSync.prototype.prepare;
  await expect(createObservedServer(input)).rejects.toThrow('metadata');
  expect(DatabaseSync.prototype.prepare).toBe(prepare);
  const released = new DatabaseSync(input.storage.path);
  try { expect(released.prepare('SELECT COUNT(*) AS n FROM not_byok').get()).toEqual({ n: 0 }); }
  finally { released.close(); }
});
