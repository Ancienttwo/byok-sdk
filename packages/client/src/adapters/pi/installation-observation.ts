import { isDeepStrictEqual } from 'node:util';
import {
  measureRuntimeInstallation, reverifyRuntimeInstallation,
  type RuntimeInstallationMeasurementV1,
} from '@byok-sdk/implementation-identity';
import type { RuntimeDetectResult, RuntimeDetectionRefusalReason, RuntimeInstallationObservationContext } from '../../types';
import { RUNTIME_LAUNCH_KINDS } from '../../daemon/tool-implementation-identity';
import { inspectTrustedLaunchCwd } from '../../daemon/trusted-launch-cwd';
import { verifyPiNativeInstallation } from './native-installation';
import { runtimeRecordCommonFields } from './runtime-descendant-plan';

function refused(reason: RuntimeDetectionRefusalReason): RuntimeDetectResult {
  return Object.freeze({ kind: 'refused', reason });
}
function commonMeasurement(value: RuntimeInstallationMeasurementV1): unknown {
  return { ...value, record: runtimeRecordCommonFields(value.record) };
}

/** No process, child env, credentials, task state or write probe; not an execution admission. */
export async function observePiInstallation(
  context: RuntimeInstallationObservationContext, signal?: AbortSignal,
): Promise<RuntimeDetectResult> {
  if (!context || typeof context !== 'object' || !context.authority || typeof context.authority.resolve !== 'function'
    || (context.scope !== 'entry' && context.scope !== 'enabled-top-level')
    || !Object.hasOwn(context, 'authority') || !Object.hasOwn(context, 'scope')
    || (context.scope === 'entry' && !Object.hasOwn(context, 'runtimeEntry'))
    || Object.keys(context).length !== (context.scope === 'entry' ? 3 : 2)
    || (context.scope === 'entry' && !RUNTIME_LAUNCH_KINDS.includes(context.runtimeEntry))) {
    return refused('installation_observation_unsupported');
  }
  const kinds = context.scope === 'entry' ? [context.runtimeEntry] : RUNTIME_LAUNCH_KINDS;
  const measured: RuntimeInstallationMeasurementV1[] = [];
  let version: string | undefined;
  for (const kind of kinds) {
    signal?.throwIfAborted();
    const value = await measureRuntimeInstallation(context.authority, { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: kind });
    if (value.kind === 'unavailable') return refused(value.reason);
    // A second entry field is a second physical author, never an alternative to installPath.
    if (value.record.entry !== undefined) return refused('install_record_mismatch');
    if ((await inspectTrustedLaunchCwd(value.record.launchCwd)).kind !== 'resolved') return refused('launch_cwd_unavailable');
    let native;
    try { native = verifyPiNativeInstallation(value.record); }
    catch { return refused('native_identity_mismatch'); }
    if (measured[0] !== undefined && (!isDeepStrictEqual(commonMeasurement(measured[0]), commonMeasurement(value))
      || version !== native.packageVersion)) return refused('install_record_mismatch');
    measured.push(value);
    version = native.packageVersion;
  }
  // No observation is lent to prepare; nevertheless close this local read window before publishing facts.
  for (const value of measured) {
    signal?.throwIfAborted();
    const result = await reverifyRuntimeInstallation(value);
    if (result !== 'ok') return refused(result.reason);
  }
  signal?.throwIfAborted();
  return Object.freeze({ kind: 'available', version: version! });
}
