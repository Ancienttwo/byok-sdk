import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { ByokKeysError } from './errors.js';

export function createCredentialNamespaceId(): string {
  return `ps_${randomBytes(16).toString('hex')}`;
}

export function isCredentialNamespaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 35 && /^ps_[0-9a-f]{32}$/u.test(value);
}

export function readCredentialNamespaceId(database: DatabaseSync, path: string): string {
  const rows = database.prepare(`
    SELECT singleton = 1 AS is_singleton, credential_namespace_id,
           instr(credential_namespace_id, char(0)) AS nul_position
    FROM main.provider_store_metadata
    LIMIT 2
  `).all();
  const [row] = rows;
  if (rows.length === 1 && row?.is_singleton === 1 && row.nul_position === 0
    && isCredentialNamespaceId(row.credential_namespace_id)) {
    return row.credential_namespace_id;
  }
  throw new ByokKeysError(
    'PROVIDER_STORE_SCHEMA_STALE',
    `Provider profile store at ${path} lacks a valid credential namespace`,
  );
}
