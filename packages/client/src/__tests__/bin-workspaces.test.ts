import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkspacesCommand } from '../bin/commands/workspaces';
import { GitWorkspaceStore, type GitWorkspaceLedgerRecord } from '../daemon/git-workspace-store';
import type { DaemonConfig } from '../index';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-bin-workspaces-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function config(storeDir: string): DaemonConfig {
  return {
    productName: 'Acme',
    productId: 'acme-product',
    serverUrl: 'http://example.invalid',
    workspaceRoot: '/unused',
    storeDir,
  };
}

function record(): GitWorkspaceLedgerRecord {
  return {
    workspaceId: 'workspace-opaque',
    taskId: 'task-opaque',
    workspaceDir: '/private/user/source/repository',
    phase: 'failed',
    baseline: '0123456789abcdef0123456789abcdef01234567',
    current: 'fedcba9876543210fedcba9876543210fedcba98',
    commitsSinceBaseline: 3,
    staged: 1,
    unstaged: 2,
    untracked: 4,
    conflicted: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    errorCategory: 'repository-invalid',
  };
}

describe('bin/commands/workspaces: runWorkspacesCommand', () => {
  it('treats a missing ledger as empty without creating it', async () => {
    const storeDir = await tempDir();
    const { lines, log } = collectLog();

    await runWorkspacesCommand(config(storeDir), { log });

    expect(lines).toEqual(['(no workspaces recorded)']);
    await expect(fs.stat(path.join(storeDir, 'git-workspaces.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hides private workspace paths by default while rendering the recovery fields', async () => {
    const storeDir = await tempDir();
    const store = new GitWorkspaceStore(storeDir);
    await store.initialize();
    await store.upsert(record());
    const before = await fs.readFile(store.filePath, 'utf8');
    const { lines, log } = collectLog();

    await runWorkspacesCommand(config(storeDir), { log });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('taskId=task-opaque');
    expect(lines[0]).toContain('workspaceId=workspace-opaque');
    expect(lines[0]).toContain('phase=failed');
    expect(lines[0]).toContain('baseline=01234567');
    expect(lines[0]).toContain('current=fedcba98');
    expect(lines[0]).toContain('commits=3');
    expect(lines[0]).toContain('dirty=1/2/4/5');
    expect(lines[0]).toContain('updatedAt=');
    expect(lines[0]).toContain('error=repository-invalid');
    expect(lines[0]).not.toContain(record().workspaceDir);
    expect(await fs.readFile(store.filePath, 'utf8')).toBe(before);
  });

  it('requires an explicit local flag to disclose workspace paths', async () => {
    const storeDir = await tempDir();
    const store = new GitWorkspaceStore(storeDir);
    await store.initialize();
    await store.upsert(record());
    const { lines, log } = collectLog();

    await runWorkspacesCommand(config(storeDir), { log, showPaths: true });

    expect(lines[0]).toContain(`path=${record().workspaceDir}`);
  });

  it('renders only stable error categories and never raw diagnostics', async () => {
    const store = { list: async () => [{ ...record(), errorCategory: 'raw git stderr: secret' } as unknown as GitWorkspaceLedgerRecord] };
    const { lines, log } = collectLog();

    await runWorkspacesCommand(config('/unused'), { log, store });

    expect(lines[0]).not.toContain('raw git stderr');
    expect(lines[0]).not.toContain('secret');
  });

  it('propagates stable corrupt and future-version ledger failures without raw diagnostics', async () => {
    const storeDir = await tempDir();
    const ledgerPath = path.join(storeDir, 'git-workspaces.json');
    const log = vi.fn();
    await fs.writeFile(ledgerPath, '{not-json');
    await expect(runWorkspacesCommand(config(storeDir), { log })).rejects.toThrow('git workspace ledger is corrupt');
    expect(log).not.toHaveBeenCalled();

    await fs.writeFile(ledgerPath, JSON.stringify({ version: 99, records: [] }));
    await expect(runWorkspacesCommand(config(storeDir), { log })).rejects.toThrow('git workspace ledger version is unsupported or invalid');
  });
});

function collectLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}
