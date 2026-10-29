import { copyFileSync, mkdtempSync, rmSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { StoreCompatibility } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createSqliteEmbeddedStores } from './stores/sqlite';
import { SqliteSchemaError, SqliteUnavailableError } from './sqlite-support';

/** A SQLite store is its main file plus a WAL or a hot rollback journal. `-shm` is rebuilt from the WAL. */
const SQLITE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;

/**
 * Store compatibility precheck for the embedded server SQLite store (#1102).
 *
 * Reports what this build does when `createByokServer({ storage: { kind:
 * 'sqlite', path } })` opens `path`. The files are copied to a private
 * temporary directory and the server's own open runs on the copy, so the
 * schema rules stay in one place and the original files are only read. Stop
 * the server that owns the file first: a file that changes while it is copied
 * fails the check rather than yielding a verdict about a torn copy.
 *
 * An older `schema_version` is `new-path-repair` (start on a new path and pair
 * the daemons again). A newer version, a file without BYOK metadata, a damaged
 * file, or data this build refuses to adopt is `rejected`.
 */
export async function inspectSqliteStore(path: string): Promise<StoreCompatibility> {
  const file = resolve(path);
  const stat = statOrUndefined(file);
  if (stat === undefined) return { store: 'server-sqlite', path: file, verdict: 'absent', reason: 'No store file at this path' };
  if (!stat.isFile()) return { store: 'server-sqlite', path: file, verdict: 'rejected', reason: 'The store path is not a regular file' };
  const directory = mkdtempSync(join(tmpdir(), 'byok-store-check-'));
  try {
    const copy = copyStoreFiles(file, directory);
    try {
      const stores = createSqliteEmbeddedStores(
        { path: copy },
        {
          clock: { now: () => new Date() },
          crypto: createWebCrypto(),
          // Queued wakes need the Host's hook at runtime; they do not change the format verdict.
          wake: { consume: () => Promise.reject(new Error('the store precheck does not deliver wakes')) },
        },
      );
      await stores.close();
    } catch (error) {
      if (error instanceof SqliteUnavailableError) throw error;
      return { store: 'server-sqlite', path: file, ...refusal(error) };
    }
    return { store: 'server-sqlite', path: file, verdict: 'accepted', reason: 'This build opens the store' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function refusal(error: unknown): Pick<StoreCompatibility, 'verdict' | 'code' | 'reason'> {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof SqliteSchemaError) {
    const older = error.code === 'SQLITE_SCHEMA_UNSUPPORTED' && isOlder(error.foundVersion, error.requiredVersion);
    return { verdict: older ? 'new-path-repair' : 'rejected', code: error.code, reason };
  }
  const code = (error as { code?: unknown } | null)?.code;
  return { verdict: 'rejected', ...(typeof code === 'string' ? { code } : {}), reason };
}

function isOlder(found: string | undefined, required: string): boolean {
  return found !== undefined && /^\d+$/.test(found) && /^\d+$/.test(required) && Number(found) < Number(required);
}

function statOrUndefined(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Copy the store files into `directory`; fail when one of them changes during the copy. */
function copyStoreFiles(file: string, directory: string): string {
  const copy = join(directory, basename(file));
  const before = SQLITE_FILE_SUFFIXES.map((suffix) => fingerprint(`${file}${suffix}`));
  SQLITE_FILE_SUFFIXES.forEach((suffix, index) => {
    if (before[index] !== undefined) copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
  });
  const after = SQLITE_FILE_SUFFIXES.map((suffix) => fingerprint(`${file}${suffix}`));
  if (after.some((value, index) => value !== before[index])) {
    throw new Error(`${file} changed while it was being checked; stop the server that owns it and check again`);
  }
  return copy;
}

function fingerprint(file: string): string | undefined {
  const stat = statOrUndefined(file);
  return stat === undefined ? undefined : `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}
