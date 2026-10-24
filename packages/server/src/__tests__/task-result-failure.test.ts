import type { TerminalResult } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { toTaskResult } from '../snapshot';

const failed: TerminalResult = { taskId: 'task-1', state: 'failed', reason: 'limit', retryable: false, recordedAt: '2026-10-24T00:00:00.000Z' };

describe('toTaskResult: the runtime failure class (#869)', () => {
  it('copies the terminal failure verbatim', () => {
    const failure = { class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' } as const;
    expect(toTaskResult({ ...failed, failure })).toMatchObject({ state: 'Failed', reason: 'limit', failure });
  });

  it('has no failure key when the terminal carried none', () => {
    expect(Object.hasOwn(toTaskResult(failed)!, 'failure')).toBe(false);
  });
});
