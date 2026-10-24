import { createHash } from 'node:crypto';

/**
 * Canonical JSON and its SHA-256 (#884). This entry imports only `node:crypto`, so K8 `rules/` can load it where
 * `node:sqlite` and `node:async_hooks` do not exist, for example Workers with `nodejs_compat`.
 */
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
