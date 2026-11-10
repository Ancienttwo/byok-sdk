import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export class ConfiguredPathLinkError extends Error {
  readonly code = 'configured_path_untrusted_link';

  constructor(
    readonly configuredPath: string,
    readonly link: string,
    readonly reason: 'link_owner' | 'directory_owner' | 'directory_writable',
    detail: string,
  ) {
    super(`configured path ${configuredPath} has an untrusted symbolic link at ${link} (${reason}, ${detail}); point the setting at the physical directory, or make the link and the directory holding it owned by root or uid ${process.getuid!()} and not writable by others`);
    this.name = 'ConfiguredPathLinkError';
  }
}

/**
 * Fold a configured path into its on-disk spelling once at its owning boundary,
 * so every consumer derives the same identity and retention's realpath check
 * holds. On POSIX, follow a symbolic link only when it and its containing
 * directory belong to root or the process user, and that directory is not
 * group/other writable unless sticky. Reject any untrusted link.
 * On Windows, name aliases (8.3 short names and letter case) are folded, but
 * links keep their configured spelling for downstream link checks to reject.
 * Volume mount points, subst drives and mapped network drives look like plain
 * directories or roots to lstat, so realpathSync.native resolves them here.
 * A missing tail keeps its spelling; any other lookup failure throws.
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
    const link = lstatSync(ancestor);
    if (!link.isSymbolicLink()) continue;
    if (process.platform === 'win32') return resolved;
    const uid = process.getuid!();
    if (link.uid !== 0 && link.uid !== uid) {
      throw new ConfiguredPathLinkError(configured, ancestor, 'link_owner', `uid ${link.uid}`);
    }
    const directory = statSync(path.dirname(ancestor));
    if (directory.uid !== 0 && directory.uid !== uid) {
      throw new ConfiguredPathLinkError(configured, ancestor, 'directory_owner', `uid ${directory.uid}`);
    }
    if ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0) {
      throw new ConfiguredPathLinkError(configured, ancestor, 'directory_writable', `mode 0o${(directory.mode & 0o7777).toString(8)}`);
    }
  }
  return path.join(realpathSync.native(existing), ...missing);
}
