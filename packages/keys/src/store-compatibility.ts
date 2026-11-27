import { copyFileSync, mkdtempSync, rmSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { StoreCompatibility } from '@byok-sdk/core';
import { ByokKeysError } from './errors.js';
import { SqliteProviderProfileStore } from './sqlite-profile-store.js';
import { loadSqliteModule } from './sqlite-support.js';

/** A SQLite store is its main file plus a WAL or a hot rollback journal. `-shm` is rebuilt from the WAL. */
const SQLITE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;

/**
 * Store compatibility precheck for the provider profile store (#1102).
 *
 * Reports what this `@byok-sdk/keys` does when a writable
 * `SqliteProviderProfileStore` opens `path`. The files are copied to a private
 * temporary directory and the store's own open runs on the copy, so the schema
 * rules stay in one place and the original files are only read. Close the
 * process that writes the store first: a file that changes while it is copied
 * fails the check rather than yielding a verdict about a torn copy.
 *
 * Unsupported schemas are refused without migration.
 */
export async function inspectProviderProfileStore(path: string): Promise<StoreCompatibility> {
  const file = resolve(path);
  const stat = statOrUndefined(file);
  if (stat === undefined) return { store: 'keys-profile-store', path: file, verdict: 'absent', reason: 'No store file at this path' };
  if (!stat.isFile()) return { store: 'keys-profile-store', path: file, verdict: 'rejected', reason: 'The store path is not a regular file' };
  loadSqliteModule();
  const directory = mkdtempSync(join(tmpdir(), 'byok-store-check-'));
  try {
    const copy = copyStoreFiles(file, stat, directory);
    const refusal = await openRefusal(copy);
    if (refusal === undefined) return { store: 'keys-profile-store', path: file, verdict: 'accepted', reason: 'This build opens the store' };
    return refused(file, refusal);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The error the store's own writable open throws on `file`, or `undefined` when it opens. */
async function openRefusal(file: string): Promise<unknown> {
  try {
    await new SqliteProviderProfileStore({ path: file }).close();
    return undefined;
  } catch (error) {
    return error;
  }
}

function isSchemaStale(error: unknown): boolean {
  return error instanceof ByokKeysError && error.code === 'PROVIDER_STORE_SCHEMA_STALE';
}

/** `new-path-repair` for a stale schema, `rejected` for any other refusal, with the code and reason the store reported. */
function refused(file: string, error: unknown): StoreCompatibility {
  const reason = error instanceof Error ? error.message : String(error);
  const code = error instanceof ByokKeysError ? error.code : (error as { code?: unknown } | null)?.code;
  return {
    store: 'keys-profile-store',
    path: file,
    verdict: isSchemaStale(error) ? 'new-path-repair' : 'rejected',
    ...(typeof code === 'string' ? { code } : {}),
    reason,
  };
}

function statOrUndefined(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Copy the store files into `directory`; fail when one of them changes during the copy.
 *
 * `main` is the first observation of the main file and the snapshot baseline. The main
 * file must keep that fingerprint before and after the copy: once it is gone, nothing is
 * copied and the writable open would create a fresh store in `directory`, so the verdict
 * would describe a store that was never checked.
 */
function copyStoreFiles(file: string, main: Stats, directory: string): string {
  const copy = join(directory, basename(file));
  const changed = (): Error => new Error(`${file} changed while it was being checked; close the process that writes it and check again`);
  const before = SQLITE_FILE_SUFFIXES.map((suffix) => fingerprint(`${file}${suffix}`));
  if (before[0] !== fingerprintOf(main)) throw changed();
  SQLITE_FILE_SUFFIXES.forEach((suffix, index) => {
    if (before[index] === undefined) return;
    const source = `${file}${suffix}`;
    try {
      copyFileSync(source, `${copy}${suffix}`);
    } catch (error) {
      // A source that vanished after its fingerprint (a WAL checkpoint) is a change. An ENOENT
      // while the source is intact, or any other error, is the copy's own failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fingerprint(source) !== before[index]) throw changed();
      throw error;
    }
  });
  const after = SQLITE_FILE_SUFFIXES.map((suffix) => fingerprint(`${file}${suffix}`));
  if (after.some((value, index) => value !== before[index])) throw changed();
  return copy;
}

function fingerprint(file: string): string | undefined {
  const stat = statOrUndefined(file);
  return stat === undefined ? undefined : fingerprintOf(stat);
}

function fingerprintOf(stat: Stats): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}
