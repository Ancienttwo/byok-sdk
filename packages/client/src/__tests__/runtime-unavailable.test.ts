import { RUNTIME_UNAVAILABLE_CAUSES, type RuntimeUnavailableCause } from '@byok-sdk/protocol/constants';
import { describe, expect, it } from 'vitest';
import { runtimeUnavailableForDetection, runtimeUnavailableRetryable } from '../runtime-unavailable';
import type { RuntimeDetectResult } from '../types';

type DetectionFailure = Exclude<RuntimeDetectResult, { kind: 'available' }>;

const DETECTION_CASES: readonly {
  readonly result: DetectionFailure;
  readonly cause: RuntimeUnavailableCause;
}[] = [
  { result: { kind: 'not-found' }, cause: 'not_installed' },
  { result: { kind: 'not-executable' }, cause: 'not_executable' },
  { result: { kind: 'timeout' }, cause: 'probe_timeout' },
  { result: { kind: 'probe-failed' }, cause: 'probe_failed' },
  { result: { kind: 'refused', reason: 'app_server_unavailable' }, cause: 'app_server_unavailable' },
  { result: { kind: 'refused', reason: 'acp_unavailable' }, cause: 'acp_unavailable' },
  { result: { kind: 'refused', reason: 'platform_unsupported' }, cause: 'platform_unsupported' },
];

/** #1103 §3.3: one boolean per cause, kept deliberately in this test so a new cause must decide. */
const RETRYABLE: Record<RuntimeUnavailableCause, boolean> = {
  not_installed: true,
  not_executable: true,
  probe_timeout: true,
  probe_failed: true,
  app_server_unavailable: true,
  acp_unavailable: true,
  platform_unsupported: true,
  environment_unavailable: false,
  version_blocked: false,
  runtime_not_configured: false,
  runtime_not_allowed: false,
  none_available: true,
};

describe('runtime_unavailable cause mapping (#1103 B2a)', () => {
  it.each(DETECTION_CASES.map(({ result, cause }) => [result, cause] as const))('maps %j to %s', (result, cause) => {
    expect(runtimeUnavailableForDetection(result)).toEqual({ cause });
  });

  it('keeps the login-shell capture code on environment_unavailable', () => {
    expect(runtimeUnavailableForDetection({
      kind: 'refused', reason: 'runtime_environment_unavailable', code: 'shell-exit-nonzero',
    })).toEqual({ cause: 'environment_unavailable', code: 'shell-exit-nonzero' });
  });

  it('has one retryable default for every append-only cause', () => {
    expect(Object.keys(RETRYABLE).sort()).toEqual([...RUNTIME_UNAVAILABLE_CAUSES].sort());
    for (const cause of RUNTIME_UNAVAILABLE_CAUSES) {
      expect(runtimeUnavailableRetryable(cause), cause).toBe(RETRYABLE[cause]);
    }
  });

  it('keeps version_blocked non-retryable', () => {
    expect(runtimeUnavailableRetryable('version_blocked')).toBe(false);
  });
});
