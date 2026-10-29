import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../errors';
import { terminalReceiptKey } from '../inbound';
import { taskOfferMessageId } from '../offer-identity';
import { SEALED_TASK_REFERENCE_KIND } from '../sealed-ciphertext';
import {
  parseTaskRedactionInput,
  taskRedactionCodec,
  taskRedactionReceiptKey,
  type TaskRedactionResult,
  type TaskRedactionTaskResult,
} from '../task-redaction';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
}

export function createTaskRedactionsApi({ root, controlPlane, options }: Dependencies): Pick<ByokCloud,
  'redactTasks'
> {
  async function redactTasks(tenant: TenantId, input: { readonly taskIds: readonly string[] }): Promise<TaskRedactionResult> {
    const store = options.taskRedactionStore;
    if (store === undefined) {
      throw new ByokCloudError('task_redaction_unavailable', 'Task redaction is not configured for this deployment.');
    }
    const taskIds = parseTaskRedactionInput(input);
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const codec = taskRedactionCodec(options.crypto);
    const tasks: TaskRedactionTaskResult[] = [];
    for (const taskId of taskIds) {
      const attempt = await stores.tasks.get(taskId);
      if (attempt === undefined) {
        tasks.push({ taskId, outcome: 'not_found' });
        continue;
      }
      const messageId = await taskOfferMessageId(tenant, taskId, attempt.deviceId, attempt.agentRef, bytes => options.crypto.sha256(bytes));
      tasks.push(await store.redactTask({
        tenantId: tenant,
        taskId,
        receiptKeys: [`task-offer:${messageId}`, terminalReceiptKey(taskId), `agent-message-offer:${attempt.deviceId}:${taskId}`],
        terminalReceiptKey: terminalReceiptKey(taskId),
        releaseObjectReferences: [{ refKind: SEALED_TASK_REFERENCE_KIND, refId: taskId }],
        auditReceiptKey: taskRedactionReceiptKey(taskId),
        codec,
      }));
    }
    return { tasks };
  }

  return { redactTasks };
}
