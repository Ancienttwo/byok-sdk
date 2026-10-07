import { TOOL_IMPLEMENTATION_UNAVAILABLE_REASONS, type ToolImplementationAuthority } from '@byok-sdk/implementation-identity';
import { RUNTIME_DETECTION_FAILURE_KINDS, type RuntimeAdapter, type RuntimeDetectionAdvisory, type RuntimeDetectResult, type RuntimeDetectionRefusalReason } from './types';

const REFUSAL_REASONS: readonly RuntimeDetectionRefusalReason[] = Object.freeze([
  ...TOOL_IMPLEMENTATION_UNAVAILABLE_REASONS, 'installation_observation_unsupported', 'native_identity_mismatch', 'launch_cwd_unavailable', 'app_server_unavailable',
]);
const MAX_VERSION_CHARS = 256;

function isVersionText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_CHARS;
}

function isAdvisory(value: unknown): value is RuntimeDetectionAdvisory {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const advisory = value as Record<string, unknown>;
  return Object.keys(advisory).length === 2 && advisory.reason === 'runtime_version_unqualified'
    && isVersionText(advisory.qualifiedVersion);
}

/** Reject legacy/mixed authoring shapes; copy only validated, known facts. */
export function validateRuntimeDetectResult(value: unknown): RuntimeDetectResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid runtime detection result');
  }
  const result = value as Record<string, unknown>;
  if (!Object.hasOwn(result, 'kind')) throw new TypeError('invalid runtime detection result');
  const { kind, version, authPresent, advisory } = result;
  if (kind === 'available') {
    if (Object.keys(result).some((key) => !['kind', 'version', 'authPresent', 'advisory'].includes(key))
      || (version !== undefined && typeof version !== 'string')
      || (authPresent !== undefined && typeof authPresent !== 'boolean')
      || (advisory !== undefined && !isAdvisory(advisory))) {
      throw new TypeError('invalid runtime detection result');
    }
    return Object.freeze({
      kind,
      ...(version === undefined ? {} : { version }),
      ...(authPresent === undefined ? {} : { authPresent }),
      ...(advisory === undefined ? {} : { advisory: Object.freeze({ reason: advisory.reason, qualifiedVersion: advisory.qualifiedVersion }) }),
    });
  }
  if (kind === 'refused') {
    if (Object.keys(result).length !== 2 || !Object.hasOwn(result, 'reason')
      || !REFUSAL_REASONS.includes(result.reason as RuntimeDetectionRefusalReason)) throw new TypeError('invalid runtime detection result');
    return Object.freeze({ kind, reason: result.reason as RuntimeDetectionRefusalReason });
  }
  if (RUNTIME_DETECTION_FAILURE_KINDS.some((candidate) => candidate === kind)
    && Object.keys(result).every((key) => key === 'kind')) {
    return Object.freeze({ kind: kind as Exclude<typeof RUNTIME_DETECTION_FAILURE_KINDS[number], 'refused'> });
  }
  throw new TypeError('invalid runtime detection result');
}

/** Single routing author for daemon, selection and local diagnostics. Custom declarations are not attestation. */
export async function observeRuntimeDetection(
  adapter: RuntimeAdapter, authority: ToolImplementationAuthority | undefined, signal?: AbortSignal,
): Promise<RuntimeDetectResult> {
  if (adapter.descriptor.id === 'pi' && authority !== undefined) {
    if (typeof adapter.detectInstallation !== 'function') return Object.freeze({ kind: 'refused', reason: 'installation_observation_unsupported' });
    return validateRuntimeDetectResult(await adapter.detectInstallation({ authority, scope: 'enabled-top-level' }, signal));
  }
  return validateRuntimeDetectResult(await adapter.detect(signal));
}
