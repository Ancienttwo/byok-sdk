/**
 * Scoped row-delete for plaintext task content (#654 E5a).
 *
 * The Host names terminal tasks. A store replaces each stored body of those
 * tasks with a body-free tombstone, deletes the task's ephemeral rows and the
 * objects its bodies name, and writes one audit receipt. The rows themselves
 * stay, so every identity fence keeps working: a replay of the same body
 * compares equal to the tombstone of that body, and a different body is still
 * a conflict.
 *
 * This module is the one authority for the tombstone format. A store builds
 * tombstones only through the {@link TaskRedactionCodec} that cloud passes in.
 */
import { contentHash, type ContentHash, type TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from './crypto/port';
import { ByokCloudError } from './errors';

/** The largest number of task ids that one `redactTasks` call accepts. */
export const TASK_REDACTION_MAX_TASKS = 100;
const TASK_ID_MAX_LENGTH = 512;
const TOMBSTONE_PREFIX = '{"byokRedacted":1,';
const ENVELOPE_TYPE = /^[a-z][a-z0-9_.]{0,63}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface TaskRedactionCounts {
  /** Receipt bodies replaced by a tombstone. */
  readonly receiptsRedacted: number;
  /** `agent_message_admission` rows whose bodies were replaced. */
  readonly admissionsRedacted: number;
  /** Acked or expired mailbox rows whose bodies were replaced. */
  readonly outboxRedacted: number;
  /** Activity, approval-timeline and message-draft rows deleted. */
  readonly ephemeralRowsDeleted: number;
  /** Stored objects deleted because a redacted body named them. */
  readonly objectsDeleted: number;
}

export type TaskRedactionRefusal = 'task_not_terminal' | 'pending_delivery';

export type TaskRedactionTaskResult =
  | {
      readonly taskId: string;
      /** `already_redacted`: an earlier call wrote the audit receipt and this call changed nothing. */
      readonly outcome: 'redacted' | 'already_redacted';
      readonly counts: TaskRedactionCounts;
    }
  | { readonly taskId: string; readonly outcome: 'not_found' }
  /** Retry later. `pending_delivery` clears when the device acks or the row expires. */
  | { readonly taskId: string; readonly outcome: 'refused'; readonly reason: TaskRedactionRefusal };

export interface TaskRedactionResult {
  readonly tasks: readonly TaskRedactionTaskResult[];
}

/** The tombstone rules a store applies inside its own transaction. */
export interface TaskRedactionCodec {
  /** The body-free replacement. One body always gives the same tombstone. */
  tombstone(body: string): Promise<{ readonly body: string; readonly bodyHash: ContentHash; readonly byteSize: bigint }>;
  /**
   * The tombstone for a body that was never stored. A store writes it under an
   * absent terminal receipt key, so a late device terminal stores nothing.
   */
  readonly absent: string;
  isTombstone(body: string): boolean;
  /** The object hashes of every BlobRef in `body`. A body that is not JSON names none. */
  blobHashes(body: string): readonly ContentHash[];
}

export interface TaskRedactionStoreInput {
  readonly tenantId: TenantId;
  readonly taskId: string;
  /** Every receipt key that holds this task's content. Cloud derives them; the store does not. */
  readonly receiptKeys: readonly string[];
  /** The device terminal receipt key. It is one of `receiptKeys`. When it is absent, the store writes `codec.absent` there. */
  readonly terminalReceiptKey: string;
  /** The identity receipt that records this redaction. */
  readonly auditReceiptKey: string;
  readonly codec: TaskRedactionCodec;
}

/**
 * Durable redaction authority for one task. It must be tenant-closed, refuse a
 * task that is not terminal or still has an undelivered mailbox row, and be
 * safe to call again after any failure.
 */
export interface TaskRedactionStore {
  redactTask(input: TaskRedactionStoreInput): Promise<TaskRedactionTaskResult>;
}

/** The audit receipt key. It is an identity receipt and never expires. */
export function taskRedactionReceiptKey(taskId: string): string {
  return `task-redaction:${taskId}`;
}

export function isTaskRedactionTombstone(body: string): boolean {
  return body.startsWith(TOMBSTONE_PREFIX);
}

/** Readers call this before they parse a task body. */
export function assertTaskContentPresent(taskId: string, body: string): void {
  if (isTaskRedactionTombstone(body)) {
    throw new ByokCloudError('task_content_redacted', `Task ${taskId} content was redacted.`);
  }
}

/** True when `stored` holds `proposed` or the tombstone of `proposed`. */
export async function sameTaskBody(
  stored: string,
  proposed: string,
  crypto: Pick<CloudCrypto, 'sha256'>,
): Promise<boolean> {
  if (stored === proposed) return true;
  if (!isTaskRedactionTombstone(stored)) return false;
  return stored === (await taskRedactionCodec(crypto).tombstone(proposed)).body;
}

export function parseTaskRedactionInput(input: { readonly taskIds: readonly string[] }): readonly string[] {
  const taskIds: unknown = input?.taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > TASK_REDACTION_MAX_TASKS) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `redactTasks takes 1 to ${String(TASK_REDACTION_MAX_TASKS)} task ids.`,
    );
  }
  const unique: string[] = [];
  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > TASK_ID_MAX_LENGTH || unique.includes(taskId)) {
      throw new ByokCloudError('coordination_input_invalid', 'redactTasks task ids must be distinct, non-empty strings.');
    }
    unique.push(taskId);
  }
  return unique;
}

export function taskRedactionCodec(crypto: Pick<CloudCrypto, 'sha256'>): TaskRedactionCodec {
  return {
    async tombstone(body) {
      const original = new TextEncoder().encode(body);
      const type = envelopeType(body);
      const tombstone = JSON.stringify({
        byokRedacted: 1,
        sha256: await crypto.sha256(original),
        bytes: original.byteLength,
        ...(type === undefined ? {} : { type }),
      });
      const bytes = new TextEncoder().encode(tombstone);
      return { body: tombstone, bodyHash: contentHash(await crypto.sha256(bytes)), byteSize: BigInt(bytes.byteLength) };
    },
    absent: JSON.stringify({ byokRedacted: 1, absent: true }),
    isTombstone: isTaskRedactionTombstone,
    blobHashes(body) {
      const hashes: string[] = [];
      collectBlobHashes(parseJson(body), hashes);
      return hashes.map((hash) => contentHash(hash));
    },
  };
}

/** The top-level envelope or offer `type`. It names a message kind and holds no free text. */
function envelopeType(body: string): string | undefined {
  const value = parseJson(body);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === 'string' && ENVELOPE_TYPE.test(type) ? type : undefined;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A BlobRef is the one object shape that carries both `blobId` and `contentHash`. */
function collectBlobHashes(value: unknown, hashes: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobHashes(item, hashes);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.blobId === 'string' && typeof record.contentHash === 'string' && SHA256.test(record.contentHash)) {
    if (!hashes.includes(record.contentHash)) hashes.push(record.contentHash);
  }
  for (const item of Object.values(record)) collectBlobHashes(item, hashes);
}
