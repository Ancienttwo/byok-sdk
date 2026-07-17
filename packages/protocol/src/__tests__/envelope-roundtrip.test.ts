import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TYPES,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  parseMessage,
  type Envelope,
  type MessageType,
} from '../index';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roundTrip(type: MessageType, envelope: Envelope) {
  expect(envelope.type).toBe(type);

  const encoded = encodeEnvelope(envelope);
  expect(encoded.endsWith('\n')).toBe(true);
  expect(encoded.indexOf('\n')).toBe(encoded.length - 1); // exactly one line

  const decoded = decodeEnvelope(encoded);
  expect(decoded).toEqual(envelope);

  // parseMessage operates on an already-parsed JS value (e.g. a WS JSON frame).
  const reparsed = parseMessage(JSON.parse(encoded));
  expect(reparsed).toEqual(envelope);

  // Isomorphic requirement: decodeEnvelope must also accept raw bytes.
  const decodedFromBytes = decodeEnvelope(new TextEncoder().encode(encoded));
  expect(decodedFromBytes).toEqual(envelope);
}

const testedTypes: MessageType[] = [];

describe('envelope round-trip: every message type encodes/decodes losslessly', () => {
  it('conn.hello', () => {
    const type = 'conn.hello' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, {
        protocolVersions: [1],
        capabilities: ['steer', 'blob-upload', 'interactive-approval'],
        deviceId: 'device-1',
        productId: 'acme-agent',
        runtimes: [
          {
            id: 'claude',
            authPresent: true,
            capabilities: {
              steer: true,
              resume: true,
              approvalInteractive: false,
              permissionModes: ['auto', 'confirm', 'plan'],
            },
          },
          // Older/partial-detection shape: capabilities omitted entirely.
          { id: 'pi' },
        ],
        cursor: 41,
      }),
    );
  });

  it('conn.ack', () => {
    const type = 'conn.ack' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(
        type,
        {
          protocolVersion: 1,
          capabilities: ['steer', 'interactive-approval'],
          serverTime: new Date().toISOString(),
        },
        { seq: 1 },
      ),
    );
  });

  it('task.offer (string instruction)', () => {
    const type = 'task.offer' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(
        type,
        {
          instruction: 'refactor the widget module',
          policy: { mode: 'auto', workspaceRoot: '/home/user/project' },
          runtime: 'claude',
          workspaceHint: '/home/user/project',
          limits: { maxDurationMs: 60_000, maxTokens: 100_000 },
        },
        { taskId: 'task-1', seq: 1 },
      ),
    );
  });

  it('task.offer (blobRef instruction)', () => {
    const type = 'task.offer' as const;
    roundTrip(
      type,
      createEnvelope(
        type,
        {
          instruction: {
            blobRef: {
              blobId: 'blob-1',
              contentHash: `sha256:${'deadbeef'.repeat(8)}`, // finding F9: must be 64 lowercase hex chars
              size: 4096,
              contentType: 'text/markdown',
            },
          },
          policy: { mode: 'confirm' },
        },
        { taskId: 'task-2', seq: 2 },
      ),
    );
  });

  it('task.approve', () => {
    const type = 'task.approve' as const;
    testedTypes.push(type);
    roundTrip(type, createEnvelope(type, {}, { taskId: 'task-1', seq: 1 }));
  });

  it('task.reject', () => {
    const type = 'task.reject' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, { reason: 'budget exceeded' }, { taskId: 'task-1', seq: 1 }),
    );
  });

  it('task.cancel', () => {
    const type = 'task.cancel' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, { reason: 'user cancelled' }, { taskId: 'task-1', seq: 1 }),
    );
  });

  it('task.steer', () => {
    const type = 'task.steer' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, { text: 'also update the README' }, { taskId: 'task-1', seq: 1 }),
    );
  });

  it('task.claim', () => {
    const type = 'task.claim' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, { deviceId: 'device-1', agentId: 'agent-1' }, { taskId: 'task-1' }),
    );
  });

  it('task.started', () => {
    const type = 'task.started' as const;
    testedTypes.push(type);
    roundTrip(type, createEnvelope(type, {}, { taskId: 'task-1' }));
  });

  it('task.decline', () => {
    const type = 'task.decline' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(
        type,
        { reason: 'no compatible runtime available', retryable: true },
        { taskId: 'task-1' },
      ),
    );
  });

  it('task.progress', () => {
    const type = 'task.progress' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(
        type,
        {
          seq: 1,
          events: [
            { type: 'progress', text: 'reading files' },
            { type: 'tool_use', tool: 'bash', input: { cmd: 'ls -la' } },
            { type: 'tool_result', tool: 'bash', output: { exitCode: 0 } },
            { type: 'needs_approval', summary: 'about to delete a file' },
            { type: 'turn_end' },
            { type: 'error', message: 'transient network error' },
            // Additive `usage` variant (partial subset — runtimes report
            // different subsets of these fields).
            { type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 },
            // Pre-freeze tolerance: an unrecognized event type from a newer
            // peer must still round-trip losslessly as an opaque event,
            // not throw.
            { type: 'future_event_v2', someField: 'from a newer minor version' },
          ],
        },
        { taskId: 'task-1', seq: 1 },
      ),
    );
  });

  it('task.artifact (inline)', () => {
    const type = 'task.artifact' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(
        type,
        { name: 'output.txt', contentType: 'text/plain', inline: 'hello world' },
        { taskId: 'task-1' },
      ),
    );
  });

  it('task.artifact (blobRef)', () => {
    const type = 'task.artifact' as const;
    roundTrip(
      type,
      createEnvelope(
        type,
        {
          name: 'build.zip',
          contentType: 'application/zip',
          blobRef: {
            blobId: 'blob-2',
            contentHash: `sha256:${'cafebabe'.repeat(8)}`, // finding F9: must be 64 lowercase hex chars
            size: 10_485_760,
            contentType: 'application/zip',
            url: 'https://blobs.example.com/blob-2',
          },
        },
        { taskId: 'task-1' },
      ),
    );
  });

  it('task.await_approval', () => {
    const type = 'task.await_approval' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, { summary: 'about to run rm -rf build/' }, { taskId: 'task-1' }),
    );
  });

  it('task.complete', () => {
    const type = 'task.complete' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(
        type,
        {
          summary: 'refactor complete, all tests passing',
          sessionRef: 'sess-1',
          artifactRefs: [
            {
              blobId: 'blob-3',
              contentHash: `sha256:${'0123'.repeat(16)}`, // finding F9: must be 64 lowercase hex chars
              size: 2048,
              contentType: 'text/plain',
            },
          ],
        },
        { taskId: 'task-1', sessionRef: 'sess-1' },
      ),
    );
  });

  it('task.fail', () => {
    const type = 'task.fail' as const;
    testedTypes.push(type);
    roundTrip(
      type,
      createEnvelope(type, { reason: 'runtime crashed', retryable: true }, { taskId: 'task-1' }),
    );
  });

  it('task.cancelled', () => {
    const type = 'task.cancelled' as const;
    testedTypes.push(type);
    roundTrip(type, createEnvelope(type, { reason: 'user cancelled' }, { taskId: 'task-1' }));
  });

  it('covers every declared message type', () => {
    expect([...new Set(testedTypes)].sort()).toEqual([...MESSAGE_TYPES].sort());
  });
});

describe('createEnvelope defaults', () => {
  it('fills v, id, ts when not supplied', () => {
    const envelope = createEnvelope('task.steer', { text: 'hi' }, { taskId: 'task-1', seq: 1 });
    expect(envelope.v).toBe(1);
    expect(envelope.id).toMatch(UUID_RE);
    expect(() => new Date(envelope.ts).toISOString()).not.toThrow();
    expect(Number.isNaN(new Date(envelope.ts).getTime())).toBe(false);
  });

  it('honors explicit overrides', () => {
    const envelope = createEnvelope(
      'task.steer',
      { text: 'hi' },
      { v: 1, id: '11111111-1111-4111-8111-111111111111', ts: '2026-07-16T00:00:00.000Z', taskId: 'task-1', seq: 7 },
    );
    expect(envelope.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(envelope.ts).toBe('2026-07-16T00:00:00.000Z');
    expect(envelope.seq).toBe(7);
    expect(envelope.task_id).toBe('task-1');
  });

  it('omits task_id/session_ref/seq entirely when not provided (no undefined leakage)', () => {
    const envelope = createEnvelope('conn.hello', {
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
    });
    expect('task_id' in envelope).toBe(false);
    expect('session_ref' in envelope).toBe(false);
    expect('seq' in envelope).toBe(false);
  });
});
