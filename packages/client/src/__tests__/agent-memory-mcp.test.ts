import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_PROJECTION_CAPABILITY } from '@byok-sdk/protocol';

import { AgentHomeManager } from '../agent-home';
import {
  AgentMemoryError,
  AgentMemoryRedactedOutbox,
  AgentMemoryRevisionConflictError,
  AgentMemoryService,
  captureAgentMemorySnapshot,
  snapshotAndProjectAgentMemory,
  type AgentMemoryTaskContext,
} from '../daemon/agent-memory';
import { handleAgentMemoryMcpRequest } from '../bin/agent-memory-mcp-server';
import { McpToolsetRegistry } from '../daemon/toolset-registry';

const roots: string[] = [];
const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const itWithSecureDescriptors = process.platform === 'linux' ? it : it.skip;

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

  it('validates the MCP surface without exposing identity or a memory root parameter', async () => {
    const calls: string[] = [];
    const deps = {
      recall: async (input: { path: string; ifRevision?: string }) => { calls.push(`recall:${input.path}`); return { path: input.path, revision: sha256('v'), content: 'v' }; },
      save: async (input: { op: 'replace' | 'delete'; path: string; expectedRevision: string; content?: string }) => { calls.push(`save:${input.path}`); return { path: input.path, revision: sha256(input.content ?? ''), deleted: input.op === 'delete' }; },
    };
    const list = await handleAgentMemoryMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps);
    expect(JSON.stringify(list)).toContain('memory.recall');
    expect(JSON.stringify(list)).toContain('memory.save');
    expect(JSON.stringify(list)).not.toContain('tenantId');
    const bad = await handleAgentMemoryMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.save', arguments: { op: 'delete', path: 'notes/a.md', expectedRevision: sha256(''), content: 'forbidden' } } }, deps);
    expect(bad?.error).toBeDefined();
    await handleAgentMemoryMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.recall', arguments: { path: 'MEMORY.md' } } }, deps);
    expect(calls).toEqual(['recall:MEMORY.md']);
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
      const rawOutbox = await fs.readFile(path.join(context.canonicalHome, '.byok', 'agent-memory-redacted-outbox-v1.jsonl'), 'utf8');
      expect(rawOutbox).toContain('eyJzdW1tYXJ5IjoiW3JlZGFjdGVkXSJ9');
      expect(rawOutbox).not.toContain('native file tool final value');
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
