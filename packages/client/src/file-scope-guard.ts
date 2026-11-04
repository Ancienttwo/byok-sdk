import { createHash } from 'node:crypto';
import { constants as fsConstants, realpath as realpathCallback } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  win32FileScopePath,
  type ToolAuthorizationHomeAccess, type ToolAuthorizationLane, type ToolFileAccess, type ToolFileScope,
} from './tool-authorization';
import {
  FILE_SCOPE_GUARD_CODES, FILE_SCOPE_GUARD_REASONS,
  type FileScopeGuardCode, type FileScopeGuardReason,
} from './file-scope-types';
export {
  FILE_SCOPE_GUARD_CODES, FILE_SCOPE_GUARD_REASONS,
  type FileScopeGuardCode, type FileScopeGuardReason,
} from './file-scope-types';

/**
 * The internal path guard of the explicit file-scope policy (#1061 slice 2,
 * D14) on darwin, linux and win32. It deliberately uses only Node built-ins:
 * `lstat`, `realpath.native`, `stat` dev+ino identity and `open` with
 * `O_NOFOLLOW`. There is no native dependency, no descriptor-relative/openat
 * helper and no /proc/self/fd use. On win32 `O_NOFOLLOW` is undefined, so an
 * open follows a final symlink; the post-open fstat identity check still
 * refuses it, and a scoped write opens without `O_TRUNC` (or with
 * `O_CREAT | O_EXCL`) and truncates only after that check.
 *
 * This module is not a file-isolation boundary and does not sandbox
 * bash/shell, MCP servers, user extensions or subagents. The six SDK-owned
 * scoped file tools (read/write/edit/find/grep/ls) call the target guard
 * immediately before IO, and the Pi host revalidates the serialized roots
 * before creating a session; the scoped tools shadow the native Pi tools of
 * the same name rather than leaving an unscoped path tool as a bypass. The
 * check-then-open path is still not race-free against same-UID processes.
 *
 * On win32 (#1423) a target is checked in a fixed order before the shared
 * checks: the win32 path syntax ({@link win32FileScopePath}), an lstat of every
 * existing segment from the drive root (a symlink, junction or AppExecLink is
 * `symlink`), then `realpath.native` of the deepest existing prefix, which
 * expands 8.3 short names and returns the on-disk case. Every shared check then
 * runs on that canonical path with byte comparison. A volume mount point
 * presents as a directory and canonicalizes onto its own volume, so it is
 * `outside_scope`, or `cross_device` by dev when that volume has no letter.
 * The Windows evidence is #1423 (PR-2a, run 41808217164).
 */

/** A filesystem identity captured once and rechecked before use. */
export interface FileScopeIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The platform-neutral stat view this guard reasons about. */
export interface FileScopeStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

/** The one opened-file view the O_NOFOLLOW check needs. */
export interface FileScopeOpenFile {
  stat(): Promise<FileScopeStat>;
  close(): Promise<void>;
}

/**
 * IO seam. Production always uses {@link nodeFileScopeIo}; tests inject a
 * wrapper only to simulate an unreachable mount (cross-device) that cannot be
 * mounted unprivileged in a unit test.
 */
export interface FileScopeIo {
  lstat(filePath: string): Promise<FileScopeStat>;
  stat(filePath: string): Promise<FileScopeStat>;
  realpath(filePath: string): Promise<string>;
  open(filePath: string, flags: number): Promise<FileScopeOpenFile>;
}

/** One validated root: `path` is canonical, `lexicalPath` is what the Host configured. */
export interface FileScopeRootGrant {
  readonly id: string;
  readonly path: string;
  readonly lexicalPath: string;
  readonly identity: FileScopeIdentity;
  readonly access: ToolFileAccess;
}

/** The immutable grant an admitted offer hands to the scoped tools. */
export interface FileScopeGrant {
  readonly mode: 'home' | 'workspaces';
  /** The canonical Agent home; never absent. Read+write for a writer, read-only for a memory reader. */
  readonly home: FileScopeRootGrant;
  /**
   * A memory reader's own run directory (`<home>/.byok/runs/<name>`, the
   * reader lease's cwd), read+write. Present only for a memory reader; it is
   * the one path under `.byok` that is not internal.
   */
  readonly run?: FileScopeRootGrant;
  /** Explicit workspace roots only; home and run are carried separately. */
  readonly roots: readonly FileScopeRootGrant[];
  /** Stable digest over the canonical grant; audit/log only, never a wire value. */
  readonly digest: string;
}

/**
 * A typed file-scope failure. Root problems are `file_scope_unavailable`
 * (authority could not be established), target violations are
 * `file_scope_denied`, and unknown platforms are `file_scope_unsupported`.
 * Messages name the root id, never a raw path.
 */
export class FileScopeGuardError extends Error {
  readonly code: FileScopeGuardCode;
  readonly reason: FileScopeGuardReason;
  readonly rootId?: string;
  readonly access?: ToolFileAccess;

  constructor(
    code: FileScopeGuardCode,
    reason: FileScopeGuardReason,
    options: { readonly rootId?: string; readonly access?: ToolFileAccess; readonly cause?: unknown } = {},
  ) {
    super(`file scope ${reason}${options.rootId === undefined ? '' : ` for root ${JSON.stringify(options.rootId)}`}`, { cause: options.cause });
    this.name = 'FileScopeGuardError';
    this.code = code;
    this.reason = reason;
    if (options.rootId !== undefined) this.rootId = options.rootId;
    if (options.access !== undefined) this.access = options.access;
    Object.freeze(this);
  }
}

function isErrno(error: unknown, ...codes: readonly string[]): boolean {
  return typeof error === 'object' && error !== null
    && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}

function statOf(value: import('node:fs').BigIntStats): FileScopeStat {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    nlink: value.nlink,
    kind: value.isSymbolicLink() ? 'symlink'
      : value.isDirectory() ? 'directory'
        : value.isFile() ? 'file' : 'other',
  });
}

const realpathNative = promisify(realpathCallback.native) as (filePath: string) => Promise<string>;

/** The one production {@link FileScopeIo}. */
export const nodeFileScopeIo: FileScopeIo = Object.freeze({
  lstat: async (filePath: string) => statOf(await lstat(filePath, { bigint: true })),
  stat: async (filePath: string) => statOf(await stat(filePath, { bigint: true })),
  realpath: (filePath: string) => realpathNative(filePath),
  open: async (filePath: string, flags: number) => {
    const handle = await open(filePath, flags);
    return Object.freeze({
      stat: async () => statOf(await handle.stat({ bigint: true })),
      close: () => handle.close(),
    });
  },
});

// Both sides are normalized absolute paths, so containment is a byte prefix
// test. `path.relative` would case-fold on win32, where the canonical paths
// already carry the on-disk case.
function relativeInside(root: string, candidate: string): string | undefined {
  if (candidate === root) return '';
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  return relativeInside(root, candidate) !== undefined;
}

function assertPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new FileScopeGuardError('file_scope_unsupported', 'unsupported_platform');
  }
}

function assertPathSyntax(value: unknown, code: FileScopeGuardCode, platform: NodeJS.Platform, rootId?: string): string {
  const refuse = () => new FileScopeGuardError(code, 'path_syntax', { ...(rootId === undefined ? {} : { rootId }) });
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\u0000\r\n]/u.test(value)) throw refuse();
  if (value.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')) throw refuse();
  if (platform === 'win32') {
    const resolved = win32FileScopePath(value);
    if (resolved === undefined) throw refuse();
    return resolved;
  }
  if (!path.isAbsolute(value)) throw refuse();
  return path.resolve(value);
}

function ioFailure(reason: FileScopeGuardReason, error: unknown, rootId?: string, access?: ToolFileAccess): FileScopeGuardError {
  return new FileScopeGuardError('file_scope_unavailable', reason, {
    ...(rootId === undefined ? {} : { rootId }),
    ...(access === undefined ? {} : { access }),
    cause: error,
  });
}

async function resolveRoot(
  root: { readonly id: string; readonly path: string; readonly access: ToolFileAccess },
  io: FileScopeIo,
  platform: NodeJS.Platform,
  expected?: FileScopeIdentity,
): Promise<FileScopeRootGrant> {
  const lexicalPath = assertPathSyntax(root.path, 'file_scope_unavailable', platform, root.id);
  const fail = (reason: FileScopeGuardReason, cause?: unknown) =>
    new FileScopeGuardError('file_scope_unavailable', reason, { rootId: root.id, access: root.access, ...(cause === undefined ? {} : { cause }) });
  let lexical;
  try {
    lexical = await io.lstat(lexicalPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) throw fail('root_missing', error);
    throw ioFailure('io_error', error, root.id, root.access);
  }
  if (lexical.kind === 'symlink') throw fail('symlink');
  if (lexical.kind !== 'directory') throw fail('not_directory');
  let canonical: string;
  let canonicalParent: string;
  try {
    canonical = await io.realpath(lexicalPath);
    canonicalParent = await io.realpath(path.dirname(lexicalPath));
  } catch (error) {
    throw ioFailure('io_error', error, root.id, root.access);
  }
  // A root is the final component of its canonical parent. Anything else means
  // the path was replaced or resolved through a component the guard did not
  // see as a real directory. On win32 the final name may be an 8.3 alias or
  // differ in case, so only the parent is compared; a volume mount point
  // canonicalizes to another volume's root and still fails.
  const childOfParent = platform === 'win32'
    ? path.win32.dirname(canonical) === canonicalParent && canonical !== canonicalParent
    : canonical === path.join(canonicalParent, path.basename(lexicalPath));
  if (!childOfParent) throw fail('root_identity_changed');
  let canonicalStat;
  try {
    canonicalStat = await io.stat(canonical);
  } catch (error) {
    throw ioFailure('io_error', error, root.id, root.access);
  }
  if (canonicalStat.kind !== 'directory') throw fail('not_directory');
  if (canonicalStat.dev !== lexical.dev || canonicalStat.ino !== lexical.ino) throw fail('root_identity_changed');
  if (expected !== undefined && (canonicalStat.dev !== expected.dev || canonicalStat.ino !== expected.ino)) {
    throw fail('root_identity_changed');
  }
  return Object.freeze({
    id: root.id,
    path: canonical,
    lexicalPath,
    identity: Object.freeze({ dev: canonicalStat.dev, ino: canonicalStat.ino }),
    access: root.access,
  });
}

/**
 * The home access of this attempt. A writer owns the home read+write. A
 * memory reader reads the home and writes only its run directory: the cwd of
 * its reader lease, which on resume is the run directory the session handoff
 * recorded, so it is never derived from the task id.
 */
export type FileScopeAttempt =
  | { readonly homeAccess: 'writer' }
  | { readonly homeAccess: 'memory-reader'; readonly cwd: string };

export interface ResolveFileScopeGrantInput {
  readonly fileScope: ToolFileScope;
  /** The canonical Agent home and the lease identity captured for this offer. */
  readonly home: { readonly path: string; readonly identity: FileScopeIdentity };
  readonly attempt: FileScopeAttempt;
  readonly platform?: NodeJS.Platform;
  readonly io?: FileScopeIo;
}

function digestGrant(
  mode: 'home' | 'workspaces',
  home: FileScopeRootGrant,
  run: FileScopeRootGrant | undefined,
  roots: readonly FileScopeRootGrant[],
): string {
  const rootJson = (root: FileScopeRootGrant) => ({
    id: root.id,
    path: root.path,
    lexicalPath: root.lexicalPath,
    access: root.access,
    dev: root.identity.dev.toString(),
    ino: root.identity.ino.toString(),
  });
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    mode,
    home: rootJson(home),
    ...(run === undefined ? {} : { run: rootJson(run) }),
    roots: roots.map(rootJson),
  })).digest('hex');
}

/** A stable digest of the configured policy only; usable before roots resolve or in a denial audit. */
export function fileScopePolicyDigest(fileScope: ToolFileScope): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    mode: fileScope.mode,
    roots: (fileScope.roots ?? []).map((root) => ({ id: root.id, path: root.path, access: root.access })),
  })).digest('hex');
}

/**
 * Verify every configured root exists, is a real directory (not a symlink),
 * canonicalizes under its canonical parent and still has the expected identity.
 * The Agent home identity comes from the lease, never from cwd text; a memory
 * reader's run root is resolved by the same rules.
 */
export async function resolveFileScopeGrant(input: ResolveFileScopeGrantInput): Promise<FileScopeGrant> {
  const platform = input.platform ?? process.platform;
  assertPlatform(platform);
  const io = input.io ?? nodeFileScopeIo;
  const { attempt } = input;
  const home = await resolveRoot(
    { id: 'home', path: input.home.path, access: attempt.homeAccess === 'memory-reader' ? 'read' : 'write' },
    io,
    platform,
    input.home.identity,
  );
  const run = attempt.homeAccess === 'memory-reader'
    ? await resolveRoot({ id: 'run', path: attempt.cwd, access: 'write' }, io, platform)
    : undefined;
  const roots: FileScopeRootGrant[] = [];
  for (const root of input.fileScope.roots ?? []) {
    roots.push(await resolveRoot(root, io, platform));
  }
  const frozenRoots = Object.freeze(roots);
  return Object.freeze({
    mode: input.fileScope.mode,
    home,
    ...(run === undefined ? {} : { run }),
    roots: frozenRoots,
    digest: digestGrant(input.fileScope.mode, home, run, frozenRoots),
  });
}

/**
 * What a checked target may be:
 * - `file` (default): one regular file, the read/write/edit contract;
 * - `directory`: one real directory, used before readdir;
 * - `entry`: an existing name of either kind, used while discovering paths.
 *   It still rejects symlinks, hard-linked files and outside paths but does not
 *   open or read file content, so it makes no content claim.
 */
export type FileScopeTargetKind = 'file' | 'directory' | 'entry';

/** One checked target: canonical path, matched root and whether it already exists. */
export interface FileScopeTargetGrant {
  readonly path: string;
  readonly root: FileScopeRootGrant;
  readonly access: ToolFileAccess;
  readonly exists: boolean;
  /** Present only when the target exists. */
  readonly kind?: 'file' | 'directory';
  readonly identity?: FileScopeIdentity;
}

export interface ResolveFileScopeTargetInput {
  readonly grant: FileScopeGrant;
  /** The model/runtime-supplied path; the caller must never trust it. */
  readonly path: string;
  readonly access: ToolFileAccess;
  /** The runtime's current working directory; a relative path resolves against it. */
  readonly cwd: string;
  /** Default `file`; `directory`/`entry` are for discovery tools only. */
  readonly kind?: FileScopeTargetKind;
  readonly platform?: NodeJS.Platform;
  readonly io?: FileScopeIo;
  /** Overrides `os.homedir()` for a leading `~`; tests use a fixture home. */
  readonly osHome?: string;
}

function expandHome(value: string, osHome: string): string {
  if (value === '~') return osHome;
  if (value.startsWith('~/')) return path.join(osHome, value.slice(2));
  return value;
}

/**
 * Win32 steps 4 and 5: lstat every existing segment from the drive root until
 * the first ENOENT, refusing any symlink (junctions and AppExecLinks report as
 * one), then canonicalize the deepest existing prefix with `realpath.native`
 * and append the missing segments. `resolved` already passed
 * {@link win32FileScopePath}.
 */
async function win32CanonicalPath(
  resolved: string,
  io: FileScopeIo,
  fail: (reason: FileScopeGuardReason) => FileScopeGuardError,
): Promise<string> {
  const segments = resolved.slice(3).split('\\').filter((segment) => segment !== '');
  let existing = resolved.slice(0, 3);
  let existingCount = 0;
  for (const segment of segments) {
    const next = path.win32.join(existing, segment);
    let value: FileScopeStat;
    try {
      value = await io.lstat(next);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) break;
      if (isErrno(error, 'ENOTDIR')) throw fail('not_regular_file');
      throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { cause: error });
    }
    if (value.kind === 'symlink') throw fail('symlink');
    existing = next;
    existingCount += 1;
  }
  let canonical: string;
  try {
    canonical = await io.realpath(existing);
  } catch (error) {
    throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { cause: error });
  }
  return path.win32.join(canonical, ...segments.slice(existingCount));
}

function matchRoot(roots: readonly FileScopeRootGrant[], absolute: string): { root: FileScopeRootGrant; path: string } | undefined {
  let best: { root: FileScopeRootGrant; path: string } | undefined;
  for (const root of roots) {
    const direct = relativeInside(root.path, absolute);
    const lexical = direct === undefined ? relativeInside(root.lexicalPath, absolute) : undefined;
    const mapped = direct !== undefined ? path.join(root.path, direct)
      : lexical === undefined ? undefined : path.join(root.path, lexical);
    if (mapped === undefined) continue;
    if (best === undefined || root.path.length > best.root.path.length) best = { root, path: mapped };
  }
  return best;
}

// ASCII-only case folding on every platform: a case-insensitive volume (the
// macOS APFS default) opens `.BYOK` as `.byok`, and no platform branch decides it.
const INTERNAL_SEGMENT = /^\.[bB][yY][oO][kK]$/u;

function insideRoot(root: FileScopeRootGrant, absolute: string): boolean {
  return relativeInside(root.path, absolute) !== undefined || relativeInside(root.lexicalPath, absolute) !== undefined;
}

/**
 * `.byok` under any root is internal. The one exception is a path inside a
 * memory reader's `run` root: `run` then owns it, and only `run`'s own `.byok`
 * child is internal. Callers pass `run` only where `run` is the root that will
 * handle the path, so an alias that reaches the run directory through another
 * root stays internal.
 */
function internalPath(roots: readonly FileScopeRootGrant[], absolute: string, run: FileScopeRootGrant | undefined): boolean {
  const owners = run !== undefined && insideRoot(run, absolute) ? [run] : roots;
  for (const root of owners) {
    for (const base of [root.path, root.lexicalPath]) {
      const relative = relativeInside(base, absolute);
      if (relative !== undefined && INTERNAL_SEGMENT.test(relative.split(path.sep)[0] ?? '')) return true;
    }
  }
  return false;
}

/**
 * Check one target against a resolved grant. The scoped file tools call this
 * primitive immediately before every fs operation; discovery tools pass
 * `kind: 'directory'` before readdir and `kind: 'entry'` per discovered name.
 *
 * The check is canonical check-then-open for regular files: every existing
 * segment is lstat'ed for symlinks, the nearest existing ancestor is
 * canonicalized and contained, dev+ino and nlink are checked, and an existing
 * regular file is opened with O_NOFOLLOW and rechecked with fstat. Entries are
 * checked the same way but are not opened; regular files still reject hard
 * links, while directories are not hard-link filtered. It is not race-free,
 * and it is not an OS sandbox.
 */
export async function resolveFileScopeTarget(input: ResolveFileScopeTargetInput): Promise<FileScopeTargetGrant> {
  const platform = input.platform ?? process.platform;
  assertPlatform(platform);
  const io = input.io ?? nodeFileScopeIo;
  const osHome = input.osHome ?? homedir();
  const fail = (reason: FileScopeGuardReason, rootId?: string, access?: ToolFileAccess) =>
    new FileScopeGuardError('file_scope_denied', reason, {
      ...(rootId === undefined ? {} : { rootId }),
      ...(access === undefined ? {} : { access }),
    });

  if (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > 4_096 || /[\u0000\r\n]/u.test(input.path)) {
    throw fail('path_syntax');
  }
  if (input.cwd.length === 0 || /[\u0000\r\n]/u.test(input.cwd)) throw fail('path_syntax');
  const run = input.grant.run;
  const allRoots = Object.freeze([input.grant.home, ...(run === undefined ? [] : [run]), ...input.grant.roots]);
  let absolute: string;
  let lexical: string | undefined;
  let runOwnsCanonical = true;
  let relativeCwd: string | undefined;
  if (platform === 'win32') {
    const cwd = win32FileScopePath(input.cwd);
    if (cwd === undefined) throw fail('path_syntax');
    const raw = input.path.replaceAll('/', '\\');
    const expanded = raw === '~' ? osHome : raw.startsWith('~\\') ? path.win32.join(osHome, raw.slice(2)) : raw;
    const resolved = win32FileScopePath(expanded, cwd);
    if (resolved === undefined) throw fail('path_syntax');
    // A segment denial happens before root matching; the root the path names
    // lexically labels it, as the shared walk does on darwin/linux.
    const owner = matchRoot(allRoots, resolved)?.root;
    absolute = await win32CanonicalPath(resolved, io, (reason) => fail(reason, owner?.id, owner === undefined ? undefined : input.access));
    lexical = resolved;
    // `run` owns the canonical path only when the path names `run` exactly,
    // as on darwin/linux. Any other spelling that canonicalizes into the run
    // directory (a case variant, an 8.3 name, a path through home) is an alias
    // of home's `.byok` and stays internal.
    runOwnsCanonical = owner === run;
    if (!/^[A-Za-z]:\\/u.test(expanded)) relativeCwd = await win32CanonicalPath(cwd, io, fail);
  } else {
    if (!path.isAbsolute(input.cwd)) throw fail('path_syntax');
    const expanded = expandHome(input.path, osHome);
    absolute = path.resolve(input.cwd, expanded);
    if (!path.isAbsolute(expanded)) relativeCwd = path.resolve(input.cwd);
  }
  // Before matching, a path inside `run` is handed to `run`: matchRoot picks
  // the longest root, and `run` is nested in home. On win32 the lexical path is
  // checked too, so `.BYOK\runs\<run>` stays internal although it
  // canonicalizes into the run root, as it does on darwin/linux.
  if (internalPath(allRoots, absolute, runOwnsCanonical ? run : undefined)
    || (lexical !== undefined && internalPath(allRoots, lexical, run))) {
    throw fail('internal_path');
  }

  if (relativeCwd !== undefined && matchRoot(allRoots, relativeCwd) === undefined) throw fail('cwd_outside_scope');
  const matched = matchRoot(allRoots, absolute);
  if (matched === undefined) throw fail('outside_scope');
  const { root } = matched;
  if (input.access === 'write' && root.access !== 'write') throw fail('read_only', root.id, input.access);

  let rootStat;
  try {
    rootStat = await io.stat(root.path);
  } catch (error) {
    throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { rootId: root.id, access: root.access, cause: error });
  }
  if (rootStat.dev !== root.identity.dev || rootStat.ino !== root.identity.ino) {
    throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: root.id, access: root.access });
  }

  const kind = input.kind ?? 'file';
  const relative = path.relative(root.path, matched.path);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = root.path;
  let existingCount = 0;
  let lastStat: FileScopeStat | undefined = rootStat;
  let targetStat: FileScopeStat | undefined = segments.length === 0 ? rootStat : undefined;
  for (const segment of segments) {
    current = path.join(current, segment);
    let currentStat: FileScopeStat;
    try {
      currentStat = await io.lstat(current);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) break;
      if (isErrno(error, 'ENOTDIR')) throw fail('not_regular_file', root.id, input.access);
      throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { rootId: root.id, access: root.access, cause: error });
    }
    if (currentStat.kind === 'symlink') throw fail('symlink', root.id, input.access);
    existingCount += 1;
    lastStat = currentStat;
    if (existingCount === segments.length) targetStat = currentStat;
  }

  const existingPath = existingCount === 0 ? root.path : path.join(root.path, ...segments.slice(0, existingCount));
  let canonicalExisting: string;
  try {
    canonicalExisting = await io.realpath(existingPath);
  } catch (error) {
    throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { rootId: root.id, access: root.access, cause: error });
  }
  if (!isWithin(root.path, canonicalExisting)) {
    throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: root.id, access: root.access });
  }
  const canonicalTarget = path.join(canonicalExisting, ...segments.slice(existingCount));
  // Aliases that only canonicalization reveals (case variants, short names) land here.
  if (internalPath(allRoots, canonicalTarget, root === run ? run : undefined)) throw fail('internal_path');
  const existingStat = targetStat ?? lastStat;
  if (existingStat !== undefined && existingStat.dev !== root.identity.dev) throw fail('cross_device', root.id, input.access);
  if (targetStat !== undefined) {
    if (kind === 'file' && targetStat.kind !== 'file') throw fail('not_regular_file', root.id, input.access);
    if (kind === 'directory' && targetStat.kind !== 'directory') throw fail('not_regular_file', root.id, input.access);
    if (kind === 'entry') {
      if (targetStat.kind !== 'file' && targetStat.kind !== 'directory') throw fail('not_regular_file', root.id, input.access);
      if (targetStat.kind === 'file' && targetStat.nlink > 1n) throw fail('hardlink', root.id, input.access);
    }
    if (kind === 'file') {
      if (targetStat.nlink > 1n) throw fail('hardlink', root.id, input.access);
      let opened: FileScopeOpenFile | undefined;
      try {
        opened = await io.open(canonicalTarget, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const openedStat = await opened.stat();
        if (openedStat.dev !== targetStat.dev || openedStat.ino !== targetStat.ino) {
          throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: root.id, access: root.access });
        }
        if (openedStat.kind !== 'file') throw fail('not_regular_file', root.id, input.access);
        if (openedStat.nlink > 1n) throw fail('hardlink', root.id, input.access);
        if (openedStat.dev !== root.identity.dev) throw fail('cross_device', root.id, input.access);
      } catch (error) {
        if (error instanceof FileScopeGuardError) throw error;
        if (isErrno(error, 'ELOOP')) throw fail('symlink', root.id, input.access);
        throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { rootId: root.id, access: root.access, cause: error });
      } finally {
        await opened?.close().catch(() => {});
      }
    }
  }

  return Object.freeze({
    path: canonicalTarget,
    root,
    access: input.access,
    exists: targetStat !== undefined,
    ...(targetStat === undefined ? {} : {
      kind: targetStat.kind === 'directory' ? 'directory' as const : 'file' as const,
      identity: Object.freeze({ dev: targetStat.dev, ino: targetStat.ino }),
    }),
  });
}

/** Local file-scope audit (D12): deny and policy adoption are recorded; allow never is. */
export interface FileScopeAudit {
  readonly taskId: string;
  readonly decision: 'deny' | 'policy-adoption';
  readonly lane: ToolAuthorizationLane;
  readonly homeAccess: ToolAuthorizationHomeAccess;
  readonly scope: {
    readonly source: 'host';
    readonly mode: 'home' | 'workspaces';
    readonly digest: string;
  };
  /** Adoption only: every root id the grant covers, home first, then run when present. */
  readonly rootIds?: readonly string[];
  /** Denial only: the root that failed, when one was identified. */
  readonly rootId?: string;
  /** Denial only: the requested access, when one was identified. */
  readonly access?: ToolFileAccess;
  /** Denial only: the typed failure code. */
  readonly code?: FileScopeGuardCode;
  /** Denial only: the typed failure reason. */
  readonly reason?: FileScopeGuardReason;
  /** Denial only: the native tool name; never a path or content. */
  readonly toolName?: string;
  /** Denial only: the runtime's own call id, when it supplied one. */
  readonly toolCallId?: string;
}
