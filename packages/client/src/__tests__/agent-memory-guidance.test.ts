import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { resolveAgentMemoryMcpBin } from '../daemon/resolve-agent-memory-mcp-bin';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { GitWorkspaceManager } from '../daemon/git-workspace';
import { GitWorkspaceStore } from '../daemon/git-workspace-store';
import { AGENT_MEMORY_GUIDANCE, prependAgentMemoryGuidance } from '../daemon/memory-guidance';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-memory-guidance-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('Agent memory guidance', () => {
  it('prepends the exact runtime-neutral guidance block', () => {
    const expected = [
      'At the start of this Agent task, first read `MEMORY.md` in the provided `cwd`.',
      'Treat `MEMORY.md` as a concise, self-contained recovery index; if it is empty, initialize a brief index from durable, non-secret task knowledge.',
      'Read files under `notes/` only as needed, following pointers from the index.',
      'When task permissions allow and a durable value is learned, update the relevant `notes/` entry and the `MEMORY.md` index.',
      'Never write credentials, secrets, tokens, API keys, private keys, or other authentication material to `MEMORY.md` or `notes/`.',
    ].join('\n');
    const instruction = 'perform the assigned work';

    expect(AGENT_MEMORY_GUIDANCE).toBe(expected);
    expect(prependAgentMemoryGuidance(instruction)).toBe(`${expected}\n\n${instruction}`);
  });

  it('injects guidance and the reserved MCP only for strict Agent tasks across the shared runtime seam', async () => {
    const hostStorageRoot = await makeRoot();
    const workspaceRoot = await makeRoot();
    const storeDir = await makeRoot();
    const runtimes = ['pi', 'claude', 'codex'] as const;
    const adapters = runtimes.map((runtime) => new StubRuntimeAdapter(runtime, undefined, {
      steer: true,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: true,
      permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
    }));
    const gitWorkspaceStore = new GitWorkspaceStore(storeDir);
    await gitWorkspaceStore.initialize();
    const gitWorkspaceManager = new GitWorkspaceManager(workspaceRoot, { ownerId: 'agent-memory-guidance-test' });
    await gitWorkspaceManager.preflight();
    const blobClient: BlobResolver = {
      resolveInstruction: async () => {
        throw new Error('not used in this test');
      },
      uploadArtifact: async () => {
        throw new Error('not used in this test');
      },
    };
    const runner = new TaskRunner({
      adapters,
      workspaceRoot,
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-guidance',
      send: () => {},
      blobClient,
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      gitWorkspaceManager,
      gitWorkspaceStore,
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-memory-guidance',
      tenantId: 'tenant-memory-guidance',
      agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
    });

    let seq = 1;
    for (const runtime of runtimes) {
      await runner.handleEnvelope(
        createEnvelope(
          'task.offer_for_agent',
          {
            instruction: `agent instruction for ${runtime}`,
            policy: { mode: 'auto' },
            runtime,
            agentRef: { agentId: `agent-${runtime}`, profileRevision: 'profile-1' },
          },
          { taskId: `agent-task-${runtime}`, seq: seq++ },
        ),
      );
    }

    for (const runtime of runtimes) {
      await runner.handleEnvelope(
        createEnvelope(
          'task.offer',
          {
            instruction: `ordinary instruction for ${runtime}`,
            policy: { mode: 'auto' },
            runtime,
          },
          { taskId: `ordinary-task-${runtime}`, seq: seq++ },
        ),
      );
    }

    for (const [index, runtime] of runtimes.entries()) {
      const adapter = adapters[index]!;
      expect(adapter.startCalls[0]?.task.instruction).toBe(
        prependAgentMemoryGuidance(`agent instruction for ${runtime}`),
      );
      expect(adapter.startCalls[1]?.task.instruction).toContain(`ordinary instruction for ${runtime}`);
      expect(adapter.startCalls[1]?.task.instruction).not.toContain('At the start of this Agent task');
      const strictMcp = adapter.startCalls[0]?.ctx.mcpServers?.byokagentmemory;
      if (isAgentMemorySecureFilesystemAvailable()) {
        expect(strictMcp).toMatchObject({ command: 'node', args: ['memory-mcp.js'] });
        expect(strictMcp?.env?.BYOK_AGENT_MEMORY_CONTEXT).toMatch(/^[-a-f0-9]{36}\.[-a-f0-9]{36}$/u);
      } else {
        expect(strictMcp).toBeUndefined();
      }
      expect(adapter.startCalls[1]?.ctx.mcpServers).toBeUndefined();
      expect(adapter.startCalls[1]?.ctx.gitWorkspace).toBeDefined();
    }

    const piToken = adapters[0]?.startCalls[0]?.ctx.mcpServers?.byokagentmemory?.env?.BYOK_AGENT_MEMORY_CONTEXT;
    if (isAgentMemorySecureFilesystemAvailable()) {
      expect(piToken).toBeTypeOf('string');
      await fs.writeFile(path.join(hostStorageRoot, 'agents', 'agent-pi', 'MEMORY.md'), 'strict task only', 'utf8');
      await expect(runner.recallAgentMemory({ contextToken: piToken!, path: 'MEMORY.md' })).resolves.toMatchObject({ content: 'strict task only' });
    } else {
      expect(piToken).toBeUndefined();
    }
    await expect(runner.recallAgentMemory({ contextToken: 'not-a-real-context-token', path: 'MEMORY.md' })).rejects.toThrow('invalid');

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const adapter of adapters) {
      for (const session of adapter.sessions) session.emit({ type: 'turn_end' });
    }
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(consoleError).not.toHaveBeenCalled();
    if (isAgentMemorySecureFilesystemAvailable()) {
      await expect(runner.recallAgentMemory({ contextToken: piToken!, path: 'MEMORY.md' })).rejects.toThrow('invalid');
    }
  });

  it('rejects explicit hosted Agent memory configuration where the secure filesystem primitive is unavailable', async () => {
    if (isAgentMemorySecureFilesystemAvailable()) return;
    const hostStorageRoot = await makeRoot();
    const workspaceRoot = await makeRoot();

    expect(() => createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Agent memory unsupported platform test',
      productId: 'agent-memory-unsupported-platform-test',
      serverUrl: 'http://localhost:1',
      workspaceRoot,
      agentHome: { hostStorageRoot },
      agentMemory: {},
    }, [new StubRuntimeAdapter('pi')])).toThrow('requires a platform with safe descriptor-relative filesystem operations');
    expect(resolveAgentMemoryMcpBin()).toBeUndefined();
  });

  it('admits only an explicit external helper on a proven helper platform', async () => {
    if (isAgentMemorySecureFilesystemAvailable()) return;
    const hostStorageRoot = await makeRoot();
    const workspaceRoot = await makeRoot();
    const helperBin = path.join(await makeRoot(), 'byok-agent-memory-fs');
    const config = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Agent memory external helper test',
      productId: 'agent-memory-external-helper-test',
      serverUrl: 'http://localhost:1',
      workspaceRoot,
      agentHome: { hostStorageRoot },
      agentMemory: {},
      agentMemoryFilesystem: { helperBin },
    } as const;

    if (process.platform === 'darwin') {
      expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')])).not.toThrow();
      expect(resolveAgentMemoryMcpBin(true)).toBeDefined();
    } else {
      expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')])).toThrow('is not admitted on this platform');
      expect(resolveAgentMemoryMcpBin(true)).toBeUndefined();
    }
  });
});
