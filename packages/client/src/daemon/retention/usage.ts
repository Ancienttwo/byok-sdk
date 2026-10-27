import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SweepBudget } from './registry';

export interface TreeUsage { bytes: number; entries: number; oldestAgeMs: number | null }
/** A complete physical measurement; symbolic links are counted, never followed. */
export async function measureTree(root: string, now: Date, maxEntries = 16_384): Promise<TreeUsage> {
  let bytes = 0, entries = 0, oldestAgeMs: number | null = null, scanned = 0;
  async function visit(target: string): Promise<void> {
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat === undefined) return;
    if (++scanned > maxEntries) throw new Error('retention_usage_scan_limit');
    if (stat.isDirectory()) {
      const directory = await fs.opendir(target);
      for await (const entry of directory) await visit(path.join(target, entry.name));
    } else {
      bytes += stat.size;
      entries++;
      oldestAgeMs = Math.max(oldestAgeMs ?? 0, Math.max(0, now.getTime() - stat.mtimeMs));
    }
  }
  await visit(root);
  return { bytes, entries, oldestAgeMs };
}

/** Only existing, canonical directories are eligible mutation roots. */
export async function existingDirectory(directory: string): Promise<boolean> {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat === undefined) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('retention_root_identity_invalid');
  return true;
}

async function existingOwnedParent(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('retention_path_outside_root');
  if (!await existingDirectory(root)) return false;
  let ancestor = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if (!await existingDirectory(ancestor)) return false;
  }
  return true;
}

/**
 * Released runtimes consume one deletion per leaf/empty directory, then one for
 * the marker-only token. Report each success immediately so a later error does
 * not lose reclaimed bytes. Other producers retain their whole-item accounting.
 */
export async function removeOwnedPath(root: string, target: string, now: Date, releasedRuntimeBudget?: SweepBudget): Promise<number> {
  if (!await existingOwnedParent(root, target)) return 0;
  let reclaimed = 0;
  if (releasedRuntimeBudget !== undefined) {
    if (!await existingDirectory(target)) return 0;
    const budget = releasedRuntimeBudget;
    async function prune(file: string): Promise<boolean> {
      if (!budget.available()) return false;
      if (!await existingOwnedParent(root, file)) return true;
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (stat === undefined) return true;
      if (stat.isDirectory()) {
        if (!await existingDirectory(file)) return true;
        const directory = await fs.opendir(file);
        for await (const entry of directory) {
          // This is the eligibility authority on the next pass, including after restart.
          if (file === target && entry.name === 'released') continue;
          if (!await prune(path.join(file, entry.name))) return false;
        }
        if (file === target) return true;
      }
      if (!budget.available()) return false;
      if (!await existingOwnedParent(root, file)) return true;
      try {
        if (stat.isDirectory()) await fs.rmdir(file);
        else await fs.unlink(file); // Includes symbolic links; never follows their targets.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      }
      const bytes = stat.isDirectory() ? 0 : stat.size;
      reclaimed += bytes;
      budget.removed(bytes);
      return true;
    }
    if (!await prune(target) || !budget.available()) return reclaimed;
  }
  // Progressive deletion must finish the payload first. At most the token and
  // its release marker may remain; new payload causes a bounded, closed failure.
  const bytes = (await measureTree(target, now, releasedRuntimeBudget === undefined ? undefined : 2)).bytes;
  // Recheck after measurement, before the irreversible operation.
  if (!await existingOwnedParent(root, target)) throw new Error('retention_root_disappeared');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  releasedRuntimeBudget?.removed(bytes);
  return reclaimed + bytes;
}
