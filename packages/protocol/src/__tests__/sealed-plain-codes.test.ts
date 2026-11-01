/**
 * #654 12d: the plaintext form of each output of a task whose output is
 * sealed. The rule comes from `SEALED_SPLIT_TABLE` and the closed codes of
 * `SEALED_TASK_PLAIN_CODES`, by exact match.
 */
import { describe, expect, it } from 'vitest';
import { SEALED_DECLINE_CODES, SEALED_TASK_PLAIN_CODES, isSealedTaskPlainOutput } from '../index';

describe('isSealedTaskPlainOutput (#654 12d)', () => {
  it('names the closed codes of the plaintext fail, decline and cancellation', () => {
    expect(SEALED_TASK_PLAIN_CODES).toEqual({
      'task.fail': { reason: ['daemon_interrupted', 'sealed_key_unavailable'] },
      'task.decline': { reason: SEALED_DECLINE_CODES },
      'task.cancelled': { reason: [] },
    });
  });

  it.each([
    ['task.fail', { reason: 'daemon_interrupted', retryable: false }],
    ['task.fail', { reason: 'sealed_key_unavailable', retryable: false }],
    ['task.decline', { code: 'sealed_open_failed', reason: 'sealed_open_failed', retryable: false }],
    ['task.cancelled', {}],
    ['task.claim', { deviceId: 'device-1' }],
    ['task.started', {}],
    ['task.approval_resolved', { approvalId: 'a', decision: 'approve', resolvedBy: 'local', at: '2026-10-24T00:00:00.000Z' }],
  ])('accepts %s %j', (type, payload) => {
    expect(isSealedTaskPlainOutput(type, payload, ['task-output'])).toBe(true);
  });

  it.each([
    ['task.fail', { reason: 'tool crashed' }],
    ['task.fail', { reason: 'sealed_key_unavailable: no key' }],
    ['task.fail', { reason: 'sealed_open_failed' }],
    ['task.fail', { reason: 'sealed_key_unavailable', preparedObservation: {} }],
    ['task.decline', { reason: 'busy' }],
    ['task.decline', { reason: 'sealed_open_failed' }],
    ['task.decline', { code: 'sealed_open_failed', reason: 'sealed_key_unavailable' }],
    ['task.cancelled', { reason: 'operator' }],
    ['task.cancelled', { reason: 'daemon_interrupted' }],
    ['task.complete', { summary: '' }],
    ['task.progress', { seq: 1, events: [] }],
    ['task.artifact', { blobRef: {} }],
    ['task.artifact', { name: 'a.txt', contentType: 'text/plain' }],
    ['task.complete', {}],
    ['task.await_approval', { summary: 'ok?' }],
  ])('refuses %s %j', (type, payload) => {
    expect(isSealedTaskPlainOutput(type, payload, ['task-output'])).toBe(false);
  });

  it.each(['task.fail', 'task.cancelled'])('keeps %s memory evidence plaintext only when the task does not seal memory-projection (#1045)', (type) => {
    const payload = {
      ...(type === 'task.fail' ? { reason: 'sealed_key_unavailable', retryable: false } : {}),
      agentHomeMemoryChange: { outcome: 'reader-attributed', paths: ['notes/plan.md'] },
    };
    expect(isSealedTaskPlainOutput(type, payload, ['task-output'])).toBe(true);
    expect(isSealedTaskPlainOutput(type, payload, ['task-output', 'memory-projection'])).toBe(false);
    const { agentHomeMemoryChange: _evidence, ...without } = payload;
    expect(isSealedTaskPlainOutput(type, without, ['task-output', 'memory-projection'])).toBe(true);
  });
});
