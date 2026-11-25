import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeUpgradeAdvice } from './runtime/runtime-releases.js';
import type { RuntimeUnsupportedVersion } from './runtime/runtime-reader-types.js';
import { RUNTIME_IDS } from '@byok-sdk/protocol/constants';
import type { ExecutionTarget, RuntimeId } from '@byok-sdk/protocol';
import { SERVICE_ENVIRONMENT_UNAVAILABLE_CODES, type ServiceEnvironmentUnavailableCode } from './login-shell-environment.js';
import { RUNTIME_DETECTION_FAILURE_KINDS, type RuntimeAdapter, type RuntimeAdapterDescriptor, type RuntimeDetectResult, type RuntimeDetectionRefusalReason, type RuntimeExecutableSource, type RuntimeVersionVerdict } from './types.js';

/** How one restart changed an installed runtime's version token (#1103 §2.6). */
export type RuntimeVersionChangeDirection = 'upgrade' | 'downgrade' | 'changed' | 'unknown';

/** The local, restart-only version comparison; never sent on the wire or into audit. */
export interface RuntimeVersionChange {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly direction: RuntimeVersionChangeDirection;
  readonly observedAt: string;
}

/** Content-free observation of one configured adapter, including unavailable outcomes. */
export interface RuntimeObservation {
  id: string;
  present: boolean;
  outcome: RuntimeDetectResult['kind'];
  reason?: RuntimeDetectionRefusalReason;
  /** With `reason: 'runtime_environment_unavailable'`: why the login-shell capture or, on win32, the logon registry read failed. */
  code?: ServiceEnvironmentUnavailableCode;
  version?: string;
  /** Native release floor refusal, for local status and doctor only. */
  unsupportedVersion?: RuntimeUnsupportedVersion;
  /** Upgrade advice derived independently of the runtime version policy. */
  upgrade?: RuntimeUpgradeAdvice;
  /**
   * The qualified version of a `warn` verdict, and only of one. Audit keeps
   * this projection of the warning while it drops the verdict itself.
   */
  qualifiedVersion?: string;
  /**
   * The effective version policy's verdict (#1103). Local-only:
   * `Daemon.status()` and control `status` carry it inline; the wire carries
   * only the protocol's `RuntimeInfo` fields. Optional: an adapter without a
   * policy has no verdict, and a reader must not infer `allow` from its absence.
   */
  versionVerdict?: RuntimeVersionVerdict;
  /**
   * #1103 §2.6: this run's comparison with the last stored token. Local-only
   * (status, doctor, startup stderr); never on the wire, in audit or in a
   * support bundle. Absent on a first run, an unchanged version, or an
   * unavailable runtime.
   */
  versionChange?: RuntimeVersionChange;
  /**
   * #1103 O10: the absolute executable detection ran, and who chose it.
   * Local-only (`Daemon.status()`, control `status`, `doctor`); never on the
   * wire, in audit or in a support bundle, because the path can name the local
   * user. Absent when detection did not run an executable it can name: an
   * unavailable runtime, a bare command the OS finds on PATH at spawn (source
   * `path` only), or a Pi lane that launches an SDK entry.
   */
  executablePath?: string;
  executableSource?: RuntimeExecutableSource;
  authPresent?: boolean;
  steer: boolean;
  resume: boolean;
  images?: boolean;
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
  const capabilities = detectedRuntimeCapabilities(descriptor, detected);
  return {
    id: bounded(descriptor.id, 128),
    present: detected.kind === 'available',
    outcome: detected.kind,
    ...(detected.kind === 'refused' ? { reason: detected.reason } : {}),
    ...(detected.kind === 'refused' && detected.reason === 'acp_unavailable' && detected.unsupportedVersion !== undefined
      ? { unsupportedVersion: detected.unsupportedVersion } : {}),
    ...(detected.kind === 'refused' && detected.reason === 'runtime_environment_unavailable' ? { code: detected.code } : {}),
    ...(detected.kind === 'available' && detected.version !== undefined ? { version: bounded(detected.version, 256) } : {}),
    ...(verdict?.state === 'warn' ? { qualifiedVersion: verdict.qualifiedVersion } : {}),
    ...(verdict === undefined ? {} : { versionVerdict: verdict }),
    ...(detected.kind === 'available' && detected.executablePath !== undefined ? { executablePath: detected.executablePath } : {}),
    ...(detected.kind === 'available' && detected.executableSource !== undefined ? { executableSource: detected.executableSource } : {}),
    ...(detected.kind === 'available' && detected.authPresent !== undefined ? { authPresent: detected.authPresent } : {}),
    steer: capabilities.steer,
    resume: capabilities.resume,
    ...(capabilities.images === undefined ? {} : { images: capabilities.images }),
  };
}

/** Keys of the redacted audit observation; see `DaemonRecord` `runtimes-detected`. */
const AUDIT_OBSERVATION_KEYS: readonly string[] = Object.freeze(['id', 'present', 'outcome', 'reason', 'code', 'version', 'qualifiedVersion', 'authPresent', 'steer', 'resume', 'images']);
/** Live status adds the local-only evidence audit never holds. */
const STATUS_OBSERVATION_KEYS: readonly string[] = Object.freeze([...AUDIT_OBSERVATION_KEYS, 'versionVerdict', 'versionChange', 'executablePath', 'executableSource', 'unsupportedVersion', 'upgrade']);

/** Side arrays an earlier daemon's control `status` sent beside `runtimes[]`. */
const REMOVED_STATUS_SIDE_ARRAYS: readonly string[] = Object.freeze(['runtimeVersionVerdicts', 'runtimeVersionChanges', 'runtimeExecutables']);

/** A control `status` from an earlier daemon release; its runtime evidence is refused, not dropped. */
export class ControlStatusShapeUnsupportedError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`daemon status carries ${fields.join(', ')} from an earlier release; run status and doctor from the daemon's release`);
    this.name = 'ControlStatusShapeUnsupportedError';
  }
}

/** The runtimes of a control `status` result. */
export function parseControlStatusRuntimes(status: { readonly runtimes?: unknown; readonly runtimeVersionVerdicts?: unknown; readonly runtimeVersionChanges?: unknown; readonly runtimeExecutables?: unknown }): RuntimeObservation[] | undefined {
  const removed = REMOVED_STATUS_SIDE_ARRAYS.filter((key) => Object.hasOwn(status, key));
  if (removed.length > 0) throw new ControlStatusShapeUnsupportedError(removed);
  return parseRuntimeObservations(status.runtimes, 'status');
}

/**
 * Reject unreadable observations; never infer availability from another
 * discovery shape. `audit` reads the redacted `runtimes-detected` record;
 * `status` reads the control `status` result, which carries the verdict,
 * restart comparison and executable inline.
 */
export function parseRuntimeObservations(value: unknown, source: 'audit' | 'status'): RuntimeObservation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = source === 'audit' ? AUDIT_OBSERVATION_KEYS : STATUS_OBSERVATION_KEYS;
  const observations: RuntimeObservation[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(key => !allowed.includes(key))
      || typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 128 || /[\r\n\t]/.test(r.id)
      || typeof r.steer !== 'boolean' || typeof r.resume !== 'boolean'
      || (r.images !== undefined && typeof r.images !== 'boolean')
      || r.present !== (r.outcome === 'available')
      || (r.version !== undefined && (typeof r.version !== 'string' || r.version.length > 256 || /[\r\n\t]/.test(r.version)))
      || (r.qualifiedVersion !== undefined && (typeof r.qualifiedVersion !== 'string' || r.qualifiedVersion.length > 256 || /[\r\n\t]/.test(r.qualifiedVersion)))
      || (r.versionChange !== undefined && !isVersionChange(r.versionChange))) return undefined;
    let detected: RuntimeDetectResult;
    try {
      detected = validateRuntimeDetectResult({
        kind: r.outcome,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(r.unsupportedVersion === undefined ? {} : { unsupportedVersion: r.unsupportedVersion }),
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(r.version === undefined ? {} : { version: r.version }),
        ...(r.authPresent === undefined ? {} : { authPresent: r.authPresent }),
        ...(r.versionVerdict === undefined ? {} : { versionVerdict: r.versionVerdict }),
        ...(r.executablePath === undefined ? {} : { executablePath: r.executablePath }),
        ...(r.executableSource === undefined ? {} : { executableSource: r.executableSource }),
      });
    } catch { return undefined; }
    if (r.qualifiedVersion !== undefined && detected.kind !== 'available') return undefined;
    const verdict = detected.kind === 'available' ? detected.versionVerdict : undefined;
    // With the verdict present, `qualifiedVersion` must be exactly its warning projection.
    if (verdict !== undefined
      && (verdict.state === 'warn' ? r.qualifiedVersion !== verdict.qualifiedVersion : r.qualifiedVersion !== undefined)) return undefined;
    if (source === 'status' && verdict === undefined && r.qualifiedVersion !== undefined) return undefined;
    if (r.upgrade !== undefined && !isRuntimeUpgradeAdvice(r.upgrade)) return undefined;
    const change = r.versionChange as RuntimeVersionChange | undefined;
    // SAFETY: the preceding checks validate every allowed observation field.
    observations.push({
      ...r,
      ...(verdict === undefined ? {} : { versionVerdict: verdict }),
      ...(change === undefined ? {} : {
        versionChange: Object.freeze({
          fromVersion: change.fromVersion,
          toVersion: change.toVersion,
          direction: change.direction,
          observedAt: change.observedAt,
        }),
      }),
    } as unknown as RuntimeObservation);
  }
  return observations;
}

const REFUSAL_REASONS: readonly RuntimeDetectionRefusalReason[] = Object.freeze(['app_server_unavailable', 'acp_unavailable', 'platform_unsupported', 'agent_user_context_unavailable']);
const ENVIRONMENT_CODES: readonly string[] = SERVICE_ENVIRONMENT_UNAVAILABLE_CODES;
const MAX_VERSION_CHARS = 256;
const MAX_EXECUTABLE_PATH_CHARS = 4096;
const EXECUTABLE_SOURCES: readonly string[] = Object.freeze(['config', 'path', 'env', 'managed'] satisfies RuntimeExecutableSource[]);

/** Both optional; a path must be absolute, printable and explained by a source. */
function isExecutableFields(executablePath: unknown, executableSource: unknown): boolean {
  if (executableSource !== undefined && !EXECUTABLE_SOURCES.includes(executableSource as string)) return false;
  if (executablePath === undefined) return true;
  return executableSource !== undefined && typeof executablePath === 'string'
    && executablePath.length > 0 && executablePath.length <= MAX_EXECUTABLE_PATH_CHARS
    && !/[\u0000-\u001f\u007f]/.test(executablePath) && path.isAbsolute(executablePath);
}

function isVersionText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_CHARS;
}

function isRuntimeUpgradeAdvice(value: unknown): value is RuntimeUpgradeAdvice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const advice = value as Record<string, unknown>;
  return Object.keys(advice).every(key => ['state', 'installedVersion', 'qualifiedVersion', 'minimumVersion', 'command'].includes(key))
    && (advice.state === 'required'
      ? isVersionText(advice.minimumVersion) && (advice.installedVersion === undefined || isVersionText(advice.installedVersion))
      : advice.state === 'available' && advice.minimumVersion === undefined && isVersionText(advice.installedVersion))
    && isVersionText(advice.qualifiedVersion) && isVersionText(advice.command) && !/[\r\n\0]/u.test(advice.command);
}

function isVersionChange(value: unknown): value is RuntimeVersionChange {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  if (Object.keys(change).some((key) => !['fromVersion', 'toVersion', 'direction', 'observedAt'].includes(key))) return false;
  if (!isVersionText(change.fromVersion) || !isVersionText(change.toVersion)) return false;
  if (change.direction !== 'upgrade' && change.direction !== 'downgrade'
    && change.direction !== 'changed' && change.direction !== 'unknown') return false;
  return typeof change.observedAt === 'string' && change.observedAt.length > 0
    && change.observedAt.length <= 64 && !Number.isNaN(Date.parse(change.observedAt));
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
export function detectedRuntimeCapabilities(descriptor: RuntimeAdapterDescriptor, detected: RuntimeDetectResult) {
  return detected.kind === 'available' && detected.sessionCapabilities !== undefined
    ? { ...descriptor.capabilities, ...detected.sessionCapabilities }
    : descriptor.capabilities;
}

/**
 * Launch data an adapter verified while producing one `available` observation,
 * keyed by that observation object. Only the adapter that bound it can read
 * it, and only once, so a forged, copied or reused `detected` never skips a
 * probe and one observation serves one `prepare()`.
 */
const verifiedDetections = new WeakMap<object, { readonly adapter: RuntimeAdapter; readonly payload: unknown }>();

/** Binds `payload` (the exact command or invocation the probe ran) to an `available` observation. Returns `result`. */
export function bindVerifiedDetection<R extends RuntimeDetectResult>(adapter: RuntimeAdapter, result: R, payload: unknown): R {
  if (result.kind === 'available') verifiedDetections.set(result, { adapter, payload });
  return result;
}

/** The payload `adapter` bound to this observation, consumed on read; `undefined` for any other observation. */
export function takeVerifiedDetection<T>(adapter: RuntimeAdapter, result: RuntimeDetectResult | undefined): T | undefined {
  if (result === undefined || result.kind !== 'available') return undefined;
  const entry = verifiedDetections.get(result);
  if (entry === undefined || entry.adapter !== adapter) return undefined;
  verifiedDetections.delete(result);
  return entry.payload as T;
}

export function validateRuntimeDetectResult(value: unknown): RuntimeDetectResult {
  const result = validateRuntimeDetectResultShape(value);
  // The validated copy carries the binding of the observation it copies.
  const entry = verifiedDetections.get(value as object);
  if (entry !== undefined && result !== value) {
    verifiedDetections.delete(value as object);
    verifiedDetections.set(result, entry);
  }
  return result;
}

function validateRuntimeDetectResultShape(value: unknown): RuntimeDetectResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid runtime detection result');
  }
  const result = value as Record<string, unknown>;
  if (!Object.hasOwn(result, 'kind')) throw new TypeError('invalid runtime detection result');
  const { kind, version, rawVersion, authPresent, versionVerdict, executablePath, executableSource, sessionCapabilities } = result;
  if (kind === 'available') {
    if (Object.keys(result).some((key) => !['kind', 'version', 'rawVersion', 'authPresent', 'versionVerdict', 'executablePath', 'executableSource', 'sessionCapabilities'].includes(key))
      || (sessionCapabilities !== undefined && (sessionCapabilities === null || typeof sessionCapabilities !== 'object'
        || Array.isArray(sessionCapabilities) || Object.entries(sessionCapabilities).some(([key, flag]) =>
          (key !== 'steer' && key !== 'images') || typeof flag !== 'boolean')))
      || !isExecutableFields(executablePath, executableSource)
      || (version !== undefined && typeof version !== 'string')
      || (rawVersion !== undefined && typeof rawVersion !== 'string')
      || (authPresent !== undefined && typeof authPresent !== 'boolean')
      || (versionVerdict !== undefined && !isVersionVerdict(versionVerdict))) {
      throw new TypeError('invalid runtime detection result');
    }
    const verdict = versionVerdict as RuntimeVersionVerdict | undefined;
    return Object.freeze({
      kind,
      ...(version === undefined ? {} : { version }),
      ...(rawVersion === undefined ? {} : { rawVersion }),
      ...(sessionCapabilities === undefined ? {} : { sessionCapabilities: Object.freeze({ ...sessionCapabilities }) }),
      ...(authPresent === undefined ? {} : { authPresent }),
      ...(executablePath === undefined ? {} : { executablePath: executablePath as string }),
      ...(executableSource === undefined ? {} : { executableSource: executableSource as RuntimeExecutableSource }),
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
  if (kind === 'refused' && result.reason === 'acp_unavailable' && result.unsupportedVersion !== undefined) {
    const fields = result.unsupportedVersion as Partial<RuntimeUnsupportedVersion> | null;
    if (Object.keys(result).length !== 3 || !fields || typeof fields !== 'object'
      || Object.keys(fields).some(key => key !== 'installedVersion' && key !== 'requiredVersion')
      || !isVersionText(fields.requiredVersion) || (fields.installedVersion !== undefined && !isVersionText(fields.installedVersion))) {
      throw new TypeError('invalid runtime detection result');
    }
    return Object.freeze({ kind, reason: 'acp_unavailable', unsupportedVersion: Object.freeze({ requiredVersion: fields.requiredVersion,
      ...(fields.installedVersion === undefined ? {} : { installedVersion: fields.installedVersion }) }) });
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
  return observeDetection(adapter, detectSignal => adapter.detect(detectSignal), signal);
}

type AdmissionDetect = (signal?: AbortSignal) => Promise<RuntimeDetectResult>;
type AdmissionEntry =
  | { readonly protoDetect: RuntimeAdapter['detect']; readonly detect: AdmissionDetect }
  | { readonly protoDetect: RuntimeAdapter['detect']; readonly inner: RuntimeAdapter };
const admissionDetects = new WeakMap<RuntimeAdapter, AdmissionEntry>();

/**
 * A built-in adapter's detection for task admission, which never reads
 * `authPresent` (#2468): it skips the login probe, so one offer runs the slow
 * login read only once, at launch. `protoDetect` is the class's own `detect`;
 * admission uses this entry only while the instance still has it, so a spy,
 * an assigned `detect` or a subclass override keeps its own path.
 */
export function registerAdmissionDetect(adapter: RuntimeAdapter, protoDetect: RuntimeAdapter['detect'], detect: AdmissionDetect): void {
  admissionDetects.set(adapter, { protoDetect, detect });
}

/**
 * Declares that a Host `decorator` delegates `detect()` to `inner`, so task
 * admission keeps a built-in adapter's fast detection, which skips the login
 * probe, for the decorator too (#2495). Admission then does not call
 * `decorator.detect`. It takes the fast path only while every adapter in the
 * chain still has the `detect` it had at registration and the chain ends at a
 * built-in adapter with a fast path; otherwise it calls `decorator.detect`.
 * Both adapters must run the same runtime: the same descriptor `id` and
 * `versionPolicy`, and the decorator's `platforms` within the inner adapter's,
 * because admission applies the decorator's descriptor to the inner result.
 * Throws `TypeError` when they differ or the delegation would form a cycle.
 */
export function delegateAdmissionDetection(decorator: RuntimeAdapter, inner: RuntimeAdapter): void {
  const outer = decorator.descriptor;
  const wrapped = inner.descriptor;
  if (outer.id !== wrapped.id) throw new TypeError('delegateAdmissionDetection requires the same descriptor id');
  if (!isDeepStrictEqual(outer.versionPolicy, wrapped.versionPolicy)) throw new TypeError('delegateAdmissionDetection requires the same versionPolicy');
  if (wrapped.platforms !== undefined && (outer.platforms === undefined || outer.platforms.some(platform => !wrapped.platforms!.includes(platform)))) {
    throw new TypeError('delegateAdmissionDetection requires decorator platforms within the inner adapter platforms');
  }
  for (let node: RuntimeAdapter | undefined = inner; node !== undefined;) {
    if (node === decorator) throw new TypeError('delegateAdmissionDetection would form a cycle');
    const entry = admissionDetects.get(node);
    node = entry !== undefined && 'inner' in entry ? entry.inner : undefined;
  }
  admissionDetects.set(decorator, { protoDetect: decorator.detect, inner });
}

function admissionDetect(adapter: RuntimeAdapter): AdmissionDetect | undefined {
  for (let node = adapter; ;) {
    const entry = admissionDetects.get(node);
    if (entry === undefined || node.detect !== entry.protoDetect) return undefined;
    if ('detect' in entry) return entry.detect;
    node = entry.inner;
  }
}

/** {@link observeRuntimeDetection} for task admission: a built-in adapter may skip facts admission never reads (`registerAdmissionDetect`). */
export async function observeAdmissionDetection(adapter: RuntimeAdapter, signal?: AbortSignal): Promise<RuntimeDetectResult> {
  return observeDetection(adapter, detectSignal => {
    const builtIn = admissionDetect(adapter);
    return builtIn === undefined ? adapter.detect(detectSignal) : builtIn(detectSignal);
  }, signal);
}

async function observeDetection(adapter: RuntimeAdapter, detect: (signal?: AbortSignal) => Promise<RuntimeDetectResult>, signal: AbortSignal | undefined): Promise<RuntimeDetectResult> {
  const platforms = adapter.descriptor.platforms;
  if (platforms !== undefined && !platforms.includes(process.platform)) {
    return validateRuntimeDetectResult({ kind: 'refused', reason: 'platform_unsupported' });
  }
  return validateRuntimeDetectResult(await detect(signal));
}

/** Whether `id` is a frozen wire runtime id. Every other adapter id is selected by a `harness` target. */
export function isWireRuntimeId(id: string): id is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(id);
}

/** Explicitly request an adapter's device-owned configuration. */
export function taskRuntimeTarget(descriptor: Pick<RuntimeAdapterDescriptor, 'id'>): Extract<ExecutionTarget, { lane: 'harness' }> {
  return { lane: 'harness', harnessId: descriptor.id, selection: { mode: 'device-default' } };
}
