import type { ByokCloud } from '../cloud';
import type { ControlPlanePrincipal, TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../errors';
import { isTaskAbandonCause, TASK_ABANDON_CAUSES } from '../stores/ports';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
}

export function createTaskAbandonmentApi({ root, controlPlane }: Dependencies): Pick<ByokCloud,
  'abandonTask'
> {
  return {
    async abandonTask(tenant, taskId, cause) {
      if (!isTaskAbandonCause(cause)) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Task abandon cause ${JSON.stringify(cause)} is not one of ${TASK_ABANDON_CAUSES.join(', ')}.`,
        );
      }
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const attempt = await stores.cancellations.abandon({ taskId, cause });
      if (attempt === undefined) {
        throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
      }
      return attempt;
    },
  };
}
