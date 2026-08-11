/**
 * The one timestamp format this package accepts across every composition.
 *
 * Every instant that crosses a store port is an ISO-8601 UTC string, and the
 * in-memory reference compares those strings with `<` / `>=` — a downgrade
 * grace deadline, a retention cutoff, a reservation expiry. Lexicographic
 * order equals chronological order **only** for the canonical
 * `YYYY-MM-DDTHH:mm:ss.sssZ` shape that `Date.prototype.toISOString` emits.
 * Feed the same store `2026-08-08T00:00:00+08:00` and the string comparison
 * silently answers a different question than a SQL `timestamptz` comparison
 * would, so the in-memory and Postgres compositions would diverge on an input
 * the conformance suite never sees.
 *
 * The fix is a format contract rather than a normalizer: a caller-supplied
 * timestamp that is not already canonical is **rejected**, not rewritten.
 * Rewriting would make this module a second authority on what instant the
 * caller meant, and an offset-bearing or second-precision string is exactly the
 * case where that guess is worth refusing.
 *
 * Store-produced timestamps are canonical by construction (they come from
 * `Clock.now().toISOString()`); this module guards the *inbound* direction —
 * `downgradeGraceUntil`, `deletePendingBefore`, `ackedBefore`,
 * `expireUnackedBefore`.
 *
 * No `node:` import and no clock read: validation is pure, so a Workers
 * composition and the constraint test (`Date.now()` is banned package-wide)
 * both stay happy. `Date.parse` is used for *calendar validity only* — the
 * pattern is what pins the shape.
 */
import { ByokCoreError } from './errors';

/**
 * Exactly what `toISOString()` produces: four-digit year, `T` separator,
 * millisecond precision, literal `Z`. No offsets, no omitted milliseconds, no
 * expanded-year form — each of those breaks the lexicographic-order property.
 */
export const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True when `value` is a canonical ISO-8601 UTC instant.
 *
 * Two checks, in order: the pattern pins the *shape*, then a round trip
 * through `Date` pins *calendar validity* — `2026-02-30T00:00:00.000Z` matches
 * the pattern and is not an instant.
 */
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

/**
 * Fail-closed gate for a caller-supplied instant.
 *
 * @param value The timestamp as received from the caller.
 * @param field Field name, so the failure names the contract that was missed
 *   rather than just the bad string.
 * @returns The same string, so call sites can validate and assign in one step.
 * @throws {ByokCoreError} code `timestamp_not_canonical`.
 */
export function assertCanonicalTimestamp(value: string, field: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new ByokCoreError(
      'timestamp_not_canonical',
      `${field} must be a canonical ISO-8601 UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ), received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}
