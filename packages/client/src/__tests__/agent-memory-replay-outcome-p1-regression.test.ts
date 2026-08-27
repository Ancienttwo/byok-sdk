import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_OUTBOX_FILENAME,
  AgentMemoryProjectionReplayPendingError,
  AgentMemoryRedactedOutbox,
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
  readonly reads: string[] = [];

  async read(filePath: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    this.reads.push(filePath);
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
    taskId: 'task-a',
    tenantId: 'tenant-memory',
    deviceId: 'device-memory',
    agentRef: { agentId: 'agent-memory', profileRevision: 'profile-r1' },
    sessionRef: 'session-a',
    runtimeId: 'codex',
    canonicalHome: '/tmp/byok-agent-memory-replay-outcome-p1',
    leaseId: 'lease-a',
    homeIdentity: { dev: 1n, ino: 1n },
    filesystem,
  };
}

describe('Agent-memory trailing replay P1 regression', () => {
  const grant = { grantRef: 'grant-memory', writerEpoch: 1, policyRevision: 'policy-r1' } as const;

  it('fails before capture, audit, redaction, or a new sequence when initial replay remains pending', async () => {
    const filesystem = new InMemoryFilesystem();
    const seeded = await AgentMemoryRedactedOutbox.open(context(filesystem), grant);
    const pending = await seeded.append(encoder.encode('{"summary":"existing"}'));
    filesystem.reads.splice(0);
    let redactorCalls = 0;

    await expect(snapshotAndProjectAgentMemory(context(filesystem), {
      capability: 'agent.memory.projection',
      grant,
      redactor: { redact: () => { redactorCalls += 1; return encoder.encode('{"summary":"new"}'); } },
      port: { publish: async () => ({ accepted: false }) },
    })).rejects.toBeInstanceOf(AgentMemoryProjectionReplayPendingError);

    expect(filesystem.reads).toEqual([`.byok/${AGENT_MEMORY_OUTBOX_FILENAME}`]);
    expect(redactorCalls).toBe(0);
    const replayed = await AgentMemoryRedactedOutbox.open(context(filesystem), grant);
    expect(replayed.pending()).toEqual([pending]);
    await expect(replayed.append(encoder.encode('{"summary":"new"}'))).rejects.toThrow('pending projection mutations');
  });

  it('rejects with the exact typed error and retains the newly appended record when trailing replay remains pending', async () => {
    const filesystem = new InMemoryFilesystem();
    let redactorCalls = 0;

    await expect(snapshotAndProjectAgentMemory(context(filesystem), {
      capability: 'agent.memory.projection',
      grant,
      redactor: { redact: () => { redactorCalls += 1; return encoder.encode('{"summary":"redacted"}'); } },
      port: { publish: async () => ({ accepted: false }) },
    })).rejects.toThrow('Agent memory projection replay remains pending');
    expect(redactorCalls).toBe(1);

    const outbox = await AgentMemoryRedactedOutbox.open(context(filesystem), grant);
    const [pending] = outbox.pending();
    expect(pending).toBeDefined();
    expect(pending?.mutation.sourceSeq).toBe(1);
    await expect(outbox.replay({ publish: async () => ({ accepted: false }) })).resolves.toMatchObject({
      status: 'pending', writerEpoch: 1, sourceSeq: 1,
    });
  });
});
