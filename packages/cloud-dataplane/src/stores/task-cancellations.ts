import type {
  TaskCancellationMutation,
  TaskCancellationRequest,
  TaskCancellationStore,
} from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';
import {
  OUTBOX_COLUMNS,
  type OutboxRow,
  toMailboxMessage,
} from './core/mailbox';
import { BEGIN_OUTBOX_WRITE, insertOutboxRow } from './core/outbox-writer';
import {
  TASK_SELECT_COLUMNS,
  type TaskRow,
  taskRowToAttempt,
} from './task-attempts';

/** PostgreSQL atomic authority for host cancellation state plus mailbox delivery. */
export class PostgresTaskCancellationStore implements TaskCancellationStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: ByokPool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async request(
    tenant: TenantId,
    input: TaskCancellationRequest,
  ): Promise<TaskCancellationMutation | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query(BEGIN_OUTBOX_WRITE);
      const selected = await client.query<TaskRow>(
        `SELECT ${TASK_SELECT_COLUMNS} FROM task
          WHERE tenant_id = $1 AND task_id = $2
          FOR UPDATE`,
        [tenant, input.taskId],
      );
      const current = selected.rows[0];
      if (current === undefined) {
        await client.query('ROLLBACK');
        return undefined;
      }

      if (
        current.cancel_requested_at === null &&
        (current.status === 'complete' || current.status === 'failed' || current.status === 'cancelled')
      ) {
        await client.query('COMMIT');
        return { attempt: taskRowToAttempt(current) };
      }

      if (current.cancel_message_id !== null) {
        const replayed = await client.query<OutboxRow>(
          `SELECT ${OUTBOX_COLUMNS} FROM outbox
            WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
          [tenant, current.device_id, current.cancel_message_id],
        );
        const message = replayed.rows[0];
        if (message === undefined) {
          // Acked mailbox rows are retention-deletable. Once the attempt is
          // cancelled, the tombstone remains the durable idempotency outcome
          // even after that delivery evidence ages out. A still-requested
          // attempt with no row is corruption and must continue to fail closed.
          if (current.status === 'cancelled') {
            await client.query('COMMIT');
            return { attempt: taskRowToAttempt(current) };
          }
          throw new Error(`Cancellation delivery ${current.cancel_message_id} is missing for task ${input.taskId}`);
        }
        await client.query('COMMIT');
        return { attempt: taskRowToAttempt(current), message: toMailboxMessage(message) };
      }

      const now = this.#clock.now().toISOString();
      const messageId = input.proposedMessageId;
      // Exempt from the mailbox limit, still counted: a full mailbox must never
      // block the cancellation that would stop further work. The task row lock
      // above bounds this to one cancellation row per task.
      const written = await insertOutboxRow(client, tenant, {
        deviceId: current.device_id,
        messageId,
        admission: 'cancellation',
        now,
        materialize: (seq) => input.materialize(seq, messageId),
      });
      const updated = await client.query<TaskRow>(
        `UPDATE task
            SET status = CASE WHEN owner_device_id IS NULL THEN 'cancelled' ELSE 'cancel_requested' END,
                terminal_at = CASE WHEN owner_device_id IS NULL THEN COALESCE(terminal_at, $3) ELSE terminal_at END,
                cancel_requested_at = $3,
                cancel_reason = $4,
                cancel_message_id = $5,
                updated_at = $3
          WHERE tenant_id = $1 AND task_id = $2
        RETURNING ${TASK_SELECT_COLUMNS}`,
        [tenant, input.taskId, now, input.reason ?? null, messageId],
      );
      await client.query('COMMIT');
      return {
        attempt: taskRowToAttempt(updated.rows[0]!),
        message: toMailboxMessage(written.row),
      };
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }
}
