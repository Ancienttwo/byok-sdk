import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { readCredentialNamespaceId } from './credential-namespace.js';
import { ByokKeysError } from './errors.js';
import { bindProviderCredentialStore } from './provider-credential-store.js';
import type { ModelProviderSecretName, SecretStore } from './secret-store.js';
import { secretStoreCall } from './secret-store-call.js';

// Frozen signature of the first namespaced layout. Normal store opens use
// their own format check. Earlier layouts share credential addresses.
export const LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA = 'be907fc2d22c93bc27d089ba6336be5edde721b0af909857bd3c7f4305453ff6';
const RELEASED_REF = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;
const SIDECARS = ['-wal', '-shm', '-journal'] as const;
const REFS = `
  SELECT profile_ref AS ref, instr(profile_ref, char(0)) AS nul FROM main.provider_profile
  UNION ALL
  SELECT profile_ref AS ref, instr(profile_ref, char(0)) AS nul FROM main.provider_custody_pending
`;

interface RetiredCredentials {
  readonly namespaceId: string;
  readonly names: readonly ModelProviderSecretName[];
}

export function providerSecretRecoverySignature(db: DatabaseSync): string {
  const rows = db.prepare(
    'SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE substr(name, 1, 7) <> ? ORDER BY type, name',
  ).all('sqlite_');
  const objects = rows.map(({ type, name, tbl_name, sql }) => [
    type, name, tbl_name,
    // SQLite has already stripped IF NOT EXISTS and the trailing semicolon.
    // Normalize whitespace between tokens, preserving quoted literals.
    typeof sql === 'string' ? sql.replace(/'(?:''|[^'])*'|\s+/gu, (token) => token.startsWith("'") ? token : ' ').trim() : sql,
  ]);
  return createHash('sha256').update(JSON.stringify(objects)).digest('hex');
}

function stale(): ByokKeysError {
  return new ByokKeysError('PROVIDER_STORE_SCHEMA_STALE', 'Provider secret recovery does not recognize the store layout or an identity row');
}

function unavailable(): ByokKeysError {
  return new ByokKeysError('PROVIDER_STORE_UNAVAILABLE', 'Provider secret recovery requires a readable, offline store without SQLite sidecars');
}

function fileFingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size === 0n) throw unavailable();
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function readRetiredCredentials(db: DatabaseSync, path: string): RetiredCredentials {
  // Extension loading is disabled by default by DatabaseSync. These pragmas
  // are connection-local and are applied before any schema or profile read.
  db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
  if (providerSecretRecoverySignature(db) !== LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA) throw stale();
  const namespaceId = readCredentialNamespaceId(db, path);
  const names = new Set<ModelProviderSecretName>();
  // Reject NUL at SQLite's boundary as well, even if a binding truncates C strings.
  for (const { ref, nul } of db.prepare(REFS).iterate()) {
    if (typeof ref !== 'string' || nul !== 0 || ref.length > 64 || !RELEASED_REF.test(ref)) throw stale();
    names.add(`model-${ref}-api-key`);
  }
  return { namespaceId, names: [...names].sort() };
}

/**
 * List sorted, unique credential names evidenced by a recognized namespaced
 * provider store's profile or pending rows. Close the store before reading it.
 * Use the names for diagnostics and {@link removeRetiredProviderCredentials}
 * for cleanup. An empty list can still leave credentials without a DB record.
 */
export async function listProviderProfileSecretNames(path: string): Promise<readonly ModelProviderSecretName[]> {
  return readOfflineStore(path).names;
}

/**
 * Remove the credentials evidenced by an offline, retired provider database.
 * The Host authorizes cleanup, retires every copy of the store identity, and
 * supplies the original base credential store with its original backend options.
 * An unreadable or unsupported database is refused before any credential calls.
 * Backend failures stop cleanup and may leave it partial. Retry with the same
 * database and backend to finish it.
 */
export async function removeRetiredProviderCredentials(
  path: string,
  originalBaseSecretStore: SecretStore<ModelProviderSecretName>,
): Promise<void> {
  const { namespaceId, names } = readOfflineStore(path);
  const credentials = bindProviderCredentialStore(originalBaseSecretStore, namespaceId);
  for (const name of names) await secretStoreCall(() => credentials.delete(name));
}

function readOfflineStore(path: string): RetiredCredentials {
  try {
    if (path === ':memory:') throw unavailable();
    const input = resolve(path);
    const source = realpathSync(input);
    const paths = source === input ? [source] : [source, input];
    const fingerprint = () => {
      if (realpathSync(input) !== source) throw unavailable();
      for (const file of paths) {
        for (const suffix of SIDECARS) {
          if (lstatSync(file + suffix, { throwIfNoEntry: false }) !== undefined) throw unavailable();
        }
      }
      return fileFingerprint(source);
    };
    const before = fingerprint();
    const directory = mkdtempSync(join(tmpdir(), 'byok-provider-secret-recovery-'));
    try {
      const copy = join(directory, 'profiles.db');
      copyFileSync(source, copy);
      if (fingerprint() !== before) throw unavailable();
      try {
        const credentials = readSqliteFileUnchanged(copy, (db) => readRetiredCredentials(db, source));
        if (credentials === undefined) throw unavailable();
        return credentials;
      } finally {
        if (fingerprint() !== before) throw unavailable();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  } catch (error) {
    if (error instanceof ByokKeysError) throw error;
    throw unavailable();
  }
}
