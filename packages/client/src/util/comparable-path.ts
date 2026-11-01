import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Real path of the nearest existing ancestor plus the rest, case-folded on
 * darwin and win32, so a symlink or a case variant cannot hide a user's
 * runtime home (`~/.hermes`, `~/.dsh`) behind an SDK root option, even below
 * a directory not yet created. For comparison only, never for opening.
 */
export function comparablePath(value: string): string {
  let existing = path.resolve(value);
  const rest: string[] = [];
  for (;;) {
    try {
      existing = realpathSync.native(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...rest);
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
