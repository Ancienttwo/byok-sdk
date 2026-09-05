import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEvent, type BlobRef, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * `DaemonConfig.maxInlineEventBytes` end to end through `TaskRunner.pump`:
 * an oversized `tool_result` reaching the wire as a preview plus a `spill`
 * descriptor, the omitted bytes landing in the blob plane verbatim, and the
 * whole-task `maxTaskOutputBytes` accounting counting the POST-spill size —
 * a task that spills is not a task that flooded. See
 * `event-spill.test.ts` for the policy's own unit-level invariants.
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface RecordedUpload {
  content: string;
  contentType: string;
  idempotencyKey?: string;
}

function fakeBlobClient(options: { fail?: Error } = {}) {
  const uploads: RecordedUpload[] = [];
  const client: BlobResolver = {
    resolveInstruction: async () => {
      throw new Error('not used in this test');
    },
    uploadArtifact: async (content, contentType, uploadOptions) => {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      uploads.push({
        content: new TextDecoder().decode(bytes),
        contentType,
        ...(uploadOptions?.idempotencyKey === undefined ? {} : { idempotencyKey: uploadOptions.idempotencyKey }),
      });
      if (options.fail) throw options.fail;
      const ref: BlobRef = {
        blobId: `blob_${uploads.length}`,
        contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
        contentType,
      };
      return ref;
    },
  };
  return { client, uploads };
}

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  blobClient: BlobResolver,
  overrides: Partial<Pick<TaskRunnerDeps, 'maxInlineEventBytes' | 'maxTaskOutputBytes'>> = {},
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-spill-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-spill-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    maxInlineEventBytes: overrides.maxInlineEventBytes,
    maxTaskOutputBytes: overrides.maxTaskOutputBytes,
  };
  return new TaskRunner(deps);
}

function progressEvents(sent: Envelope[], taskId: string): AgentEvent[] {
  return sent
    .filter((envelope) => envelope.type === 'task.progress' && envelope.task_id === taskId)
    .flatMap((envelope) => (envelope.payload as { events: AgentEvent[] }).events);
}

const OUTPUT_300_KIB = { stdout: 'S'.repeat(300 * 1024), exitCode: 0 };

describe('TaskRunner: maxInlineEventBytes spill to the blob plane', () => {
  it('sends a preview + spill.blob, uploads the original serialization, and counts only the post-spill bytes against maxTaskOutputBytes', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { client, uploads } = fakeBlobClient();
    // 300 KiB of tool output against a 128 KiB whole-task cap: this MUST NOT
    // trip the cap, because the event is bounded to 64 KiB before it is
    // counted. Without the spill hook this task fails.
    const runner = await makeRunner(adapter, sent, client, {
      maxInlineEventBytes: 64 * 1024,
      maxTaskOutputBytes: 128 * 1024,
    });

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-spill', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    session!.emit({ type: 'tool_result', tool: 'bash', toolCallId: 'call-1', output: OUTPUT_300_KIB });
    session!.emit({ type: 'turn_end' });

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-spill')).toBe(true);
    });
    expect(sent.some((e) => e.type === 'task.fail')).toBe(false);

    const events = progressEvents(sent, 'task-spill');
    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult).toBeDefined();

    const serialized = JSON.stringify(OUTPUT_300_KIB);
    const spill = (toolResult as { spill?: Record<string, unknown> }).spill;
    expect(spill).toBeDefined();
    expect(spill).toMatchObject({
      field: 'output',
      contentType: 'application/json',
      totalBytes: Buffer.byteLength(serialized, 'utf8'),
    });
    expect(spill?.['unstoredReason']).toBeUndefined();
    const blob = spill?.['blob'] as BlobRef;
    expect(blob.contentHash).toBe(`sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`);

    const preview = (toolResult as { output: { preview: { head: string; tail: string } } }).output.preview;
    expect(serialized.startsWith(preview.head)).toBe(true);
    expect(serialized.endsWith(preview.tail)).toBe(true);

    // The envelope that actually crossed the wire is bounded.
    const envelope = sent.find(
      (e) => e.type === 'task.progress' && JSON.stringify(e).includes('"spill"'),
    );
    expect(Buffer.byteLength(JSON.stringify(envelope!.payload), 'utf8')).toBeLessThanOrEqual(70 * 1024);

    // The blob holds the omitted bytes verbatim.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.content).toBe(serialized);
    expect(uploads[0]?.contentType).toBe('application/json');
    expect(uploads[0]?.idempotencyKey).toBe(
      `spill_task-spill_${createHash('sha256').update(serialized, 'utf8').digest('hex')}`,
    );
  });

  it('carries unstoredReason and still completes the task when the blob upload rejects', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { client, uploads } = fakeBlobClient({ fail: new Error('blob store unavailable: HTTP 503') });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = await makeRunner(adapter, sent, client, {
      maxInlineEventBytes: 64 * 1024,
      maxTaskOutputBytes: 128 * 1024,
    });

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-unstored', seq: 1 }),
    );
    const session = adapter.sessions[0];
    session!.emit({ type: 'tool_use', tool: 'write_file', input: OUTPUT_300_KIB });
    session!.emit({ type: 'turn_end' });

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-unstored')).toBe(true);
    });
    expect(sent.some((e) => e.type === 'task.fail')).toBe(false);

    const toolUse = progressEvents(sent, 'task-unstored').find((event) => event.type === 'tool_use');
    const spill = (toolUse as { spill?: Record<string, unknown> }).spill;
    expect(spill?.['blob']).toBeUndefined();
    expect(spill?.['field']).toBe('input');
    expect(spill?.['unstoredReason']).toContain('HTTP 503');
    expect(uploads).toHaveLength(1);
    // Never silent: the daemon logged the lost content exactly once.
    expect(diagnostic.mock.calls.filter((call) => String(call[0]).includes('could not be stored'))).toHaveLength(1);
    diagnostic.mockRestore();
  });

  it('leaves an under-cap tool_result byte-identical on the wire', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { client, uploads } = fakeBlobClient();
    const runner = await makeRunner(adapter, sent, client, { maxInlineEventBytes: 64 * 1024 });

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-small', seq: 1 }),
    );
    const session = adapter.sessions[0];
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', toolCallId: 'c1', output: { stdout: 'ok' } };
    session!.emit(event);
    session!.emit({ type: 'turn_end' });

    await vi.waitFor(() => {
      expect(sent.some((e) => e.type === 'task.complete' && e.task_id === 'task-small')).toBe(true);
    });
    expect(progressEvents(sent, 'task-small')).toContainEqual(event);
    expect(uploads).toHaveLength(0);
  });
});
