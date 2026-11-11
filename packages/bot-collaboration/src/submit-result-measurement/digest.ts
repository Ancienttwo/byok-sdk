import { createHash } from 'node:crypto';

/**
 * The SDK content digest, as docs/submit-result-measurement.md "Exact-target
 * equality" defines it: `sha256:` plus the hex SHA-256 of key-sorted JSON.
 * The SDK function (`agentResultDigest`) is not public, so this is the
 * harness copy of the documented rules.
 */
export function resultDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(sortedJson(value), 'utf8').digest('hex')}`;
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`;
}
