import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  snapshotAndProjectAgentMemory,
  type AgentMemoryTaskContext,
} from '../daemon/agent-memory';
import type {
  AgentMemoryFilesystem,
  AgentMemoryFilesystemFileState,
} from '../daemon/agent-memory-filesystem';

const encoder = new TextEncoder();

function revision(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

class InMemoryFilesystem implements AgentMemoryFilesystem {
  readonly files = new Map<string, string>([['MEMORY.md', 'local authority']]);

  async read(filePath: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    const content = this.files.get(filePath);
    const value = content ?? '';
    const byteCount = encoder.encode(value).byteLength;
    if (byteCount > maxBytes) throw new Error('size_limit');
    return { exists: content !== undefined, content: value, revision: revision(value), byteCount };
  }

  async replace(filePath: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    if ((await this.read(filePath, maxBytes)).revision !== expectedRevision) throw new Error('revision_conflict');
    const byteCount = encoder.encode(content).byteLength;
    if (byteCount > maxBytes) throw new Error('size_limit');
    this.files.set(filePath, content);
    return { exists: true, content, revision: revision(content), byteCount };
  }

  async delete(): Promise<void> { throw new Error('not_used'); }
  async append(): Promise<void> { throw new Error('not_used'); }
  async walk(): Promise<readonly string[]> { return []; }
  async close(): Promise<void> {}
}

function context(filesystem: AgentMemoryFilesystem): AgentMemoryTaskContext {
  return {
    taskId: 'projection-timeout-task',
    tenantId: 'tenant-projection-timeout',
    deviceId: 'device-projection-timeout',
    agentRef: { agentId: 'projection-timeout-agent', profileRevision: 'profile-r1' },
    sessionRef: 'projection-timeout-session',
    runtimeId: 'codex',
    canonicalHome: '/tmp/byok-agent-memory-projection-timeout',
    leaseId: 'projection-timeout-lease',
    homeIdentity: { dev: 1n, ino: 1n },
    filesystem,
  };
}

describe('Agent-memory projection publish timeout P1 regression', () => {
  it('bounds a hosted publish that never settles before task-terminal cleanup can await it', async () => {
    vi.useFakeTimers();
    try {
      const filesystem = new InMemoryFilesystem();
      let publishCalls = 0;
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void snapshotAndProjectAgentMemory(context(filesystem), {
        capability: 'agent.memory.projection',
        grant: { grantRef: 'projection-timeout-grant', writerEpoch: 1, policyRevision: 'projection-timeout-policy' },
        redactor: { redact: () => encoder.encode('{"summary":"redacted"}') },
        port: {
          publish: async () => {
            publishCalls += 1;
            return new Promise<{ readonly accepted: boolean }>(() => {});
          },
        },
      }).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );

      await vi.advanceTimersByTimeAsync(10_000);

      expect(publishCalls).toBe(1);
      expect(outcome).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });
});
