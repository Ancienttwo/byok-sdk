/**
 * Hosted mailbox contract (§12.7.3).
 *
 * The load-bearing rule of this file: **reading is not acknowledging.**
 * `readAfter` never mutates the cursor. The only ack is the cursor the daemon
 * brings back on its next poll, after it has durably appended the envelope to
 * its local journal. "领走即弃" means *cursor-advanced-then-deleted*, not
 * *read-then-deleted* — read-deletes would break the frozen at-least-once
 * semantics the client's stall recovery is built on (§8.3).
 *
 * The mailbox transports opaque envelope bytes and is **not** an
 * execution-state authority. `body` is a string here rather than a parsed
 * message because core is protocol-free: the frozen v1 shape lives in
 * `@byok-sdk/protocol`, and core must not grow an edge to it (§12.1 invariant).
 */
import type { ContentHash } from './blob';
import type { TenantId } from './tenant';

/**
 * Row lifecycle. `pending` and `acked` are derived from the device cursor;
 * `expired` is the dead-letter state for rows that aged out before ever being
 * acked — §12.7.5 requires those to be visible, not silently dropped.
 */
export const MAILBOX_MESSAGE_STATES = ['pending', 'acked', 'expired'] as const;
export type MailboxMessageState = (typeof MAILBOX_MESSAGE_STATES)[number];

/** One mailbox row. `seq` is monotonic per (tenant, device) — never global. */
export interface MailboxMessage {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly seq: number;
  readonly messageId: string;
  /** Opaque encoded envelope. Core never parses it. */
  readonly body: string;
  readonly bodyHash: ContentHash;
  readonly byteSize: bigint;
  readonly state: MailboxMessageState;
  readonly appendedAt: string;
}

/** Opaque bytes produced after the mailbox has atomically reserved their delivery sequence. */
export interface MailboxBody {
  readonly body: string;
  readonly bodyHash: ContentHash;
  readonly byteSize: bigint;
}

export interface MailboxAppendInput {
  readonly deviceId: string;
  /**
   * Producer-supplied idempotency key. A second append with the same
   * `messageId` returns the existing row instead of enqueuing a duplicate.
   */
  readonly messageId: string;
  /**
   * Builds the opaque body around the sequence reserved by this append.
   *
   * The store invokes this only for a new row and commits the returned bytes
   * at exactly that `seq`. Allocation, materialization, and insertion are one
   * per-device serialized operation; otherwise concurrent offers could commit
   * out of order and let an ack skip a late lower sequence.
   */
  readonly materialize: (seq: number) => MailboxBody | Promise<MailboxBody>;
}

export interface MailboxReadQuery {
  readonly deviceId: string;
  /** Exclusive lower bound. `0` reads from the beginning of the retained window. */
  readonly afterSeq: number;
  readonly limit?: number;
}

export interface MailboxPage {
  readonly messages: readonly MailboxMessage[];
  /**
   * The seq to poll after next. Equal to `afterSeq` when the page is empty —
   * reading never moves the ack cursor, so a caller that only reads can replay
   * the same page forever without losing anything.
   */
  readonly nextSeq: number;
  readonly hasMore: boolean;
  /**
   * The earliest seq a reader can still recover from: one past the highest row
   * this device LOST. A caller at `recoverableFrom - 1` can still be handed
   * the first row it has any claim to; a caller below that has a gap it cannot
   * see, and resuming it would hand back a partial tail indistinguishable from
   * a complete one.
   *
   * Lost means `expired` — a row that aged out before anyone acked it. An
   * `acked` row is consumed, not lost, so acking never moves this and never
   * turns a re-poll from an old cursor into a failure; that distinction is the
   * whole point of the field.
   *
   * `1` for a mailbox that has lost nothing, so a fresh device's cursor `0` is
   * always inside the window. Monotonic for as long as dead-lettered rows are
   * retained, which §12.7.5 requires.
   *
   * This is a READ of the retained window, never a second retention authority:
   * `collectRetired` decides what is retained, this reports what it cost.
   */
  readonly recoverableFrom: number;
}

export interface MailboxAdvanceCursorInput {
  readonly deviceId: string;
  /** Highest seq the device has durably journaled. */
  readonly ackedSeq: number;
}

/** Server-owned proof that a cursor was returned to this device. */
export interface MailboxRecordDeliveryInput {
  readonly deviceId: string;
  /** Highest cursor the server has returned to this device. */
  readonly deliveredSeq: number;
}

/** The device's durable delivery and acknowledgement positions. */
export interface MailboxCursorState {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  /** Highest cursor the server has returned to this device. */
  readonly deliveredSeq: number;
  readonly ackedSeq: number;
  readonly updatedAt: string;
}

/**
 * Retention cutoffs.
 *
 * Both instants must be **canonical ISO-8601 UTC** (`YYYY-MM-DDTHH:mm:ss.sssZ`);
 * anything else is rejected with `timestamp_not_canonical`. A retention sweep
 * deletes rows, so an offset-bearing string that a string comparison and a SQL
 * `timestamptz` comparison read differently is the worst place to guess — see
 * `time.ts`.
 */
export interface MailboxRetentionInput {
  readonly deviceId?: string;
  /** Acked rows appended before this instant are deleted. */
  readonly ackedBefore: string;
  /** Unacked rows appended before this instant move to `expired`, never deleted here. */
  readonly expireUnackedBefore: string;
}

export interface MailboxRetentionResult {
  readonly deletedCount: number;
  readonly expiredCount: number;
  readonly releasedBytes: bigint;
}

/**
 * Mailbox port. Tenant-first, async.
 *
 * Raises: `mailbox_cursor_regression` (an ack that moves the cursor backwards,
 * which would silently re-deliver already-journaled work),
 * `mailbox_cursor_ahead_of_delivery` (an ack beyond the highest cursor the
 * server has returned to that device),
 * `timestamp_not_canonical` (a retention cutoff that is not a canonical
 * ISO-8601 UTC instant).
 */
export interface MailboxStore {
  append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage>;
  /** Pure read. Never advances the cursor, never deletes, never marks acked. */
  readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage>;
  /** Records the highest cursor a device-facing response is about to return. */
  recordDelivery(
    tenant: TenantId,
    input: MailboxRecordDeliveryInput,
  ): Promise<MailboxCursorState>;
  /** The one and only ack. Monotonic and bounded by the recorded delivery watermark. */
  advanceCursor(
    tenant: TenantId,
    input: MailboxAdvanceCursorInput,
  ): Promise<MailboxCursorState>;
  readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState>;
  /** Retention hook: delete acked rows, dead-letter unacked ones. */
  collectRetired(
    tenant: TenantId,
    input: MailboxRetentionInput,
  ): Promise<MailboxRetentionResult>;
}
