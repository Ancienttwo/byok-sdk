import { testScratchOwner, testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
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
import {
  AGENT_MEMORY_GUIDANCE,
  AGENT_MEMORY_READER_GUIDANCE,
  prependAgentMemoryGuidance,
  prependAgentMemoryReaderGuidance,
  prependAgentReaderResultGuidance,
} from '../daemon/memory-guidance';
import { serveAgentMemoryMcpOverStdio, serveGrantedAgentMemoryMcpOverStdio } from '../bin/agent-memory-mcp-server';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

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
    const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
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
    // Ordinary tasks finish only after their Git observation, which spawns
    // serial git processes and is bounded at 5s in TaskRunner. The 1s
    // waitFor default is below that bound and fails on slow spawn hosts.
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0), { timeout: 5_000 });
    expect(consoleError).not.toHaveBeenCalled();
    if (isAgentMemorySecureFilesystemAvailable()) {
      await expect(runner.recallAgentMemory({ contextToken: piToken!, path: 'MEMORY.md' })).rejects.toThrow('invalid');
    }
  });

  it('rejects explicit hosted Agent memory configuration where the secure filesystem primitive is unavailable', async () => {
    if (isAgentMemorySecureFilesystemAvailable(process.platform === 'darwin')) return;
    const hostStorageRoot = await makeRoot();
    const workspaceRoot = await makeRoot();

    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() },
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

  it('rejects the removed product-owned helper configuration', async () => {
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
      expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter('pi')])).toThrow('agentMemoryFilesystem is removed');
      expect(resolveAgentMemoryMcpBin(true)).toBeDefined();
    } else {
      expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter('pi')])).toThrow('agentMemoryFilesystem is removed');
      expect(resolveAgentMemoryMcpBin(true)).toBeUndefined();
    }
  });
});

// #614 follow-ups: the guidance follows `agentMemoryMcp`, and a reader gets no write tool.
describe('Agent memory admission follow-ups', () => {
  async function memoryRunner(agentMemoryMcp: 'auto' | 'off' | undefined) {
    const hostStorageRoot = await makeRoot();
    const workspaceRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi', undefined, { steer: true, resume: true, approvalInteractive: true, mcpToolsets: true });
    const gitWorkspaceStore = new GitWorkspaceStore(storeDir);
    await gitWorkspaceStore.initialize();
    const gitWorkspaceManager = new GitWorkspaceManager(workspaceRoot, { ownerId: 'agent-memory-admission-test' });
    await gitWorkspaceManager.preflight();
    const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      workspaceRoot,
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-admission',
      send: () => {},
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used in this test'); },
        uploadArtifact: async () => { throw new Error('not used in this test'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      gitWorkspaceManager,
      gitWorkspaceStore,
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-memory-admission',
      tenantId: 'tenant-memory-admission',
      // `off` resolves no helper in the daemon; `auto` models an admitted
      // secure filesystem (the macOS release helper is never opened here).
      ...(agentMemoryMcp === 'off' ? { agentMemoryMcp } : {
        ...(agentMemoryMcp === undefined ? {} : { agentMemoryMcp }),
        agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
        ...(process.platform === 'darwin' ? { resolveAgentMemoryFilesystemHelperBin: () => '/sdk/release/agent-memory-fs' } : {}),
      }),
    });
    let seq = 1;
    for (const [taskId, reader] of [['writer-task', false], ['reader-task', true]] as const) {
      await runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
        instruction: `instruction for ${taskId}`,
        runtime: 'pi',
        agentRef: { agentId: 'agent-admission', profileRevision: 'profile-1' },
        ...(reader ? { homeAccess: 'memory-reader' as const } : {}),
      }, { taskId, seq: seq++ }));
    }
    expect(adapter.startCalls).toHaveLength(2);
    return { runner, writer: adapter.startCalls[0]!, reader: adapter.startCalls[1]! };
  }

  async function listToolNames(serve: (stdin: PassThrough, stdout: PassThrough) => void): Promise<string[]> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); });
    serve(stdin, stdout);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
    await vi.waitFor(() => expect(buffer).toContain('\n'));
    stdin.end();
    const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { result: { tools: { name: string }[] } };
    return response.result.tools.map((tool) => tool.name);
  }

  const deps = {
    recall: async () => { throw new Error('not used in this test'); },
    save: async () => { throw new Error('not used in this test'); },
  };

  it('keeps the auto reader guidance byte-identical and adds a result-only reader guidance', () => {
    const memoryLines = [
      'At the start of this Agent task, first read `MEMORY.md` in the Agent home, which is `../../../MEMORY.md` from the provided `cwd`.',
      'Read files under the Agent home `notes/` (`../../../notes/`) only as needed, following pointers from the index.',
      'This task reads Agent memory only. Do not change `MEMORY.md` or `notes/`: another task writes memory.',
    ];
    const resultLine = 'Give the result of this task in your final reply. Files in the provided `cwd` are scratch files: do not expect the host to read them.';
    expect(AGENT_MEMORY_READER_GUIDANCE).toBe([...memoryLines, resultLine].join('\n'));
    expect(prependAgentReaderResultGuidance('work')).toBe(`${resultLine}\n\nwork`);
  });

  it('omits the memory guidance and the memory MCP for writer and reader when agentMemoryMcp is off', async () => {
    const { writer, reader } = await memoryRunner('off');
    expect(writer.task.instruction).toBe('instruction for writer-task');
    expect(reader.task.instruction).toBe(prependAgentReaderResultGuidance('instruction for reader-task'));
    for (const start of [writer, reader]) {
      expect(start.task.instruction).not.toContain('MEMORY.md');
      expect(start.task.instruction).not.toContain('notes/');
      expect(start.ctx.mcpServers?.byokagentmemory).toBeUndefined();
    }
  });

  it.skipIf(process.platform === 'win32').each([undefined, 'auto'] as const)(
    'with agentMemoryMcp %s seals a reader read-only and lists only granted tools', async (mode) => {
      const { writer, reader } = await memoryRunner(mode);
      expect(writer.task.instruction).toBe(prependAgentMemoryGuidance('instruction for writer-task'));
      expect(reader.task.instruction).toBe(prependAgentMemoryReaderGuidance('instruction for reader-task'));
      expect(writer.ctx.mcpServers?.byokagentmemory?.env).toMatchObject({
        BYOK_PREPARED_AGENT_MEMORY_MODE: 'read-write', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
      });
      expect(reader.ctx.mcpServers?.byokagentmemory?.env).toMatchObject({
        BYOK_PREPARED_AGENT_MEMORY_MODE: 'read', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
      });
    },
  );

  it('lists only memory_recall from a granted read helper and keeps the complete prepared listing', async () => {
    expect(await listToolNames((stdin, stdout) => serveGrantedAgentMemoryMcpOverStdio({ deps, mode: 'read', stdin, stdout })))
      .toEqual(['memory_recall']);
    expect(await listToolNames((stdin, stdout) => serveGrantedAgentMemoryMcpOverStdio({ deps, mode: 'read-write', stdin, stdout })))
      .toEqual(['memory_recall', 'memory_save']);
    // The prepared lane compares this listing with its complete sealed descriptor.
    expect(await listToolNames((stdin, stdout) => serveAgentMemoryMcpOverStdio({ deps, mode: 'read', stdin, stdout })))
      .toEqual(['memory_recall', 'memory_save']);
  });
});
