import type { Pool } from 'pg';
import type { Json } from '@byok-sdk/server/execution-core';
import type { Principal } from '@byok-sdk/bot-collaboration/host-kit';
import type { HostConfig, ProjectionPort } from '@byok-sdk/example-hosted-bot-collaboration/src/index';

/**
 * The product rows that the Worker Host reads for each scope: the owner session (the hash of its token), the owner principal,
 * and the H Host config (model templates and read-only toolsets). In a product these come from its own user and device tables.
 * Here one table stands in for them. Node writes it when it provisions a scope; the Worker only reads it.
 */
export interface HostScope { scope: string; ownerTokenSha256: string; owner: Principal; config: HostConfig }

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
function table(schema: string, name = 'host_scope'): string {
  if (!SCHEMA.test(schema)) throw new Error('Invalid host scope schema name');
  return `"${schema}".${name}`;
}

export const hostScopeDdl = (schema: string): string => `CREATE TABLE IF NOT EXISTS ${table(schema)} (
  scope text PRIMARY KEY, owner_token_sha256 text NOT NULL UNIQUE, owner jsonb NOT NULL, config jsonb NOT NULL)`;

/** The projections that H's outbox sender delivers, one row per `(scope, id)`: the receiver deduplicates, as the sender requires. */
export const hostProjectionDdl = (schema: string): string => `CREATE TABLE IF NOT EXISTS ${table(schema, 'host_projection')} (
  scope text NOT NULL, id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY (scope, id))`;

export function hostProjections(pool: Pool, schema: string): ProjectionPort {
  const target = table(schema, 'host_projection');
  return { deliver: async (scope, id, value: Json) => {
    await pool.query(`INSERT INTO ${target} (scope, id, body) VALUES ($1, $2, $3) ON CONFLICT (scope, id) DO NOTHING`, [scope, id, JSON.stringify(value)]);
  } };
}

type HostScopeRow = { scope: string; owner_token_sha256: string; owner: Principal; config: HostConfig };
const hostScope = (row: HostScopeRow | undefined): HostScope | undefined =>
  row && { scope: row.scope, ownerTokenSha256: row.owner_token_sha256, owner: row.owner, config: row.config };

/** The row of one scope, by its primary key, or nothing for an unknown scope. */
export async function readHostScope(pool: Pool, schema: string, scope: string): Promise<HostScope | undefined> {
  const found = await pool.query<HostScopeRow>(`SELECT scope, owner_token_sha256, owner, config FROM ${table(schema)} WHERE scope = $1`, [scope]);
  return hostScope(found.rows[0]);
}

/** The row whose owner session token hashes to `sha256`, through the column's unique index, or nothing. */
export async function readHostScopeByToken(pool: Pool, schema: string, sha256: string): Promise<HostScope | undefined> {
  const found = await pool.query<HostScopeRow>(
    `SELECT scope, owner_token_sha256, owner, config FROM ${table(schema)} WHERE owner_token_sha256 = $1`, [sha256]);
  return hostScope(found.rows[0]);
}

export async function writeHostScope(pool: Pool, schema: string, row: HostScope): Promise<void> {
  await pool.query(`INSERT INTO ${table(schema)} (scope, owner_token_sha256, owner, config) VALUES ($1, $2, $3, $4)
    ON CONFLICT (scope) DO UPDATE SET owner_token_sha256 = EXCLUDED.owner_token_sha256, owner = EXCLUDED.owner, config = EXCLUDED.config`,
  [row.scope, row.ownerTokenSha256, JSON.stringify(row.owner), JSON.stringify(row.config)]);
}

/** Lowercase hex SHA-256 over WebCrypto, which Node and workerd both have. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
