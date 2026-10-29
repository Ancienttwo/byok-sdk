import type { ByokCloud, ByokCloudOptions, EnqueuedAgentControl } from '../cloud';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import {
  TaskSteerSealedPayloadSchema,
  createEnvelope,
  requiredReceiverCapabilities,
  type TaskSteerSealedPayload,
} from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors';
import { uuidFromSha256 } from '../offer-identity';
import { releaseSealedCiphertext, sealedCiphertextRef } from '../sealed-ciphertext';
import { sameSealedProjection } from '../sealed-comparison';
import { SteerRejectedError } from '../steer-control';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';
import { isTerminalAttemptStatus, refuseSealedFields, type EnqueuePaths } from './enqueue';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
  assertAgentCapabilities: EnqueuePaths['assertAgentCapabilities'];
  assertSealedCiphertext: EnqueuePaths['assertSealedCiphertext'];
  retainTaskCiphertext: EnqueuePaths['retainTaskCiphertext'];
  enqueueAgentControlEnvelope: EnqueuePaths['enqueueAgentControlEnvelope'];
}

export function createSteeringApi({
  root,
  controlPlane,
  options,
  assertAgentCapabilities,
  assertSealedCiphertext,
  retainTaskCiphertext,
  enqueueAgentControlEnvelope,
}: Dependencies): Pick<ByokCloud,
  | 'steerTask'
  | 'steerSealedTask'
> {
  /**
   * The steer gate. See {@link ByokCloud.steerTask} for the order and
   * `steer-control.ts` for why the claim snapshot is the only input.
   */
  async function steerTask(
    tenant: TenantId,
    taskId: string,
    payload: { readonly text: string },
  ): Promise<EnqueuedAgentControl> {
    refuseSealedFields(payload, ['sealing', 'sealed', 'steerId'], 'steerSealedTask');
    const ownerDeviceId = await runningSteerTarget(tenant, taskId);
    const messageId = options.crypto.randomUuid();
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      createEnvelope('task.steer', { text: payload.text }, { id: messageId, taskId, seq }),
    );
  }

  /** The sealed steer: the same gates, then the device flag. See {@link ByokCloud.steerSealedTask}. */
  async function steerSealedTask(
    tenant: TenantId,
    taskId: string,
    payload: TaskSteerSealedPayload,
  ): Promise<EnqueuedAgentControl> {
    const sealed = TaskSteerSealedPayloadSchema.parse(payload);
    const ownerDeviceId = await runningSteerTarget(tenant, taskId);
    await assertAgentCapabilities(tenant, ownerDeviceId, requiredReceiverCapabilities('task.steer', sealed));
    await assertSealedCiphertext(tenant, sealed);
    await retainTaskCiphertext(tenant, taskId, sealed);
    // One steer id names one steer: a retry finds the same mailbox row. A
    // retry that seals the same text again keeps the first ciphertext (§9.2).
    // Mailbox retention deletes an acknowledged row while the task runs, so a
    // later retry appends again. The device drops a steer id it has seen (12a).
    const messageId = uuidFromSha256(await options.crypto.sha256(
      new TextEncoder().encode(JSON.stringify({ domain: 'byok:task-steer-sealed', tenant, taskId, steerId: sealed.steerId })),
    ));
    const enqueued = await enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      createEnvelope('task.steer', sealed, { id: messageId, taskId, seq }),
    );
    // A retry that names a new blob is a duplicate or a conflict. The stored
    // row keeps its own blob, so the task does not hold the new one.
    const proposedRef = sealedCiphertextRef(sealed);
    if (proposedRef !== undefined && sealedCiphertextRef(enqueued.envelope.payload)?.contentHash !== proposedRef.contentHash) {
      await releaseSealedCiphertext(tenantStoresFor(controlPlane(tenant), root).objects, taskId, proposedRef);
    }
    if (enqueued.envelope.type !== 'task.steer' || enqueued.envelope.payload.sealed === undefined
      || !sameSealedProjection(enqueued.envelope.payload, sealed)) {
      throw new ByokCloudError('coordination_input_invalid', `Task ${taskId} already has a different steer ${sealed.steerId}.`);
    }
    return enqueued;
  }

  /** The steer gates 1 to 4; returns the device that owns the running task. */
  async function runningSteerTarget(tenant: TenantId, taskId: string): Promise<string> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const attempt = await stores.tasks.get(taskId);
    if (attempt === undefined) {
      throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
    }
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new SteerRejectedError(taskId, 'task_terminal', attempt.status, attempt.claimedRuntime);
    }
    // The owner check rides the same gate as the status check rather than
    // getting a fourth code: an attempt with no owning device has no runtime
    // paused on a turn, which is exactly what `task_not_running` says. It is
    // also unreachable while `running` implies a prior claim — this is the
    // narrowing, not a second contract.
    const ownerDeviceId = attempt.ownerDeviceId;
    if (attempt.status !== 'running' || ownerDeviceId === undefined) {
      throw new SteerRejectedError(taskId, 'task_not_running', attempt.status, attempt.claimedRuntime);
    }
    if (attempt.claimedRuntimeCapabilities?.steer !== true) {
      throw new SteerRejectedError(
        taskId,
        'steer_unsupported_runtime',
        attempt.status,
        attempt.claimedRuntime,
      );
    }
    return ownerDeviceId;
  }

  return { steerTask, steerSealedTask };
}
