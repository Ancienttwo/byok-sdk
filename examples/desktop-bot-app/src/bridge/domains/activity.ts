/**
 * The activity bridge domain: activity and approval cards. Owned by A4 #1808.
 * Methods are named `activity.<verb>`; the Host handlers live in `src/host/activity/domain.ts`.
 */
import type { BridgeDomain } from '../domain.ts';
import type { ActivityCard } from '../../host/activity/cards.ts';

export interface ActivityMethods {
  /** The cards of the tasks created since the Host started, newest first, at most 50. */
  'activity.cards': { params: undefined; result: ActivityCard[] };
  /** One task's card, such as a conversation Turn's. */
  'activity.card': { params: { taskId: string }; result: ActivityCard };
  /** Approves exactly this pending approval; a superseded one is refused (`StaleApprovalError`). */
  'activity.approve': { params: { taskId: string; approvalId: string }; result: null };
  'activity.reject': { params: { taskId: string; approvalId: string; reason?: string }; result: null };
}

export const ACTIVITY_DOMAIN = {
  renderer: ['activity.cards', 'activity.card', 'activity.approve', 'activity.reject'],
  main: [],
} as const satisfies BridgeDomain<ActivityMethods>;
