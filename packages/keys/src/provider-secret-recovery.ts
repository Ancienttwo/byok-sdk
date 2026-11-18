import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { ByokKeysError } from './errors.js';
import type { ModelProviderSecretName } from './secret-store.js';

// Frozen signatures of the full released DDL. Reproduce the first four from
// fixtures/provider-store-recovery-ddl.sql and the last two from the release
// stores 0.41.0 and 0.44.0. Normal store opens never consult this allowlist.
export const LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA = 'b98adbeaf0e72ae2dd9459b961ea78f6217444aa4f95d5cb3451d0006701b834';
const RELEASED_SCHEMAS = new Map<string, 'provider-id' | 'profile-ref' | 'custody'>([
  ['cedb8ffb40cd05a44fa83cc480f9dc8d89cfe544a32de9245981d276becf02dd', 'provider-id'], // keys 0.1.0–0.3.9
  ['ccbeac2b67121214a6dfd388d37d760c446e70ee31a4050fbd0dd7f15a27b127', 'profile-ref'], // keys 0.3.10
  ['ee4efa8773f7987882cba2676b6256b4c1ec7f30fb810e2598be343cc99677f3', 'profile-ref'], // keys 0.4.0–0.4.3
  ['35a65f43af77a150d388848db0ae9f752dfa14a154ff26d6ecd27cd4d6329524', 'profile-ref'], // keys 0.5.0–0.7.0
  ['2c4cc1ba7d87b14558d2d32d50987deec50309d0c146a7ff3824ee4c8d7693d0', 'custody'], // keys 0.8.0–0.41.0
  [LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA, 'custody'], // keys 0.42.0–0.44.0
]);

const LEGACY_NAMES = new Map<string, ModelProviderSecretName>([
  ['openai', 'model-openai-api-key'],
  ['deepseek', 'model-deepseek-api-key'],
  ['anthropic', 'model-anthropic-api-key'],
  ['custom', 'model-custom-api-key'],
]);
const RELEASED_REF = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;
const SIDECARS = ['-wal', '-shm', '-journal'] as const;
const REF_SELECT = 'SELECT profile_ref AS ref, instr(profile_ref, char(0)) AS nul FROM main.provider_profile';
const IDENTITIES = {
  'provider-id': 'SELECT provider_id AS ref, instr(provider_id, char(0)) AS nul FROM main.provider_profile',
  'profile-ref': REF_SELECT,
  custody: `${REF_SELECT} UNION ALL SELECT profile_ref AS ref, instr(profile_ref, char(0)) AS nul FROM main.provider_custody_pending`,
} as const;

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

function readNames(db: DatabaseSync): ModelProviderSecretName[] {
  // Extension loading is disabled by default by DatabaseSync. These pragmas
  // are connection-local and are applied before any schema or profile read.
  db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
  const layout = RELEASED_SCHEMAS.get(providerSecretRecoverySignature(db));
  if (layout === undefined) throw stale();

  const names = new Set<ModelProviderSecretName>();
  // Reject NUL at SQLite's boundary as well, even if a binding truncates C strings.
  for (const { ref, nul } of db.prepare(IDENTITIES[layout]).iterate()) {
    if (typeof ref !== 'string' || nul !== 0) throw stale();
    if (layout === 'provider-id') {
      const name = LEGACY_NAMES.get(ref);
      if (name === undefined) throw stale();
      names.add(name);
    } else {
      if (ref.length > 64 || !RELEASED_REF.test(ref)) throw stale();
      names.add(`model-${ref}-api-key`);
    }
  }
  return [...names].sort();
}

/**
 * List sorted, unique provider credential entry names from a known released
 * provider store. Stop its writers first. A store with SQLite sidecars must
 * finish recovery and close before this function can read it.
 *
 * Credential names can be shared by stores in the same SecretStore scope.
 * Before deleting anything, exclude the names referenced by active stores in
 * that scope. Use the original credential backend and scope. Only names still
 * evidenced by database rows are returned: older releases could leave orphaned
 * credentials if a process crashed between writing the credential and profile,
 * or between deleting the profile and credential. An empty list does not prove
 * cleanup complete. Check the original backend's inventory or UI as described
 * in the recovery guide; if ownership cannot be verified, report cleanup
 * incomplete.
 */
export async function listProviderProfileSecretNames(path: string): Promise<readonly ModelProviderSecretName[]> {
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
        const names = readSqliteFileUnchanged(copy, readNames);
        if (names === undefined) throw unavailable();
        return names;
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
