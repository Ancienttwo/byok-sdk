import { describe, expect, it } from 'vitest';
import { createEnvelope, decodeEnvelope, PROTOCOL_VERSION, readDeclineCode } from '../index';

function wire(payload: Record<string, unknown>): string {
  return JSON.stringify({
    ...createEnvelope('task.decline', { reason: 'display only' }, { taskId: 'busy-task' }),
    payload,
  });
}

describe('typed home-busy decline code', () => {
  it.each(['agent_home_writer_busy', 'agent_home_reader_busy'])(
    'preserves %s through wire decoding without a reason prefix', (code) => {
      const payload = { reason: 'display only', retryable: true, code };
      expect(decodeEnvelope(wire(payload))).toMatchObject({ v: 4, type: 'task.decline', payload });
      expect(PROTOCOL_VERSION).toBe(4);
    },
  );

  it('keeps a well-formed code it does not know verbatim and reads it as unknown (#1121)', () => {
    const payload = { reason: 'display only', retryable: true, code: 'agent_home_busy' };
    expect(decodeEnvelope(wire(payload)).payload).toEqual(payload);
    expect(readDeclineCode('agent_home_busy')).toEqual({ code: 'unknown', reportedCode: 'agent_home_busy' });
    expect(readDeclineCode('agent_home_writer_busy')).toEqual({ code: 'agent_home_writer_busy' });
  });

  it.each(['AGENT_HOME_WRITER_BUSY', '', null, 1])(
    'rejects a malformed code %j at wire decoding', (code) => {
      expect(() => decodeEnvelope(wire({ reason: 'display only', code }))).toThrow();
    },
  );

  it('keeps other declines code-free even when their display text mentions busy', () => {
    const payload = { reason: 'agent home busy: display text is not authority', retryable: false };
    expect(decodeEnvelope(wire(payload)).payload).toEqual(payload);
    expect(decodeEnvelope(wire(payload)).payload).not.toHaveProperty('code');
  });
});
