import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentHomeBusyError,
  AgentHomeCollisionError,
  AgentHomeManager,
  AgentHomeResolver,
  createAgentHomeLifecycle,
  validateAgentRef,
} from '../agent-home';
import { AgentSessionHandoffStore, AgentSessionHandoffMismatchError } from '../daemon/agent-session-handoff-store';
import { sealRuntimeOperationManifest } from '../types';

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

describe('host-owned Agent home contract', () => {
  it('rejects traversal, absolute and malformed AgentRef path segments', () => {
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

  it('requires an absolute resolver result and contains canonical existing ancestors', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const resolver = new AgentHomeResolver({ configuredRoot: root, resolve: () => path.join(root, 'agents', 'one') });
    const resolved = await resolver.resolve(ref('one'));
    expect(resolved.homeDir).toBe(path.join(await fs.realpath(root), 'agents', 'one'));
    expect(path.isAbsolute(resolved.homeDir)).toBe(true);

    const unknown = new AgentHomeResolver({ configuredRoot: root, resolve: () => undefined as never });
    await expect(unknown.resolve(ref('unknown'))).rejects.toThrow(/absolute path|resolver result/);

    const link = path.join(root, 'agents', 'escape');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(outside, link, 'dir');
    const symlinkResolver = new AgentHomeResolver({ configuredRoot: root, resolve: () => link });
    await expect(symlinkResolver.resolve(ref('escape'))).rejects.toThrow(/outside|escapes/);
  });

  it('fails closed on cross-Agent canonical collisions', async () => {
    const root = await makeRoot();
    const home = path.join(root, 'agents', 'shared');
    const resolver = new AgentHomeResolver({ configuredRoot: root, resolve: () => home });
    await resolver.resolve(ref('one'));
    await expect(resolver.resolve(ref('two'))).rejects.toBeInstanceOf(AgentHomeCollisionError);
    await expect(resolver.resolve(ref('one', 'profile-2'))).rejects.toBeInstanceOf(AgentHomeCollisionError);
  });

  it('keeps host lifecycle idempotent and preserves existing MEMORY content', async () => {
    const root = await makeRoot();
    const home = path.join(root, 'agents', 'one');
    let lifecycleCalls = 0;
    const lifecycle = createAgentHomeLifecycle(async ({ cwd }) => {
      lifecycleCalls += 1;
      await fs.mkdir(path.join(cwd, 'notes'), { recursive: true });
      const memory = path.join(cwd, 'MEMORY.md');
      try {
        await fs.access(memory);
      } catch {
        await fs.writeFile(memory, 'host-owned memory\n', 'utf8');
      }
    });
    const manager = new AgentHomeManager({
      resolver: new AgentHomeResolver({ configuredRoot: root, resolve: () => home }),
      lifecycle,
    });
    const first = await manager.prepare(ref('one'));
    expect(first.lease.cwd).toBe(first.resolution.canonicalHome);
    await first.lease.release();
    await fs.writeFile(path.join(home, 'MEMORY.md'), 'preserved edit\n', 'utf8');
    const second = await manager.prepare(ref('one'));
    await second.lease.release();
    expect(lifecycleCalls).toBe(2);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('preserved edit\n');
    expect(await fs.stat(path.join(home, 'notes'))).toBeTruthy();
  });

  it('enforces same-Agent single writer while isolating different homes', async () => {
    const root = await makeRoot();
    const manager = (agentId: string) => new AgentHomeManager({
      resolver: new AgentHomeResolver({ configuredRoot: root, resolve: () => path.join(root, 'agents', agentId) }),
      lifecycle: createAgentHomeLifecycle(async () => {}),
    });
    const one = manager('one');
    const two = manager('two');
    const lease = await one.prepare(ref('one'));
    await expect(one.prepare(ref('one'))).rejects.toBeInstanceOf(AgentHomeBusyError);
    const other = await two.prepare(ref('two'));
    await other.lease.release();
    await lease.lease.release();
    const retry = await one.prepare(ref('one'));
    await retry.lease.release();
  });

  it('persists exact AgentRef/profileRevision/session/runtime/cwd and terminal cause across restart', async () => {
    const root = await makeRoot();
    const storeDir = path.join(root, 'state');
    const store = new AgentSessionHandoffStore(storeDir);
    const expected = {
      agentRef: ref('one', 'profile-7'),
      sessionRef: 'session-1',
      runtimeId: 'pi',
      cwd: path.join(root, 'agents', 'one'),
      leaseId: 'lease-1',
    } as const;
    await store.record(expected);
    await expect(store.requireMatch({ ...expected })).resolves.toMatchObject(expected);
    await expect(store.requireMatch({ ...expected, runtimeId: 'codex' })).rejects.toBeInstanceOf(AgentSessionHandoffMismatchError);
    await store.recordTerminal({ ...expected }, 'failed', 'runtime stopped');
    const restarted = new AgentSessionHandoffStore(storeDir);
    await expect(restarted.get('session-1')).resolves.toMatchObject({
      ...expected,
      terminalCause: 'failed',
      terminalReason: 'runtime stopped',
    });
    await fs.writeFile(path.join(storeDir, 'agent-session-handoffs.json'), '{broken', 'utf8');
    await expect(restarted.get('session-1')).rejects.toThrow(/not valid JSON/);
  });

  it('seals AgentRef, canonical cwd and lease in an immutable runtime manifest', () => {
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
    expect(manifest.agentRef).toEqual(ref('one', 'profile-1'));
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.agentRef)).toBe(true);
    expect(Object.isFrozen(manifest.lease)).toBe(true);
  });
});
