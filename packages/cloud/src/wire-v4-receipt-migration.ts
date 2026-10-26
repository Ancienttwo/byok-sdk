/**
 * The store-independent half of the one-shot wire v3 -> v4 migration (#925).
 * A store runner first lists, read-only, the legacy tasks and every row with
 * no v4 form ({@link WireV4MigrationPreflight}). The operator passes the legacy
 * task list back; the runner then deletes those tasks' rows and re-encodes the
 * rest in one transaction, or changes nothing. It ships in 0.31.x only; 0.32.0
 * removes it (#1017).
 */
import {
  MESSAGE_PAYLOAD_SCHEMAS,
  PROTOCOL_VERSION,
  WIRE_V3_TO_V4_TYPES,
  decodeEnvelope,
  migrateWireV3Envelope,
  wireV4TypeOf,
  type WireV4MigrationRefusal,
} from '@byok-sdk/protocol';
import { parseApprovalObservations } from './approval-timeline';
import { hashOfferBytes, taskOfferMessageId } from './offer-identity';
import { isTaskRedactionTombstone } from './task-redaction';

export type WireV4ReceiptKind = 'offer' | 'terminal';

/** Which migrated receipt family `key` belongs to, or `undefined` for every other receipt. */
export function wireV4ReceiptKind(key: string): WireV4ReceiptKind | undefined {
  if (key.startsWith('task-offer:')) return 'offer';
  if (key.startsWith('task:') && key.endsWith(':terminal')) return 'terminal';
  return undefined;
}

export type WireV4ReceiptMigration =
  /** `body` is already readable under v4: a v4 terminal, an offer receipt whose type v4 keeps, or a redaction tombstone. */
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'migrated'; readonly body: string }
  | { readonly outcome: 'refused'; readonly refusal: WireV4MigrationRefusal; readonly type?: string };

function storedOfferReceipt(body: string): { readonly type: string; readonly payload: unknown } | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const { type, payload } = stored as { type?: unknown; payload?: unknown };
  return typeof type === 'string' ? { type, payload } : undefined;
}

/**
 * Migrates one stored receipt of a {@link WireV4ReceiptKind}. An offer receipt
 * is `{ deviceId, type, payload }` without a wire version: it keeps its bytes
 * when v4 keeps its type unchanged. A terminal receipt is a v3 envelope and is
 * re-encoded under v4.
 */
export function migrateWireV3Receipt(kind: WireV4ReceiptKind, body: string): WireV4ReceiptMigration {
  if (isTaskRedactionTombstone(body)) return { outcome: 'unchanged' };
  if (kind === 'terminal') {
    try {
      decodeEnvelope(body);
      return { outcome: 'unchanged' };
    } catch {
      const result = migrateWireV3Envelope(body);
      return result.ok
        ? { outcome: 'migrated', body: result.body }
        : { outcome: 'refused', refusal: result.refusal, ...(result.type === undefined ? {} : { type: result.type }) };
    }
  }
  const stored = storedOfferReceipt(body);
  if (stored === undefined) return { outcome: 'refused', refusal: 'not_wire_v3' };
  const v4Type = wireV4TypeOf(stored.type);
  if (v4Type === undefined) return { outcome: 'refused', refusal: 'type_without_v4_form', type: stored.type };
  const parsed = MESSAGE_PAYLOAD_SCHEMAS[v4Type].safeParse(stored.payload);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(stored.payload)) {
    return { outcome: 'refused', refusal: 'invalid_under_v4', type: stored.type };
  }
  if (v4Type === stored.type) return { outcome: 'unchanged' };
  return { outcome: 'migrated', body: JSON.stringify({ ...(JSON.parse(body) as object), type: v4Type }) };
}

/** What a store runner changed. */
export interface WireV4ReceiptMigrationResult {
  /** Receipts rewritten to v4 bytes. */
  readonly migrated: number;
  /** Offer and terminal receipts already readable under v4. */
  readonly unchanged: number;
  /** Legacy tasks whose rows were deleted. */
  readonly deletedTasks: number;
}

/**
 * A task offered as a v3 type that v4 removed (`task.offer`,
 * `task.offer_with_toolsets` or their sealed twins). It has no AgentRef and no
 * v4 form; after operator confirmation the migration deletes every row it owns.
 */
export interface WireV3LegacyTask {
  readonly tenantId: string;
  readonly taskId: string;
  readonly deviceId: string;
  /** The removed offer type, or `null` when the offer receipt was never recorded. */
  readonly type: string | null;
}

/** A stored row the migration cannot carry into v4. Any one fails the run. */
export type WireV4UnmappableRow =
  | {
      readonly kind: 'receipt';
      readonly tenantId: string;
      readonly key: string;
      readonly receiptKind: WireV4ReceiptKind;
      readonly refusal: WireV4MigrationRefusal;
      readonly type?: string;
    }
  /** An approval request or resolution recorded without the approvalId v4 requires. */
  | { readonly kind: 'approval'; readonly tenantId: string; readonly taskId: string; readonly refusal: 'approval_id_missing' }
  /**
   * A pending mailbox row of a non-legacy task in older wire bytes. A v4
   * device would fail to decode it and stop its cursor there.
   */
  | {
      readonly kind: 'mailbox';
      readonly tenantId: string;
      readonly deviceId: string;
      readonly seq: number;
      readonly refusal: 'wire_version_unsupported';
    };

/** The read-only result an operator reviews before the migration changes anything. */
export interface WireV4MigrationPreflight {
  readonly legacyTasks: readonly WireV3LegacyTask[];
  readonly unmappable: readonly WireV4UnmappableRow[];
}

const REMOVED_OFFER_TYPES: ReadonlySet<string> = new Set(
  Object.entries(WIRE_V3_TO_V4_TYPES)
    .filter(([type, v4Type]) => v4Type === null && type.startsWith('task.offer'))
    .map(([type]) => type),
);

/**
 * The removed offer type an offer receipt holds, or `undefined`. A redaction
 * tombstone keeps the original `type`, so a redacted legacy offer is still found.
 */
export function wireV3LegacyOfferType(body: string): string | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(body);
  } catch {
    return undefined;
  }
  const type = stored !== null && typeof stored === 'object' ? (stored as { type?: unknown }).type : undefined;
  return typeof type === 'string' && REMOVED_OFFER_TYPES.has(type) ? type : undefined;
}

/**
 * The offer receipt keys of a task offered without an AgentRef, as a v3 build
 * derived them. Every legacy task was offered this way.
 */
export async function wireV3LegacyOfferReceiptKeys(
  tenantId: string,
  taskId: string,
  deviceId: string,
): Promise<{ readonly offer: string; readonly delivered: string }> {
  const messageId = await taskOfferMessageId(tenantId, taskId, deviceId, undefined, hashOfferBytes);
  return { offer: `task-offer:${messageId}`, delivered: `task-offer-delivered:${messageId}` };
}

/** True when a stored mailbox envelope is wire v4 bytes. */
export function isWireV4MailboxBody(body: string): boolean {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' && (value as { readonly v?: unknown }).v === PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

/** True when a stored approval timeline entry list names an approval without an id. */
export function hasUnnamedApproval(entries: unknown): boolean {
  return parseApprovalObservations(entries).some((entry) => entry.event.approvalId === undefined);
}

/** The migration changed nothing because these rows have no v4 form. */
export class ReceiptMigrationUnmappableError extends Error {
  readonly code = 'wire_v4_migration_unmappable';
  constructor(readonly unmappable: readonly WireV4UnmappableRow[]) {
    super(
      `${unmappable.length} stored row(s) cannot be migrated to wire v4; nothing was changed: ` +
        unmappable.slice(0, 20).map(describe).join(', ') +
        (unmappable.length > 20 ? ', ...' : ''),
    );
    this.name = 'ReceiptMigrationUnmappableError';
  }
}

function describe(row: WireV4UnmappableRow): string {
  switch (row.kind) {
    case 'receipt':
      return `${row.tenantId}/${row.key} (${row.type ?? 'unknown type'}: ${row.refusal})`;
    case 'approval':
      return `${row.tenantId}/approvals/${row.taskId} (${row.refusal})`;
    case 'mailbox':
      return `${row.tenantId}/mailbox/${row.deviceId}/${row.seq} (pending: ${row.refusal})`;
  }
}

/** The confirmed legacy task list differs from the one this store holds; nothing was changed. */
export class WireV4LegacyTaskListMismatchError extends Error {
  readonly code = 'wire_v4_legacy_task_list_mismatch';
  constructor(
    readonly found: readonly WireV3LegacyTask[],
    readonly confirmed: readonly WireV3LegacyTask[],
  ) {
    super(
      `The confirmed legacy task list (${confirmed.length}) does not match the store's (${found.length}); ` +
        'run the preflight again and confirm its exact list. Nothing was changed.',
    );
    this.name = 'WireV4LegacyTaskListMismatchError';
  }
}

function legacyTaskId(task: WireV3LegacyTask): string {
  return JSON.stringify([task.tenantId, task.taskId, task.deviceId, task.type]);
}

/**
 * Fails closed unless the store has no unmappable row and the operator
 * confirmed exactly the legacy tasks the preflight found.
 */
export function assertWireV4MigrationConfirmed(
  preflight: WireV4MigrationPreflight,
  confirmedLegacyTasks: readonly WireV3LegacyTask[],
): void {
  if (preflight.unmappable.length > 0) throw new ReceiptMigrationUnmappableError(preflight.unmappable);
  const found = new Set(preflight.legacyTasks.map(legacyTaskId));
  const confirmed = new Set(confirmedLegacyTasks.map(legacyTaskId));
  if (
    confirmed.size !== confirmedLegacyTasks.length ||
    found.size !== confirmed.size ||
    [...found].some((id) => !confirmed.has(id))
  ) {
    throw new WireV4LegacyTaskListMismatchError(preflight.legacyTasks, confirmedLegacyTasks);
  }
}
