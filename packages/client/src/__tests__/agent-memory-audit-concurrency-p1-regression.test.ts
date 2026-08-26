import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_AUDIT_FILENAME,
  AgentMemoryError,
  AgentMemoryRevisionConflictError,
  AgentMemoryService,
  captureAgentMemorySnapshot,
  type AgentMemoryTaskContext,
} from '../daemon/agent-memory';
import type {
  AgentMemoryFilesystem,
  AgentMemoryFilesystemFileState,
} from '../daemon/agent-memory-filesystem';

const AUDIT_PATH = `.byok/${AGENT_MEMORY_AUDIT_FILENAME}`;

function revision(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function state(content: string | undefined): AgentMemoryFilesystemFileState {
  const value = content ?? '';
  return Object.freeze({
    exists: content !== undefined,
    content: value,
    revision: revision(value),
    byteCount: Buffer.byteLength(value, 'utf8'),
  });
}

class AuditRaceFilesystem implements AgentMemoryFilesystem {
  readonly files = new Map<string, string>([['MEMORY.md', 'durable memory']]);
  activeAuditReads = 0;
  maxConcurrentAuditReads = 0;

  constructor(private readonly failAuditReplace = false) {}

  async read(filePath: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    const value = this.files.get(filePath);
    if (value !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new AgentMemoryError('memory file is not a bounded regular file');
    }
    if (filePath !== AUDIT_PATH) return state(value);

    this.activeAuditReads += 1;
    this.maxConcurrentAuditReads = Math.max(this.maxConcurrentAuditReads, this.activeAuditReads);
    try {
      // Hold the audit read across one event-loop turn. Without the shared
      // per-home writer queue, concurrent operations both capture the same CAS
      // revision and one later fails after its source read already succeeded.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return state(this.files.get(filePath));
    } finally {
      this.activeAuditReads -= 1;
    }
  }

  async replace(filePath: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    if (filePath === AUDIT_PATH && this.failAuditReplace) {
      throw new AgentMemoryError('audit persistence rejected');
    }
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new AgentMemoryError('memory content exceeds its bounded file size');
    }
    const current = state(this.files.get(filePath));
    if (current.revision !== expectedRevision) {
      throw new AgentMemoryRevisionConflictError(expectedRevision, current.revision);
    }
    this.files.set(filePath, content);
    return state(content);
  }

  async delete(filePath: string, expectedRevision: string): Promise<void> {
    const current = state(this.files.get(filePath));
    if (current.revision !== expectedRevision) {
      throw new AgentMemoryRevisionConflictError(expectedRevision, current.revision);
    }
    this.files.delete(filePath);
  }

  async append(): Promise<void> {}
  async walk(): Promise<readonly string[]> { return Object.freeze([]); }
  async close(): Promise<void> {}
}

function context(filesystem: AgentMemoryFilesystem, suffix: string): AgentMemoryTaskContext {
  return Object.freeze({
    taskId: `task-audit-${suffix}`,
    tenantId: 'tenant-audit',
    deviceId: 'device-audit',
    agentRef: Object.freeze({ agentId: 'agent-audit', profileRevision: 'p1' }),
    sessionRef: `session-audit-${suffix}`,
    runtimeId: 'codex',
    canonicalHome: '/virtual/agent-audit',
    leaseId: `lease-audit-${suffix}`,
    homeIdentity: Object.freeze({ dev: 1n, ino: 2n }),
    filesystem,
  });
}

function auditEntries(filesystem: AuditRaceFilesystem): readonly Record<string, unknown>[] {
  return Object.freeze((filesystem.files.get(AUDIT_PATH) ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>));
}

describe('Agent memory metadata-only audit concurrency P1 regression', () => {
  it('serializes concurrent recalls through the per-home audit writer', async () => {
    const filesystem = new AuditRaceFilesystem();
    const first = new AgentMemoryService(context(filesystem, 'recall-a'));
    const second = new AgentMemoryService(context(filesystem, 'recall-b'));

    const recalled = await Promise.all([
      first.recall({ path: 'MEMORY.md' }),
      second.recall({ path: 'MEMORY.md' }),
    ]);

    expect(recalled.map((value) => value.content)).toEqual(['durable memory', 'durable memory']);
    expect(filesystem.maxConcurrentAuditReads).toBe(1);
    expect(auditEntries(filesystem).map((entry) => entry.kind)).toEqual(['recall', 'recall']);
  });

  it('serializes recall audit with save mutation and audit for the same Agent home', async () => {
    const filesystem = new AuditRaceFilesystem();
    const recallService = new AgentMemoryService(context(filesystem, 'recall'));
    const saveService = new AgentMemoryService(context(filesystem, 'save'));

    const [recalled, saved] = await Promise.all([
      recallService.recall({ path: 'MEMORY.md' }),
      saveService.save({
        op: 'replace',
        path: 'MEMORY.md',
        expectedRevision: revision('durable memory'),
        content: 'updated memory',
      }),
    ]);

    expect(recalled.content).toBe('durable memory');
    expect(saved).toMatchObject({ deleted: false, revision: revision('updated memory') });
    expect(filesystem.maxConcurrentAuditReads).toBe(1);
    expect(auditEntries(filesystem).map((entry) => entry.kind).sort()).toEqual(['recall', 'save']);
  });

  it('serializes recall audit with quiescence snapshot audit for the same Agent home', async () => {
    const filesystem = new AuditRaceFilesystem();
    const recallContext = context(filesystem, 'recall-snapshot');
    const snapshotContext = context(filesystem, 'snapshot');

    const [recalled, snapshot] = await Promise.all([
      new AgentMemoryService(recallContext).recall({ path: 'MEMORY.md' }),
      captureAgentMemorySnapshot(snapshotContext),
    ]);

    expect(recalled.content).toBe('durable memory');
    expect(snapshot.files).toHaveLength(1);
    expect(filesystem.maxConcurrentAuditReads).toBe(1);
    expect(auditEntries(filesystem).map((entry) => entry.kind).sort()).toEqual(['recall', 'snapshot']);
  });

  it('returns recalled source content with a metadata-only warning when audit persistence fails', async () => {
    const filesystem = new AuditRaceFilesystem(true);
    const service = new AgentMemoryService(context(filesystem, 'warning'));

    await expect(service.recall({ path: 'MEMORY.md' })).resolves.toMatchObject({
      path: 'MEMORY.md',
      revision: revision('durable memory'),
      content: 'durable memory',
      auditWarning: { code: 'agent_memory_audit_unavailable' },
    });
  });
});
