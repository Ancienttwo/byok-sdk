import { describe, expect, it } from 'vitest';
import {
  createEnvelope, decodeEnvelope, PROTOCOL_VERSION, RUNTIME_UNAVAILABLE_CAUSES, readDeclineCode, readRuntimeUnavailableCause,
} from '../index';
import { TASK_FAIL_REASON_MAX_BYTES } from '../constants';

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
      expect(decodeEnvelope(wire(payload))).toMatchObject({ v: 7, type: 'task.decline', payload });
      expect(PROTOCOL_VERSION).toBe(7);
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

describe('wire v7 decline vocabulary', () => {
  it('reads a prepared-offer refusal as a typed code', () => {
    expect(readDeclineCode('preparation_not_found')).toEqual({ code: 'preparation_not_found' });
  });

  it('bounds the display reason like task.fail: an over-long reason is truncated, never refused', () => {
    const decoded = decodeEnvelope(wire({ reason: 'x'.repeat(TASK_FAIL_REASON_MAX_BYTES + 1), code: 'offer_capability_missing' }));
    const reason = (decoded.payload as { reason: string }).reason;
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);
    expect(reason).toMatch(/truncated/u);
  });
});

describe('typed runtime-unavailable cause (#1103 B2a)', () => {
  it('carries the open runtime_unavailable code beside the typed cause', () => {
    const payload = {
      reason: 'runtime "codex" is not installed/available on this device',
      retryable: true,
      code: 'runtime_unavailable',
      runtimeUnavailable: { cause: 'not_installed' },
    };
    expect(decodeEnvelope(wire(payload)).payload).toEqual(payload);
    // Wire v7 types the code a v6 device already sent.
    expect(readDeclineCode('runtime_unavailable')).toEqual({ code: 'runtime_unavailable' });
    expect(readRuntimeUnavailableCause('not_installed')).toEqual({ cause: 'not_installed' });
  });

  it('keeps the login-shell capture code only with environment_unavailable', () => {
    const payload = {
      reason: 'runtime environment unavailable: timeout',
      retryable: false,
      code: 'runtime_unavailable',
      runtimeUnavailable: { cause: 'environment_unavailable', code: 'timeout' },
    };
    expect(decodeEnvelope(wire(payload)).payload).toEqual(payload);
    expect(() => decodeEnvelope(wire({
      reason: 'display only', code: 'runtime_unavailable', runtimeUnavailable: { cause: 'version_blocked', code: 'timeout' },
    }))).toThrow();
  });

  it('accepts a well-formed cause it does not know and reads it as unknown (#1121)', () => {
    const payload = {
      reason: 'display only',
      code: 'runtime_unavailable',
      runtimeUnavailable: { cause: 'invented_cause' },
    };
    expect(decodeEnvelope(wire(payload)).payload).toEqual(payload);
    expect(readRuntimeUnavailableCause('invented_cause')).toEqual({ cause: 'unknown', reportedCause: 'invented_cause' });
    expect(RUNTIME_UNAVAILABLE_CAUSES).toContain('version_blocked');
  });

  it.each([
    { cause: 'Not_Snake_Case' },
    { cause: '' },
    { cause: 1 },
    { cause: 'not_installed', code: 'BAD CODE' },
  ])('rejects malformed runtimeUnavailable %j at wire decoding', (runtimeUnavailable) => {
    expect(() => decodeEnvelope(wire({ reason: 'display only', runtimeUnavailable }))).toThrow();
  });

  it('keeps a decline without the nested field readable by an older sender shape', () => {
    const payload = { reason: 'no compatible runtime', retryable: true };
    expect(decodeEnvelope(wire(payload)).payload).toEqual(payload);
  });
});
