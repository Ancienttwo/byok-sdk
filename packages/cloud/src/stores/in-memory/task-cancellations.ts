import { tenantKey, type MailboxStore, type TenantId } from '@byok-sdk/core';
import type {
  DeviceDirectory,
  TaskAbandonRequest,
  TaskAttempt,
  TaskCancellationMutation,
  TaskCancellationRequest,
  TaskCancellationStore,
} from '../ports';
import { InMemoryTaskAttemptState } from './task-attempts';
import { abandonTask } from './task-retirement';

const COLLECTED = new Error('Cancellation delivery was collected.');

/** Failure-free reference composition of the atomic cancellation port. */
export class InMemoryTaskCancellationStore implements TaskCancellationStore {
  readonly #state: InMemoryTaskAttemptState;
  readonly #mailbox: MailboxStore;
  readonly #devices: Pick<DeviceDirectory, 'get'>;
  readonly #messageIds = new Map<string, string>();
  readonly #inFlight = new Map<string, Promise<TaskCancellationMutation | undefined>>();

  constructor(state: InMemoryTaskAttemptState, mailbox: MailboxStore, devices: Pick<DeviceDirectory, 'get'>) {
    this.#state = state;
    this.#mailbox = mailbox;
    this.#devices = devices;
  }

  request(
    tenant: TenantId,
    input: TaskCancellationRequest,
  ): Promise<TaskCancellationMutation | undefined> {
    const key = tenantKey(tenant, input.taskId);
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running;
    const operation = this.#request(tenant, key, input).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, operation);
    return operation;
  }

  abandon(tenant: TenantId, input: TaskAbandonRequest): Promise<TaskAttempt | undefined> {
    return abandonTask(this.#state, this.#mailbox, tenant, tenantKey(tenant, input.taskId), input.cause,
      async (deviceId) => await this.#devices.get(tenant, deviceId) !== undefined);
  }

  async #request(
    tenant: TenantId,
    key: string,
    input: TaskCancellationRequest,
  ): Promise<TaskCancellationMutation | undefined> {
    return this.#state.mutate(key, async () => {
      const existing = this.#state.attempts.get(key);
      if (existing === undefined) return undefined;
      if (existing.cancellation !== undefined) {
        const messageId = this.#messageIds.get(key);
        if (messageId === undefined) {
          throw new Error(`Task ${input.taskId} has a cancellation tombstone without its delivery id.`);
        }
        // Append is the mailbox's only lookup by id. It materializes only a new
        // row, so a call means retention collected the acked row: the delivery
        // is settled and the throw keeps it from being enqueued again.
        const message = await this.#mailbox.append(tenant, {
          deviceId: existing.deviceId,
          messageId,
          materialize: () => {
            throw COLLECTED;
          },
          admission: 'cancellation',
        }).catch((cause: unknown) => {
          if (cause === COLLECTED) return undefined;
          throw cause;
        });
        return message === undefined ? { attempt: existing } : { attempt: existing, message };
      }
      if (existing.status === 'complete' || existing.status === 'failed' || existing.status === 'cancelled') {
        return { attempt: existing };
      }

      const messageId = input.proposedMessageId;
      const message = await this.#mailbox.append(tenant, {
        deviceId: existing.deviceId,
        messageId,
        materialize: (seq) => input.materialize(seq, messageId),
        admission: 'cancellation',
      });
      const requestedAt = this.#state.now();
      const attempt = {
        ...existing,
        status: existing.ownerDeviceId === undefined
          ? 'cancelled' as const
          : 'cancel_requested' as const,
        cancellation: {
          requestedAt,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        ...(existing.ownerDeviceId === undefined ? { terminalAt: requestedAt } : {}),
        updatedAt: requestedAt,
      };
      this.#state.attempts.set(key, attempt);
      this.#messageIds.set(key, messageId);
      return { attempt, message };
    });
  }
}
