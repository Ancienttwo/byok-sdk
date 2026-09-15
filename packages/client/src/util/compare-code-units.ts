/**
 * Order two strings by UTF-16 code unit, the one ordering this package sorts
 * every canonical list with.
 *
 * `Array.prototype.sort()`'s default comparator already does this, but naming
 * it keeps the intent explicit at the call sites that MUST NOT drift to a
 * locale-sensitive comparison: `String.prototype.localeCompare` reorders by
 * the ambient ICU locale, so a toolset revision digest, a frozen tool manifest
 * and a projection computed on two machines would disagree. Every canonical
 * ordering in this package therefore goes through this function.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
