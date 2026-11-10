import type { Pool, PoolClient } from 'pg';
import { STORE_VERSION } from './ddl';
import { exportMarkOf, SwitchExportedError, SwitchImportedError } from '@byok-sdk/example-bot-collaboration/migration';
import { importMarkOf } from './switch';

/** A stored scope row of a store version that this code does not support. Nothing was written. */
export class HostedStoreVersionError extends Error {
  constructor(readonly version: number) { super(`Unsupported hosted collaboration store version ${version}`); this.name = 'HostedStoreVersionError'; }
}

export const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

/** Runs `work` in one transaction with `search_path` set to `schema`. A throw rolls back every row. */
export async function inSchema<T>(pool: Pool, schema: string, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  if (!SCHEMA.test(schema)) throw new Error('Invalid hosted collaboration schema name');
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    if (!readOnly) locks.set(client, { scopes: new Set(), switchStep: false });
    const value = await work(client);
    if (!readOnly) await refuseSwitched(client, locks.get(client)!);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    // A client whose rollback failed is broken: release it with the error, so the pool drops it.
    broken = await client.query('ROLLBACK').then(() => undefined, (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure)));
    throw error;
  } finally {
    locks.delete(client);
    client.release(broken);
  }
}

/** The scopes that each open write transaction of `inSchema` locked, and whether it is a switch step (#975). */
const locks = new WeakMap<PoolClient, { scopes: Set<string>; switchStep: boolean }>();
/**
 * The switch fence (#975): a transaction that locked an exported scope, or one with an uncommitted import, does not
 * commit, so H writes nothing to it. It runs right before the commit, so the work's own refusals come first, as each L
 * write refuses after its own (K8 `writeLedger`). Only the switch steps (`lockScope` with `'switch'`) pass: the export,
 * the commit away and the abort, and the import, its commit and its discard.
 */
async function refuseSwitched(client: PoolClient, lock: { scopes: Set<string>; switchStep: boolean }): Promise<void> {
  if (!lock.scopes.size || lock.switchStep) return;
  const found = await client.query<{ exported: unknown; imported: unknown }>(`SELECT switch_export AS exported, switch_import AS imported FROM scope
    WHERE scope = ANY($1::text[]) AND (switch_export IS NOT NULL OR switch_import IS NOT NULL) LIMIT 1`, [[...lock.scopes]]);
  const row = found.rows[0];
  if (row?.exported != null) throw new SwitchExportedError(exportMarkOf(row.exported).digest);
  if (row?.imported != null) throw new SwitchImportedError(importMarkOf(row.imported).digest);
}

/**
 * Locks an existing scope row for the rest of the transaction and returns its frame. Every writer of a scope
 * takes this lock first. A scope row of an unknown store version is refused before any write. The lock joins the switch
 * fence of the transaction, so it runs only in a write transaction of `inSchema`; `step` marks a switch step.
 */
export async function lockScope(client: PoolClient, scopeKey: string, step?: 'switch'): Promise<string> {
  const lock = locks.get(client);
  if (!lock) throw new Error('A scope lock needs a write transaction of inSchema');
  lock.scopes.add(scopeKey);
  if (step) lock.switchStep = true;
  const head = await client.query<{ state_version: number; frame: string }>(
    'SELECT state_version, frame::text AS frame FROM scope WHERE scope = $1 FOR UPDATE', [scopeKey]);
  if (!head.rows[0]) throw new Error('Unknown hosted collaboration scope');
  if (head.rows[0].state_version !== STORE_VERSION) throw new HostedStoreVersionError(head.rows[0].state_version);
  return head.rows[0].frame;
}
