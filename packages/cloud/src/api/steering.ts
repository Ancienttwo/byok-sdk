import type { ByokCloud, ByokCloudOptions, EnqueuedAgentControl } from '../cloud.js';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import {
  InputImagesSchema,
  TASK_STEER_TEXT_MAX_BYTES,
  TaskSteerSealedPayloadSchema,
  createEnvelope,
  requiredReceiverCapabilities,
  type TaskSteerSealedPayload,
} from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors.js';
import { assertCommittedInputImages } from '../input-images.js';
import { uuidFromSha256 } from '@byok-sdk/protocol';
import { releaseSealedCiphertext, sealedCiphertextRef } from '../sealed-ciphertext.js';
import { sameSealedProjection } from '../sealed-comparison.js';
import { SteerRejectedError } from '../steer-control.js';
import type { SteerRefusalRecord } from '../stores/ports.js';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores.js';
import { isTerminalAttemptStatus, refuseSealedFields, type EnqueuePaths } from './enqueue.js';

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
  | 'readSteerRefusal'
  | 'listSteerRefusals'
> {
  /**
   * The steer gate. See {@link ByokCloud.steerTask} for the order and
   * `steer-control.ts` for why the claim snapshot is the only input.
   */
  const steerTask: ByokCloud['steerTask'] = async (tenant, taskId, payload) => {
    refuseSealedFields(payload, ['sealing', 'sealed', 'steerId'], 'steerSealedTask');
    // C1 (wire v7): refuse an oversized text here, before a mailbox row
    // exists, rather than as an envelope the device could never accept.
    const { text } = payload;
    if (new TextEncoder().encode(text).length > TASK_STEER_TEXT_MAX_BYTES) {
      throw new ByokCloudError('coordination_input_invalid', `Steer text exceeds ${TASK_STEER_TEXT_MAX_BYTES} UTF-8 bytes.`);
    }
    const parsed = payload.images === undefined ? undefined : InputImagesSchema.safeParse(payload.images);
    if (parsed?.success === false) {
      throw new ByokCloudError('coordination_input_invalid', 'Input images must contain 1–16 valid image references.');
    }
    const images = parsed?.data;
    const steer = { text, ...(images === undefined ? {} : { images }) };
    const ownerDeviceId = await runningSteerTarget(tenant, taskId);
    const required = requiredReceiverCapabilities('task.steer', steer);
    if (required.length > 0) await assertAgentCapabilities(tenant, ownerDeviceId, required);
    if (images !== undefined) await assertCommittedInputImages(options.cloud.blobs, tenant, images);
    const messageId = options.crypto.randomUuid();
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      createEnvelope('task.steer', steer, { id: messageId, taskId, seq }),
    );
  };

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
      throw new SteerRejectedError(taskId, 'task_terminal', attempt.status, attempt.claimedExecutor);
    }
    // The owner check rides the same gate as the status check rather than
    // getting a fourth code: an attempt with no owning device has no runtime
    // paused on a turn, which is exactly what `task_not_running` says. It is
    // also unreachable while `running` implies a prior claim — this is the
    // narrowing, not a second contract.
    const ownerDeviceId = attempt.ownerDeviceId;
    if (attempt.status !== 'running' || ownerDeviceId === undefined) {
      throw new SteerRejectedError(taskId, 'task_not_running', attempt.status, attempt.claimedExecutor);
    }
    if (attempt.claimedRuntimeCapabilities?.steer !== true) {
      throw new SteerRejectedError(
        taskId,
        'steer_unsupported_runtime',
        attempt.status,
        attempt.claimedExecutor,
      );
    }
    return ownerDeviceId;
  }

  async function readSteerRefusal(tenant: TenantId, taskId: string, steerMessageId: string): Promise<SteerRefusalRecord | undefined> {
    return tenantStoresFor(controlPlane(tenant), root).steerRefusals.get(taskId, steerMessageId);
  }

  async function listSteerRefusals(
    tenant: TenantId,
    query: { readonly taskId: string; readonly afterRevision: number; readonly limit: number },
  ): Promise<readonly SteerRefusalRecord[]> {
    if (!Number.isSafeInteger(query.afterRevision) || query.afterRevision < 0) {
      throw new ByokCloudError('coordination_input_invalid', `Steer refusal afterRevision must be a non-negative integer; received ${String(query.afterRevision)}.`);
    }
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0) {
      throw new ByokCloudError('coordination_input_invalid', `Steer refusal list limit must be a positive integer; received ${String(query.limit)}.`);
    }
    return tenantStoresFor(controlPlane(tenant), root).steerRefusals.list(query);
  }

  return { steerTask, steerSealedTask, readSteerRefusal, listSteerRefusals };
}
