import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonOverrides } from '../daemon/create-daemon';
import { GitWorkspaceManager, type GitCommandResult, type GitRunner } from '../daemon/git-workspace';
import { GitWorkspaceStore } from '../daemon/git-workspace-store';
import type { DaemonEvent } from '../daemon/observer';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function baseConfig(serverUrl: string, workspaceRoot: string, storeDir: string) {
  return {
    productName: 'Git startup integration test',
    productId: `git-startup-${Math.random().toString(36).slice(2)}`,
    serverUrl,
    workspaceRoot,
    storeDir,
  };
}

function fakeGitRunner(onCall?: (args: readonly string[]) => void): GitRunner {
  return async (args, options): Promise<GitCommandResult> => {
    onCall?.(args);
    const command = args[0];
    if (command === '--version') return { code: 0, stdout: 'git version test', stderr: '' };
    if (command === 'init') return { code: 0, stdout: '', stderr: '' };
    if (command === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: `${options?.cwd}\n`, stderr: '' };
    if (command === 'rev-parse' && args[1] === '--verify') return { code: 1, stdout: '', stderr: '' };
    if (command === 'status') return { code: 0, stdout: '', stderr: '' };
    if (command === 'rev-list') return { code: 0, stdout: '0\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function daemonOverrides(manager: GitWorkspaceManager, store: GitWorkspaceStore): DaemonOverrides {
  return { gitWorkspace: { manager, store } };
}

describe('daemon Git workspace startup/local-event boundary', () => {
  let server: TestServer | undefined;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server?.close();
    server = undefined;
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('keeps Git completely inactive when gitWorkspace is absent and still starts normally', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tempDir('byok-git-startup-disabled-workspace-');
    const storeDir = await tempDir('byok-git-startup-disabled-store-');
    const gitRunner = vi.fn<GitRunner>(fakeGitRunner());
    const manager = new GitWorkspaceManager(workspaceRoot, { run: gitRunner, ownerId: `disabled-${process.pid}` });
    const store = new GitWorkspaceStore(storeDir);
    const preflight = vi.spyOn(manager, 'preflight');
    const initialize = vi.spyOn(store, 'initialize');
    const reconcile = vi.spyOn(store, 'reconcile');

    daemon = createDaemonWithAdapters(
      baseConfig(server.url, workspaceRoot, storeDir),
      [new StubRuntimeAdapter()],
      daemonOverrides(manager, store),
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    await server.waitFor((envelope) => envelope.type === 'conn.hello');
    expect(preflight).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(gitRunner).not.toHaveBeenCalled();
  });

  it('rejects enabled startup on Git preflight failure before transport hello or offers', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tempDir('byok-git-startup-failure-workspace-');
    const storeDir = await tempDir('byok-git-startup-failure-store-');
    const run: GitRunner = vi.fn(async (args) => {
      if (args[0] === '--version') {
        const error = Object.assign(new Error('git not found'), { code: 'ENOENT' });
        throw error;
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const manager = new GitWorkspaceManager(workspaceRoot, { run, ownerId: `failure-${process.pid}` });
    const store = new GitWorkspaceStore(storeDir);
    daemon = createDaemonWithAdapters(
      { ...baseConfig(server.url, workspaceRoot, storeDir), gitWorkspace: { mode: 'local-checkpoints' } },
      [new StubRuntimeAdapter()],
      daemonOverrides(manager, store),
    );
    await daemon.pair('pairing-code');

    await expect(daemon.start()).rejects.toMatchObject({ category: 'git-unavailable' });
    expect(server.received).toEqual([]);
    expect(server.httpRequests.some((request) => request.pathname === '/byok/messages')).toBe(false);
    expect(run).toHaveBeenCalledWith(['--version'], expect.objectContaining({ timeout: 5000, maxBuffer: expect.any(Number) }));
  });

  it('reconciles preparing/active ledger records to interrupted before transport is observable', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tempDir('byok-git-startup-reconcile-workspace-');
    const storeDir = await tempDir('byok-git-startup-reconcile-store-');
    const store = new GitWorkspaceStore(storeDir);
    await store.initialize();
    const now = new Date().toISOString();
    await store.upsert({
      workspaceId: 'workspace-preparing', taskId: 'task-preparing', workspaceDir: path.join(workspaceRoot, 'preparing'),
      phase: 'preparing', commitsSinceBaseline: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, createdAt: now, updatedAt: now,
    });
    await store.upsert({
      workspaceId: 'workspace-active', taskId: 'task-active', workspaceDir: path.join(workspaceRoot, 'active'),
      phase: 'active', commitsSinceBaseline: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, createdAt: now, updatedAt: now,
    });
    await store.upsert({
      workspaceId: 'workspace-complete', taskId: 'task-complete', workspaceDir: path.join(workspaceRoot, 'complete'),
      phase: 'completed', commitsSinceBaseline: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, createdAt: now, updatedAt: now,
    });

    const manager = new GitWorkspaceManager(workspaceRoot, { run: fakeGitRunner(), ownerId: `reconcile-${process.pid}` });
    const originalReconcile = store.reconcile.bind(store);
    const reconcile = vi.spyOn(store, 'reconcile').mockImplementation(async () => {
      expect(server?.received.some((envelope) => envelope.type === 'conn.hello')).toBe(false);
      await originalReconcile();
    });
    daemon = createDaemonWithAdapters(
      { ...baseConfig(server.url, workspaceRoot, storeDir), gitWorkspace: { mode: 'local-checkpoints' } },
      [new StubRuntimeAdapter()],
      daemonOverrides(manager, store),
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(server.waitFor((envelope) => envelope.type === 'conn.hello')).resolves.toBeDefined();
    await expect(store.get('workspace-preparing')).resolves.toMatchObject({ phase: 'interrupted' });
    await expect(store.get('workspace-active')).resolves.toMatchObject({ phase: 'interrupted' });
    await expect(store.get('workspace-complete')).resolves.toMatchObject({ phase: 'completed' });
  });

  it('emits Git workspace lifecycle events locally while keeping Git details out of protocol envelopes', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tempDir('byok-git-local-event-workspace-');
    const storeDir = await tempDir('byok-git-local-event-store-');
    const manager = new GitWorkspaceManager(workspaceRoot, { run: fakeGitRunner(), ownerId: `events-${process.pid}` });
    const store = new GitWorkspaceStore(storeDir);
    const adapter = new StubRuntimeAdapter();
    const events: DaemonEvent[] = [];
    daemon = createDaemonWithAdapters(
      { ...baseConfig(server.url, workspaceRoot, storeDir), gitWorkspace: { mode: 'local-checkpoints' } },
      [adapter],
      daemonOverrides(manager, store),
    );
    daemon.subscribe((event) => events.push(event));
    await daemon.pair('pairing-code');
    await daemon.start();

    server.send(createEnvelope(
      'task.offer',
      { instruction: 'perform local work', policy: { mode: 'auto' } },
      { taskId: 'git-event-task', seq: server.nextSeq() },
    ));
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === 'git-event-task');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete' && envelope.task_id === 'git-event-task');
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'git-workspace' && event.taskId === 'git-event-task' && event.phase === 'preparing')).toBe(true);
      expect(events.some((event) => event.kind === 'git-workspace' && event.taskId === 'git-event-task' && event.phase === 'active')).toBe(true);
      expect(events.some((event) => event.kind === 'git-workspace' && event.taskId === 'git-event-task' && event.phase === 'completed')).toBe(true);
    });

    const serializedReceived = JSON.stringify(server.received);
    expect(serializedReceived).not.toContain('git-workspace');
    expect(serializedReceived).not.toContain('workspaceId');
    expect(serializedReceived).not.toContain('gitWorkspace');
    expect(server.received.filter((envelope) => envelope.type === 'task.claim' || envelope.type === 'task.complete'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task.claim', task_id: 'git-event-task' }),
        expect.objectContaining({ type: 'task.complete', task_id: 'git-event-task' }),
      ]));
  });
});
