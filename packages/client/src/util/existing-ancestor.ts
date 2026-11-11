import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ExistingAncestor {
  readonly canonical: string;
  readonly tail: readonly string[];
}

/**
 * Realpath of the deepest existing ancestor of `inputPath` plus the missing tail.
 * ENOENT and ENOTDIR move the walk up; any other error propagates. Returns
 * `undefined` when the walk reaches the filesystem root without an existing
 * path, so each caller throws its own error class.
 */
export async function resolveExistingAncestor(inputPath: string): Promise<ExistingAncestor | undefined> {
  let cursor = path.resolve(inputPath);
  const tail: string[] = [];
  for (;;) {
    try {
      return { canonical: await fs.realpath(cursor), tail };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return undefined;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
