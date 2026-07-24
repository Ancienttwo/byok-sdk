import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspaceStore, type GitWorkspaceLedgerRecord } from '../daemon/git-workspace-store';

const dirs: string[] = [];
async function tempDir(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-git-store-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
function record(i: number, phase: GitWorkspaceLedgerRecord['phase'] = 'completed'): GitWorkspaceLedgerRecord {
  const now = new Date(0).toISOString();
  return { workspaceId: `w-${i}`, taskId: `t-${i}`, workspaceDir: `/private/${i}`, phase, commitsSinceBaseline: i, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, createdAt: now, updatedAt: now };
}

describe('GitWorkspaceStore', () => {
  it('writes a secure versioned ledger atomically and serializes updates', async () => {
    const dir = await tempDir();
    const store = new GitWorkspaceStore(dir, { maxRecords: 20 });
    await store.initialize();
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.upsert(record(i))));
    expect((await store.list())).toHaveLength(10);
    const file = await fs.stat(path.join(dir, 'git-workspaces.json'));
    if (process.platform !== 'win32') expect(file.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'git-workspaces.json'), 'utf8')) as { version: number };
    expect(parsed.version).toBe(1);
  });

  it('fails closed for corrupt and future-version ledgers', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'git-workspaces.json');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, '{broken');
    await expect(new GitWorkspaceStore(dir).list()).rejects.toThrow(/corrupt/);
    await fs.writeFile(file, JSON.stringify({ version: 99, records: [] }));
    await expect(new GitWorkspaceStore(dir).list()).rejects.toThrow(/unsupported/);
  });

  it('retains active/interrupted/salvage records and reconciles active records', async () => {
    const dir = await tempDir();
    const store = new GitWorkspaceStore(dir, { maxRecords: 2 });
    await store.initialize();
    await store.upsert(record(1, 'active'));
    await store.upsert(record(2, 'salvage'));
    await store.upsert(record(3, 'completed'));
    await store.reconcile();
    const values = await store.list();
    expect(values.find((value) => value.workspaceId === 'w-1')?.phase).toBe('interrupted');
    expect(values.find((value) => value.workspaceId === 'w-2')?.phase).toBe('salvage');
    expect(values.find((value) => value.workspaceId === 'w-3')).toBeUndefined();
    expect(values).toHaveLength(2);
  });
});
