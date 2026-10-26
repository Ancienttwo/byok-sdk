/**
 * The receipt half of the one-shot wire v3 -> v4 migration (#925). A store
 * runs {@link migrateWireV3Receipt} over every stored offer and terminal
 * receipt. It changes nothing when any receipt is refused, and lists the
 * refused ones. It ships in 0.31.x only; the next minor removes it.
 */
import {
  MESSAGE_PAYLOAD_SCHEMAS,
  decodeEnvelope,
  migrateWireV3Envelope,
  wireV4TypeOf,
  type WireV4MigrationRefusal,
} from '@byok-sdk/protocol';
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

/** What a store runner did when no receipt was refused. */
export interface WireV4ReceiptMigrationResult {
  /** Receipts rewritten to v4 bytes. */
  readonly migrated: number;
  /** Offer and terminal receipts already readable under v4. */
  readonly unchanged: number;
}

/** One receipt a store could not migrate. */
export interface WireV4ReceiptRefusal {
  readonly tenantId: string;
  readonly key: string;
  readonly kind: WireV4ReceiptKind;
  readonly refusal: WireV4MigrationRefusal;
  readonly type?: string;
}

/** The migration changed no receipt because these could not be migrated. */
export class WireV4ReceiptMigrationError extends Error {
  readonly code = 'wire_v4_receipt_migration_refused';
  constructor(readonly refused: readonly WireV4ReceiptRefusal[]) {
    super(
      `${refused.length} stored receipt(s) cannot be migrated to wire v4; no receipt was changed: ` +
        refused.slice(0, 20).map((entry) => `${entry.tenantId}/${entry.key} (${entry.type ?? 'unknown type'}: ${entry.refusal})`).join(', ') +
        (refused.length > 20 ? ', ...' : ''),
    );
    this.name = 'WireV4ReceiptMigrationError';
  }
}
