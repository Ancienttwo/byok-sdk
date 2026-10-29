import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { StoreCompatibility } from '@byok-sdk/core';
import { JournalCorruptError, JournalUnavailableError } from '../daemon/journal/journal';
import { JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { loadSqliteModule } from '../daemon/journal/sqlite-support';
import { DURABLE_REPLICA_DIRNAME, isDurableReplicaFile } from '../adapters/pi-durable/replica';
import { openLocalDurableStorage } from '../adapters/pi-durable/storage';

/** A SQLite store is its main file plus a WAL or a hot rollback journal. `-shm` is rebuilt from the WAL. */
const SQLITE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;

export interface InspectDaemonStoresInput {
  /** The daemon's resolved store directory (`DaemonConfig.storeDir` or its default). */
  readonly storeDir: string;
}

/**
 * Store compatibility precheck for the stores a daemon owns (#1102): the
 * local task journal (`<storeDir>/daemon.db`) and every pi-durable replica
 * under `<storeDir>/durable-replicas/`.
 *
 * Reports what this build does when it opens each one. The files are copied to
 * a private temporary directory and this build's own open runs on the copy, so
 * the format rules stay in the store code and the originals are only read.
 * Stop the daemon first: a file that changes while it is copied fails the
 * check rather than yielding a verdict about a torn copy.
 *
 * The journal comes first and is `absent` when there is none; one result
 * follows per replica. The server SQLite store and the provider profile store
 * are checked by `inspectSqliteStore` (`@byok-sdk/server`) and
 * `inspectProviderProfileStore` (`@byok-sdk/keys`).
 */
export async function inspectDaemonStores(input: InspectDaemonStoresInput): Promise<readonly StoreCompatibility[]> {
  const storeDir = resolve(input.storeDir);
  loadSqliteModule();
  const results = [await inspectJournal(storeDir)];
  for (const replica of listReplicas(join(storeDir, DURABLE_REPLICA_DIRNAME))) results.push(await inspectDurableReplica(replica));
  return results;
}

async function inspectJournal(storeDir: string): Promise<StoreCompatibility> {
  const file = join(storeDir, JOURNAL_DB_FILENAME);
  return inspectCopy('client-journal', file, async (copy) => {
    // The journal is opened by directory; the copy is the only file in its own.
    const journal = new SqliteLocalTaskJournal({ storeDir: resolve(copy, '..') });
    await journal.close();
  }, (error) => {
    // A pre-#826 or hash-only journal is refused with JournalUnavailableError and
    // left unchanged; an unreadable one would be quarantined. Both need the operator.
    if (error instanceof JournalUnavailableError || error instanceof JournalCorruptError) {
      return { verdict: 'rejected', code: error.name, reason: error.message };
    }
    return undefined;
  });
}

async function inspectDurableReplica(file: string): Promise<StoreCompatibility> {
  return inspectCopy('pi-durable', file, async (copy) => {
    // Opening applies pi-durable's forward migrations to the copy; a newer schema is refused.
    // Pi packages stay out of the root entry's static graph, as openLocalDurableStorage does.
    const storage = await openLocalDurableStorage(copy);
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    await storage.close(BACKGROUND_CONTEXT);
  }, () => undefined);
}

type Refusal = Pick<StoreCompatibility, 'verdict' | 'code' | 'reason'>;

async function inspectCopy(
  store: StoreCompatibility['store'],
  file: string,
  open: (copy: string) => Promise<void>,
  classify: (error: unknown) => Refusal | undefined,
): Promise<StoreCompatibility> {
  const stat = statOrUndefined(file);
  if (stat === undefined) return { store, path: file, verdict: 'absent', reason: 'No store file at this path' };
  if (!stat.isFile()) return { store, path: file, verdict: 'rejected', reason: 'The store path is not a regular file' };
  const directory = mkdtempSync(join(tmpdir(), 'byok-store-check-'));
  try {
    const copy = copyStoreFiles(file, directory);
    try {
      await open(copy);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      return { store, path: file, ...(classify(error) ?? { verdict: 'rejected', ...(typeof code === 'string' ? { code } : {}), reason }) };
    }
    return { store, path: file, verdict: 'accepted', reason: 'This build opens the store' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function listReplicas(root: string): string[] {
  const replicas: string[] = [];
  for (const binding of readDirectory(root)) {
    if (!binding.isDirectory()) continue;
    const directory = join(root, binding.name);
    for (const entry of readDirectory(directory)) {
      if (entry.isFile() && isDurableReplicaFile(entry.name)) replicas.push(join(directory, entry.name));
    }
  }
  return replicas.sort();
}

function readDirectory(directory: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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
    throw new Error(`${file} changed while it was being checked; stop the daemon that owns it and check again`);
  }
  return copy;
}

function fingerprint(file: string): string | undefined {
  const stat = statOrUndefined(file);
  return stat === undefined ? undefined : `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}
