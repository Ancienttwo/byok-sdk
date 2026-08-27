import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_MAX_LOCAL_LOG_BYTES,
  AGENT_MEMORY_OUTBOX_FILENAME,
  AgentMemoryRedactedOutbox,
  type AgentMemoryTaskContext,
} from '../daemon/agent-memory';
import { AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES } from '@byok-sdk/protocol';
import type {
  AgentMemoryFilesystem,
  AgentMemoryFilesystemFileState,
} from '../daemon/agent-memory-filesystem';

const encoder = new TextEncoder();

function revision(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

class InMemoryFilesystem implements AgentMemoryFilesystem {
  readonly files = new Map<string, string>();

  async read(filePath: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    const content = this.files.get(filePath);
    if (content === undefined) return { exists: false, content: '', revision: revision(''), byteCount: 0 };
    const byteCount = encoder.encode(content).byteLength;
    if (byteCount > maxBytes) throw new Error('size_limit');
    return { exists: true, content, revision: revision(content), byteCount };
  }

  async replace(filePath: string, _expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    const byteCount = encoder.encode(content).byteLength;
    if (byteCount > maxBytes) throw new Error('size_limit');
    this.files.set(filePath, content);
    return { exists: true, content, revision: revision(content), byteCount };
  }

  async delete(filePath: string, _expectedRevision: string): Promise<void> {
    this.files.delete(filePath);
  }

  async append(filePath: string, content: string, maxBytes: number): Promise<void> {
    const next = `${this.files.get(filePath) ?? ''}${content}`;
    if (encoder.encode(next).byteLength > maxBytes) throw new Error('size_limit');
    this.files.set(filePath, next);
  }

  async walk(): Promise<readonly string[]> {
    return [];
  }

  async close(): Promise<void> {}
}

function taskContext(filesystem: AgentMemoryFilesystem, taskId: string, sessionRef: string): AgentMemoryTaskContext {
  return {
    taskId,
    tenantId: 'tenant-memory',
    deviceId: 'device-memory',
    agentRef: { agentId: 'agent-memory', profileRevision: 'profile-r1' },
    sessionRef,
    runtimeId: 'codex',
    canonicalHome: '/tmp/byok-agent-memory-outbox-p1',
    leaseId: `lease-${taskId}`,
    homeIdentity: { dev: 1n, ino: 1n },
    filesystem,
  };
}

const grant = { grantRef: 'grant-memory', writerEpoch: 1, policyRevision: 'policy-r1' } as const;

describe('Agent-memory projection outbox P1 regression', () => {
  it('replays a pending prior task/session mutation before assigning a later sequence', async () => {
    const filesystem = new InMemoryFilesystem();
    const first = await AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-a', 'session-a'), grant);
    const firstRecord = await first.append(encoder.encode('{"summary":"first"}'));
    const pendingReplay = await first.replay({ publish: async () => ({ accepted: false }) });
    expect(first.pending()).toEqual([firstRecord]);
    expect(pendingReplay).toMatchObject({
      status: 'pending', writerEpoch: 1, sourceSeq: 1, mutationId: firstRecord.mutation.mutationId,
    });
    expect(Object.isFrozen(pendingReplay)).toBe(true);
    expect(JSON.stringify(pendingReplay)).not.toContain('summary');

    const later = await AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-b', 'session-b'), grant);
    const delivered: Array<{ taskId: string; sessionRef: string; sourceSeq: number }> = [];

    // A same-epoch outbox is not allowed to mint sourceSeq 2 until it drains
    // immutable seq 1 with task-a/session-a's original grant binding.
    await expect(later.append(encoder.encode('{"summary":"second"}'))).rejects.toThrow('pending projection mutations');
    const drainedReplay = await later.replay({
      publish: async ({ mutation }) => {
        delivered.push({ taskId: mutation.taskId, sessionRef: mutation.sessionRef, sourceSeq: mutation.sourceSeq });
        return { accepted: true };
      },
    });
    expect(drainedReplay).toEqual({ status: 'drained' });
    expect(Object.isFrozen(drainedReplay)).toBe(true);
    const secondRecord = await later.append(encoder.encode('{"summary":"second"}'));
    await later.replay({
      publish: async ({ mutation }) => {
        delivered.push({ taskId: mutation.taskId, sessionRef: mutation.sessionRef, sourceSeq: mutation.sourceSeq });
        return { accepted: true };
      },
    });

    expect(delivered).toEqual([
      { taskId: 'task-a', sessionRef: 'session-a', sourceSeq: 1 },
      { taskId: 'task-b', sessionRef: 'session-b', sourceSeq: 2 },
    ]);
    expect(later.pending()).toEqual([]);
    expect(secondRecord.mutation.sourceSeq).toBe(2);
  });

  it('allows only a strictly newer writer epoch to supersede pending state and reset sourceSeq', async () => {
    const filesystem = new InMemoryFilesystem();
    const first = await AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-a', 'session-a'), grant);
    await first.append(encoder.encode('{"summary":"first"}'));

    const sameEpoch = await AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-b', 'session-b'), grant);
    await expect(sameEpoch.append(encoder.encode('{"summary":"same-epoch"}'))).rejects.toThrow('pending projection mutations');

    const nextGrant = { ...grant, writerEpoch: 2 } as const;
    const nextEpoch = await AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-c', 'session-c'), nextGrant);
    expect(nextEpoch.pending()).toEqual([]);
    expect(JSON.parse(filesystem.files.get(`.byok/${AGENT_MEMORY_OUTBOX_FILENAME}`) ?? '{}')).toMatchObject({
      currentWriterEpoch: 2, highWater: [], pending: [],
    });
    expect((await nextEpoch.append(encoder.encode('{"summary":"new-epoch"}'))).mutation.sourceSeq).toBe(1);
    const state = JSON.parse(filesystem.files.get(`.byok/${AGENT_MEMORY_OUTBOX_FILENAME}`) ?? '{}') as {
      readonly currentWriterEpoch: number;
      readonly highWater: readonly { readonly writerEpoch: number; readonly sourceSeq: number }[];
    };
    expect(state.highWater).toEqual([{ writerEpoch: state.currentWriterEpoch, sourceSeq: 1 }]);
    expect(state.highWater).toHaveLength(1);
    await expect(AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-a', 'session-a'), grant)).rejects.toThrow('writer epoch is stale');
  });

  it('fits one maximum redacted snapshot in the 1 MiB state bound and fails closed for an oversized persisted state', async () => {
    const filesystem = new InMemoryFilesystem();
    const outbox = await AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-a', 'session-a'), grant);
    await outbox.append(new Uint8Array(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES));
    const filePath = `.byok/${AGENT_MEMORY_OUTBOX_FILENAME}`;
    expect(encoder.encode(filesystem.files.get(filePath) ?? '').byteLength).toBeLessThanOrEqual(AGENT_MEMORY_MAX_LOCAL_LOG_BYTES);

    filesystem.files.set(filePath, 'x'.repeat(AGENT_MEMORY_MAX_LOCAL_LOG_BYTES + 1));
    await expect(AgentMemoryRedactedOutbox.open(taskContext(filesystem, 'task-a', 'session-a'), grant)).rejects.toThrow('size_limit');
  });
});
