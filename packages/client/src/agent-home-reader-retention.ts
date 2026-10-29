import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AGENT_HOME_READER_RUN_MAX_RETAINED, AGENT_HOME_READER_RUN_MAX_AGE_MS, isReaderRunName } from './agent-home-readers';
/**
 * The reader-run retention policy. Inputs are canonical absolute paths.
 *
 * - A directory in `active` is never selected.
 * - A directory that a reader session handoff points to stays while that
 *   record's last update is within the age limit.
 * - Other directories older than the age limit are selected.
 * - Then, while more than `maxRetained` directories remain, the oldest
 *   unprotected directory is selected first.
 *
 * Age is the directory's own modification time. The `reader-run` retention
 * class removes what this yields, under its root identity checks.
 */
export async function* selectReaderRuns(input: {
 readonly runsRoot: string; readonly active: ReadonlySet<string>; readonly referenced: ReadonlyMap<string, number>;
 readonly nowMs: number; readonly maxRetained?: number; readonly maxAgeMs?: number;
 readonly entries?: AsyncIterable<import('node:fs').Dirent>;
 readonly pending?: readonly string[];
}): AsyncGenerator<{ readonly dir: string; readonly mtimeMs: number }> {
  const maxRetained = input.maxRetained ?? AGENT_HOME_READER_RUN_MAX_RETAINED;
  const cutoff = input.nowMs - (input.maxAgeMs ?? AGENT_HOME_READER_RUN_MAX_AGE_MS);
  let entries: AsyncIterable<import('node:fs').Dirent> | import('node:fs').Dirent[];
  try {
    entries = input.entries ?? await fs.readdir(input.runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  async function* names(): AsyncGenerator<string> {
    for (const directory of input.pending ?? []) if (path.dirname(directory) === input.runsRoot) yield path.basename(directory);
    for await (const entry of entries) if (entry.isDirectory()) yield entry.name;
  }
  const seen = new Set<string>();
  const kept: { dir: string; mtimeMs: number; protected: boolean }[] = [];
  for await (const name of names()) {
    if (seen.has(name) || !isReaderRunName(name)) continue;
    seen.add(name);
    const dir = path.join(input.runsRoot, name);
    const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat === undefined || !stat.isDirectory()) continue;
    const referencedAt = input.referenced.get(dir);
    const run = { dir, mtimeMs: stat.mtimeMs, protected: input.active.has(dir) || (referencedAt !== undefined && referencedAt >= cutoff) };
    if (!run.protected && run.mtimeMs < cutoff) yield run;
    else kept.push(run);
  }
  const overflow = kept.filter(run => !run.protected).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const run of overflow.slice(0, Math.max(0, kept.length - maxRetained))) yield run;
}
