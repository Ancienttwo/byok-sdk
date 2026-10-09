import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOME_MEMORY_DIGEST_MAX_BYTES,
  AGENT_HOME_MEMORY_DIGEST_MAX_FILES,
  AGENT_HOME_MEMORY_PATH_MAX_LENGTH,
  type TerminalAgentHomeMemoryChange,
} from '@byok-sdk/protocol';

/**
 * How one Agent Attempt uses its home. The wire carries only
 * `homeAccess: 'memory-reader'`; an absent value is the writer.
 */
export type AgentHomeAccessMode = 'memory-writer' | 'memory-reader';

/** SDK-owned parent of reader run directories, under the home's `.byok/`. */
export const AGENT_HOME_READER_RUNS_DIRECTORY = 'runs';
/** Retention keeps at most this many reader run directories per home. */
export const AGENT_HOME_READER_RUN_MAX_RETAINED = 32;
/** Retention removes an unprotected reader run directory older than this. */
export const AGENT_HOME_READER_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const READER_RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Whether a taskId can name a reader run directory. A taskId is any
 * non-empty wire string, so the SDK accepts only one plain path segment.
 */
export function isReaderRunName(taskId: string): boolean {
  return READER_RUN_NAME.test(taskId) && taskId !== '.' && taskId !== '..';
}

/**
 * Removes old reader run directories. Inputs are canonical absolute paths.
 *
 * - A directory in `active` is never removed.
 * - A directory that a reader session handoff points to stays while that
 *   record's last update is within the age limit.
 * - Other directories older than the age limit are removed.
 * - Then, while more than `maxRetained` directories remain, the oldest
 *   unprotected directory is removed first.
 *
 * Age is the directory's own modification time.
 */
export async function pruneReaderRuns(input: {
  readonly runsRoot: string;
  readonly active: ReadonlySet<string>;
  readonly referenced: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly maxRetained?: number;
  readonly maxAgeMs?: number;
}): Promise<readonly string[]> {
  const maxRetained = input.maxRetained ?? AGENT_HOME_READER_RUN_MAX_RETAINED;
  const cutoff = input.nowMs - (input.maxAgeMs ?? AGENT_HOME_READER_RUN_MAX_AGE_MS);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(input.runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const runs: { readonly dir: string; readonly mtimeMs: number; readonly protected: boolean }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isReaderRunName(entry.name)) continue;
    const dir = path.join(input.runsRoot, entry.name);
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory()) continue;
    const referencedAt = input.referenced.get(dir);
    runs.push({
      dir,
      mtimeMs: stat.mtimeMs,
      protected: input.active.has(dir) || (referencedAt !== undefined && referencedAt >= cutoff),
    });
  }
  const removed: string[] = [];
  const remove = async (dir: string): Promise<void> => {
    await fs.rm(dir, { recursive: true, force: true });
    removed.push(dir);
  };
  const kept: typeof runs = [];
  for (const run of runs) {
    if (!run.protected && run.mtimeMs < cutoff) await remove(run.dir);
    else kept.push(run);
  }
  const overflow = kept.filter((run) => !run.protected).sort((left, right) => left.mtimeMs - right.mtimeMs);
  let retained = kept.length;
  for (const run of overflow) {
    if (retained <= maxRetained) break;
    await remove(run.dir);
    retained -= 1;
  }
  return removed;
}

/** Relative path (with `/` separators) -> content fingerprint of one memory file. */
export type AgentHomeMemoryDigest = ReadonlyMap<string, string>;

/**
 * Fingerprints `MEMORY.md` and every entry under `notes/`, bounded by
 * {@link AGENT_HOME_MEMORY_DIGEST_MAX_FILES} entries and
 * {@link AGENT_HOME_MEMORY_DIGEST_MAX_BYTES} bytes. It never follows a
 * symbolic link: a link is fingerprinted by its target text. Returns
 * `undefined` when a bound is exceeded or a read fails; the caller then
 * reports `unmeasured`.
 */
export async function digestAgentHomeMemory(home: string): Promise<AgentHomeMemoryDigest | undefined> {
  const digest = new Map<string, string>();
  let bytes = 0;
  const visit = async (relative: string): Promise<boolean> => {
    if (relative.length > AGENT_HOME_MEMORY_PATH_MAX_LENGTH) return false;
    const absolute = path.join(home, ...relative.split('/'));
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    if (stat.isDirectory()) {
      const names = (await fs.readdir(absolute)).sort();
      for (const name of names) {
        if (!(await visit(`${relative}/${name}`))) return false;
      }
      return true;
    }
    if (digest.size >= AGENT_HOME_MEMORY_DIGEST_MAX_FILES) return false;
    if (stat.isSymbolicLink()) {
      digest.set(relative, `link:${await fs.readlink(absolute)}`);
      return true;
    }
    if (!stat.isFile()) {
      digest.set(relative, 'special');
      return true;
    }
    bytes += stat.size;
    if (bytes > AGENT_HOME_MEMORY_DIGEST_MAX_BYTES) return false;
    const content = await fs.readFile(absolute);
    bytes += content.length - stat.size;
    if (bytes > AGENT_HOME_MEMORY_DIGEST_MAX_BYTES) return false;
    digest.set(relative, `sha256:${createHash('sha256').update(content).digest('hex')}`);
    return true;
  };
  try {
    if (!(await visit('MEMORY.md'))) return undefined;
    if (!(await visit('notes'))) return undefined;
  } catch {
    return undefined;
  }
  return digest;
}

/**
 * Compares the reader's start and terminal digests. `writerOverlapped` is
 * true when a writer Attempt of the same home was active at any time
 * during the reader.
 */
export function compareAgentHomeMemory(
  before: AgentHomeMemoryDigest | undefined,
  after: AgentHomeMemoryDigest | undefined,
  writerOverlapped: boolean,
): TerminalAgentHomeMemoryChange {
  if (before === undefined || after === undefined) return { outcome: 'unmeasured' };
  const changed = new Set<string>();
  for (const [relative, fingerprint] of before) {
    if (after.get(relative) !== fingerprint) changed.add(relative);
  }
  for (const relative of after.keys()) {
    if (!before.has(relative)) changed.add(relative);
  }
  if (changed.size === 0) return { outcome: 'unchanged' };
  // Each digest holds at most AGENT_HOME_MEMORY_DIGEST_MAX_FILES entries, so
  // the union fits the wire bound of twice that number.
  const paths = [...changed].sort();
  return writerOverlapped ? { outcome: 'unattributed', paths } : { outcome: 'reader-attributed', paths };
}
