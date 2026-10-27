import { promises as fs } from 'node:fs';
import path from 'node:path';

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

export async function removeOwnedPath(root: string, target: string, now: Date, maxEntries = 16_384): Promise<number> {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('retention_path_outside_root');
  if (!await existingDirectory(root)) return 0;
  let ancestor = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if (!await existingDirectory(ancestor)) return 0;
  }
  const bytes = (await measureTree(target, now, maxEntries)).bytes;
  // Recheck after measurement, before the irreversible operation.
  if (!await existingDirectory(root)) throw new Error('retention_root_disappeared');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  return bytes;
}
