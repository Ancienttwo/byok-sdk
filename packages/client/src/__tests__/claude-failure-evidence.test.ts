import { describe, expect, it } from 'vitest';
import { ClaudeFailureEvidence } from '../adapters/claude/failure-evidence';
import type { ClaudeStreamMessage } from '../adapters/claude/events';
import { RuntimeExecutionFailure } from '../runtime-failure';

const RESETS_AT_SECONDS = 1_792_832_400;
const RESETS_AT = new Date(RESETS_AT_SECONDS * 1000).toISOString();

const rateLimit = (info: Record<string, unknown>): ClaudeStreamMessage => ({ type: 'rate_limit_event', rate_limit_info: info });
const assistantError = (error: string): ClaudeStreamMessage => ({ type: 'assistant', message: { content: [] }, error });
const failedResult = (status: number | null = null): ClaudeStreamMessage => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: status });
const turnFailure = () => new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'claude reported terminal task failure' });

/** Feeds one turn's frames and returns the failure attached at its result. */
function classify(evidence: ClaudeFailureEvidence, frames: readonly ClaudeStreamMessage[]): RuntimeExecutionFailure {
  for (const frame of frames) evidence.observe(frame);
  return evidence.attach(frames.at(-1)!, turnFailure());
}

describe('ClaudeFailureEvidence (#869)', () => {
  it.each([
    ['a rejected account limit with a reset time', [rateLimit({ status: 'rejected', resetsAt: RESETS_AT_SECONDS, rateLimitType: 'five_hour' }), assistantError('rate_limit'), failedResult(429)], { class: 'quota', resetsAt: RESETS_AT, scope: 'account' }],
    ['a rejected per-model weekly limit (#1271)', [rateLimit({ status: 'rejected', resetsAt: RESETS_AT_SECONDS, rateLimitType: 'seven_day_opus' }), assistantError('rate_limit'), failedResult(429)], { class: 'quota', resetsAt: RESETS_AT, scope: 'model' }],
    ['a rejected limit whose type names no scope (#1271)', [rateLimit({ status: 'rejected', resetsAt: RESETS_AT_SECONDS, rateLimitType: 'overage' }), assistantError('rate_limit'), failedResult(429)], { class: 'quota', resetsAt: RESETS_AT }],
    ['a rejected limit without a reset time', [rateLimit({ status: 'rejected' }), assistantError('rate_limit'), failedResult()], { class: 'quota' }],
    ['a rejected limit whose reset time is out of range', [rateLimit({ status: 'rejected', resetsAt: 1e16 }), assistantError('rate_limit'), failedResult()], { class: 'quota' }],
    ['a rejected limit whose reset time is in milliseconds', [rateLimit({ status: 'rejected', resetsAt: 1.79e12 }), assistantError('rate_limit'), failedResult()], { class: 'quota' }],
    ['a rejected limit whose reset time is just past year 9999', [rateLimit({ status: 'rejected', resetsAt: 253_402_300_800 }), assistantError('rate_limit'), failedResult()], { class: 'quota' }],
    ['a rejected limit whose reset time is the last second of year 9999', [rateLimit({ status: 'rejected', resetsAt: 253_402_300_799 }), assistantError('rate_limit'), failedResult()], { class: 'quota', resetsAt: '9999-12-31T23:59:59.000Z' }],
    ['a rejected limit whose reset time is the epoch', [rateLimit({ status: 'rejected', resetsAt: 0 }), assistantError('rate_limit'), failedResult()], { class: 'quota', resetsAt: '1970-01-01T00:00:00.000Z' }],
    ['a rejected limit whose reset time is not an integer', [rateLimit({ status: 'rejected', resetsAt: 1.5 }), assistantError('rate_limit'), failedResult()], { class: 'quota' }],
    ['a rejected limit whose reset time is negative', [rateLimit({ status: 'rejected', resetsAt: -1 }), assistantError('rate_limit'), failedResult()], { class: 'quota' }],
    ['a 401', [assistantError('authentication_failed'), failedResult(401)], { class: 'auth' }],
    ['a 429 under an allowed limit', [rateLimit({ status: 'allowed', resetsAt: RESETS_AT_SECONDS }), assistantError('rate_limit'), failedResult(429)], { class: 'rate_limited' }],
    ['a 404 model', [assistantError('model_not_found'), failedResult(404)], { class: 'model_unavailable' }],
    ['a billing error', [assistantError('billing_error'), failedResult(402)], { class: 'billing' }],
    ['an overloaded provider', [assistantError('overloaded'), failedResult(529)], { class: 'overloaded' }],
    ['a status only', [failedResult(404)], { class: 'model_unavailable' }],
    ['a 5xx status only', [failedResult(502)], { class: 'provider' }],
    ['an unrecognized error', [assistantError('totally_new_error'), failedResult(404)], { class: 'unknown' }],
    ['max_output_tokens', [assistantError('max_output_tokens'), failedResult()], { class: 'unknown' }],
    ['an unmapped status', [failedResult(418)], { class: 'unknown' }],
    ['no evidence', [failedResult()], { class: 'unknown' }],
    ['a stale allowed report before a 404', [rateLimit({ status: 'allowed', resetsAt: RESETS_AT_SECONDS }), failedResult(404)], { class: 'model_unavailable' }],
  ] as const)('classifies %s', (_label, frames, failure) => {
    const attached = classify(new ClaudeFailureEvidence(), frames);
    expect(attached.failure).toEqual(failure);
  });

  it('keeps the reason, phase, category, retry and cause of the failure it decorates', () => {
    const evidence = new ClaudeFailureEvidence();
    for (const frame of [assistantError('authentication_failed'), failedResult(401)]) evidence.observe(frame);
    const cause = new Error('underlying');
    const original = new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'claude reported terminal task failure' }, { cause });
    const attached = evidence.attach(failedResult(401), original);
    expect(attached).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable', message: 'claude reported terminal task failure', failure: { class: 'auth' } });
    expect(attached.cause).toBe(cause);
  });

  it('leaves a failure that is not a failed result frame unchanged', () => {
    const evidence = new ClaudeFailureEvidence();
    const failure = turnFailure();
    evidence.observe(assistantError('authentication_failed'));
    expect(evidence.attach({ type: 'assistant' }, failure)).toBe(failure);
    expect(evidence.attach({ type: 'result', is_error: 'yes' }, failure)).toBe(failure);
  });

  it('never carries one turn\'s error into the next turn', () => {
    const evidence = new ClaudeFailureEvidence();
    expect(classify(evidence, [rateLimit({ status: 'rejected', resetsAt: RESETS_AT_SECONDS }), assistantError('rate_limit'), failedResult(429)]).failure)
      .toEqual({ class: 'quota', resetsAt: RESETS_AT });
    expect(classify(evidence, [assistantError('model_not_found'), failedResult(404)]).failure).toEqual({ class: 'model_unavailable' });
    // A successful turn also ends the turn's error.
    evidence.observe(assistantError('overloaded'));
    evidence.observe({ type: 'result', subtype: 'success', is_error: false });
    expect(classify(evidence, [failedResult()]).failure).toEqual({ class: 'unknown' });
  });
});
