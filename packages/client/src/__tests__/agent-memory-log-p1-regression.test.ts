import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentHomeManager } from '../agent-home';
import {
  AGENT_MEMORY_AUDIT_FILENAME,
  AGENT_MEMORY_MAX_LOCAL_LOG_BYTES,
  AGENT_MEMORY_OUTBOX_FILENAME,
  AgentMemoryError,
  AgentMemoryRedactedOutbox,
  AgentMemoryService,
  isAgentMemorySecureFilesystemAvailable,
  snapshotAndProjectAgentMemory,
  type AgentMemoryTaskContext,
} from '../daemon/agent-memory';
import type { AgentMemoryFilesystem, AgentMemoryFilesystemFileState } from '../daemon/agent-memory-filesystem';

const MAX_LOCAL_LOG_BYTES = AGENT_MEMORY_MAX_LOCAL_LOG_BYTES;
const roots: string[] = [];
const itWithNativeDescriptors = isAgentMemorySecureFilesystemAvailable() ? it : it.skip;

function revision(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function state(content: string | undefined): AgentMemoryFilesystemFileState {
  const value = content ?? '';
  return Object.freeze({ exists: content !== undefined, content: value, revision: revision(value), byteCount: Buffer.byteLength(value, 'utf8') });
}

class BoundedFilesystem implements AgentMemoryFilesystem {
  readonly files = new Map<string, string>();
  constructor(private readonly failure?: { readonly filePath: string; readonly error: Error }) {}

  async read(filePath: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    const value = this.files.get(filePath);
    if (value !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) throw new AgentMemoryError('memory file is not a bounded regular file');
    return state(value);
  }

  async replace(filePath: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    if (this.failure?.filePath === filePath) throw this.failure.error;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new AgentMemoryError('memory content exceeds its bounded file size');
    if (state(this.files.get(filePath)).revision !== expectedRevision) throw new AgentMemoryError('revision conflict');
    this.files.set(filePath, content);
    return state(content);
  }

  async delete(filePath: string, expectedRevision: string): Promise<void> {
    if (state(this.files.get(filePath)).revision !== expectedRevision) throw new AgentMemoryError('revision conflict');
    this.files.delete(filePath);
  }

  async append(filePath: string, content: string, maxBytes: number): Promise<void> {
    const prior = this.files.get(filePath) ?? '';
    if (Buffer.byteLength(prior, 'utf8') + Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new AgentMemoryError('file exceeds the requested byte limit');
    }
    this.files.set(filePath, prior + content);
  }

  async walk(): Promise<readonly string[]> { return Object.freeze([]); }
  async close(): Promise<void> {}
}

async function memory(filesystem?: AgentMemoryFilesystem): Promise<{ context: AgentMemoryTaskContext; release: () => Promise<void> }> {
  const hostStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-memory-log-p1-'));
  roots.push(hostStorageRoot);
  const binding = await new AgentHomeManager({ hostStorageRoot }).prepare({ agentId: 'agent-memory-log-p1', profileRevision: 'p1' });
  return {
    context: {
      taskId: 'task-memory-log-p1', tenantId: 'tenant-memory-log-p1', deviceId: 'device-memory-log-p1',
      agentRef: binding.resolution.agentRef, sessionRef: 'session-memory-log-p1', runtimeId: 'codex',
      canonicalHome: binding.resolution.canonicalHome, leaseId: binding.lease.leaseId, homeIdentity: binding.lease.homeIdentity,
      ...(filesystem === undefined ? {} : { filesystem }),
    },
    release: () => binding.lease.release(),
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('Agent memory local log P1 regressions', () => {
  itWithNativeDescriptors('atomically rotates the native metadata-only audit tail at the 1 MiB local-log limit', async () => {
    const { context, release } = await memory();
    try {
      expect(AGENT_MEMORY_MAX_LOCAL_LOG_BYTES).toBe(1024 * 1024);
      await fs.writeFile(path.join(context.canonicalHome, '.byok', AGENT_MEMORY_AUDIT_FILENAME), 'x'.repeat(MAX_LOCAL_LOG_BYTES), { mode: 0o600 });
      await expect(new AgentMemoryService(context).recall({ path: 'MEMORY.md' })).resolves.toMatchObject({ path: 'MEMORY.md' });
      const audit = await fs.readFile(path.join(context.canonicalHome, '.byok', AGENT_MEMORY_AUDIT_FILENAME), 'utf8');
      expect(Buffer.byteLength(audit, 'utf8')).toBeLessThanOrEqual(MAX_LOCAL_LOG_BYTES);
      expect(audit).toContain('"kind":"recall"');
      expect(audit).not.toContain('x'.repeat(1024));
    } finally { await release(); }
  });

  itWithNativeDescriptors('rejects a concurrently replaced native redacted outbox state', async () => {
    const { context, release } = await memory();
    try {
      const outbox = await AgentMemoryRedactedOutbox.open(context, { grantRef: 'grant-native-p1', writerEpoch: 1, policyRevision: 'policy-native-p1' });
      await fs.writeFile(path.join(context.canonicalHome, '.byok', AGENT_MEMORY_OUTBOX_FILENAME), 'x'.repeat(MAX_LOCAL_LOG_BYTES), { mode: 0o600 });
      await expect(outbox.append(new Uint8Array([1]))).rejects.toThrow('revision conflict');
    } finally { await release(); }
  });

  it('returns a metadata-only warning when audit persistence fails after a source replacement', async () => {
    const filesystem = new BoundedFilesystem({
      filePath: `.byok/${AGENT_MEMORY_AUDIT_FILENAME}`,
      error: new AgentMemoryError('audit persistence rejected'),
    });
    const { context, release } = await memory(filesystem);
    try {
      await expect(new AgentMemoryService(context).save({
        op: 'replace', path: 'MEMORY.md', expectedRevision: revision(''), content: 'must remain absent without audit',
      })).resolves.toMatchObject({
        deleted: false,
        auditWarning: { code: 'agent_memory_audit_unavailable' },
      });
      expect(filesystem.files.get('MEMORY.md')).toBe('must remain absent without audit');
    } finally { await release(); }
  });

  it('keeps local save independent when a full/failed outbox blocks only projection', async () => {
    const filesystem = new BoundedFilesystem({
      filePath: `.byok/${AGENT_MEMORY_OUTBOX_FILENAME}`,
      error: new AgentMemoryError('outbox state exceeds its bounded size'),
    });
    const { context, release } = await memory(filesystem);
    try {
      const saved = await new AgentMemoryService(context).save({
        op: 'replace', path: 'MEMORY.md', expectedRevision: revision(''), content: 'local authority survives projection pressure',
      });
      expect(saved.auditWarning).toBeUndefined();
      await expect(snapshotAndProjectAgentMemory(context, {
        capability: 'agent.memory.projection',
        grant: { grantRef: 'grant-p1', writerEpoch: 1, policyRevision: 'policy-p1' },
        redactor: { redact: () => new TextEncoder().encode('{"summary":"redacted"}') },
        port: { publish: async () => ({ accepted: true }) },
      })).rejects.toThrow('outbox state exceeds its bounded size');
      expect(filesystem.files.get('MEMORY.md')).toBe('local authority survives projection pressure');
    } finally { await release(); }
  });
});
