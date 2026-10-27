import { createEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectTerminalResult } from '../terminal-result';
import { tenantId } from '@byok-sdk/core';

const receipt = (envelope: Envelope) => ({ tenantId: tenantId('tenant-a'), key: 'terminal', body: encodeEnvelope(envelope), recordedAt: '2026-10-24T00:00:00.000Z' });

/** The golden task.fail_sealed line that carries a quota class (#869). */
const sealedQuota = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n').map((raw) => JSON.parse(raw) as Envelope)
  .find((line) => line.type === 'task.fail_sealed' && (line.payload as { failure?: { class: string } }).failure?.class === 'quota')!;

describe('projectTerminalResult: the runtime failure class (#869)', () => {
  it('copies task.fail.failure verbatim', () => {
    const failure = { class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' } as const;
    const projected = projectTerminalResult('task-1', receipt(createEnvelope('task.fail', { reason: 'limit', retryable: false, failure }, { taskId: 'task-1' })));
    expect(projected).toMatchObject({ state: 'failed', reason: 'limit', retryable: false, failure });
  });

  it('copies the plaintext failure of task.fail_sealed', () => {
    const projected = projectTerminalResult(sealedQuota.task_id!, receipt(sealedQuota));
    expect(projected.failure).toEqual({ class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' });
    expect(projected.reason).toBeUndefined();
  });

  it('has no failure key when the terminal carried none', () => {
    const projected = projectTerminalResult('task-2', receipt(createEnvelope('task.fail', { reason: 'old daemon' }, { taskId: 'task-2' })));
    expect(Object.hasOwn(projected, 'failure')).toBe(false);
  });
});
