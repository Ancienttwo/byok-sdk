import { tenantKey, type MailboxStore, type TenantId } from '@byok-sdk/core';
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
      if (
        existing.cancellation === undefined &&
        (existing.status === 'complete' || existing.status === 'failed' || existing.status === 'cancelled')
      ) {
        return { attempt: existing };
      }

      const messageId = this.#messageIds.get(key) ?? input.proposedMessageId;
      const message = await this.#mailbox.append(tenant, {
        deviceId: existing.deviceId,
        messageId,
        materialize: (seq) => input.materialize(seq, messageId),
      });
      const requestedAt = this.#state.now();
      const attempt = existing.cancellation === undefined
        ? {
            ...existing,
            status: existing.ownerDeviceId === undefined
              ? 'cancelled' as const
              : 'cancel_requested' as const,
            cancellation: {
              requestedAt,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
            updatedAt: requestedAt,
          }
        : existing;
      this.#state.attempts.set(key, attempt);
      this.#messageIds.set(key, messageId);
      return { attempt, message };
    });
  }
}
