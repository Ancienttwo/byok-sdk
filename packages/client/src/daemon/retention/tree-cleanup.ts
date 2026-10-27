import { accountLeaves } from './runtime-accounting';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SweepBudget } from './registry';
import { existingDirectory, removeOwnedPath } from './usage';

/** Resumable deletion; the owning producer rechecks eligibility before each directory batch. */
export class TreeCleanup {
  private current: string;
  private constructor(readonly target: string, private readonly dev: number, private readonly ino: number, private readonly releasedMarker: boolean, private readonly mtime: Date, private readonly atime: Date) { this.current = target; }
  /** A token that disappears first needs no cleanup, as with the whole-tree removal path. */
  static async create(target: string, releasedMarker = false): Promise<TreeCleanup | undefined> {
    try {
      if (!await existingDirectory(target)) return undefined;
      const stat = await fs.lstat(target);
      return new TreeCleanup(target, stat.dev, stat.ino, releasedMarker, stat.mtime, stat.atime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async validate(root: string, eligible: () => Promise<boolean>): Promise<void> {
    if (!this.current.startsWith(`${this.target}${path.sep}`) && this.current !== this.target) throw new Error('retention_runtime_path_invalid');
    if (!this.target.startsWith(`${root}${path.sep}`) || !await existingDirectory(root)) throw new Error('retention_runtime_root_invalid');
    const stat = await fs.lstat(this.target);
    if (stat.dev !== this.dev || stat.ino !== this.ino || !await eligible()) throw new Error('retention_runtime_identity_changed');
    let directory = root;
    if (!await existingDirectory(directory)) throw new Error('retention_runtime_missing');
    for (const component of path.relative(root, this.current).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, component);
      if (!await existingDirectory(directory)) throw new Error('retention_runtime_missing');
    }
  }
  /** Each descend, unlink, rmdir or final removal costs one `available` inspection; bytes accrue to `budget`. */
  async resume(root: string, eligible: () => Promise<boolean>, budget: SweepBudget, available: () => boolean): Promise<boolean> {
    try {
      for (;;) {
        // Identity is checked once per opened directory, then the directory's entries are removed as one batch.
        await this.validate(root, eligible);
        const directory = await fs.opendir(this.current);
        let child: string | undefined, removedAny = false;
        try {
          for (let entry = await directory.read(); entry !== null; entry = await directory.read()) {
            if (this.releasedMarker && this.current === this.target && entry.name === 'released') continue;
            if (!available()) return false;
            const file = path.join(this.current, entry.name), stat = await fs.lstat(file);
            if (stat.isDirectory() && !stat.isSymbolicLink()) { child = file; break; }
            await fs.unlink(file); removedAny = true;
            accountLeaves(budget, stat.size);
          }
        } finally { await directory.close(); }
        if (child !== undefined) { this.current = child; continue; }
        // Removing entries while reading can hide others, so only an untouched read proves the directory empty.
        if (removedAny) continue;
        if (!available()) return false;
        if (this.current !== this.target) { await fs.rmdir(this.current); this.current = path.dirname(this.current); continue; }
        await this.validate(root, eligible);
        // Reuse the existing finalization semantics, but cap verification to the
        // target and, for runtimes, its marker. Unexpected descendants refuse recursive removal.
        const bytes = await removeOwnedPath(root, this.target, budget.now, this.releasedMarker ? 2 : 1);
        budget.removed(bytes); return true;
      }
    } finally {
      // Removing leaves changes directory mtime. Keep the original TTL authority
      // on disk so a new registry can continue an interrupted collection.
      if (!this.releasedMarker) {
        const stat = await fs.lstat(this.target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (stat !== undefined && stat.dev === this.dev && stat.ino === this.ino && await eligible()) {
          if (!await existingDirectory(root) || !await existingDirectory(this.target)) throw new Error('retention_runtime_missing');
          await fs.utimes(this.target, this.atime, this.mtime);
        }
      }
    }
  }
}
