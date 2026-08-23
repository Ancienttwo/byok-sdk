import { promises as fs } from 'node:fs';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import {
  AgentHomeBusyError,
  AgentHomeLayout,
  AgentHomeLeaseManager,
  AgentHomeManager,
  createAgentHomeProjection,
  validateAgentRef,
} from '../agent-home';
import { AgentSessionHandoffStore, AgentSessionHandoffMismatchError } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { sealRuntimeOperationManifest } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';

const RUNTIME_FIXTURES = {
  pi: fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url)),
  claude: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
  codex: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
} as const;

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-home-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function ref(agentId: string, profileRevision = 'profile-1') {
  return { agentId, profileRevision } as const;
}

describe('SDK-owned Agent home contract', () => {
  it('rejects traversal, absolute, malformed, and oversized AgentRef segments', () => {
    expect(() => validateAgentRef(ref('../escape'))).toThrow();
    expect(() => validateAgentRef(ref('/absolute'))).toThrow();
    expect(() => validateAgentRef(ref('C:\\absolute'))).toThrow();
    expect(() => validateAgentRef(ref('a/b'))).toThrow();
    expect(() => validateAgentRef(ref('.'))).toThrow();
    expect(() => validateAgentRef(ref('..'))).toThrow();
    expect(() => validateAgentRef(ref(''))).toThrow();
    expect(() => validateAgentRef(ref('agent', ''))).toThrow();
    expect(() => validateAgentRef(ref('agent', 'revision\u0000'))).toThrow();
    expect(() => validateAgentRef(ref('é'.repeat(100)))).toThrow();
  });

  it('is the sole composer of hostStorageRoot/agents/agentId and rejects symlink escape', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    expect(() => new AgentHomeLayout('relative/root')).toThrow(/absolute/);

    const layout = new AgentHomeLayout(root);
    const resolved = await layout.resolve(ref('one'));
    expect(resolved.canonicalHome).toBe(path.join(await fs.realpath(root), 'agents', 'one'));
    expect(path.isAbsolute(resolved.canonicalHome)).toBe(true);

    const escape = path.join(root, 'agents', 'escape');
    await fs.symlink(outside, escape, 'dir');
    await expect(layout.resolve(ref('escape'))).rejects.toThrow(/real directory|escapes|outside|symlink/);

    const firstLayout = new AgentHomeLayout(root);
    const one = await firstLayout.resolve(ref('one'));
    await fs.symlink(one.canonicalHome, path.join(root, 'agents', 'two'), 'dir');
    const restartedLayout = new AgentHomeLayout(root);
    await expect(restartedLayout.resolve(ref('two'))).rejects.toThrow(/real directory|symlink/);
  });

  it('keeps one Agent home across profile revisions and different Agents isolated', async () => {
    const root = await makeRoot();
    const layout = new AgentHomeLayout(root);
    const first = await layout.resolve(ref('one', 'profile-1'));
    const revised = await layout.resolve(ref('one', 'profile-2'));
    const other = await layout.resolve(ref('two', 'profile-1'));
    expect(revised.canonicalHome).toBe(first.canonicalHome);
    expect(other.canonicalHome).not.toBe(first.canonicalHome);
  });

  it('initializes create-if-missing assets, preserves existing bytes, and leaves artifacts opaque', async () => {
    const root = await makeRoot();
    const projectedHomes: string[] = [];
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      projection: createAgentHomeProjection(async ({ cwd, agentRef }) => {
        projectedHomes.push(cwd);
        await fs.writeFile(
          path.join(cwd, 'profile.json'),
          JSON.stringify({ profileRevision: agentRef.profileRevision }),
          'utf8',
        );
      }),
    });
    const first = await manager.prepare(ref('one'));
    const home = first.resolution.canonicalHome;
    expect(first.lease.cwd).toBe(home);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('');
    expect((await fs.stat(path.join(home, 'notes'))).isDirectory()).toBe(true);
    await first.lease.release();

    await fs.writeFile(path.join(home, 'MEMORY.md'), 'preserved edit\n', 'utf8');
    await fs.writeFile(path.join(home, 'strategy.pdf'), 'opaque artifact bytes', 'utf8');
    const second = await manager.prepare(ref('one', 'profile-2'));
    await second.lease.release();

    expect(projectedHomes).toEqual([home, home]);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('preserved edit\n');
    expect(await fs.readFile(path.join(home, 'strategy.pdf'), 'utf8')).toBe('opaque artifact bytes');
    await expect(fs.stat(path.join(home, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces same-Agent single writer while different Agents remain independent', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const one = await manager.prepare(ref('one'));
    await expect(manager.prepare(ref('one', 'profile-2'))).rejects.toBeInstanceOf(AgentHomeBusyError);
    const two = await manager.prepare(ref('two'));
    await two.lease.release();
    await one.lease.release();
    const retry = await manager.prepare(ref('one', 'profile-2'));
    await retry.lease.release();
  });

  it('reclaims only exact daemon-owner crash residue and declines another owner', async () => {
    const root = await makeRoot();
    const ownerId = 'store-product:stable-owner';
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      leaseManager: new AgentHomeLeaseManager({ ownerId }),
    });
    const initial = await manager.prepare(ref('one'));
    const home = initial.resolution.canonicalHome;
    await initial.lease.release();
    const marker = path.join(home, '.byok', 'agent-home.lease');
    await fs.writeFile(marker, JSON.stringify({
      version: 1,
      ownerId,
      leaseId: 'crashed-lease',
      agentRef: ref('one'),
      canonicalHome: home,
    }), 'utf8');

    const restarted = await manager.prepare(ref('one'));
    await restarted.lease.release();
    await fs.writeFile(marker, JSON.stringify({
      version: 1,
      ownerId: 'store-product:another-owner',
      leaseId: 'live-lease',
      agentRef: ref('one'),
      canonicalHome: home,
    }), 'utf8');
    await expect(manager.prepare(ref('one'))).rejects.toBeInstanceOf(AgentHomeBusyError);
  });

  it('persists exact AgentRef/profileRevision/session/runtime/cwd and terminal cause in Agent home', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const binding = await manager.prepare(ref('one', 'profile-7'));
    const store = new AgentSessionHandoffStore();
    const identity = {
      agentRef: ref('one', 'profile-7'),
      sessionRef: 'session-1',
      runtimeId: 'pi',
      cwd: binding.resolution.canonicalHome,
    } as const;
    await store.record({ ...identity, taskId: 'task-1', leaseId: binding.lease.leaseId });
    await expect(store.requireMatch(identity)).resolves.toMatchObject(identity);
    await expect(store.requireMatch({ ...identity, agentRef: ref('one', 'profile-8') }))
      .rejects.toBeInstanceOf(AgentSessionHandoffMismatchError);
    await expect(store.requireMatch({ ...identity, runtimeId: 'codex' }))
      .rejects.toBeInstanceOf(AgentSessionHandoffMismatchError);
    await store.recordTerminal(identity, 'failed', 'runtime stopped');
    await binding.lease.release();

    const restarted = new AgentSessionHandoffStore();
    await expect(restarted.get(identity)).resolves.toMatchObject({
      ...identity,
      taskId: 'task-1',
      terminalCause: 'failed',
      terminalReason: 'runtime stopped',
    });
    await expect(restarted.history(identity)).resolves.toHaveLength(2);
    const evidenceDir = path.join(identity.cwd, '.byok', 'runtime-sessions');
    const [evidenceFile] = await fs.readdir(evidenceDir);
    await fs.writeFile(path.join(evidenceDir, evidenceFile!), '{broken', 'utf8');
    await expect(restarted.get(identity)).rejects.toThrow(/not valid JSON/);
  });

  it('seals exact AgentRef, canonical cwd and lease in an immutable runtime manifest', () => {
    const manifest = sealRuntimeOperationManifest({
      taskId: 'task-1',
      runtimeId: 'pi',
      descriptor: {
        id: 'pi',
        supportsDispatchSelection: false,
        capabilities: { steer: false, resume: true, approvalInteractive: false, permissionModes: ['auto'] },
        environmentRequirements: {},
      },
      policy: { mode: 'auto' },
      requiredToolsetIds: [],
      agentRef: ref('one', 'profile-1'),
      cwd: '/tmp/agent-home-one',
      lease: { leaseId: 'lease-1', canonicalHome: '/tmp/agent-home-one' },
      workspace: { workspaceDir: '/tmp/agent-home-one' },
      forwardedEnvironmentNames: [],
    });
    expect(manifest.cwd).toBe('/tmp/agent-home-one');
    expect(manifest.workspace.workspaceDir).toBe(manifest.cwd);
    expect(manifest.agentRef).toEqual(ref('one', 'profile-1'));
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.agentRef)).toBe(true);
    expect(Object.isFrozen(manifest.lease)).toBe(true);
  });

  it('passes the sealed canonical Agent home to the runtime adapter and persists terminal evidence', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const workspaceRoot = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const agentHome = new AgentHomeManager({ hostStorageRoot });
    const handoffs = new AgentSessionHandoffStore();
    const recordTerminal = handoffs.recordTerminal.bind(handoffs);
    const terminalEvidence = vi.spyOn(handoffs, 'recordTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.complete')).toBe(false);
      return recordTerminal(...args);
    });
    const blobClient: BlobResolver = {
      resolveInstruction: async () => { throw new Error('not used'); },
      uploadArtifact: async () => { throw new Error('not used'); },
    };
    const deps: TaskRunnerDeps = {
      adapters: [adapter],
      workspaceRoot,
      agentHome,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient,
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    };
    const runner = new TaskRunner(deps);
    const agentRef = ref('agent-runtime', 'profile-3');
    await runner.handleEnvelope(createEnvelope(
      'task.offer_for_agent',
      { instruction: 'run in the durable Agent home', policy: { mode: 'auto' }, runtime: 'pi', agentRef },
      { taskId: 'task-agent-runtime', seq: 1 },
    ));

    const expectedCwd = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(expectedCwd);
    expect(sent.find((entry) => entry.type === 'task.claim')?.payload).toMatchObject({ agentRef });
    expect(sent.some((entry) => entry.type === 'task.started')).toBe(true);

    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(terminalEvidence).toHaveBeenCalledTimes(1);
    await expect(handoffs.get({
      agentRef,
      sessionRef: adapter.sessions[0]!.sessionRef,
      runtimeId: 'pi',
      cwd: expectedCwd,
    })).resolves.toMatchObject({ terminalCause: 'complete' });
  });

  it('persists claimed Agent adapter-start failure before sending task.fail with exact AgentRef', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    adapter.startError = new Error('spawn failed');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    const realRecordTaskTerminal = handoffs.recordTaskTerminal.bind(handoffs);
    const terminalEvidence = vi.spyOn(handoffs, 'recordTaskTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.fail')).toBe(false);
      return realRecordTaskTerminal(...args);
    });
    const runner = new TaskRunner({
      adapters: [adapter],
      workspaceRoot: await makeRoot(),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const agentRef = ref('agent-start-failure', 'profile-4');
    const taskId = 'task-agent-start-failure';

    await runner.handleEnvelope(createEnvelope(
      'task.offer_for_agent',
      { instruction: 'fail before session start', policy: { mode: 'auto' }, runtime: 'pi', agentRef },
      { taskId, seq: 1 },
    ));

    const cwd = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(terminalEvidence).toHaveBeenCalledTimes(1);
    expect(sent.map((entry) => entry.type)).toEqual(['task.claim', 'task.fail']);
    expect(sent.at(-1)?.payload).toMatchObject({ agentRef });
    await expect(new AgentSessionHandoffStore().getTaskTerminal({ agentRef, taskId, runtimeId: 'pi', cwd }))
      .resolves.toMatchObject({
      agentRef,
      taskId,
      runtimeId: 'pi',
      cwd,
      terminalCause: 'failed',
      terminalReason: expect.stringContaining('start'),
      });
  });

  it('persists claimed Agent handoff-write failure before task.fail and includes the runtime sessionRef', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    vi.spyOn(handoffs, 'record').mockRejectedValueOnce(new Error('disk unavailable'));
    const realRecordTaskTerminal = handoffs.recordTaskTerminal.bind(handoffs);
    const terminalEvidence = vi.spyOn(handoffs, 'recordTaskTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.fail')).toBe(false);
      return realRecordTaskTerminal(...args);
    });
    const runner = new TaskRunner({
      adapters: [adapter],
      workspaceRoot: await makeRoot(),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const agentRef = ref('agent-handoff-failure', 'profile-5');
    const taskId = 'task-agent-handoff-failure';

    await runner.handleEnvelope(createEnvelope(
      'task.offer_for_agent',
      { instruction: 'fail while writing handoff', policy: { mode: 'auto' }, runtime: 'pi', agentRef },
      { taskId, seq: 1 },
    ));

    const cwd = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(terminalEvidence).toHaveBeenCalledTimes(1);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(sent.map((entry) => entry.type)).toEqual(['task.claim', 'task.fail']);
    expect(sent.at(-1)?.payload).toMatchObject({ agentRef });
    await expect(new AgentSessionHandoffStore().getTaskTerminal({ agentRef, taskId, runtimeId: 'pi', cwd }))
      .resolves.toMatchObject({
      agentRef,
      taskId,
      runtimeId: 'pi',
      cwd,
      sessionRef: adapter.sessions[0]?.sessionRef,
      terminalCause: 'failed',
      terminalReason: expect.stringContaining('disk unavailable'),
      });
  });

  it('declines profile-revision and cross-Agent resume before projection or adapter start', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const workspaceRoot = await makeRoot();
    let projectionCalls = 0;
    const manager = new AgentHomeManager({
      hostStorageRoot,
      projection: createAgentHomeProjection(() => { projectionCalls += 1; }),
    });
    const original = await manager.prepare(ref('one', 'profile-1'));
    const handoffs = new AgentSessionHandoffStore();
    await handoffs.record({
      agentRef: ref('one', 'profile-1'),
      taskId: 'task-original',
      sessionRef: 'session-original',
      runtimeId: 'pi',
      cwd: original.resolution.canonicalHome,
      leaseId: original.lease.leaseId,
    });
    await original.lease.release();

    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = new TaskRunner({
      adapters: [adapter],
      workspaceRoot,
      agentHome: manager,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const offer = (taskId: string, agentRef: ReturnType<typeof ref>, seq: number) => createEnvelope(
      'task.offer_for_agent',
      {
        instruction: 'resume',
        policy: { mode: 'auto' as const },
        runtime: 'pi' as const,
        sessionRef: 'session-original',
        agentRef,
      },
      { taskId, seq },
    );

    await runner.handleEnvelope(offer('task-revision-mismatch', ref('one', 'profile-2'), 1));
    await runner.handleEnvelope(offer('task-cross-agent', ref('two', 'profile-1'), 2));
    expect(adapter.startCalls).toHaveLength(0);
    expect(projectionCalls).toBe(1);
    const declines = sent.filter((entry) => entry.type === 'task.decline');
    expect(declines).toHaveLength(2);
    expect(declines[0]?.payload).toMatchObject({ agentRef: ref('one', 'profile-2') });
    expect(declines[1]?.payload).toMatchObject({ agentRef: ref('two', 'profile-1') });
  });

  it.each(['pi', 'claude', 'codex'] as const)(
    'binds the %s process cwd to the sealed manifest cwd',
    async (runtime) => {
      const cwd = await makeRoot();
      const observedCwds: Array<string | URL | undefined> = [];
      const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
        observedCwds.push(options?.cwd);
        return realSpawn(command, args, options);
      }) as never;
      const adapter = runtime === 'pi'
        ? new PiAdapter({
            resolveBin: () => ({ command: RUNTIME_FIXTURES.pi, source: 'env' }),
            resolveExtensions: () => ({
              webAccess: '/extensions/pi-web-access/index.ts',
              mcpAdapter: '/extensions/byok-pi-mcp.js',
            }),
            spawnFn,
          })
        : runtime === 'claude'
          ? new ClaudeAdapter({ resolveBin: () => ({ command: RUNTIME_FIXTURES.claude, source: 'path' }), spawnFn })
          : new CodexAdapter({ resolveBin: () => ({ command: RUNTIME_FIXTURES.codex, source: 'path' }), spawnFn });
      const session = await startPreparedOperation(
        adapter,
        { instruction: 'verify cwd', policy: { mode: 'auto' } },
        { workspaceDir: cwd, policy: { mode: 'auto' }, env: process.env },
      );
      await session.close();
      expect(observedCwds.length).toBeGreaterThan(0);
      expect(observedCwds.every((observed) => observed === cwd)).toBe(true);
    },
  );
});
