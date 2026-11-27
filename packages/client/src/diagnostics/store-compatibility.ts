import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { StoreCompatibility } from '@byok-sdk/core';
import { JournalCorruptError, JournalUnavailableError } from '../daemon/journal/journal.js';
import { JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal.js';
import { loadSqliteModule } from '../util/sqlite-support.js';
import { DURABLE_REPLICA_DIRNAME, durableReplicaFiles, isReplicaWriterLock } from '../adapters/pi-durable/replica.js';
import { openExistingLocalDurableStorage } from '../adapters/pi-durable/storage.js';

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
  for (const replica of listReplicas(join(storeDir, DURABLE_REPLICA_DIRNAME))) {
    const result = await inspectDurableReplica(replica);
    if (result !== undefined) results.push(result);
  }
  return results;
}

async function inspectJournal(storeDir: string): Promise<StoreCompatibility> {
  const file = join(storeDir, JOURNAL_DB_FILENAME);
  return inspectCopy('client-journal', file, async (copy) => {
    // The journal is opened by directory; the copy is the only file in its own.
    const journal = new SqliteLocalTaskJournal({ storeDir: resolve(copy, '..') });
    await journal.close();
  }, (error) => {
    // A journal in another format is refused with JournalUnavailableError and
    // left unchanged; an unreadable one would be quarantined. Both need the operator.
    if (error instanceof JournalUnavailableError || error instanceof JournalCorruptError) {
      return { verdict: 'rejected', code: error.name, reason: error.message };
    }
    return undefined;
  });
}

async function inspectDurableReplica(file: string): Promise<StoreCompatibility | undefined> {
  return inspectCopy('pi-durable', file, async (copy) => {
    // A replica in any pi-durable schema version other than the pinned one is refused unchanged.
    // Pi packages stay out of the root entry's static graph, as the storage factory does.
    const storage = await openExistingLocalDurableStorage(copy);
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    await storage.close(BACKGROUND_CONTEXT);
  }, () => undefined, isReplicaWriterLock);
}

type Refusal = Pick<StoreCompatibility, 'verdict' | 'code' | 'reason'>;

async function inspectCopy(
  store: StoreCompatibility['store'], file: string, open: (copy: string) => Promise<void>,
  classify: (error: unknown) => Refusal | undefined,
): Promise<StoreCompatibility>;
async function inspectCopy(
  store: StoreCompatibility['store'], file: string, open: (copy: string) => Promise<void>,
  classify: (error: unknown) => Refusal | undefined, omit: (copy: string) => boolean,
): Promise<StoreCompatibility | undefined>;
async function inspectCopy(
  store: StoreCompatibility['store'],
  file: string,
  open: (copy: string) => Promise<void>,
  classify: (error: unknown) => Refusal | undefined,
  omit?: (copy: string) => boolean,
): Promise<StoreCompatibility | undefined> {
  const stat = statOrUndefined(file);
  if (stat === undefined) return { store, path: file, verdict: 'absent', reason: 'No store file at this path' };
  if (!stat.isFile()) return { store, path: file, verdict: 'rejected', reason: 'The store path is not a regular file' };
  const directory = mkdtempSync(join(tmpdir(), 'byok-store-check-'));
  try {
    const copy = copyStoreFiles(file, stat, directory);
    try {
      if (omit?.(copy)) return undefined;
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
    const files = readDirectory(directory).filter((entry) => entry.isFile()).map((entry) => entry.name);
    for (const name of durableReplicaFiles(files)) replicas.push(join(directory, name));
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
  const changed = (): Error => new Error(`${file} changed while it was being checked; stop the daemon that owns it and check again`);
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
