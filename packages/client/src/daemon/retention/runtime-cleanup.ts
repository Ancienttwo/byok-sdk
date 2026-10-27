import { runtimeReclaimedBytes } from './runtime-accounting';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SweepBudget } from './registry';
import { existingDirectory, removeOwnedPath } from './usage';

/** Only released, expired scratch tokens may use this resumable leaf collector. */
export class RuntimeCleanup {
  private current: string;
  private constructor(readonly target: string, private readonly dev: number, private readonly ino: number) { this.current = target; }
  static async create(target: string): Promise<RuntimeCleanup> {
    if (!await existingDirectory(target)) throw new Error('retention_runtime_missing');
    const stat = await fs.lstat(target);
    return new RuntimeCleanup(target, stat.dev, stat.ino);
  }
  async resume(root: string, eligible: () => Promise<boolean>, budget: SweepBudget): Promise<boolean> {
    const validate = async (): Promise<void> => {
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
    };
    while (budget.available()) {
      await validate();
      // No directory handle survives a pass; reopening also avoids deletion invalidating a cursor.
      const directory = await fs.opendir(this.current);
      let entry;
      try {
        entry = await directory.read();
        if (this.current === this.target && entry?.name === 'released') entry = await directory.read();
      } finally { await directory.close(); }
      if (entry !== null) {
        const file = path.join(this.current, entry.name), stat = await fs.lstat(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) { this.current = file; continue; }
        await fs.unlink(file); runtimeReclaimedBytes.set(budget, (runtimeReclaimedBytes.get(budget) ?? 0) + stat.size);
      } else if (this.current !== this.target) {
        await fs.rmdir(this.current); this.current = path.dirname(this.current);
      } else {
        // Reuse the existing finalization semantics, but cap verification to the
        // token and its marker. Unexpected descendants refuse recursive removal.
        const bytes = await removeOwnedPath(root, this.target, budget.now, 2);
        budget.removed(bytes); return true;
      }
    }
    return false;
  }
}
