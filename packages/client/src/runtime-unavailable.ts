// The one mapping from local detection/admission facts to the append-only
// `runtime_unavailable` cause vocabulary (#1103 D6/D7).
//
// The cause is the machine-readable classification; `reason` stays display
// text and is never parsed back into a cause. Names are explicit, not derived
// from the detection kinds (snake_case vs kebab-case), so a rename on one side
// can never silently change the wire meaning.
import type { RuntimeUnavailableCause } from '@byok-sdk/protocol/constants';
import type { ServiceEnvironmentUnavailableCode } from './login-shell-environment';
import type { RuntimeDetectResult } from './types';

/** One typed pre-claim admission cause, plus the optional environment capture code. */
export interface RuntimeUnavailableAdmission {
  readonly cause: RuntimeUnavailableCause;
  /** Only with `environment_unavailable`: why the login-shell capture failed (#1095). */
  readonly code?: ServiceEnvironmentUnavailableCode;
}

/**
 * Default retryability by cause (#1103 §3.3). `retryable` still answers one
 * question only: could re-offering this task, possibly to another device,
 * succeed? It is not a promise that this device will heal itself.
 */
const RETRYABLE_BY_CAUSE = Object.freeze({
  // Another device may have the runtime installed, executable, or responsive;
  // a later probe on this device may also succeed.
  not_installed: true,
  not_executable: true,
  probe_timeout: true,
  probe_failed: true,
  // Another device or build may have the required mode.
  app_server_unavailable: true,
  acp_unavailable: true,
  // Another device may support this platform.
  platform_unsupported: true,
  // The captured login-shell environment fails on this device; re-offering
  // would run the same capture again.
  environment_unavailable: false,
  // The Host explicitly refuses this version line.
  version_blocked: false,
  // Local configuration decisions; re-offering does not change them.
  runtime_not_configured: false,
  runtime_not_allowed: false,
  // Another device may have an available runtime.
  none_available: true,
} satisfies Record<RuntimeUnavailableCause, boolean>);

/** The retryable default for `cause`; the one table every decline path uses. */
export function runtimeUnavailableRetryable(cause: RuntimeUnavailableCause): boolean {
  return RETRYABLE_BY_CAUSE[cause];
}

const DETECTION_CAUSES = Object.freeze({
  'not-found': 'not_installed',
  'not-executable': 'not_executable',
  timeout: 'probe_timeout',
  'probe-failed': 'probe_failed',
} satisfies Record<Exclude<RuntimeDetectResult['kind'], 'available' | 'refused'>, RuntimeUnavailableCause>);

/**
 * Map one detection failure to its cause. `available` is not a failure and
 * is rejected by the type; a version block is an admission decision on an
 * available runtime and is mapped by `pickAdapter`, not here.
 */
export function runtimeUnavailableForDetection(
  result: Exclude<RuntimeDetectResult, { kind: 'available' }>,
): RuntimeUnavailableAdmission {
  if (result.kind !== 'refused') return { cause: DETECTION_CAUSES[result.kind] };
  switch (result.reason) {
    case 'app_server_unavailable':
      return { cause: 'app_server_unavailable' };
    case 'acp_unavailable':
      return { cause: 'acp_unavailable' };
    case 'platform_unsupported':
      return { cause: 'platform_unsupported' };
    case 'runtime_environment_unavailable':
      return { cause: 'environment_unavailable', code: result.code };
  }
  throw new TypeError('unmapped runtime detection refusal');
}
