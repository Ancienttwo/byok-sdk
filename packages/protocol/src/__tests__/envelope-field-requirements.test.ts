import { describe, expect, it } from 'vitest';
import {
  EnvelopeSchema,
  EnvelopeValidationError,
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

/**
 * Finding F1 (createEnvelope type-unsound): before this fix, `taskId`/`seq`
 * were uniformly optional on `createEnvelope`'s `opts` regardless of `type`
 * — a call site missing a required field (e.g. `createEnvelope('task.offer',
 * payload)` with no `taskId`/`seq` at all) type-checked cleanly and only
 * surfaced as a runtime `EnvelopeValidationError` wherever the malformed
 * envelope happened to get decoded, often on the *other* side of the wire.
 * Two independent nets now exist and are tested separately below: the type
 * system rejects an under-specified call at the call site itself (compile
 * time), and `createEnvelope` validates its own output against
 * `EnvelopeSchema` before returning (runtime) — a caller that bypasses the
 * type system (e.g. `as any`) still can't get a malformed envelope out.
 */
describe('createEnvelope: taskId/seq requiredness (finding F1)', () => {
  /**
   * Type-only assertions — this function is defined (so `tsc --noEmit`
   * checks its body) but deliberately never called (see the `it` below):
   * nothing in here should ever execute, only compile-check. Each
   * `@ts-expect-error` line asserts a genuine type error is produced right
   * there; if the call actually type-checked, the directive itself becomes
   * an "Unused '@ts-expect-error' directive" compile error, failing
   * `pnpm -r typecheck` — i.e. this whole block IS the test, enforced by
   * the project's typecheck script rather than by anything vitest runs.
   */
  function typeOnlyRejectedShapes(): void {
    // @ts-expect-error task.offer requires both taskId and seq — opts omitted entirely
    createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } });
    // @ts-expect-error task.offer requires taskId
    createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { seq: 1 });
    // @ts-expect-error task.offer requires seq (server->daemon type)
    createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-1' });
    // @ts-expect-error task.claim requires taskId — every task.* type routes by it, daemon->server or not
    createEnvelope('task.claim', { deviceId: 'device-1' });
    // @ts-expect-error task.approve requires seq (server->daemon type), even though taskId alone would be enough for most task.* types
    createEnvelope('task.approve', {}, { taskId: 'task-1' });
    // @ts-expect-error conn.ack requires seq (server->daemon type)
    createEnvelope('conn.ack', { protocolVersion: 1, capabilities: [], serverTime: new Date().toISOString() });
    // @ts-expect-error conn.ack's taskId/seq shape doesn't accept a plain seq-less object either
    createEnvelope('conn.ack', { protocolVersion: 1, capabilities: [], serverTime: new Date().toISOString() }, {});
  }

  it('rejects under-specified call sites at compile time (see the @ts-expect-error assertions above this test)', () => {
    // Never invoked (see the function's own doc comment) — referencing it
    // here is just to keep it from looking unused to a linter/reader.
    expect(typeof typeOnlyRejectedShapes).toBe('function');
  });

  it('still refuses to hand back a malformed envelope at runtime if a caller bypasses the type system (e.g. `as any`)', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, {} as any),
    ).toThrow(EnvelopeValidationError);

    expect(() =>
      createEnvelope(
        'conn.ack',
        { protocolVersion: 1, capabilities: [], serverTime: new Date().toISOString() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      ),
    ).toThrow(EnvelopeValidationError);
  });

  it('compiles and constructs cleanly for every message type using exactly the fields its own direction requires', () => {
    expect(() => {
      createEnvelope('conn.hello', { protocolVersions: [1], capabilities: [], deviceId: 'd', productId: 'p' }); // no opts at all
      createEnvelope('conn.ack', { protocolVersion: 1, capabilities: [], serverTime: new Date().toISOString() }, { seq: 1 });
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 't', seq: 1 });
      createEnvelope('task.claim', { deviceId: 'd' }, { taskId: 't' }); // seq optional, may be omitted
      createEnvelope('task.claim', { deviceId: 'd' }, { taskId: 't', seq: 1 }); // seq optional, may also be supplied
    }).not.toThrow();
  });
});
