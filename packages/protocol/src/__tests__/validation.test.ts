import { describe, expect, it } from 'vitest';
import {
  EnvelopeValidationError,
  ProtocolError,
  TaskArtifactPayloadSchema,
  UnknownMessageTypeError,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  parseMessage,
} from '../index';

describe('malformed payload rejection', () => {
  it('rejects task.offer missing required "policy"', () => {
    const raw = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: new Date().toISOString(),
      type: 'task.offer',
      task_id: 'task-1',
      seq: 1,
      payload: { instruction: 'do it' /* missing policy */ },
    };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('rejects task.steer with wrong payload field type', () => {
    const raw = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: new Date().toISOString(),
      type: 'task.steer',
      task_id: 'task-1',
      seq: 1,
      payload: { text: 42 }, // should be string
    };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('rejects an envelope with a non-uuid id', () => {
    const raw = {
      v: 1,
      id: 'not-a-uuid',
      ts: new Date().toISOString(),
      type: 'task.approve',
      task_id: 'task-1',
      seq: 1,
      payload: {},
    };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('rejects an envelope with a non-ISO-8601 timestamp', () => {
    const raw = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: 'yesterday',
      type: 'task.approve',
      task_id: 'task-1',
      seq: 1,
      payload: {},
    };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('rejects decodeEnvelope input that is not valid JSON at all', () => {
    expect(() => decodeEnvelope('{not valid json')).toThrow();
  });

  it('EnvelopeValidationError carries the zod issues for diagnostics', () => {
    const raw = {
      v: 1,
      id: 'not-a-uuid',
      ts: new Date().toISOString(),
      type: 'task.approve',
      task_id: 'task-1',
      seq: 1,
      payload: {},
    };
    try {
      parseMessage(raw);
      throw new Error('expected parseMessage to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeValidationError);
      expect(err).toBeInstanceOf(ProtocolError);
      const validationError = err as EnvelopeValidationError;
      expect(validationError.issues.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('unknown-field tolerance (forward-compat)', () => {
  it('tolerates an unknown top-level envelope field', () => {
    const envelope = createEnvelope('task.approve', {}, { taskId: 'task-1', seq: 1 });
    const raw = { ...envelope, fromTheFuture: 'ignore me' };
    const decoded = parseMessage(raw);
    expect(decoded).toEqual(envelope);
    expect('fromTheFuture' in decoded).toBe(false);
  });

  it('tolerates an unknown field inside a known payload', () => {
    const envelope = createEnvelope('task.reject', { reason: 'no' }, { taskId: 'task-1', seq: 1 });
    const raw = { ...envelope, payload: { ...envelope.payload, futureField: 123 } };
    const decoded = parseMessage(raw);
    expect(decoded).toEqual(envelope);
    expect('futureField' in decoded.payload).toBe(false);
  });
});

describe('unknown message type handling', () => {
  it('throws UnknownMessageTypeError (not EnvelopeValidationError) for an unrecognized type', () => {
    const raw = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: new Date().toISOString(),
      type: 'task.teleport', // does not exist (yet)
      payload: { anything: true },
    };

    let caught: unknown;
    try {
      parseMessage(raw);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnknownMessageTypeError);
    expect(caught).not.toBeInstanceOf(EnvelopeValidationError);
    expect((caught as UnknownMessageTypeError).type).toBe('task.teleport');
  });

  it('is distinguishable so a daemon can skip-and-continue instead of crashing', () => {
    const line = encodeEnvelope(
      createEnvelope('task.approve', {}, { taskId: 'task-1', seq: 1 }),
    );
    const futureLine = line.replace('"task.approve"', '"task.some_new_v2_message"');

    function tryDecode(l: string): 'ok' | 'skip' | 'error' {
      try {
        decodeEnvelope(l);
        return 'ok';
      } catch (err) {
        if (err instanceof UnknownMessageTypeError) return 'skip';
        return 'error';
      }
    }

    expect(tryDecode(line)).toBe('ok');
    expect(tryDecode(futureLine)).toBe('skip');
  });

  it('missing/non-string type is also treated as unknown, not a hard parse error', () => {
    expect(() => parseMessage({ v: 1, id: '11111111-1111-4111-8111-111111111111', ts: new Date().toISOString() })).toThrow(
      UnknownMessageTypeError,
    );
    expect(() =>
      parseMessage({ v: 1, id: '11111111-1111-4111-8111-111111111111', ts: new Date().toISOString(), type: 42 }),
    ).toThrow(UnknownMessageTypeError);
  });
});

describe('task.artifact inline size limit (<=64KB)', () => {
  it('accepts inline payloads at or under the limit', () => {
    const okPayload = { name: 'a.txt', contentType: 'text/plain', inline: 'x'.repeat(65_536) };
    expect(TaskArtifactPayloadSchema.safeParse(okPayload).success).toBe(true);
  });

  it('rejects inline payloads over the limit', () => {
    const tooBig = { name: 'a.txt', contentType: 'text/plain', inline: 'x'.repeat(65_537) };
    expect(TaskArtifactPayloadSchema.safeParse(tooBig).success).toBe(false);
  });
});
