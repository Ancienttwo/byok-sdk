/**
 * The one error taxonomy for `@byok/core`.
 *
 * Two rules the rest of the package is built around:
 *
 * 1. **One class, code-based branching.** Consumers switch on `error.code`, not
 *    on class identity — the same idiom `@byok/keys` uses. A composition that
 *    maps core errors onto HTTP does it with a code table, so adding a code is
 *    an additive change instead of a new `instanceof` chain everywhere.
 * 2. **Every conflict carries the current snapshot.** A CAS failure that
 *    reports only "conflict" forces the caller into a second round trip and
 *    invites last-write-wins retries. {@link CoreConflictError} therefore
 *    carries `current` — the authoritative state the caller lost to — plus the
 *    `observedAt` instant it was read at.
 *
 * This module imports nothing. It is the graph sink: `quota.ts` narrows
 * {@link StorageErrorCode} out of this union and maps it to HTTP status, and
 * every port module documents which codes it can raise. That keeps the code
 * list in one place while letting each domain own its own status mapping.
 */

/**
 * Every error code this package can raise.
 *
 * Codes are stable strings. Two groups are additionally **wire-stable** — a
 * composition is expected to surface them verbatim to clients, so renaming one
 * is a breaking change:
 *
 * - `terminal_conflict` (§12.6.4, HTTP 409)
 * - the five `storage_*` codes (§12.7.7, see `quota.ts`)
 */
export const CORE_ERROR_CODES = {
  // identity + content addressing
  tenant_id_invalid: 'tenant_id_invalid',
  content_hash_invalid: 'content_hash_invalid',

  // caller-supplied instants (see `time.ts`)
  timestamp_not_canonical: 'timestamp_not_canonical',

  // capability declaration (ADR-010)
  capability_declaration_invalid: 'capability_declaration_invalid',
  capability_unavailable: 'capability_unavailable',

  // device proof (§12.6.3)
  proof_envelope_invalid: 'proof_envelope_invalid',
  proof_canonicalization_failed: 'proof_canonicalization_failed',

  // mailbox (§12.7.3)
  mailbox_message_not_found: 'mailbox_message_not_found',
  mailbox_cursor_regression: 'mailbox_cursor_regression',

  // board coordination (§12.3)
  board_item_not_found: 'board_item_not_found',
  board_item_exists: 'board_item_exists',
  board_transition_invalid: 'board_transition_invalid',
  board_status_conflict: 'board_status_conflict',
  board_claim_conflict: 'board_claim_conflict',
  board_not_held: 'board_not_held',

  // truth records (§12.3, §12.6.4)
  truth_record_not_found: 'truth_record_not_found',
  terminal_conflict: 'terminal_conflict',
  truth_revision_conflict: 'truth_revision_conflict',

  // presence + activity hints (§12.3)
  activity_capacity_invalid: 'activity_capacity_invalid',
  hint_ttl_invalid: 'hint_ttl_invalid',

  // object manifest (§12.7.4, §12.7.8)
  object_not_found: 'object_not_found',
  object_state_invalid: 'object_state_invalid',

  // storage entitlement / usage / reservation (§12.7.6-12.7.7)
  storage_entitlement_missing: 'storage_entitlement_missing',
  storage_entitlement_version_conflict: 'storage_entitlement_version_conflict',
  storage_reservation_not_found: 'storage_reservation_not_found',
  storage_object_too_large: 'storage_object_too_large',
  storage_quota_exceeded: 'storage_quota_exceeded',
  storage_reservation_expired: 'storage_reservation_expired',
  storage_integrity_mismatch: 'storage_integrity_mismatch',
  storage_write_suspended: 'storage_write_suspended',
} as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[keyof typeof CORE_ERROR_CODES];

/** Base error for every failure this package raises. */
export class ByokCoreError extends Error {
  public readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ByokCoreError';
    this.code = code;
  }
}

/**
 * A compare-and-set failure.
 *
 * `current` is the authoritative state at the moment the write was rejected —
 * the board item whose status moved, the terminal record already committed, the
 * entitlement row at a newer version. The caller re-decides against it; the
 * store never merges (§12.3: "不做 silent last-write-wins", §12.6.4: 不覆写第一份事实).
 */
export class CoreConflictError<TCurrent> extends ByokCoreError {
  public readonly current: TCurrent;
  public readonly observedAt: string;

  constructor(
    code: CoreErrorCode,
    message: string,
    current: TCurrent,
    observedAt: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = 'CoreConflictError';
    this.current = current;
    this.observedAt = observedAt;
  }
}

/** Narrows an unknown thrown value to a core error, optionally to one code. */
export function isCoreError(value: unknown, code?: CoreErrorCode): value is ByokCoreError {
  if (!(value instanceof ByokCoreError)) return false;
  return code === undefined || value.code === code;
}

/** Narrows an unknown thrown value to a conflict error carrying a snapshot. */
export function isCoreConflictError<TCurrent>(
  value: unknown,
  code?: CoreErrorCode,
): value is CoreConflictError<TCurrent> {
  if (!(value instanceof CoreConflictError)) return false;
  return code === undefined || value.code === code;
}
