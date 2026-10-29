import type { DaemonConfig } from '../create-daemon';
import { validateInputPreparationLimits } from '../../input-preparation';
import {
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_MS,
  DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  assertPresenceHeartbeatCadence,
} from '../presence-publisher';
import { resolveDeviceAssertionAudiences, resolveDeviceAssertionTtlMs } from './support';

/** Pure operational bounds shared by construction and the side-effect-free config check. */
export function resolveDaemonOperationalConfig(config: Pick<DaemonConfig, 'presence' | 'deviceAssertion' | 'inputPreparation'>) {
  const presenceCadence = {
    intervalMs: config.presence?.intervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
    ttlMs: config.presence?.ttlMs ?? DEFAULT_PRESENCE_TTL_MS,
    minimumIntervalMs: config.presence?.minimumIntervalMs ?? DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  };
  assertPresenceHeartbeatCadence(presenceCadence);

  // Exact membership and credential lifetime must be validated before the
  // operator can observe a running assertion broker.
  const deviceAssertionAudiences = resolveDeviceAssertionAudiences(config.deviceAssertion);
  const deviceAssertionTtlMs = resolveDeviceAssertionTtlMs(config.deviceAssertion);
  const inputPreparationLimits = config.inputPreparation === undefined
    ? undefined
    : validateInputPreparationLimits(config.inputPreparation.limits);
  return { presenceCadence, deviceAssertionAudiences, deviceAssertionTtlMs, inputPreparationLimits };
}
