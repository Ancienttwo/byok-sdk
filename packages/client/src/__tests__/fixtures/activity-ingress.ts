import type { TaskRunnerDeps } from '../../daemon/task-runner';
import type { ActivityIngress, HarnessInfo } from '@byok-sdk/protocol';
import type { RuntimeAdapter } from '../../types';

export function testHarnesses(adapters: readonly RuntimeAdapter[]): HarnessInfo[] {
  return adapters.map(({ descriptor }) => ({ id: descriptor.id, capabilities: {
    selectionModes: [...descriptor.selectionModes],
    ...(descriptor.defaultModelModes === undefined ? {} : { defaultModelModes: [...descriptor.defaultModelModes] }),
    effort: descriptor.supportsEffort === true,
    ...(descriptor.supportsServiceTier === true ? { serviceTier: true } : {}),
    ...(descriptor.supportsServiceTierFallback === true ? { serviceTierFallback: true } : {}),
    ...(descriptor.byokProviderId === undefined ? {} : { byokProviderId: descriptor.byokProviderId }),
  } }));
}

/**
 * The reference cloud's default activity advertisement. TaskRunner harnesses
 * run without a ConnectionManager, so this stands in for the `ingress` an
 * accepted handshake always carries on wire v3.
 */
export const TEST_ACTIVITY_INGRESS: Readonly<ActivityIngress> = Object.freeze({ activityMaxEvents: 50, activityMaxBytes: 65536 });

export function testIngressBudget(): Readonly<ActivityIngress> {
  return TEST_ACTIVITY_INGRESS;
}

/**
 * TaskRunner harnesses have no cloud to answer their `task.claim`; this
 * stands in for the POST outcome of an accepted claim (#2294).
 */
export const acceptClaimSettlement: TaskRunnerDeps['awaitClaimSettlement'] = async () => ({ outcome: 'accepted' });
