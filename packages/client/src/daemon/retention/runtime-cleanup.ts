import { runtimeReclaimedBytes } from './runtime-accounting';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SweepBudget } from './registry';
import { existingDirectory, removeOwnedPath } from './usage';

/**
 * Windows refuses to remove read-only entries. Recursive `fs.rm` clears the attribute and
 * retries, so this does too. Never for a symlink: chmod would follow it out of the token.
 */
async function removeEntry(remove: (file: string) => Promise<void>, file: string, symlink: boolean): Promise<void> {
  try { await remove(file); } catch (error) {
    if (process.platform !== 'win32' || symlink || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    await fs.chmod(file, 0o666); await remove(file);
  }
}

/** Only released, expired scratch tokens may use this resumable leaf collector. */
export class RuntimeCleanup {
  private current: string;
  private constructor(readonly target: string, private readonly dev: number, private readonly ino: number) { this.current = target; }
  /** A token that disappears first needs no cleanup, as with the whole-tree removal path. */
  static async create(target: string): Promise<RuntimeCleanup | undefined> {
    try {
      if (!await existingDirectory(target)) return undefined;
      const stat = await fs.lstat(target);
      return new RuntimeCleanup(target, stat.dev, stat.ino);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async validate(root: string, eligible: () => Promise<boolean>): Promise<void> {
    if (!this.current.startsWith(`${this.target}${path.sep}`) && this.current !== this.target) throw new Error('retention_runtime_path_invalid');
    if (path.dirname(this.target) !== root || !await existingDirectory(root)) throw new Error('retention_runtime_root_invalid');
    const stat = await fs.lstat(this.target);
    if (stat.dev !== this.dev || stat.ino !== this.ino || !await eligible()) throw new Error('retention_runtime_identity_changed');
    let directory = this.target;
    if (!await existingDirectory(directory)) throw new Error('retention_runtime_missing');
    for (const component of path.relative(this.target, this.current).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, component);
      if (!await existingDirectory(directory)) throw new Error('retention_runtime_missing');
    }
  }
  /** Each descend, unlink, rmdir or final removal costs one `available` inspection; bytes accrue to `budget`. */
  async resume(root: string, eligible: () => Promise<boolean>, budget: SweepBudget, available: () => boolean): Promise<boolean> {
    for (;;) {
      // Identity is checked once per opened directory, then the directory's entries are removed as one batch.
      await this.validate(root, eligible);
      const directory = await fs.opendir(this.current);
      let child: string | undefined, removedAny = false;
      try {
        for (let entry = await directory.read(); entry !== null; entry = await directory.read()) {
          if (this.current === this.target && entry.name === 'released') continue;
          if (!available()) return false;
          const file = path.join(this.current, entry.name), stat = await fs.lstat(file);
          if (stat.isDirectory() && !stat.isSymbolicLink()) { child = file; break; }
          await removeEntry(fs.unlink, file, stat.isSymbolicLink()); removedAny = true;
          runtimeReclaimedBytes.set(budget, (runtimeReclaimedBytes.get(budget) ?? 0) + stat.size);
        }
      } finally { await directory.close(); }
      if (child !== undefined) { this.current = child; continue; }
      // Removing entries while reading can hide others, so only an untouched read proves the directory empty.
      if (removedAny) continue;
      if (!available()) return false;
      if (this.current !== this.target) { await removeEntry(fs.rmdir, this.current, false); this.current = path.dirname(this.current); continue; }
      await this.validate(root, eligible);
      // Reuse the existing finalization semantics, but cap verification to the
      // token and its marker. Unexpected descendants refuse recursive removal.
      const bytes = await removeOwnedPath(root, this.target, budget.now, 2);
      budget.removed(bytes); return true;
    }
  }
}
