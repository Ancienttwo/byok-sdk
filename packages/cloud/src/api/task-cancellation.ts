import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { contentHash, type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import { createEnvelope, decodeEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors';
import { isTaskRedactionTombstone } from '../task-redaction';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
}

export function createTaskCancellationApi({ root, controlPlane, options }: Dependencies): Pick<ByokCloud,
  'cancelTask'
> {
  return {
    async cancelTask(tenant, taskId, reason) {
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const proposedMessageId = options.crypto.randomUuid();
      const mutation = await stores.cancellations.request({
        taskId,
        proposedMessageId,
        ...(reason === undefined ? {} : { reason }),
        materialize: async (seq, messageId) => {
          const envelope = createEnvelope('task.cancel', reason === undefined ? {} : { reason }, {
            id: messageId,
            taskId,
            seq,
          });
          const body = encodeEnvelope(envelope);
          const bytes = new TextEncoder().encode(body);
          return {
            body,
            bodyHash: contentHash(await options.crypto.sha256(bytes)),
            byteSize: BigInt(bytes.length),
          };
        },
      });
      if (mutation === undefined) {
        throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
      }
      // A redacted task keeps its cancellation row with a tombstone body.
      if (mutation.message !== undefined && !isTaskRedactionTombstone(mutation.message.body)) {
        const envelope = decodeEnvelope(mutation.message.body);
        if (envelope.seq !== mutation.message.seq || envelope.type !== 'task.cancel') {
          throw new ByokCloudError(
            'mailbox_seq_mismatch',
            `Mailbox stored cancellation seq ${String(envelope.seq)} at row ${mutation.message.seq}.`,
          );
        }
      }
      return mutation.attempt;
    },
  };
}
