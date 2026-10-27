import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Fold a configured path into its on-disk spelling once, at the boundary that
 * owns it, so every consumer derives the same identity and retention's
 * `realpath(root) === root` check holds. A Windows name alias (an 8.3 short
 * name or a letter-case variant) is not a link. A component that lstat reports
 * as a link (a symbolic link, or a junction to a drive-letter path) is never
 * followed: such a path keeps its configured spelling, and the link checks
 * downstream reject it. Volume mount points (junctions to
 * `\??\Volume{GUID}\`), subst drives and mapped network drives look like plain
 * directories or roots to lstat, so `realpathSync.native` resolves them here,
 * once; later sweeps still compare each root with its real path. A missing
 * tail keeps its spelling; any other lookup failure throws.
 */
export function foldNameAliases(configured: string): string {
  const resolved = path.resolve(configured);
  const missing: string[] = [];
  let existing = resolved;
  for (;;) {
    try { lstatSync(existing); break; }
    catch (error) {
      const parent = path.dirname(existing);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let ancestor = path.parse(existing).root;
  for (const component of existing.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    if (lstatSync(ancestor).isSymbolicLink()) return resolved;
  }
  return path.join(realpathSync.native(existing), ...missing);
}
