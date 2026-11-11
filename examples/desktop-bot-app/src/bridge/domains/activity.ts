/**
 * The activity bridge domain: activity and approval cards. Owned by A4 #1808.
 * Methods are named `activity.<verb>`; the Host handlers live in `src/host/activity/domain.ts`.
 */
import type { BridgeDomain } from '../domain.ts';

export interface ActivityMethods {}

export const ACTIVITY_DOMAIN = { renderer: [], main: [] } as const satisfies BridgeDomain<ActivityMethods>;
