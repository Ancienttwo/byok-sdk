import { RUNTIME_IDS } from '@byok-sdk/protocol/constants';
import type { RuntimeId } from '@byok-sdk/protocol';
import { SERVICE_ENVIRONMENT_UNAVAILABLE_CODES, type ServiceEnvironmentUnavailableCode } from './login-shell-environment';
import { RUNTIME_DETECTION_FAILURE_KINDS, type RuntimeAdapter, type RuntimeAdapterDescriptor, type RuntimeDetectionAdvisory, type RuntimeDetectResult, type RuntimeDetectionRefusalReason, type RuntimeVersionVerdict } from './types';

/** Content-free observation of one configured adapter, including unavailable outcomes. */
export interface RuntimeObservation {
  id: string;
  present: boolean;
  outcome: RuntimeDetectResult['kind'];
  reason?: RuntimeDetectionRefusalReason;
  /** With `reason: 'runtime_environment_unavailable'`: why the login-shell capture failed. */
  code?: ServiceEnvironmentUnavailableCode;
  version?: string;
  qualifiedVersion?: string;
  /**
   * The effective version policy's verdict (#1103). Local-only: `Daemon.status()`
   * carries it inline, while control `status` ships it through the additive
   * `runtimeVersionVerdicts` side channel so a pre-#1103 client's strict
   * observation parser still accepts `runtimes`. `doctor` merges the two. The
   * wire still carries only the protocol's `RuntimeInfo` fields. Additive and
   * optional: an observation from an older daemon has no verdict, and a reader
   * must not infer `allow` from its absence.
   */
  versionVerdict?: RuntimeVersionVerdict;
  authPresent?: boolean;
  steer: boolean;
  resume: boolean;
}

/** The daemon and explicit local probes project the same detection authority. */
export function projectRuntimeObservation(descriptor: RuntimeAdapterDescriptor, detected: RuntimeDetectResult): RuntimeObservation {
  const bounded = (value: string, max: number): string => value.replace(/[\r\n\t]/g, ' ').slice(0, max);
  const verdict = detected.kind === 'available' && detected.versionVerdict !== undefined
    ? Object.freeze({
        state: detected.versionVerdict.state,
        qualifiedVersion: bounded(detected.versionVerdict.qualifiedVersion, 256),
        ...(detected.versionVerdict.matched === undefined ? {} : { matched: bounded(detected.versionVerdict.matched, 256) }),
      }) as RuntimeVersionVerdict
    : undefined;
  return {
    id: bounded(descriptor.id, 128),
    present: detected.kind === 'available',
    outcome: detected.kind,
    ...(detected.kind === 'refused' ? { reason: detected.reason } : {}),
    ...(detected.kind === 'refused' && detected.reason === 'runtime_environment_unavailable' ? { code: detected.code } : {}),
    ...(detected.kind === 'available' && detected.version !== undefined ? { version: bounded(detected.version, 256) } : {}),
    ...(detected.kind === 'available' && detected.advisory !== undefined ? { qualifiedVersion: bounded(detected.advisory.qualifiedVersion, 256) } : {}),
    ...(verdict === undefined ? {} : { versionVerdict: verdict }),
    ...(detected.kind === 'available' && detected.authPresent !== undefined ? { authPresent: detected.authPresent } : {}),
    steer: descriptor.capabilities.steer === true,
    resume: descriptor.capabilities.resume === true,
  };
}

/** Reject unreadable observations; never infer availability from an older discovery shape. */
export function parseRuntimeObservations(value: unknown): RuntimeObservation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const observations: RuntimeObservation[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(key => !['id', 'present', 'outcome', 'reason', 'code', 'version', 'qualifiedVersion', 'versionVerdict', 'authPresent', 'steer', 'resume'].includes(key))
      || typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 128 || /[\r\n\t]/.test(r.id)
      || typeof r.steer !== 'boolean' || typeof r.resume !== 'boolean'
      || r.present !== (r.outcome === 'available')
      || (r.version !== undefined && (typeof r.version !== 'string' || r.version.length > 256 || /[\r\n\t]/.test(r.version)))
      || (r.qualifiedVersion !== undefined && (typeof r.qualifiedVersion !== 'string' || r.qualifiedVersion.length > 256 || /[\r\n\t]/.test(r.qualifiedVersion)))
      || (r.versionVerdict !== undefined && !isVersionVerdict(r.versionVerdict))) return undefined;
    try {
      validateRuntimeDetectResult({
        kind: r.outcome,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(r.version === undefined ? {} : { version: r.version }),
        ...(r.authPresent === undefined ? {} : { authPresent: r.authPresent }),
        ...(r.qualifiedVersion === undefined ? {} : { advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: r.qualifiedVersion } }),
        ...(r.versionVerdict === undefined ? {} : { versionVerdict: r.versionVerdict }),
      });
    } catch { return undefined; }
    const verdict = r.versionVerdict as RuntimeVersionVerdict | undefined;
    observations.push({
      ...r,
      ...(verdict === undefined ? {} : {
        versionVerdict: Object.freeze({
          state: verdict.state,
          qualifiedVersion: verdict.qualifiedVersion,
          ...(verdict.matched === undefined ? {} : { matched: verdict.matched }),
        }) as RuntimeVersionVerdict,
      }),
    } as unknown as RuntimeObservation);
  }
  return observations;
}

/**
 * Merge the control status's additive {@link RuntimeVersionVerdict} channel
 * (#1103) into observations. The verdicts travel outside `runtimes` so a
 * pre-#1103 client's strict observation parser still accepts that array; a
 * missing or malformed side channel means "unknown", never `allow`.
 *
 * @internal
 */
export function attachRuntimeVersionVerdicts(observations: RuntimeObservation[], value: unknown): RuntimeObservation[] {
  if (!Array.isArray(value)) return observations;
  const verdicts = new Map<string, RuntimeVersionVerdict>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['id', 'versionVerdict'].includes(key))) continue;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 128 || /[\r\n\t]/.test(entry.id)) continue;
    if (!isVersionVerdict(entry.versionVerdict)) continue;
    verdicts.set(entry.id, Object.freeze({
      state: entry.versionVerdict.state,
      qualifiedVersion: entry.versionVerdict.qualifiedVersion,
      ...(entry.versionVerdict.matched === undefined ? {} : { matched: entry.versionVerdict.matched }),
    }) as RuntimeVersionVerdict);
  }
  if (verdicts.size === 0) return observations;
  return observations.map((observation) => {
    const verdict = verdicts.get(observation.id);
    if (verdict === undefined) return observation;
    // Keep the legacy advisory (warn) and the verdict two projections of one
    // fact; a side channel that disagrees is ignored, not rendered.
    if (verdict.state === 'warn'
      ? observation.qualifiedVersion !== verdict.qualifiedVersion
      : observation.qualifiedVersion !== undefined) return observation;
    return { ...observation, versionVerdict: verdict };
  });
}

const REFUSAL_REASONS: readonly RuntimeDetectionRefusalReason[] = Object.freeze(['app_server_unavailable', 'acp_unavailable', 'platform_unsupported']);
const ENVIRONMENT_CODES: readonly string[] = SERVICE_ENVIRONMENT_UNAVAILABLE_CODES;
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

function isVersionVerdict(value: unknown): value is RuntimeVersionVerdict {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const verdict = value as Record<string, unknown>;
  if (Object.keys(verdict).some((key) => !['state', 'qualifiedVersion', 'matched'].includes(key))) return false;
  if (verdict.state !== 'allow' && verdict.state !== 'warn' && verdict.state !== 'block') return false;
  if (!isVersionText(verdict.qualifiedVersion)) return false;
  if (verdict.matched !== undefined && !isVersionText(verdict.matched)) return false;
  // A block verdict always names what decided it; allow/warn may carry the matched spec.
  return verdict.state !== 'block' || verdict.matched !== undefined;
}

/** Reject legacy/mixed authoring shapes; copy only validated, known facts. */
export function validateRuntimeDetectResult(value: unknown): RuntimeDetectResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid runtime detection result');
  }
  const result = value as Record<string, unknown>;
  if (!Object.hasOwn(result, 'kind')) throw new TypeError('invalid runtime detection result');
  const { kind, version, authPresent, advisory, versionVerdict } = result;
  if (kind === 'available') {
    if (Object.keys(result).some((key) => !['kind', 'version', 'authPresent', 'advisory', 'versionVerdict'].includes(key))
      || (version !== undefined && typeof version !== 'string')
      || (authPresent !== undefined && typeof authPresent !== 'boolean')
      || (advisory !== undefined && !isAdvisory(advisory))
      || (versionVerdict !== undefined && !isVersionVerdict(versionVerdict))) {
      throw new TypeError('invalid runtime detection result');
    }
    // A warning verdict and the legacy advisory are two projections of one
    // fact: warn ⇔ advisory, with the same qualified version. An absent
    // verdict keeps the old semantics (an advisory means warn).
    const verdict = versionVerdict as RuntimeVersionVerdict | undefined;
    const warn = verdict?.state === 'warn';
    if (warn && (advisory === undefined || advisory.qualifiedVersion !== verdict!.qualifiedVersion)) {
      throw new TypeError('invalid runtime detection result');
    }
    if (verdict !== undefined && !warn && advisory !== undefined) {
      throw new TypeError('invalid runtime detection result');
    }
    return Object.freeze({
      kind,
      ...(version === undefined ? {} : { version }),
      ...(authPresent === undefined ? {} : { authPresent }),
      ...(advisory === undefined ? {} : { advisory: Object.freeze({ reason: advisory.reason, qualifiedVersion: advisory.qualifiedVersion }) }),
      ...(verdict === undefined ? {} : {
        versionVerdict: Object.freeze({
          state: verdict.state,
          qualifiedVersion: verdict.qualifiedVersion,
          ...(verdict.matched === undefined ? {} : { matched: verdict.matched }),
        }) as RuntimeVersionVerdict,
      }),
    });
  }
  if (kind === 'refused' && result.reason === 'runtime_environment_unavailable') {
    if (Object.keys(result).length !== 3 || !ENVIRONMENT_CODES.includes(result.code as string)) throw new TypeError('invalid runtime detection result');
    return Object.freeze({ kind, reason: 'runtime_environment_unavailable', code: result.code as ServiceEnvironmentUnavailableCode });
  }
  if (kind === 'refused') {
    if (Object.keys(result).length !== 2 || !Object.hasOwn(result, 'reason')
      || !REFUSAL_REASONS.includes(result.reason as RuntimeDetectionRefusalReason)) throw new TypeError('invalid runtime detection result');
    return Object.freeze({ kind, reason: result.reason as Exclude<RuntimeDetectionRefusalReason, 'runtime_environment_unavailable'> });
  }
  if (RUNTIME_DETECTION_FAILURE_KINDS.some((candidate) => candidate === kind)
    && Object.keys(result).every((key) => key === 'kind')) {
    return Object.freeze({ kind: kind as Exclude<typeof RUNTIME_DETECTION_FAILURE_KINDS[number], 'refused'> });
  }
  throw new TypeError('invalid runtime detection result');
}

/**
 * Single routing author for daemon, selection and local diagnostics. A host
 * platform outside `descriptor.platforms` is refused before `detect()` runs.
 */
export async function observeRuntimeDetection(adapter: RuntimeAdapter, signal?: AbortSignal): Promise<RuntimeDetectResult> {
  const platforms = adapter.descriptor.platforms;
  if (platforms !== undefined && !platforms.includes(process.platform)) {
    return validateRuntimeDetectResult({ kind: 'refused', reason: 'platform_unsupported' });
  }
  return validateRuntimeDetectResult(await adapter.detect(signal));
}

/** Whether `id` is a frozen wire runtime id. Every other adapter id is selected by `harnessId`. */
export function isWireRuntimeId(id: string): id is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(id);
}

/** The task selection that reaches this adapter: `runtime` for a wire runtime id, else `harnessId`. Never both. */
export function taskRuntimeTarget(descriptor: Pick<RuntimeAdapterDescriptor, 'id'>): { readonly runtime: RuntimeId } | { readonly harnessId: string } {
  return isWireRuntimeId(descriptor.id) ? { runtime: descriptor.id } : { harnessId: descriptor.id };
}
