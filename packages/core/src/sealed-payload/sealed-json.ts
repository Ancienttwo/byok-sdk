/**
 * Canonical JSON of a sealed plaintext (#786): RFC 8785 with its full number
 * rule.
 *
 * Keys sort by UTF-16 code unit and strings use the ECMAScript serialization,
 * the same as `canonicalizeJson`. Numbers differ. A finite number serializes
 * as `Number.prototype.toString` (RFC 8785 §3.2.2.3), so a decimal, an
 * exponent and an integer above 2^53 are sealable. `-0` serializes as `0`.
 * NaN and the infinities have no JSON form and throw.
 *
 * Only the sealed plaintext uses this rule. The AAD, the MAC identity, member
 * chain entries and key packages keep `canonicalizeJson`, whose safe-integer
 * rule belongs to the attestation contract.
 */
import type { JsonValue } from '../attestation';
import { invalidInput } from './primitives';

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw invalidInput('Sealed plaintext holds a number with no JSON form');
      return String(value);
    case 'object':
      break;
    default:
      throw invalidInput(`Sealed plaintext holds a ${typeof value}, which is not a JSON type`);
  }
  if (seen.has(value)) throw invalidInput('Sealed plaintext holds a circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, (entry) => canonicalValue(entry, seen)).join(',')}]`;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidInput('Sealed plaintext holds an object that is not plain');
    const record = value as Record<string, unknown>;
    const members = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], seen)}`);
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** The canonical JSON text of a sealed plaintext value. Throws `sealed_secret_invalid` outside JSON. */
export function canonicalizeSealedJson(value: JsonValue): string {
  return canonicalValue(value, new Set());
}
