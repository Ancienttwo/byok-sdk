/** The Host side of the activity bridge domain (`src/bridge/domains/activity.ts`). Owned by A4 #1808. */
import type { ActivityMethods } from '../../bridge/domains/activity.ts';
import type { HostDomain, HostContext } from '../domains.ts';

export async function createActivityDomain(_context: HostContext): Promise<HostDomain<ActivityMethods>> {
  return { handlers: {} };
}
