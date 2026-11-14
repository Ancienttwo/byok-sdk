import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveExistingAncestor } from '../util/existing-ancestor.js';

/**
 * The store path rules of a service installation (#2011, #2102, #2106), in
 * one place: the precheck and a snapshot restore apply the same checks.
 *
 * - Containment ({@link within}) folds case on darwin and win32. It is used
 *   only to refuse, where folding makes a check stricter.
 * - Identity ({@link resolvesTo}) compares realpaths exactly. It allows a
 *   restore, so folding there would accept `a/` for `A/` on a
 *   case-sensitive volume.
 */

/** `snapshot.json` format: 2 records each entry's canonical path, and a restore writes there. SDK 0.42 wrote none. */
export const SNAPSHOT_FORMAT = 2;

/** One store in `snapshot.json`. */
export interface SnapshotEntry {
  readonly store: string;
  readonly path: string;
  /** Absent for a file store. */
  readonly kind?: 'directory';
  /** `path` with its links resolved when the snapshot was taken. */
  readonly canonical: string;
  /** Saved files by suffix (`''`, `-wal`, `-journal`; a directory's tree under `''`); empty when the store was absent. */
  readonly files: Readonly<Record<string, string>>;
}

export interface SnapshotRecord {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly entries: readonly SnapshotEntry[];
}

/**
 * `snapshot.json` parsed and checked once, or `undefined` for anything else,
 * such as a record SDK 0.42 wrote without `format` and `canonical`. `files`
 * must be a plain object naming exactly the copies a snapshot writes: a
 * directory entry's tree as `''` -> `<index>.d`, a file entry's files as
 * `''`, `-wal` or `-journal` -> `<index><suffix>`. `{}` is a store that was
 * absent; any other shape would make a restore delete a store.
 */
export function parseSnapshotRecord(text: string): SnapshotRecord | undefined {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  const { format, entries } = (record ?? {}) as { format?: unknown; entries?: unknown };
  const string = (value: unknown): value is string => typeof value === 'string';
  const isFiles = (files: unknown, index: number, directory: boolean): boolean => files !== null && typeof files === 'object' && Object.getPrototypeOf(files) === Object.prototype
    && Object.entries(files).every(([suffix, name]) => (directory ? suffix === '' : ['', '-wal', '-journal'].includes(suffix)) && name === `${index}${directory ? '.d' : suffix}`);
  const isEntry = (entry: Partial<Record<keyof SnapshotEntry, unknown>> | null, index: number): boolean => entry !== null && typeof entry === 'object'
    && string(entry.store) && string(entry.path) && string(entry.canonical) && (entry.kind === undefined || entry.kind === 'directory')
    && isFiles(entry.files, index, entry.kind === 'directory');
  return format === SNAPSHOT_FORMAT && Array.isArray(entries) && entries.every(isEntry) ? record as SnapshotRecord : undefined;
}

/** A refused store path: the installation error code and the text its message ends with, naming the path. */
export interface StorePathRefusal {
  readonly code: 'precheck_failed' | 'store_overlaps_service_state';
  readonly detail: string;
}

/**
 * Whether `child` is `parent` or lies under it, compared by path segment
 * (`current-old/x` is not under `current`) and, on darwin and win32, without
 * case. For refusals and plausibility checks only.
 */
export function within(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string): string => platform === 'darwin' || platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

/** `at` with the symbolic links of its deepest existing ancestor resolved and the missing rest appended, so an alias compares as its target. */
export async function canonical(at: string): Promise<string> {
  const found = await resolveExistingAncestor(at);
  return found === undefined ? path.resolve(at) : path.join(found.canonical, ...found.tail);
}

/**
 * The existing directory `at` and every directory a lookup of it passes
 * through up to `/`, along the path as given and along its real path: whoever
 * can rename an entry in one of them can replace `at` (#2028).
 */
export async function lookupDirectories(at: string): Promise<string[]> {
  const chain = (dir: string): string[] => path.dirname(dir) === dir ? [dir] : [dir, ...chain(path.dirname(dir))];
  return [...new Set([...chain(path.resolve(at)), ...chain(await fs.realpath(at))])];
}

/**
 * A directory store path without terminal separators and `.` components,
 * exposing its root to lstat. Links and interior `..` stay: resolving them
 * could change the target.
 */
export function directoryStorePath(input: string, platform: NodeJS.Platform): string {
  const root = path.parse(input).root;
  const separators = platform === 'win32' ? /[\\/]+$/u : /\/+$/u;
  let value = input;
  while (value.length > root.length) {
    const trimmed = value.replace(separators, '');
    if (trimmed.length < root.length) return root;
    if (path.basename(trimmed) !== '.') return trimmed;
    value = path.dirname(trimmed);
  }
  return value;
}

/**
 * Checks store paths as written and returns them canonical, or the first
 * refusal:
 * - a `..` segment (either separator on win32): after a link, `..` resolves
 *   through the link's target, while {@link canonical} folds it away (`.`
 *   cannot do that, #1350);
 * - two stores that are or contain each other, as written or resolved: one
 *   store's restore would change the other's tree, or the links it
 *   resolves through;
 * - a store that is, holds or lies in a `guarded` directory (the install
 *   root, a daemon store's `service/`), each taken both as its target and as
 *   the entry naming it, since a restore removes a link, not its target.
 */
export async function checkStorePaths(written: readonly string[], guarded: readonly string[], platform: NodeJS.Platform): Promise<{ canonical: string[] } | { refusal: StorePathRefusal }> {
  const dotted = written.find((at) => at.split(platform === 'win32' ? /[\\/]/u : '/').includes('..'));
  if (dotted !== undefined) return { refusal: { code: 'precheck_failed', detail: ` A store path must not contain .. segments; pass a normalized absolute path. (${dotted})` } };
  const paths = await Promise.all(written.map(canonical));
  for (const spelled of [written.map((at) => path.resolve(at)), paths]) {
    for (const [i, a] of spelled.entries()) {
      const j = spelled.findIndex((b, at) => at !== i && within(b, a, platform));
      if (j !== -1) return { refusal: { code: 'precheck_failed', detail: ` Two stores must not be or contain each other. (${written[i]}, ${written[j]})` } };
    }
  }
  const guards = (await Promise.all(guarded.map(async (at) => [await canonical(at), path.join(await canonical(path.dirname(at)), path.basename(at))]))).flat();
  const overlapping = paths.findIndex((a) => guards.some((b) => within(a, b, platform) || within(b, a, platform)));
  if (overlapping !== -1) return { refusal: { code: 'store_overlaps_service_state', detail: ` (${written[overlapping]})` } };
  return { canonical: paths };
}

/**
 * Checks a snapshot's entries before a restore changes any store:
 * {@link checkStorePaths}; that no directory store's root, as listed, is a
 * link; then that each listed path still resolves to the canonical path
 * recorded for it. A restore then writes only to the recorded paths. That
 * write is safe because (a) the listed path resolves exactly to the
 * recorded realpath now, so the target's existing ancestors are real
 * directories, and (b) no two recorded paths contain each other, so the tree
 * another entry's restore replaces holds neither this target nor an
 * ancestor of it. (a) says nothing about the listed path's own links, which
 * is why the root check is separate.
 */
export async function checkRestoreTargets(entries: ReadonlyArray<{ path: string; canonical: string; kind?: 'directory' }>, guarded: readonly string[], platform: NodeJS.Platform): Promise<StorePathRefusal | undefined> {
  return returningRefusal(() => checkRestoreEntries(entries, guarded, platform));
}

async function checkRestoreEntries(entries: ReadonlyArray<{ path: string; canonical: string; kind?: 'directory' }>, guarded: readonly string[], platform: NodeJS.Platform): Promise<StorePathRefusal | undefined> {
  const checked = await checkStorePaths(entries.map((entry) => entry.path), guarded, platform);
  if ('refusal' in checked) return checked.refusal;
  // A directory store's root must not be a link, a junction included: its
  // realpath can still equal the recorded one through a link swapped in
  // above it, so the identity check below does not prove this.
  for (const entry of entries) {
    const root = entry.kind === 'directory' ? directoryStorePath(entry.path, platform) : undefined;
    if (root !== undefined && (await lstatOrUndefined(root))?.isSymbolicLink()) return { code: 'precheck_failed', detail: ` A directory store's root must not be a link. (${entry.path})` };
  }
  for (const entry of entries) {
    if (!(await resolvesTo(entry.path, entry.canonical))) return { code: 'precheck_failed', detail: ` A store path no longer resolves as it did at the snapshot. (${entry.path})` };
  }
  return undefined;
}

/**
 * Whether `listed` resolves now to `recorded`. The existing part must match
 * exactly. A missing segment keeps the listed spelling, so it may differ
 * from the recorded one in case only while the recorded spelling is missing
 * too, as on a case-insensitive volume after the store was removed.
 */
async function resolvesTo(listed: string, recorded: string): Promise<boolean> {
  const found = await resolveExistingAncestor(listed);
  if (found === undefined) return false;
  if (found.tail.length === 0) return found.canonical === recorded;
  // A segment is missing only when nothing is there: a dangling link, or an
  // existing part that is not a directory, is not a missing tail.
  if (!(await lstatOrUndefined(found.canonical))?.isDirectory() || await lstatOrUndefined(path.join(found.canonical, found.tail[0]!)) !== undefined) return false;
  const prefix = found.canonical.endsWith(path.sep) ? found.canonical : `${found.canonical}${path.sep}`;
  if (!recorded.startsWith(prefix)) return false;
  const rest = recorded.slice(prefix.length).split(path.sep);
  if (rest.length !== found.tail.length) return false;
  for (const [index, part] of found.tail.entries()) {
    if (rest[index] === part) continue;
    if (rest[index]!.toLowerCase() !== part.toLowerCase() || await lstatOrUndefined(path.join(found.canonical, ...rest.slice(0, index + 1))) !== undefined) return false;
  }
  return true;
}

/** Creates `dir` and its missing ancestors as real directories, never following a link; an existing entry that is not a directory is refused. */
export async function mkdirReal(dir: string): Promise<StorePathRefusal | undefined> {
  return returningRefusal(() => mkdirRealDirs(dir));
}

async function mkdirRealDirs(dir: string): Promise<StorePathRefusal | undefined> {
  const stat = await lstatOrUndefined(dir);
  if (stat !== undefined) return stat.isDirectory() ? undefined : { code: 'precheck_failed', detail: ` A store's parent is not a directory. (${dir})` };
  const refused = path.dirname(dir) === dir ? undefined : await mkdirRealDirs(path.dirname(dir));
  if (refused === undefined) await fs.mkdir(dir);
  return refused;
}

/** A refusal raised below a checking function, which returns it: nothing untyped leaves this module from a path lookup. */
class Refused extends Error {
  constructor(readonly refusal: StorePathRefusal) {
    super(refusal.detail);
  }
}

async function returningRefusal<T>(check: () => Promise<T>): Promise<T | StorePathRefusal> {
  try {
    return await check();
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

/** `lstat`, or `undefined` when nothing is there. A component that is not a directory (ENOTDIR) or a link loop (ELOOP) is a refused path. */
async function lstatOrUndefined(at: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.lstat(at);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ENOTDIR' || code === 'ELOOP') throw new Refused({ code: 'precheck_failed', detail: ` A store path runs through a file or a link loop. (${at})` });
    throw error;
  }
}
