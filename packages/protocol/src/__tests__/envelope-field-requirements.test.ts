import { describe, expect, it } from 'vitest';
import {
  EnvelopeSchema,
  MESSAGE_TYPES,
  SERVER_TO_DAEMON_TYPES,
  createEnvelope,
  isServerToDaemonType,
  type MessageType,
} from '../index';

/**
 * M1 gap #1: envelope `task_id` is required for every `task.*` type (they
 * all route by task id) and stays optional for `conn.*`.
 *
 * M1 Part B: envelope `seq` (the per-device redelivery cursor) is required
 * for every type the server sends to the daemon, and stays optional for
 * daemon -> server types.
 *
 * Both rules are exercised here for *every* declared message type, so a
 * regression in either rule for any single type fails a test.
 */

const TASK_ROUTED_TYPES = MESSAGE_TYPES.filter((t) => t.startsWith('task.'));
const CONN_TYPES = MESSAGE_TYPES.filter((t) => t.startsWith('conn.'));
const DAEMON_TO_SERVER_TYPES = MESSAGE_TYPES.filter((t) => !isServerToDaemonType(t));

/** Minimal valid payload for each message type — just enough to satisfy its own payload schema. */
function minimalPayload(type: MessageType): unknown {
  switch (type) {
    case 'conn.hello':
      return { protocolVersions: [1], capabilities: [], deviceId: 'device-1', productId: 'acme-agent' };
    case 'conn.ack':
      return { protocolVersion: 1, capabilities: [], serverTime: new Date().toISOString() };
    case 'task.offer':
      return { instruction: 'do it', policy: { mode: 'auto' } };
    case 'task.approve':
      return {};
    case 'task.reject':
      return {};
    case 'task.cancel':
      return {};
    case 'task.steer':
      return { text: 'hi' };
    case 'task.claim':
      return { deviceId: 'device-1' };
    case 'task.started':
      return {};
    case 'task.decline':
      return { reason: 'no compatible runtime' };
    case 'task.progress':
      return { seq: 1, events: [] };
    case 'task.artifact':
      return { name: 'a.txt', contentType: 'text/plain' };
    case 'task.await_approval':
      return { summary: 'about to do a thing' };
    case 'task.complete':
      return { summary: 'done', sessionRef: 'sess-1' };
    case 'task.fail':
      return { reason: 'boom' };
    case 'task.cancelled':
      return {};
    default: {
      const exhaustive: never = type;
      throw new Error(`no minimal payload fixture for message type: ${exhaustive}`);
    }
  }
}

/** Build `createEnvelope` opts that satisfy every OTHER requirement for `type`, so a test can isolate one field at a time. */
function baseOpts(type: MessageType): { taskId?: string; seq?: number } {
  const opts: { taskId?: string; seq?: number } = {};
  if (type.startsWith('task.')) opts.taskId = 'task-1';
  if (isServerToDaemonType(type)) opts.seq = 1;
  return opts;
}

describe('envelope.task_id requiredness (M1 gap #1)', () => {
  it.each(TASK_ROUTED_TYPES)('requires envelope.task_id for %s', (type) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = createEnvelope(type, minimalPayload(type) as any, baseOpts(type));
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);

    const { task_id: _taskId, ...withoutTaskId } = envelope as Record<string, unknown>;
    expect(EnvelopeSchema.safeParse(withoutTaskId).success).toBe(false);
  });

  it.each(CONN_TYPES)('leaves envelope.task_id optional for %s', (type) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = createEnvelope(type, minimalPayload(type) as any, baseOpts(type));
    expect('task_id' in envelope).toBe(false);
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('envelope.seq requiredness (M1 Part B redelivery cursor)', () => {
  it.each(SERVER_TO_DAEMON_TYPES as readonly MessageType[])(
    'requires envelope.seq for server->daemon type %s',
    (type) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelope = createEnvelope(type, minimalPayload(type) as any, baseOpts(type));
      expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);

      const { seq: _seq, ...withoutSeq } = envelope as Record<string, unknown>;
      expect(EnvelopeSchema.safeParse(withoutSeq).success).toBe(false);
    },
  );

  it.each(DAEMON_TO_SERVER_TYPES)('leaves envelope.seq optional for daemon->server type %s', (type) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = createEnvelope(type, minimalPayload(type) as any, baseOpts(type));
    expect('seq' in envelope).toBe(false);
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('SERVER_TO_DAEMON_TYPES / isServerToDaemonType agree, and partition MESSAGE_TYPES', () => {
  it('every message type is either server->daemon or daemon->server, never both', () => {
    for (const type of MESSAGE_TYPES) {
      const serverToDaemon = (SERVER_TO_DAEMON_TYPES as readonly MessageType[]).includes(type);
      expect(isServerToDaemonType(type)).toBe(serverToDaemon);
    }
    expect(SERVER_TO_DAEMON_TYPES.length + DAEMON_TO_SERVER_TYPES.length).toBe(MESSAGE_TYPES.length);
  });
});
