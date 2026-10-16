import type { ActivityIngress } from '@byok-sdk/protocol';

/**
 * The reference cloud's default activity advertisement. TaskRunner harnesses
 * run without a ConnectionManager, so this stands in for the `ingress` an
 * accepted handshake always carries on wire v3.
 */
export const TEST_ACTIVITY_INGRESS: Readonly<ActivityIngress> = Object.freeze({ activityMaxEvents: 50, activityMaxBytes: 65536 });

export function testIngressBudget(): Readonly<ActivityIngress> {
  return TEST_ACTIVITY_INGRESS;
}
