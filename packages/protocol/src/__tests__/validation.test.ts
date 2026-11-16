import { describe, expect, it } from 'vitest';
import {
  EnvelopeValidationError,
  EnvelopeSchema,
  MessagesSendRequestSchema,
  ProtocolError,
  TASK_STEER_TEXT_MAX_BYTES,
  TaskArtifactPayloadSchema,
  TaskOfferPayloadSchema,
  TaskSteerPayloadSchema,
  readSteerRefusalReason,
  steerRefusalEnvelopeId,
  uuidFromSha256,
  UnknownMessageTypeError,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  parseMessage,
} from '../index';

describe('malformed payload rejection', () => {
  it.each([0, -1, 1, 2, 3, 4, 5, 6, 99])('rejects unsupported wire major %i at decode; the batch frame admits only a positive major', (v) => {
    const supported = createEnvelope('task.cancel', {
      reason: 'same task contract',
    }, { taskId: 'version-gate', seq: 1 });
    const unsupported = { ...supported, v };
    expect(() => parseMessage(unsupported)).toThrow(EnvelopeValidationError);
    expect(() => decodeEnvelope(JSON.stringify(unsupported))).toThrow(EnvelopeValidationError);
    expect(EnvelopeSchema.safeParse(unsupported).success).toBe(false);
    // Wire v7: the frame carries an entry of another positive major, answered protocol_version_unsupported on its own.
    expect(MessagesSendRequestSchema.safeParse({ messages: [unsupported] }).success).toBe(v > 0);
    expect(parseMessage(supported)).toEqual(supported);
  });

  it('rejects task.steer with wrong payload field type', () => {
    const raw = {
      v: 7,
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
      v: 7,
      id: 'not-a-uuid',
      ts: new Date().toISOString(),
      type: 'task.approve',
      task_id: 'task-1',
      seq: 1,
      payload: { approvalId: 'approval-1' },
    };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('rejects an envelope with a non-ISO-8601 timestamp', () => {
    const raw = {
      v: 7,
      id: '11111111-1111-4111-8111-111111111111',
      ts: 'yesterday',
      type: 'task.approve',
      task_id: 'task-1',
      seq: 1,
      payload: { approvalId: 'approval-1' },
    };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('rejects decodeEnvelope input that is not valid JSON at all', () => {
    expect(() => decodeEnvelope('{not valid json')).toThrow();
  });

  it('EnvelopeValidationError carries the zod issues for diagnostics', () => {
    const raw = {
      v: 7,
      id: 'not-a-uuid',
      ts: new Date().toISOString(),
      type: 'task.approve',
      task_id: 'task-1',
      seq: 1,
      payload: { approvalId: 'approval-1' },
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
    const envelope = createEnvelope('task.approve', { approvalId: 'approval-1' }, { taskId: 'task-1', seq: 1 });
    const raw = { ...envelope, fromTheFuture: 'ignore me' };
    const decoded = parseMessage(raw);
    expect(decoded).toEqual(envelope);
    expect('fromTheFuture' in decoded).toBe(false);
  });

  it('tolerates an unknown field inside a known payload', () => {
    const envelope = createEnvelope('task.reject', { reason: 'no', approvalId: 'approval-1' }, { taskId: 'task-1', seq: 1 });
    const raw = { ...envelope, payload: { ...envelope.payload, futureField: 123 } };
    const decoded = parseMessage(raw);
    expect(decoded).toEqual(envelope);
    expect('futureField' in decoded.payload).toBe(false);
  });
});

describe('unknown message type handling', () => {
  it('throws UnknownMessageTypeError (not EnvelopeValidationError) for an unrecognized type', () => {
    const raw = {
      v: 7,
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
      createEnvelope('task.approve', { approvalId: 'approval-1' }, { taskId: 'task-1', seq: 1 }),
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
    expect(() => parseMessage({ v: 7, id: '11111111-1111-4111-8111-111111111111', ts: new Date().toISOString() })).toThrow(
      UnknownMessageTypeError,
    );
    expect(() =>
      parseMessage({ v: 7, id: '11111111-1111-4111-8111-111111111111', ts: new Date().toISOString(), type: 42 }),
    ).toThrow(UnknownMessageTypeError);
  });
});

describe('instruction remains fail-closed on unknown shapes (pre-freeze asymmetry vs. AgentEvent tolerance)', () => {
  // Unlike task.progress's AgentEvent events (observability data, now
  // tolerant of unknown variants — see agent-event.test.ts), `instruction`
  // is a control/security field and must never gain an
  // unknown-tolerant fallback. These are regression guards for that rule.

  it('TaskOfferPayloadSchema rejects an instruction that is neither a string nor a {blobRef} object', () => {
    const result = TaskOfferPayloadSchema.safeParse({
      agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
      session: { mode: 'resume', sessionRef: 'session-1' },
      instruction: { unknownKind: 'from a hypothetical future variant' },
    });
    expect(result.success).toBe(false);
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

describe('task.steer text bound and task.steer_refused (wire v7, #2009)', () => {
  it('bounds the plaintext steer text in UTF-8 bytes', () => {
    expect(TASK_STEER_TEXT_MAX_BYTES).toBe(65_536);
    expect(TaskSteerPayloadSchema.safeParse({ text: 'x'.repeat(65_536) }).success).toBe(true);
    expect(TaskSteerPayloadSchema.safeParse({ text: 'x'.repeat(65_537) }).success).toBe(false);
    // 21,846 three-byte characters are 65,538 bytes though only 21,846 UTF-16 units.
    expect(TaskSteerPayloadSchema.safeParse({ text: '\u4e2d'.repeat(21_846) }).success).toBe(false);
  });

  it('reads a known refusal reason typed and keeps an unknown one verbatim', () => {
    expect(readSteerRefusalReason('input_too_large')).toEqual({ reason: 'input_too_large' });
    expect(readSteerRefusalReason('invented_reason')).toEqual({ reason: 'unknown', reportedReason: 'invented_reason' });
  });

  it('derives one envelope id per refused steer: SHA-256 of the domain-tagged steer id, as an RFC 9562 v8 UUID', async () => {
    // sha256({"domain":"byok:task-steer-refused","steerMessageId":"00000000-0000-4000-8000-000000000007"}) = 075b8b83fa37f6d141ef4947cff3b8b7…
    expect(await steerRefusalEnvelopeId('00000000-0000-4000-8000-000000000007')).toBe('075b8b83-fa37-86d1-81ef-4947cff3b8b7');
    expect(uuidFromSha256(`sha256:${'f'.repeat(64)}`)).toBe('ffffffff-ffff-8fff-bfff-ffffffffffff');
    expect(uuidFromSha256(`sha256:${'0'.repeat(64)}`)).toBe('00000000-0000-8000-8000-000000000000');
    expect(() => uuidFromSha256('F'.repeat(64))).toThrow();
  });
});
