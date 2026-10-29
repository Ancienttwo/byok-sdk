import { tenantKey, type MailboxMessage, type MailboxStore, type TenantId } from '@byok-sdk/core';
import type {
  TaskCancellationMutation,
  TaskCancellationRequest,
  TaskCancellationStore,
} from '../ports';
import { InMemoryTaskAttemptState } from './task-attempts';

/** Failure-free reference composition of the atomic cancellation port. */
export class InMemoryTaskCancellationStore implements TaskCancellationStore {
  readonly #state: InMemoryTaskAttemptState;
  readonly #mailbox: MailboxStore;
  readonly #messageIds = new Map<string, string>();
  readonly #inFlight = new Map<string, Promise<TaskCancellationMutation | undefined>>();

  constructor(state: InMemoryTaskAttemptState, mailbox: MailboxStore) {
    this.#state = state;
    this.#mailbox = mailbox;
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
        const message = await this.#retainedDelivery(tenant, existing.deviceId, messageId);
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

  /**
   * The delivery row while retention keeps it, read through append's
   * idempotency: the mailbox materializes only a new row, so a call to
   * materialize means the row was collected, and throwing there aborts the
   * append before it takes a seq. Retention collects only acked rows, so a
   * collected delivery counts as delivered and nothing is enqueued again.
   */
  async #retainedDelivery(
    tenant: TenantId,
    deviceId: string,
    messageId: string,
  ): Promise<MailboxMessage | undefined> {
    const collected = new Error(`Cancellation delivery ${messageId} was collected.`);
    try {
      return await this.#mailbox.append(tenant, {
        deviceId,
        messageId,
        materialize: () => {
          throw collected;
        },
        admission: 'cancellation',
      });
    } catch (cause) {
      if (cause === collected) return undefined;
      throw cause;
    }
  }
}
