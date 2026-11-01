import { createEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectTerminalResult } from '../terminal-result';
import { tenantId } from '@byok-sdk/core';

const receipt = (envelope: Envelope) => ({ tenantId: tenantId('tenant-a'), key: 'terminal', body: encodeEnvelope(envelope), recordedAt: '2026-10-24T00:00:00.000Z' });

/** The golden sealed task.fail line that carries a quota class (#869). */
const sealedQuota = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n').map((raw) => JSON.parse(raw) as Envelope)
  .find((line) => line.type === 'task.fail' && (line.payload as { sealed?: unknown }).sealed !== undefined && (line.payload as { failure?: { class: string } }).failure?.class === 'quota')!;

describe('projectTerminalResult: the runtime failure class (#869)', () => {
  it('copies task.fail.failure verbatim, with a quota scope (#1271)', () => {
    const failure = { class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z', scope: 'model' } as const;
    const projected = projectTerminalResult('task-1', receipt(createEnvelope('task.fail', { reason: 'limit', retryable: false, failure }, { taskId: 'task-1' })));
    expect(projected).toMatchObject({ state: 'failed', reason: 'limit', retryable: false, failure });
  });

  it('copies the plaintext failure of a sealed task.fail', () => {
    const projected = projectTerminalResult(sealedQuota.task_id!, receipt(sealedQuota));
    expect(projected.failure).toEqual({ class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' });
    expect(projected.reason).toBeUndefined();
  });

  it('reads a class this version does not know as unknown, keeping the raw token (#1121)', () => {
    const wire = JSON.stringify({ ...createEnvelope('task.fail', { reason: 'busy' }, { taskId: 'task-3' }),
      payload: { reason: 'busy', retryable: true, failure: { class: 'provider_capacity', retryAfterMs: 30_000 } } });
    const projected = projectTerminalResult('task-3', { ...receipt(createEnvelope('task.fail', { reason: 'x' }, { taskId: 'task-3' })), body: wire });
    expect(projected).toMatchObject({ state: 'failed', reason: 'busy', retryable: true, failure: { class: 'unknown', reportedClass: 'provider_capacity' } });
  });

  it('reads a decline code this version does not know as unknown, keeping the raw token (#1121)', () => {
    const wire = JSON.stringify({ ...createEnvelope('task.decline', { reason: 'device full' }, { taskId: 'task-4' }),
      payload: { reason: 'device full', retryable: true, code: 'device_task_limit' } });
    const projected = projectTerminalResult('task-4', { ...receipt(createEnvelope('task.decline', { reason: 'x' }, { taskId: 'task-4' })), body: wire });
    expect(projected).toMatchObject({ state: 'failed', code: 'unknown', reportedCode: 'device_task_limit', retryable: true });
  });

  it('has no failure key when the terminal carried none', () => {
    const projected = projectTerminalResult('task-2', receipt(createEnvelope('task.fail', { reason: 'old daemon' }, { taskId: 'task-2' })));
    expect(Object.hasOwn(projected, 'failure')).toBe(false);
  });
});
