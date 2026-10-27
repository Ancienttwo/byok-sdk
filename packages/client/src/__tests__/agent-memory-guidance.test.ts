import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchOwner, testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentMemorySelection, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { resolveAgentMemoryMcpBin } from '../daemon/resolve-agent-memory-mcp-bin';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import {
  AGENT_MEMORY_GUIDANCE,
  AGENT_MEMORY_READER_GUIDANCE,
  prependAgentMemoryGuidance,
  prependAgentMemoryReaderGuidance,
  prependAgentReaderResultGuidance,
} from '../daemon/memory-guidance';
import { serveAgentMemoryMcpOverStdio, serveGrantedAgentMemoryMcpOverStdio } from '../bin/agent-memory-mcp-server';
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

  it('injects guidance and the reserved MCP into Agent tasks across the shared runtime seam', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const runtimes = ['pi', 'claude', 'codex'] as const;
    const adapters = runtimes.map((runtime) => new StubRuntimeAdapter(runtime, undefined, {
      steer: true,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: true,
    }));
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
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-guidance',
      send: () => {},
      blobClient,
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

    for (const [index, runtime] of runtimes.entries()) {
      const adapter = adapters[index]!;
      expect(adapter.startCalls[0]?.task.instruction).toBe(
        prependAgentMemoryGuidance(`agent instruction for ${runtime}`),
      );
      const strictMcp = adapter.startCalls[0]?.ctx.mcpServers?.byokagentmemory;
      if (isAgentMemorySecureFilesystemAvailable()) {
        expect(strictMcp).toMatchObject({ command: 'node', args: ['memory-mcp.js'] });
        expect(strictMcp?.env?.BYOK_AGENT_MEMORY_CONTEXT).toMatch(/^[-a-f0-9]{36}\.[-a-f0-9]{36}$/u);
      } else {
        expect(strictMcp).toBeUndefined();
      }
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
    if (isAgentMemorySecureFilesystemAvailable(process.platform === 'darwin')) return;
    const hostStorageRoot = await makeRoot();

    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Agent memory unsupported platform test',
      productId: 'agent-memory-unsupported-platform-test',
      serverUrl: 'http://localhost:1',
      agentHome: { hostStorageRoot },
      agentMemory: {},
    }, [new StubRuntimeAdapter('pi')])).toThrow('requires a platform with safe descriptor-relative filesystem operations');
    expect(resolveAgentMemoryMcpBin()).toBeUndefined();
  });

  it('rejects the removed product-owned helper configuration', async () => {
    if (isAgentMemorySecureFilesystemAvailable()) return;
    const hostStorageRoot = await makeRoot();
    const helperBin = path.join(await makeRoot(), 'byok-agent-memory-fs');
    const config = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Agent memory external helper test',
      productId: 'agent-memory-external-helper-test',
      serverUrl: 'http://localhost:1',
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
// `withHelperBin: false` under `auto` leaves out the memory MCP helper, which is admission `unavailable`.
async function createMemoryRunner(agentMemoryMcp: 'auto' | 'off' | undefined, mcpToolsets = true, withHelperBin = true) {
  const hostStorageRoot = await makeRoot();
  const storeDir = await makeRoot();
  const adapter = new StubRuntimeAdapter('pi', undefined, { steer: true, resume: true, approvalInteractive: true, mcpToolsets });
  const sent: Envelope[] = [];
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome: new AgentHomeManager({ hostStorageRoot }),
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-memory-admission',
    send: (envelope) => { sent.push(envelope); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('not used in this test'); },
      uploadArtifact: async () => { throw new Error('not used in this test'); },
    },
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'product-memory-admission',
    tenantId: 'tenant-memory-admission',
    // `off` resolves no helper in the daemon; `auto` models an admitted
    // secure filesystem (the macOS release helper is never opened here).
    ...(agentMemoryMcp === 'off' ? { agentMemoryMcp } : !withHelperBin ? { agentMemoryMcp: 'auto' as const } : {
      ...(agentMemoryMcp === undefined ? {} : { agentMemoryMcp }),
      agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
      ...(process.platform === 'darwin' ? { resolveAgentMemoryFilesystemHelperBin: () => '/sdk/release/agent-memory-fs' } : {}),
    }),
  });
  let seq = 1;
  const offer = (taskId: string, options: { reader?: boolean; agentId?: string; agentMemory?: AgentMemorySelection } = {}) =>
    runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
      instruction: `instruction for ${taskId}`,
      runtime: 'pi',
      agentRef: { agentId: options.agentId ?? 'agent-admission', profileRevision: 'profile-1' },
      ...(options.reader ? { homeAccess: 'memory-reader' as const } : {}),
      ...(options.agentMemory === undefined ? {} : { agentMemory: options.agentMemory }),
    }, { taskId, seq: seq++ }));
  const declineOf = (taskId: string) => sent.find((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId);
  return { runner, adapter, offer, declineOf };
}

describe('Agent memory admission follow-ups', () => {
  async function memoryRunner(agentMemoryMcp: 'auto' | 'off' | undefined) {
    const { runner, adapter, offer } = await createMemoryRunner(agentMemoryMcp);
    await offer('writer-task');
    await offer('reader-task', { reader: true });
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

// #614: an ordinary Agent offer selects the memory of its own task.
describe('per-task Agent memory selection', () => {
  const readOnlyGuidance = [
    'At the start of this Agent task, first read `MEMORY.md` in the provided `cwd`.',
    'Read files under `notes/` only as needed, following pointers from the index.',
    'This task reads Agent memory only. Do not change `MEMORY.md` or `notes/`.',
  ].join('\n');

  it('exports the reserved name of the memory server in the task MCP servers', async () => {
    const { AGENT_MEMORY_MCP_SERVER_NAME } = await import('../index');
    expect(AGENT_MEMORY_MCP_SERVER_NAME).toBe('byokagentmemory');
  });

  it('none gives no memory MCP and no memory guidance, and needs no adapter MCP support', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto', false);
    await offer('writer-none', { agentMemory: 'none' });
    await offer('reader-none', { reader: true, agentMemory: 'none' });
    expect(declineOf('writer-none')).toBeUndefined();
    expect(declineOf('reader-none')).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(2);
    const [writer, reader] = adapter.startCalls;
    expect(writer!.task.instruction).toBe('instruction for writer-none');
    expect(reader!.task.instruction).toBe(prependAgentReaderResultGuidance('instruction for reader-none'));
    for (const start of [writer!, reader!]) expect(start.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('read seals a writer read-only with read-only guidance; read-write keeps the writer', async () => {
    const { adapter, offer } = await createMemoryRunner('auto');
    await offer('writer-read', { agentId: 'agent-read', agentMemory: 'read' });
    await offer('writer-read-write', { agentId: 'agent-read-write', agentMemory: 'read-write' });
    await offer('reader-read', { agentId: 'agent-read', reader: true, agentMemory: 'read' });
    expect(adapter.startCalls).toHaveLength(3);
    const [read, readWrite, reader] = adapter.startCalls;
    expect(read!.task.instruction).toBe(`${readOnlyGuidance}\n\ninstruction for writer-read`);
    expect(read!.ctx.mcpServers?.byokagentmemory?.env).toMatchObject({
      BYOK_PREPARED_AGENT_MEMORY_MODE: 'read', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
    });
    expect(readWrite!.task.instruction).toBe(prependAgentMemoryGuidance('instruction for writer-read-write'));
    expect(readWrite!.ctx.mcpServers?.byokagentmemory?.env).toMatchObject({
      BYOK_PREPARED_AGENT_MEMORY_MODE: 'read-write', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
    });
    expect(reader!.task.instruction).toBe(prependAgentMemoryReaderGuidance('instruction for reader-read'));
    expect(reader!.ctx.mcpServers?.byokagentmemory?.env).toMatchObject({
      BYOK_PREPARED_AGENT_MEMORY_MODE: 'read', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
    });
  });

  it('declines a memory-reader that selects read-write before it starts', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto');
    await offer('reader-read-write', { reader: true, agentMemory: 'read-write' });
    expect(declineOf('reader-read-write')?.payload).toMatchObject({
      retryable: false, reason: expect.stringContaining('agent_memory_selection_invalid'),
    });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines read and read-write when the daemon does not admit memory, and still runs none', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('off');
    await offer('off-read', { agentId: 'agent-off-read', agentMemory: 'read' });
    await offer('off-read-write', { agentId: 'agent-off-read-write', agentMemory: 'read-write' });
    await offer('off-none', { agentId: 'agent-off-none', agentMemory: 'none' });
    for (const taskId of ['off-read', 'off-read-write']) {
      expect(declineOf(taskId)?.payload, taskId).toMatchObject({
        retryable: false, reason: expect.stringContaining('agent_memory_unavailable'),
      });
    }
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]!.task.instruction).toBe('instruction for off-none');
    expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });
});

// #815: `read-if-admitted` runs as `read` when the daemon admits the memory MCP, and as `none` when it does not.
describe('agentMemory read-if-admitted', () => {
  it.skipIf(process.platform === 'win32')('runs exactly as read when the daemon admits memory, for a writer and a reader', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto');
    await offer('writer-read', { agentId: 'agent-writer-read', agentMemory: 'read' });
    await offer('writer-if', { agentId: 'agent-writer-if', agentMemory: 'read-if-admitted' });
    await offer('reader-read', { agentId: 'agent-reader-read', reader: true, agentMemory: 'read' });
    await offer('reader-if', { agentId: 'agent-reader-if', reader: true, agentMemory: 'read-if-admitted' });
    for (const taskId of ['writer-if', 'reader-if']) expect(declineOf(taskId), taskId).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(4);
    const [writerRead, writerIf, readerRead, readerIf] = adapter.startCalls;
    for (const [read, ifAdmitted, name] of [[writerRead!, writerIf!, 'writer'], [readerRead!, readerIf!, 'reader']] as const) {
      expect(String(ifAdmitted.task.instruction).replace('-if', ''), name).toBe(String(read.task.instruction).replace('-read', ''));
      expect(ifAdmitted.ctx.mcpServers?.byokagentmemory?.env, name).toMatchObject({
        BYOK_PREPARED_AGENT_MEMORY_MODE: 'read', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
      });
    }
  });

  it('runs exactly as none when the daemon does not admit memory, with no decline and no adapter MCP support', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('off', false);
    await offer('writer-if', { agentId: 'agent-writer-if', agentMemory: 'read-if-admitted' });
    await offer('reader-if', { agentId: 'agent-reader-if', reader: true, agentMemory: 'read-if-admitted' });
    for (const taskId of ['writer-if', 'reader-if']) expect(declineOf(taskId), taskId).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(2);
    const [writer, reader] = adapter.startCalls;
    expect(writer!.task.instruction).toBe('instruction for writer-if');
    expect(reader!.task.instruction).toBe(prependAgentReaderResultGuidance('instruction for reader-if'));
    for (const start of [writer!, reader!]) expect(start.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });

  it('runs exactly as none when admission is unavailable (auto, no helper), with no decline', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto', true, false);
    await offer('writer-if', { agentId: 'agent-writer-if', agentMemory: 'read-if-admitted' });
    await offer('reader-if', { agentId: 'agent-reader-if', reader: true, agentMemory: 'read-if-admitted' });
    for (const taskId of ['writer-if', 'reader-if']) expect(declineOf(taskId), taskId).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(2);
    const [writer, reader] = adapter.startCalls;
    expect(writer!.task.instruction).toBe('instruction for writer-if');
    expect(reader!.task.instruction).toBe(prependAgentReaderResultGuidance('instruction for reader-if'));
    for (const start of [writer!, reader!]) expect(start.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });
});

// #833: `read-write-if-admitted` runs as `read-write` when the daemon admits the memory MCP, and as `none` when it does
// not. A memory-reader cannot select it, whatever the admission.
describe('agentMemory read-write-if-admitted', () => {
  it.skipIf(process.platform === 'win32')('runs a writer exactly as read-write when the daemon admits memory', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto');
    await offer('writer-rw', { agentId: 'agent-writer-rw', agentMemory: 'read-write' });
    await offer('writer-rw-if', { agentId: 'agent-writer-rw-if', agentMemory: 'read-write-if-admitted' });
    expect(declineOf('writer-rw-if')).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(2);
    const [readWrite, ifAdmitted] = adapter.startCalls;
    expect(ifAdmitted!.task.instruction).toBe(prependAgentMemoryGuidance('instruction for writer-rw-if'));
    expect(readWrite!.task.instruction).toBe(prependAgentMemoryGuidance('instruction for writer-rw'));
    expect(ifAdmitted!.ctx.mcpServers?.byokagentmemory?.env).toMatchObject({
      BYOK_PREPARED_AGENT_MEMORY_MODE: 'read-write', BYOK_AGENT_MEMORY_TOOL_LIST: 'granted',
    });
  });

  it('runs a writer exactly as none when the daemon does not admit memory, with no decline and no adapter MCP support', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('off', false);
    await offer('writer-rw-if', { agentId: 'agent-writer-rw-if', agentMemory: 'read-write-if-admitted' });
    expect(declineOf('writer-rw-if')).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]!.task.instruction).toBe('instruction for writer-rw-if');
    expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });

  it('runs a writer exactly as none when admission is unavailable (auto, no helper), with no decline', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto', true, false);
    await offer('writer-rw-if', { agentId: 'agent-writer-rw-if', agentMemory: 'read-write-if-admitted' });
    expect(declineOf('writer-rw-if')).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]!.task.instruction).toBe('instruction for writer-rw-if');
    expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });

  // An absent field keeps the daemon default, which is keyed on `agentMemoryMcp` alone: `auto` without a helper
  // still defaults a writer to read-write guidance, though no memory MCP is bound. The `*-if-admitted` value above
  // is keyed on admission and differs from it.
  it('keeps the default read-write guidance, with no memory MCP, for an absent field when admission is unavailable', async () => {
    const { adapter, offer, declineOf } = await createMemoryRunner('auto', true, false);
    await offer('writer-absent', { agentId: 'agent-writer-absent' });
    expect(declineOf('writer-absent')).toBeUndefined();
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]!.task.instruction).toBe(prependAgentMemoryGuidance('instruction for writer-absent'));
    expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentmemory).toBeUndefined();
  });

  it.each(['auto', 'off'] as const)('declines a memory-reader that selects it before it starts (agentMemoryMcp %s)', async (agentMemoryMcp) => {
    const { adapter, offer, declineOf } = await createMemoryRunner(agentMemoryMcp);
    await offer('reader-rw-if', { reader: true, agentMemory: 'read-write-if-admitted' });
    expect(declineOf('reader-rw-if')?.payload).toMatchObject({
      retryable: false, reason: expect.stringContaining('agent_memory_selection_invalid'),
    });
    expect(adapter.startCalls).toHaveLength(0);
  });
});

