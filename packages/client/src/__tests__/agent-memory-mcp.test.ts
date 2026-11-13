import { reservedMcpToken, testScratchOwner } from "./fixtures/execution-scratch";
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_PROJECTION_CAPABILITY, createEnvelope, type Envelope } from '@byok-sdk/protocol';

import { AgentHomeManager } from '../agent-home';
import {
  AgentMemoryRedactedOutbox,
  AgentMemoryRevisionConflictError,
  AgentMemoryService,
  captureAgentMemorySnapshot,
  cleanupAgentMemoryHomeForRestore,
  snapshotAndProjectAgentMemory,
  type AgentMemoryTaskContext,
} from '../daemon/agent-memory';
import { AGENT_MEMORY_TOOLS, handleAgentMemoryToolCall } from '../agent-memory/mcp-server';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { TaskRunner } from '../daemon/task-runner';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { expectAgentMemoryNameRules, expectAgentMemoryRawByteCompare, expectAgentMemoryRestoreCleanup } from './fixtures/agent-memory-name-rules';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import { AgentMemoryError, AgentMemoryValidationError, validateAgentMemoryPath } from '@byok-sdk/protocol/agent-memory';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

const roots: string[] = [];
const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const itWithSecureDescriptors = process.platform === 'linux' ? it : it.skip;
const itWithMemoryMcp = isAgentMemorySecureFilesystemAvailable(true) ? it : it.skip;

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-memory-mcp-'));
  roots.push(value);
  return value;
}

async function memory(agentId = 'agent-memory'): Promise<{ context: AgentMemoryTaskContext; release: () => Promise<void> }> {
  const hostStorageRoot = await root();
  const manager = new AgentHomeManager({ hostStorageRoot });
  const binding = await manager.prepare({ agentId, profileRevision: 'p1' });
  return {
    context: {
      taskId: 'task-memory', tenantId: 'tenant-memory', deviceId: 'device-memory', agentRef: binding.resolution.agentRef,
      sessionRef: 'session-memory', runtimeId: 'codex', canonicalHome: binding.resolution.canonicalHome, leaseId: binding.lease.leaseId, homeIdentity: binding.lease.homeIdentity,
    },
    release: () => binding.lease.release(),
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true }))); });

describe('Agent memory MCP local authority', () => {
  itWithSecureDescriptors('enforces exact revision CAS, path/symlink isolation, and metadata-only audit', async () => {
    const { context, release } = await memory();
    try {
      const service = new AgentMemoryService(context);
      const initial = await service.recall({ path: 'MEMORY.md' });
      expect(initial.revision).toBe(sha256(''));
      const saved = await service.save({ op: 'replace', path: 'MEMORY.md', expectedRevision: initial.revision, content: 'durable secret-looking value stays local' });
      expect(saved.revision).toBe(sha256('durable secret-looking value stays local'));
      await expect(service.save({ op: 'replace', path: 'MEMORY.md', expectedRevision: initial.revision, content: 'stale' })).rejects.toBeInstanceOf(AgentMemoryRevisionConflictError);
      await expect(service.save({ op: 'delete', path: 'MEMORY.md', expectedRevision: saved.revision! })).rejects.toBeInstanceOf(AgentMemoryError);
      await expect(service.recall({ path: '../MEMORY.md' })).rejects.toBeInstanceOf(AgentMemoryError);
      await expect(service.recall({ path: 'notes/credential.md' })).rejects.toBeInstanceOf(AgentMemoryError);
      await expect(service.recall({ path: '.byok/state.md' })).rejects.toBeInstanceOf(AgentMemoryError);
      await fs.symlink(path.join(context.canonicalHome, 'MEMORY.md'), path.join(context.canonicalHome, 'notes', 'linked.md'));
      await expect(service.recall({ path: 'notes/linked.md' })).rejects.toBeInstanceOf(AgentMemoryError);
      const audit = await fs.readFile(path.join(context.canonicalHome, '.byok', 'agent-memory-audit-v1.jsonl'), 'utf8');
      expect(audit).toContain('"kind":"save"');
      expect(audit).not.toContain('durable secret-looking value stays local');
    } finally { await release(); }
  });

  it('refuses Windows device names and trailing dots in memory paths on every platform', () => {
    for (const value of ['notes/CON.md', 'notes/con', 'notes/nul.txt.md', 'notes/Aux/a.md', 'notes/com0.md', 'notes/LPT9.md', 'notes/x./a.md', 'notes/a.md.']) {
      expect(() => validateAgentMemoryPath(value)).toThrow(AgentMemoryValidationError);
    }
    for (const value of ['notes/console.md', 'notes/com10.md', 'notes/lpt.md', 'notes/nul-x.md', 'notes/x.y/a.md']) {
      expect(validateAgentMemoryPath(value)).toBe(value);
    }
  });

  itWithSecureDescriptors('refuses case pairs and hard links, and the snapshot leaves them out', async () => {
    const { context, release } = await memory();
    try {
      await expectAgentMemoryNameRules(context, await root(), { caseAlias: 'differs only in letter case', hardLink: 'with one link' });
    } finally { await release(); }
  });

  itWithSecureDescriptors.each([
    ['compares raw bytes', expectAgentMemoryRawByteCompare],
    ['cleans a home for a restore', expectAgentMemoryRestoreCleanup],
  ])('%s through the native backend (#1440)', async (_label, expectation) => {
    const { context, release } = await memory();
    try {
      await expectation(context, await root());
    } finally { await release(); }
  });

  itWithSecureDescriptors('refuses a directory on another volume in the walk and in a restore cleanup (#1440)', async () => {
    const { context, release } = await memory();
    const tree = path.join(context.canonicalHome, 'notes', 'tree');
    await fs.mkdir(path.join(tree, 'mounted'), { recursive: true });
    await fs.writeFile(path.join(tree, 'mounted', 'other-volume.txt'), 'on another volume');
    const lstat = fs.lstat.bind(fs);
    const spy = vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options?: { bigint?: boolean }) => {
      const stat = await lstat(target, options as { bigint: true });
      return target.toString().endsWith('/mounted') ? Object.assign(Object.create(stat) as typeof stat, { dev: stat.dev + 1n }) : stat;
    }) as unknown as typeof fs.lstat);
    try {
      await expect(captureAgentMemorySnapshot(context)).rejects.toThrow('on another volume');
      await expect(cleanupAgentMemoryHomeForRestore(context, { files: ['MEMORY.md'], entries: [] })).rejects.toThrow('on another volume');
      expect(await fs.readFile(path.join(tree, 'mounted', 'other-volume.txt'), 'utf8')).toBe('on another volume');
    } finally { spy.mockRestore(); await release(); }
  });

  itWithSecureDescriptors('rejects FIFO memory paths without blocking recall, replace, or delete', async () => {
    const { context, release } = await memory();
    const fifoPath = path.join(context.canonicalHome, 'notes', 'blocked.md');
    execFileSync('mkfifo', [fifoPath]);
    const service = new AgentMemoryService(context);
    const startedAt = Date.now();
    try {
      await expect(service.recall({ path: 'notes/blocked.md' })).rejects.toThrow('bounded regular file');
      await expect(service.save({
        op: 'replace',
        path: 'notes/blocked.md',
        expectedRevision: sha256(''),
        content: 'replacement',
      })).rejects.toThrow('regular file with one link');
      await expect(service.save({
        op: 'delete',
        path: 'notes/blocked.md',
        expectedRevision: sha256(''),
      })).rejects.toThrow('regular file with one link');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally { await release(); }
  });

  it('validates the MCP surface without exposing identity or a memory root parameter', async () => {
    const calls: string[] = [];
    const deps = {
      recall: async (input: { path: string; ifRevision?: string }) => { calls.push(`recall:${input.path}`); return { path: input.path, revision: sha256('v'), content: 'v' }; },
      save: async (input: { op: 'replace' | 'delete'; path: string; expectedRevision: string; content?: string }) => { calls.push(`save:${input.path}`); return { path: input.path, revision: sha256(input.content ?? ''), deleted: input.op === 'delete' }; },
    };
    const advertised = JSON.stringify(AGENT_MEMORY_TOOLS);
    expect(advertised).toContain('memory_recall');
    expect(advertised).toContain('memory_save');
    expect(advertised).not.toContain('tenantId');
    await expect(
      handleAgentMemoryToolCall(
        { name: 'memory_save', arguments: { op: 'delete', path: 'notes/a.md', expectedRevision: sha256(''), content: 'forbidden' }, progress: () => {}, signal: new AbortController().signal },
        deps,
        'read-write',
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await handleAgentMemoryToolCall(
      { name: 'memory_recall', arguments: { path: 'MEMORY.md' }, progress: () => {}, signal: new AbortController().signal },
      deps,
      'read-write',
    );
    expect(calls).toEqual(['recall:MEMORY.md']);
  });

  it('rejects memory_save before calling dependencies under a read grant', async () => {
    let saves = 0;
    const deps = {
      recall: async () => ({ path: 'MEMORY.md', revision: sha256(''), content: '' }),
      save: async () => { saves += 1; return { path: 'MEMORY.md', deleted: false }; },
    };
    await expect(handleAgentMemoryToolCall(
      { name: 'memory_save', arguments: { op: 'replace', path: 'MEMORY.md', expectedRevision: sha256(''), content: 'blocked' }, progress: () => {}, signal: new AbortController().signal },
      deps,
      'read',
    )).rejects.toMatchObject({ code: -32000, message: 'agent_memory_operation_denied' });
    expect(saves).toBe(0);
  });

  itWithSecureDescriptors('isolates each Agent home even when their task identity fields otherwise match', async () => {
    const first = await memory('agent-memory-a');
    const second = await memory('agent-memory-b');
    try {
      const left = new AgentMemoryService(first.context);
      const right = new AgentMemoryService(second.context);
      const initial = await left.recall({ path: 'MEMORY.md' });
      await left.save({ op: 'replace', path: 'MEMORY.md', expectedRevision: initial.revision, content: 'Agent A only' });
      expect((await right.recall({ path: 'MEMORY.md' })).content).toBe('');
      expect(first.context.canonicalHome).not.toBe(second.context.canonicalHome);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('reserves the SDK memory MCP name against host toolset registry override', () => {
    expect(() => new McpToolsetRegistry({
      host: { mcpServers: { byokagentmemory: { command: 'attacker' } } },
    })).toThrow('reserved by the daemon');
  });

  itWithMemoryMcp('declines a named strict Agent runtime that cannot project required memory MCP before claim', async () => {
    const hostStorageRoot = await root();
    const storeDir = await root();
    const sent: Envelope[] = [];
    const adapter = new StubRuntimeAdapter('codex', { kind: 'available' }, {
      steer: true,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: false,
    });
    const runner = new TaskRunner({ getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-mcp-toolsets',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'memory-mcp-toolsets',
      tenantId: 'tenant-memory-mcp-toolsets',
      agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
      ...(process.platform === 'darwin' ? { resolveAgentMemoryFilesystemHelperBin: () => '/opt/byok-agent-memory-fs' } : {}),
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      {
        ...FRESH_OFFER, instruction: 'strict Agent task must not receive an unsupported MCP surface',
        runtime: 'codex',
        agentRef: { agentId: 'agent-memory-mcp-toolsets', profileRevision: 'profile-1' },
      },
      { taskId: 'task-memory-mcp-toolsets', seq: 1 },
    ));

    const decline = sent.find((envelope) => envelope.type === 'task.decline');
    expect(decline?.payload).toMatchObject({ retryable: false });
    expect(JSON.stringify(decline)).toContain('required MCP toolsets');
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
  });

  itWithMemoryMcp('skips an unsupported runtime during automatic strict Agent selection and injects required memory MCP into the selected runtime', async () => {
    const hostStorageRoot = await root();
    const storeDir = await root();
    const unsupported = new StubRuntimeAdapter('unsupported-memory-runtime', { kind: 'available' }, {
      steer: true,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: false,
    });
    const supported = new StubRuntimeAdapter('supported-memory-runtime', { kind: 'available' }, {
      steer: true,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: true,
    });
    const runner = new TaskRunner({ getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
      adapters: [unsupported, supported],
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-mcp-selection',
      send: () => {},
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'memory-mcp-selection',
      tenantId: 'tenant-memory-mcp-selection',
      agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
      ...(process.platform === 'darwin' ? { resolveAgentMemoryFilesystemHelperBin: () => '/opt/byok-agent-memory-fs' } : {}),
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      {
        ...FRESH_OFFER, instruction: 'automatic strict Agent selection must skip MCP-incompatible runtimes',
        agentRef: { agentId: 'agent-memory-mcp-selection', profileRevision: 'profile-1' },
      },
      { taskId: 'task-memory-mcp-selection', seq: 1 },
    ));

    expect(unsupported.startCalls).toHaveLength(0);
    expect(supported.startCalls).toHaveLength(1);
    expect(supported.startCalls[0]?.ctx.mcpServers?.byokagentmemory).toMatchObject({
      command: 'node',
      args: ['memory-mcp.js', expect.any(String)],
    });

    supported.sessions[0]?.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  });

  // #1861: the token exists before start() returns, the task is active only after it.
  async function memoryCallDuringBlockedStart() {
    const hostStorageRoot = await root();
    const adapter = new StubRuntimeAdapter('codex', { kind: 'available' }, { steer: true, resume: true, approvalInteractive: true, mcpToolsets: true });
    const releaseStart = adapter.blockStart();
    const runner = new TaskRunner({ getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-start',
      send: () => {},
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir: await root(),
      productId: 'memory-start',
      tenantId: 'tenant-memory-start',
      agentMemoryMcpBin: { command: 'node', args: ['memory-mcp.js'] },
      ...(process.platform === 'darwin' ? { resolveAgentMemoryFilesystemHelperBin: () => '/opt/byok-agent-memory-fs' } : {}),
    });
    const offer = runner.handleEnvelope(createEnvelope('task.offer', {
      ...FRESH_OFFER, instruction: 'recall memory in the first turn', runtime: 'codex',
      agentRef: { agentId: 'agent-memory-start', profileRevision: 'profile-1' },
    }, { taskId: 'task-memory-start', seq: 1 }));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    await fs.writeFile(path.join(hostStorageRoot, 'agents', 'agent-memory-start', 'MEMORY.md'), 'first turn', 'utf8');
    let settled = false;
    const recall = runner.recallAgentMemory({ contextToken: reservedMcpToken(adapter.startCalls[0]?.ctx.mcpServers?.byokagentmemory), path: 'MEMORY.md' });
    void recall.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    return { adapter, runner, offer, recall, releaseStart };
  }

  itWithSecureDescriptors('answers a memory call made during start once the task is active', async () => {
    const { adapter, runner, offer, recall, releaseStart } = await memoryCallDuringBlockedStart();
    releaseStart();
    await offer;
    await expect(recall).resolves.toMatchObject({ content: 'first turn' });
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  });

  itWithMemoryMcp('fails a memory call made during start closed when the start fails', async () => {
    const { offer, recall, releaseStart } = await memoryCallDuringBlockedStart();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      releaseStart(new Error('runtime start failed'));
      await offer;
      await expect(recall).rejects.toThrow('invalid, expired, or quiescing Agent memory task context');
    } finally { consoleError.mockRestore(); }
  });

  itWithMemoryMcp.each(['bind', 'handoff', 'unexpected', 'aborted start'] as const)(
    'releases memory waiters before startup disposal after %s failure', async failure => {
      const acquire = AgentHomeManager.prototype.acquireExecution;
      const acquireSpy = vi.spyOn(AgentHomeManager.prototype, 'acquireExecution').mockImplementation(async function (this: AgentHomeManager, ...args: Parameters<typeof acquire>) {
        const binding = await acquire.apply(this, args);
        return failure === 'bind'
          ? { ...binding, lease: { ...binding.lease, bindSession: async () => { throw new Error('fixture bind failure'); } } }
          : binding;
      });
      const { adapter, runner, offer, recall, releaseStart } = await memoryCallDuringBlockedStart();
      acquireSpy.mockRestore();
      const token = reservedMcpToken(adapter.startCalls[0]?.ctx.mcpServers?.byokagentmemory);
      const handoff = vi.spyOn(runner['deps'].agentSessionHandoffs!, 'record');
      const send = vi.spyOn(runner['deps'], 'send');
      if (failure === 'handoff') handoff.mockRejectedValueOnce(new Error('fixture handoff failure'));
      if (failure === 'unexpected') send.mockImplementation(envelope => {
        if (envelope.type === 'task.started') throw new Error('fixture activation send failure');
      });
      // The aborted start returns during failure IO, before the offer's disposal check.
      const failClaimed = runner['failClaimedAgent'].bind(runner);
      const failSpy = vi.spyOn(runner as unknown as { failClaimedAgent: typeof failClaimed }, 'failClaimedAgent')
        .mockImplementation(async (...args) => {
          if (failure === 'aborted start') { releaseStart(); await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1)); }
          return failClaimed(...args);
        });
      let releaseClose!: () => void;
      const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
      let closeEntered!: () => void;
      const closing = new Promise<void>(resolve => { closeEntered = resolve; });
      adapter.decorateSession = session => {
        const close = session.close.bind(session);
        vi.spyOn(session, 'close').mockImplementation(async () => {
          closeEntered();
          // Model a runtime that drains its outstanding MCP request on close.
          await Promise.race([recall.catch(() => undefined), closeGate]);
          await close();
        });
      };
      try {
        // The startup deadline aborts this signal.
        if (failure === 'aborted start') runner['inFlightBlobAborts'].get('task-memory-start')!.abort(new Error('fixture deadline'));
        else releaseStart();
        await closing;
        expect(runner['memoryStartWaits'].size).toBe(0);
        await expect(recall).rejects.toThrow('invalid, expired, or quiescing Agent memory task context');
        await expect(runner.recallAgentMemory({ contextToken: token, path: 'MEMORY.md' }))
          .rejects.toThrow('invalid, expired, or quiescing Agent memory task context');
        await offer;
        expect(adapter.sessions[0]?.closeCalled).toBe(true);
        expect(runner['startupOwnership'].count).toBe(0);
        expect(send.mock.calls.filter(([envelope]) => envelope.type === 'task.fail')).toHaveLength(1);
        await runner.shutdownActiveTasks('fixture shutdown');
      } finally {
        releaseClose();
        await offer;
        handoff.mockRestore(); send.mockRestore(); failSpy.mockRestore();
      }
    },
  );

  it('does zero capture, audit, or network work when projection authority is incomplete', async () => {
    const { context, release } = await memory();
    let networkCalls = 0;
    try {
      await snapshotAndProjectAgentMemory(context, {
        capability: AGENT_MEMORY_PROJECTION_CAPABILITY,
        port: { publish: async () => { networkCalls += 1; return { accepted: true }; } },
      });
      expect(networkCalls).toBe(0);
      await expect(fs.readFile(path.join(context.canonicalHome, '.byok', 'agent-memory-audit-v1.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await release(); }
  });

  itWithSecureDescriptors('captures direct writes at quiescence and permits no hosted network without every authority', async () => {
    const { context, release } = await memory();
    try {
      await fs.writeFile(path.join(context.canonicalHome, 'MEMORY.md'), 'native file tool final value', 'utf8');
      await fs.writeFile(path.join(context.canonicalHome, 'notes', 'topic.md'), 'native note', 'utf8');
      await fs.mkdir(path.join(context.canonicalHome, 'notes', 'nested'), { recursive: true });
      await fs.writeFile(path.join(context.canonicalHome, 'notes', 'nested', 'topic.md'), 'native nested note', 'utf8');
      const snapshot = await captureAgentMemorySnapshot(context);
      expect(snapshot.files.map((file) => file.path)).toEqual(['MEMORY.md', 'notes/nested/topic.md', 'notes/topic.md']);
      expect(snapshot.files.find((file) => file.path === 'MEMORY.md')?.content).toBe('native file tool final value');
      let networkCalls = 0;
      await snapshotAndProjectAgentMemory(context, { capability: AGENT_MEMORY_PROJECTION_CAPABILITY, port: { publish: async () => { networkCalls += 1; return { accepted: true }; } } });
      await snapshotAndProjectAgentMemory(context, {
        grant: { grantRef: 'grant', writerEpoch: 1, policyRevision: 'policy-1' },
        redactor: { redact: () => new TextEncoder().encode('{"summary":"[redacted]"}') },
        port: { publish: async () => { networkCalls += 1; return { accepted: true }; } },
      });
      await expect(snapshotAndProjectAgentMemory(context, {
        capability: AGENT_MEMORY_PROJECTION_CAPABILITY,
        grant: { grantRef: 'grant', writerEpoch: 1, policyRevision: 'policy-1' },
        redactor: { redact: (value) => new TextEncoder().encode(JSON.stringify({ files: value.files.map((file) => ({ path: file.path, revision: file.revision, byteCount: file.byteCount, content: file.content })) })) },
        port: { publish: async () => { networkCalls += 1; return { accepted: true }; } },
      })).rejects.toBeInstanceOf(AgentMemoryError);
      expect(networkCalls).toBe(0);
      await snapshotAndProjectAgentMemory(context, {
        capability: AGENT_MEMORY_PROJECTION_CAPABILITY,
        grant: { grantRef: 'grant', writerEpoch: 1, policyRevision: 'policy-1' },
        redactor: { redact: () => new TextEncoder().encode('{"summary":"[redacted]"}') },
        port: { publish: async ({ mutation }) => {
          if (mutation.sealed !== undefined) throw new Error("plaintext projection expected");
          networkCalls += 1;
          expect(Buffer.from(mutation.snapshot.redactedBytes, 'base64url').toString('utf8')).toContain('[redacted]');
          expect(JSON.stringify(mutation)).not.toContain('native file tool final value');
          expect(JSON.stringify(mutation)).not.toContain('notes/topic.md');
          expect(mutation.sourceSeq).toBe(1);
          return { accepted: true };
        } },
      });
      expect(networkCalls).toBe(1);
      const outbox = await AgentMemoryRedactedOutbox.open(context, { grantRef: 'grant', writerEpoch: 1, policyRevision: 'policy-1' });
      expect(outbox.pending()).toEqual([]);
      const rawOutbox = await fs.readFile(path.join(context.canonicalHome, '.byok', 'agent-memory-redacted-outbox-v2.json'), 'utf8');
      expect(rawOutbox).toContain('"version":3');
      expect(rawOutbox).not.toContain('eyJzdW1tYXJ5IjoiW3JlZGFjdGVkXSJ9');
      expect(rawOutbox).not.toContain('native file tool final value');
      expect(JSON.parse(rawOutbox)).toMatchObject({
        currentWriterEpoch: 1,
        sealing: null,
        highWater: [{ writerEpoch: 1, sourceSeq: 1 }],
        pending: [],
      });
    } finally { await release(); }
  });

  itWithSecureDescriptors('keeps recall, replace, and delete pinned to the opened notes descriptor during a parent-symlink race', async () => {
    const { context, release } = await memory();
    const notes = path.join(context.canonicalHome, 'notes');
    const outside = await root();
    const held = path.join(context.canonicalHome, 'notes-held');
    const fileName = 'race.md';
    const originalOpen = fs.open.bind(fs);

    const runWithSwap = async <T>(inside: string, operation: (service: AgentMemoryService) => Promise<T>): Promise<T> => {
      await fs.writeFile(path.join(notes, fileName), inside, 'utf8');
      await fs.writeFile(path.join(outside, fileName), 'outside sentinel', 'utf8');
      let swapped = false;
      const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (!swapped && typeof args[0] === 'string' && args[0].endsWith('/notes')) {
          await fs.rename(notes, held);
          await fs.symlink(outside, notes);
          swapped = true;
        }
        return handle;
      });
      try {
        const result = await operation(new AgentMemoryService(context));
        expect(swapped).toBe(true);
        expect(await fs.readFile(path.join(outside, fileName), 'utf8')).toBe('outside sentinel');
        return result;
      } finally {
        spy.mockRestore();
        await fs.unlink(notes).catch(() => {});
        await fs.rename(held, notes).catch(() => {});
      }
    };

    try {
      await expect(runWithSwap('inside recall', (service) => service.recall({ path: `notes/${fileName}` }))).resolves.toMatchObject({ content: 'inside recall' });
      await runWithSwap('inside replace', (service) => service.save({ op: 'replace', path: `notes/${fileName}`, expectedRevision: sha256('inside replace'), content: 'replaced inside' }));
      expect(await fs.readFile(path.join(notes, fileName), 'utf8')).toBe('replaced inside');
      await runWithSwap('inside delete', (service) => service.save({ op: 'delete', path: `notes/${fileName}`, expectedRevision: sha256('inside delete') }));
      await expect(fs.readFile(path.join(notes, fileName), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await release(); }
  });

  it('fails closed where Node lacks a safe descriptor-relative primitive', async () => {
    if (process.platform === 'linux') return;
    const { context, release } = await memory();
    try {
      await expect(new AgentMemoryService(context).recall({ path: 'MEMORY.md' })).rejects.toThrow('lacks safe descriptor-relative filesystem operations');
      await expect(captureAgentMemorySnapshot(context)).rejects.toThrow('lacks safe descriptor-relative filesystem operations');
    } finally { await release(); }
  });
});
