/**
 * Host retention for terminal tasks (#1120).
 *
 * A terminal task whose `archive_after` instant is older than the policy's
 * `terminalTaskArchiveMs` is archived: in one store transaction every stored
 * body of the task becomes the redaction tombstone, the task's ephemeral rows
 * and object references go, and `archived_at` is set. What stays is the
 * compact identity fence: the task row and the tombstoned receipts. A replayed
 * body still compares equal to its tombstone and a different body is still a
 * conflict, so every device answer stays what it was. Fences are never
 * deleted; only tenant deletion removes them.
 *
 * The board item lives behind its own port, so its removal follows the
 * transaction. `archived_at` drives it: a task archived but not yet settled is
 * listed again by every later run until its board item is gone.
 */
import type { Clock, CoreStores, TenantId } from '@byok-sdk/core';
import type { AgentRef } from '@byok-sdk/protocol';
import type { CloudCrypto } from './crypto/port';
import { terminalReceiptKey } from './inbound';
import { taskOfferMessageId } from './offer-identity';
import { SEALED_TASK_REFERENCE_KIND } from './sealed-ciphertext';
import { taskRedactionCodec, type TaskRedactionCodec } from './task-redaction';
import type { CloudStores } from './stores/ports';

/** One unit of archive work, listed by {@link TaskArchiveStore.listWork}. */
export interface TaskArchiveWork {
  readonly taskId: string;
  readonly deviceId: string;
  readonly agentRef?: AgentRef;
  /** `archive`: not archived yet. `settle`: archived, and its board item may remain. */
  readonly phase: 'archive' | 'settle';
}

export interface TaskArchiveListInput {
  /** Only tasks whose `archive_after` is before this instant are listed for `archive`. */
  readonly archiveBefore: string;
  readonly limit: number;
}

export interface TaskArchiveStoreInput {
  readonly taskId: string;
  /** Every receipt key that holds this task's content. Cloud derives them; the store does not. */
  readonly receiptKeys: readonly string[];
  /** The device terminal receipt key, one of `receiptKeys`. When it is absent, the store writes `codec.absent` there. */
  readonly terminalReceiptKey: string;
  /** The object references this task holds. The store removes them in the same transaction. */
  readonly releaseObjectReferences: readonly { readonly refKind: string; readonly refId: string }[];
  readonly archivedAt: string;
  readonly codec: TaskRedactionCodec;
}

export interface TaskArchiveCounts {
  readonly receiptsRedacted: number;
  readonly admissionsRedacted: number;
  readonly outboxRedacted: number;
  readonly ephemeralRowsDeleted: number;
  readonly referencesReleased: number;
}

export type TaskArchiveStoreResult =
  | { readonly outcome: 'archived'; readonly counts: TaskArchiveCounts }
  | { readonly outcome: 'already_archived' | 'not_found' }
  /** Not archived. `pending_delivery` cannot happen under the policy floor; it is still refused, never overwritten. */
  | { readonly outcome: 'refused'; readonly reason: 'task_not_terminal' | 'pending_delivery' };

/**
 * Durable archive authority. Tenant-closed and safe to call again after any
 * failure. `archive` is one transaction holding the task row lock: it refuses a
 * task that is not terminal or still has a pending mailbox row, writes
 * `codec.absent` under an absent `terminalReceiptKey`, replaces each body that
 * is not a tombstone yet (receipts in `receiptKeys`, Agent message admission
 * payload and terminal, acked and expired mailbox rows), clears the task's
 * free-text terminal cause and cancel reason, deletes its ephemeral rows and
 * the listed object references, and sets `archived_at`. It never deletes a
 * mailbox row, so a device's recovery-floor dead letter stays (#1115).
 */
export interface TaskArchiveStore {
  /** Up to `limit` units: archived tasks not yet settled first, then archivable tasks by `archive_after` ascending. */
  listWork(tenant: TenantId, input: TaskArchiveListInput): Promise<readonly TaskArchiveWork[]>;
  archive(tenant: TenantId, input: TaskArchiveStoreInput): Promise<TaskArchiveStoreResult>;
  /** Records that the post-transaction steps are done. Idempotent. */
  settle(tenant: TenantId, taskId: string, settledAt: string): Promise<void>;
}

/** Counts in the maintenance report's `tasks` step. */
export interface TaskArchiveStepCounts {
  readonly archived: number;
  readonly settled: number;
  /** Tasks the store refused this run; they are listed again next run. */
  readonly refused: number;
  readonly more: boolean;
}

export async function archiveTerminalTasks(
  ports: { readonly core: CoreStores; readonly cloud: CloudStores; readonly clock: Clock; readonly crypto: Pick<CloudCrypto, 'sha256'> },
  tenant: TenantId,
  input: TaskArchiveListInput & { readonly now: string },
): Promise<TaskArchiveStepCounts> {
  const work = await ports.cloud.taskArchive.listWork(tenant, input);
  const codec = taskRedactionCodec(ports.crypto);
  let archived = 0;
  let settled = 0;
  let refused = 0;
  for (const unit of work) {
    if (unit.phase === 'archive') {
      const messageId = await taskOfferMessageId(tenant, unit.taskId, unit.deviceId, unit.agentRef, bytes => ports.crypto.sha256(bytes));
      const result = await ports.cloud.taskArchive.archive(tenant, {
        taskId: unit.taskId,
        receiptKeys: [`task-offer:${messageId}`, terminalReceiptKey(unit.taskId), `agent-message-offer:${unit.deviceId}:${unit.taskId}`],
        terminalReceiptKey: terminalReceiptKey(unit.taskId),
        releaseObjectReferences: [{ refKind: SEALED_TASK_REFERENCE_KIND, refId: unit.taskId }],
        archivedAt: input.now,
        codec,
      });
      if (result.outcome === 'refused') { refused += 1; continue; }
      if (result.outcome === 'not_found') continue;
      if (result.outcome === 'archived') archived += 1;
    }
    // The board item is a projection of a live task. It goes only after the
    // archive committed, so a crash before this point leaves an archived task
    // that the next run lists as `settle`.
    await ports.core.board.remove(tenant, unit.taskId);
    await ports.cloud.taskArchive.settle(tenant, unit.taskId, input.now);
    settled += 1;
  }
  return { archived, settled, refused, more: work.length === input.limit };
}
