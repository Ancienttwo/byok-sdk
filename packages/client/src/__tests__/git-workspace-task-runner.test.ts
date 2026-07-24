import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { GitWorkspaceManager, type GitWorkspaceObservation, type GitWorkspaceLease } from '../daemon/git-workspace';
import { GitWorkspaceStore } from '../daemon/git-workspace-store';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type { Session, TaskContext } from '../types';
import { StubRuntimeAdapter, StubSession } from './fixtures/stub-adapter';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
}
const blobClient: BlobResolver = {
  resolveInstruction: async (ref) => `blob:${ref}`,
  uploadArtifact: async () => ({ blobId: 'blob', contentHash: `sha256:${'0'.repeat(64)}`, contentType: 'text/plain', size: 1 }),
};
function payload(instruction = 'do work', sessionRef?: string) {
  return { instruction, policy: { mode: 'auto' as const }, ...(sessionRef ? { sessionRef } : {}) };
}
function envelope(_name: string, taskId: string, p: ReturnType<typeof payload> | { reason?: string }): Envelope {
  const type = 'reason' in p ? 'task.cancel' : 'task.offer';
  return createEnvelope(type, p as never, { taskId, seq: 1 });
}
async function makeDeps(options: {
  enabled?: boolean;
  adapter?: StubRuntimeAdapter;
  manager?: GitWorkspaceManager;
  store?: GitWorkspaceStore;
  sent?: Envelope[];
  events?: Array<Record<string, unknown>>;
} = {}): Promise<{ deps: TaskRunnerDeps; root: string; sessionStore: SessionWorkspaceStore; store?: GitWorkspaceStore }> {
  const root = await tempDir('byok-taskrunner-git-root-');
  const storeDir = await tempDir('byok-taskrunner-git-store-');
  const sessionStore = new SessionWorkspaceStore(storeDir);
  const sent = options.sent ?? [];
  const events = options.events ?? [];
  const store = options.enabled ? (options.store ?? new GitWorkspaceStore(storeDir)) : undefined;
  if (store) await store.initialize();
  const manager = options.enabled ? (options.manager ?? new GitWorkspaceManager(root, { ownerId: `test-${Math.random()}` })) : undefined;
  if (manager) await manager.preflight();
  const deps: TaskRunnerDeps = {
    adapters: [options.adapter ?? new StubRuntimeAdapter()],
    workspaceRoot: root,
    deviceId: 'device',
    send: (e) => sent.push(e),
    blobClient,
    sessionWorkspaces: sessionStore,
    ...(manager ? { gitWorkspaceManager: manager } : {}),
    ...(store ? { gitWorkspaceStore: store } : {}),
    onGitWorkspaceEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'product',
  };
  return { deps, root, sessionStore, ...(store ? { store } : {}) };
}
function terminal(sent: Envelope[], taskId: string): Envelope[] {
  return sent.filter((e) => e.task_id === taskId && ['task.complete', 'task.fail', 'task.cancelled'].includes(e.type));
}
async function waitForAssertion(assertion: () => void, timeoutMs = 1_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() <= deadline);
  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for assertion');
}

 describe('TaskRunner local Git workspace lifecycle', () => {
  afterEach(cleanup);

  it('keeps disabled mode legacy and performs no Git work', async () => {
    const sent: Envelope[] = [];
    const adapter = new StubRuntimeAdapter();
    const { deps, sessionStore, root } = await makeDeps({ adapter, sent });
    const runner = new TaskRunner(deps);
    await runner.handleEnvelope(envelope('task.offer', 'plain', payload()));
    expect(adapter.startCalls[0]?.ctx.gitWorkspace).toBeUndefined();
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(path.join(root, 'plain'));
    expect(sent.map((e) => e.type)).toContain('task.claim');
    expect(sent.some((e) => JSON.stringify(e).includes('workspaceId'))).toBe(false);
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await waitForAssertion(() => expect(terminal(sent, 'plain')).toHaveLength(1));
    const known = await sessionStore.get(adapter.sessions[0]!.sessionRef);
    expect(known?.workspaceDir).toBe(path.join(root, 'plain'));
  });

  it('acquires before claim, records preparing then active, and prepends guidance once', async () => {
    const sent: Envelope[] = [];
    const events: Array<Record<string, unknown>> = [];
    const { deps, store } = await makeDeps({ enabled: true, sent, events });
    const adapter = deps.adapters[0] as StubRuntimeAdapter;
    await new TaskRunner(deps).handleEnvelope(envelope('task-1', 'task-1', payload('instruction')));
    expect(sent.findIndex((e) => e.type === 'task.claim')).toBeGreaterThanOrEqual(0);
    expect(events.map((e) => e.phase)).toEqual(['preparing', 'active']);
    expect(adapter.startCalls[0]?.task.instruction).toBe(`Work only in the provided workspace directory.\nInspect git status before and after edits.\nWhen Git identity is already configured, create small ordinary checkpoint commits after coherent, verified units.\nDo not change Git identity.\nDo not push, merge, rebase, stash, reset, clean, switch branches, or delete work.\nLeave incomplete work visible for recovery.\n\ninstruction`);
    expect(adapter.startCalls[0]?.task.instruction).not.toContain('Work only in the provided workspace directory.\nWork only in the provided workspace directory.');
    const records = await store!.list();
    expect(records[0]?.phase).toBe('active');
    adapter.sessions[0]!.emit({ type: 'turn_end' });
  });

  it('requires matching resume records and validates existing repositories without fresh preparation', async () => {
    const sent: Envelope[] = [];
    const manager = { preflight: vi.fn(), acquireLease: vi.fn(), validateExisting: vi.fn(), prepareFresh: vi.fn() } as unknown as GitWorkspaceManager;
    const { deps, sessionStore, store, root } = await makeDeps({ enabled: true, manager, sent });
    const workspaceDir = path.join(root, 'existing');
    await fs.mkdir(workspaceDir, { recursive: true });
    const id = 'opaque-id';
    await sessionStore.record('resume', { workspaceDir, runtimeSessionId: 'old', workspaceKind: 'git', gitWorkspaceId: id });
    const now = new Date().toISOString();
    await store!.upsert({ workspaceId: id, taskId: 'old', workspaceDir, sessionRef: 'resume', phase: 'completed', commitsSinceBaseline: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, createdAt: now, updatedAt: now });
    const lease = { workspaceDir, sessionRef: 'resume', release: vi.fn() } as unknown as GitWorkspaceLease;
    (manager.acquireLease as ReturnType<typeof vi.fn>).mockResolvedValue(lease);
    (manager.validateExisting as ReturnType<typeof vi.fn>).mockResolvedValue({ workspaceDir, headChanged: false, commitsSinceBaseline: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    const adapter = deps.adapters[0] as StubRuntimeAdapter;
    await new TaskRunner(deps).handleEnvelope(envelope('task-resume', 'task-resume', payload('resume', 'resume')));
    expect(manager.validateExisting).toHaveBeenCalled();
    expect(manager.prepareFresh).not.toHaveBeenCalled();
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(workspaceDir);
    expect(adapter.startCalls[0]?.ctx.gitWorkspace?.workspaceId).toBe(id);
    adapter.sessions[0]!.emit({ type: 'turn_end' });
  });

  it('rejects interrupted workspace revival under the old protocol task ID', async () => {
    const sent: Envelope[] = [];
    const { deps, sessionStore, store, root } = await makeDeps({ enabled: true, sent });
    const workspaceDir = path.join(root, 'interrupted-old');
    const observation = await deps.gitWorkspaceManager!.prepareFresh(workspaceDir);
    const workspaceId = 'interrupted-old-id';
    const now = new Date().toISOString();
    await sessionStore.record('interrupted-old-session', {
      workspaceDir,
      runtimeSessionId: 'old-runtime-session',
      workspaceKind: 'git',
      gitWorkspaceId: workspaceId,
    });
    await store!.upsert({
      workspaceId,
      taskId: 'interrupted-old-task',
      workspaceDir,
      sessionRef: 'interrupted-old-session',
      phase: 'interrupted',
      baseline: observation.head,
      current: observation.head,
      commitsSinceBaseline: observation.commitsSinceBaseline,
      staged: observation.staged,
      unstaged: observation.unstaged,
      untracked: observation.untracked,
      conflicted: observation.conflicted,
      createdAt: now,
      updatedAt: now,
    });

    const adapter = deps.adapters[0] as StubRuntimeAdapter;
    await new TaskRunner(deps).handleEnvelope(
      envelope('old-revival', 'interrupted-old-task', payload('continue old task', 'interrupted-old-session')),
    );

    expect(sent.some((entry) => entry.type === 'task.decline' && entry.task_id === 'interrupted-old-task')).toBe(true);
    expect(sent.some((entry) => entry.type === 'task.claim' && entry.task_id === 'interrupted-old-task')).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('redispatches a new task ID into a matching interrupted workspace', async () => {
    const sent: Envelope[] = [];
    const { deps, sessionStore, store, root } = await makeDeps({ enabled: true, sent });
    const workspaceDir = path.join(root, 'interrupted-new');
    const observation = await deps.gitWorkspaceManager!.prepareFresh(workspaceDir);
    const workspaceId = 'interrupted-new-id';
    const sessionRef = 'interrupted-new-session';
    const now = new Date().toISOString();
    await sessionStore.record(sessionRef, {
      workspaceDir,
      runtimeSessionId: 'old-runtime-session',
      workspaceKind: 'git',
      gitWorkspaceId: workspaceId,
    });
    await store!.upsert({
      workspaceId,
      taskId: 'interrupted-old-task',
      workspaceDir,
      sessionRef,
      phase: 'interrupted',
      baseline: observation.head,
      current: observation.head,
      commitsSinceBaseline: observation.commitsSinceBaseline,
      staged: observation.staged,
      unstaged: observation.unstaged,
      untracked: observation.untracked,
      conflicted: observation.conflicted,
      createdAt: now,
      updatedAt: now,
    });

    const adapter = deps.adapters[0] as StubRuntimeAdapter;
    const newTaskId = 'interrupted-new-task';
    await new TaskRunner(deps).handleEnvelope(envelope('new-redispatch', newTaskId, payload('resume work', sessionRef)));

    expect(sent.some((entry) => entry.type === 'task.claim' && entry.task_id === newTaskId)).toBe(true);
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(workspaceDir);
    expect(adapter.startCalls[0]?.ctx.gitWorkspace?.workspaceId).toBe(workspaceId);
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await waitForAssertion(() => expect(terminal(sent, newTaskId)).toHaveLength(1));
  });

  it('declines resume mismatches and busy workspaces before claim', async () => {
    const sent: Envelope[] = [];
    const { deps, sessionStore, store, root } = await makeDeps({ enabled: true, sent });
    await sessionStore.record('mismatch', { workspaceDir: path.join(root, 'x'), runtimeSessionId: 'x', workspaceKind: 'git', gitWorkspaceId: 'wrong' });
    const runner = new TaskRunner(deps);
    await runner.handleEnvelope(envelope('mismatch-task', 'mismatch-task', payload('x', 'mismatch')));
    expect(sent.some((e) => e.type === 'task.decline')).toBe(true);
    expect(sent.some((e) => e.type === 'task.claim')).toBe(false);
    const busy = await deps.gitWorkspaceManager!.acquireLease(path.join(root, 'busy-task'), 'busy');
    await runner.handleEnvelope(envelope('busy-task', 'busy-task', payload()));
    busy.release();
    expect(sent.filter((e) => e.type === 'task.claim')).toHaveLength(0);
  });

  it('releases lease on preparation, blob, adapter-start, and cancel-during-start exits', async () => {
    const cases: Array<'prepare' | 'blob' | 'start' | 'cancel'> = ['prepare', 'blob', 'start', 'cancel'];
    for (const kind of cases) {
      const sent: Envelope[] = [];
      const adapter = new StubRuntimeAdapter();
      if (kind === 'start') adapter.startError = new Error('start');
      const manager = new GitWorkspaceManager(await tempDir(`manager-${kind}-`), { ownerId: `${kind}-${Date.now()}` });
      await manager.preflight();
      if (kind === 'prepare') vi.spyOn(manager, 'prepareFresh').mockRejectedValue(new Error('prep'));
      if (kind === 'blob') {
        const { deps } = await makeDeps({ enabled: true, adapter, sent });
        deps.blobClient.resolveInstruction = async () => { throw new Error('blob'); };
        await new TaskRunner(deps).handleEnvelope(envelope(`task-${kind}`, `task-${kind}`, { instruction: { blobRef: { blobId: 'ref', contentHash: `sha256:${'0'.repeat(64)}`, contentType: 'text/plain', size: 1 } }, policy: { mode: 'auto' } } as never));
        expect(sent.some((e) => e.type === 'task.fail')).toBe(true);
        continue;
      }
      const { deps, store } = await makeDeps({ enabled: true, manager, adapter, sent });
      const runner = new TaskRunner(deps);
      const offer = runner.handleEnvelope(envelope(`task-${kind}`, `task-${kind}`, payload()));
      if (kind === 'cancel') {
        await waitForAssertion(() => expect(sent.some((e) => e.type === 'task.claim')).toBe(true));
        await runner.handleEnvelope(envelope('task.cancel', 'task-cancel', { reason: 'stop' }));
      }
      await offer;
      expect(sent.some((e) => ['task.fail', 'task.cancelled'].includes(e.type))).toBe(true);
      const records = await store!.list();
      expect(records.every((record) => !['preparing', 'active'].includes(record.phase))).toBe(true);
      const lease = await deps.gitWorkspaceManager!.acquireLease(path.join(deps.workspaceRoot, `task-${kind}`));
      lease.release();
    }
  });

  it('observes before complete, tolerates observation degradation, and keeps wire envelopes Git-free', async () => {
    const sent: Envelope[] = [];
    const deps = (await makeDeps({ enabled: true, sent })).deps;
    const adapter = deps.adapters[0] as StubRuntimeAdapter;
    const observe = vi.spyOn(deps.gitWorkspaceManager!, 'observe');
    await new TaskRunner(deps).handleEnvelope(envelope('complete', 'complete', payload()));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await waitForAssertion(() => expect(terminal(sent, 'complete')).toHaveLength(1));
    expect(observe).toHaveBeenCalled();
    for (const e of sent) expect(JSON.stringify(e)).not.toContain('gitWorkspace');
    const adapter2 = new StubRuntimeAdapter();
    const built2 = await makeDeps({ enabled: true, adapter: adapter2, sent });
    const deps2 = built2.deps;
    const observe2 = vi.spyOn(deps2.gitWorkspaceManager!, 'observe');
    const runner2 = new TaskRunner(deps2);
    await runner2.handleEnvelope(envelope('degraded', 'degraded', payload()));
    await waitForAssertion(() => expect(adapter2.startCalls).toHaveLength(1));
    observe2.mockRejectedValue(new Error('degraded'));
    adapter2.sessions[0]!.emit({ type: 'turn_end' });
    await waitForAssertion(() => expect(terminal(sent, 'degraded')).toHaveLength(1));
    const degradedRecords = await built2.store!.list();
    expect(degradedRecords?.every((record) => !['preparing', 'active'].includes(record.phase))).toBe(true);
  });

  it('keeps registration synchronous and consumes cancel during start', async () => {
    const sent: Envelope[] = [];
    const adapter = new StubRuntimeAdapter();
    const release = adapter.blockStart();
    const { deps } = await makeDeps({ enabled: true, adapter, sent });
    const runner = new TaskRunner(deps);
    const offer = runner.handleEnvelope(envelope('race', 'race', payload()));
    await waitForAssertion(() => expect(sent.some((e) => e.type === 'task.claim')).toBe(true));
    await runner.handleEnvelope(envelope('task.cancel', 'race', { reason: 'cancel' }));
    release();
    await offer;
    expect(terminal(sent, 'race').map((e) => e.type)).toEqual(['task.cancelled']);
    expect(sent.some((e) => e.type === 'task.started')).toBe(false);
  });
});
