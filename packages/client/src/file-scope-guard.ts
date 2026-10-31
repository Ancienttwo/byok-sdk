import { createHash } from 'node:crypto';
import { constants as fsConstants, realpath as realpathCallback } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ToolAuthorizationHomeAccess, ToolAuthorizationLane, ToolFileAccess, ToolFileScope } from './tool-authorization';

/**
 * The internal POSIX path guard of the explicit file-scope policy (#1061
 * slice 2, D14). It deliberately uses only Node built-ins: `lstat`,
 * `realpath.native`, `stat` dev+ino identity and `open` with `O_NOFOLLOW`.
 * There is no native dependency, no descriptor-relative/openat helper and no
 * /proc/self/fd use.
 *
 * This module is not a file-isolation boundary and does not replace Pi's
 * native read/write/edit/bash tools. Slice 2 uses it to revalidate configured
 * roots after claim and before a runtime starts; the scoped file tools that
 * would call the target guard ship in a later slice. Shell, MCP servers,
 * extensions and runtime-native file tools remain outside it, and the
 * check-then-open path is not race-free against same-UID processes.
 *
 * Windows is refused outright as `file_scope_unsupported`: without native
 * code this guard cannot classify 8.3 short names, junctions/reparse points,
 * case folding or alternate data streams, and guessing is worse than failing
 * closed.
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

/** The immutable grant an admitted offer would hand to scoped tools in a later slice. */
export interface FileScopeGrant {
  readonly mode: 'home' | 'workspaces';
  /** The canonical Agent home; always read+write and never absent. */
  readonly home: FileScopeRootGrant;
  /** Explicit workspace roots only; home is carried separately. */
  readonly roots: readonly FileScopeRootGrant[];
  /** Stable digest over the canonical grant; audit/log only, never a wire value. */
  readonly digest: string;
}

/** The closed reasons this guard reports. */
export type FileScopeGuardReason =
  | 'outside_scope'
  | 'read_only'
  | 'symlink'
  | 'hardlink'
  | 'not_regular_file'
  | 'cross_device'
  | 'path_syntax'
  | 'cwd_outside_scope'
  | 'internal_path'
  | 'root_identity_changed'
  | 'unsupported_platform'
  | 'root_missing'
  | 'not_directory'
  | 'io_error';

export type FileScopeGuardCode = 'file_scope_denied' | 'file_scope_unavailable' | 'file_scope_unsupported';

/**
 * A typed file-scope failure. Root problems are `file_scope_unavailable`
 * (authority could not be established), target violations are
 * `file_scope_denied`, and Windows/unknown platforms are
 * `file_scope_unsupported`. Messages name the root id, never a raw path.
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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativeInside(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative;
}

function assertPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new FileScopeGuardError('file_scope_unsupported', 'unsupported_platform');
  }
}

function assertPathSyntax(value: unknown, code: FileScopeGuardCode, rootId?: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\u0000\r\n]/u.test(value)) {
    throw new FileScopeGuardError(code, 'path_syntax', { ...(rootId === undefined ? {} : { rootId }) });
  }
  if (!path.isAbsolute(value)) {
    throw new FileScopeGuardError(code, 'path_syntax', { ...(rootId === undefined ? {} : { rootId }) });
  }
  const resolved = path.resolve(value);
  if (value.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')) {
    throw new FileScopeGuardError(code, 'path_syntax', { ...(rootId === undefined ? {} : { rootId }) });
  }
  return resolved;
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
  expected?: FileScopeIdentity,
): Promise<FileScopeRootGrant> {
  const lexicalPath = assertPathSyntax(root.path, 'file_scope_unavailable', root.id);
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
  // see as a real directory.
  if (canonical !== path.join(canonicalParent, path.basename(lexicalPath))) throw fail('root_identity_changed');
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

export interface ResolveFileScopeGrantInput {
  readonly fileScope: ToolFileScope;
  /** The canonical Agent home and the writer-lease identity captured for this offer. */
  readonly home: { readonly path: string; readonly identity: FileScopeIdentity };
  readonly platform?: NodeJS.Platform;
  readonly io?: FileScopeIo;
}

function digestGrant(mode: 'home' | 'workspaces', home: FileScopeRootGrant, roots: readonly FileScopeRootGrant[]): string {
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
 * The Agent home identity comes from the writer lease, never from cwd text.
 */
export async function resolveFileScopeGrant(input: ResolveFileScopeGrantInput): Promise<FileScopeGrant> {
  const platform = input.platform ?? process.platform;
  assertPlatform(platform);
  const io = input.io ?? nodeFileScopeIo;
  const home = await resolveRoot(
    { id: 'home', path: input.home.path, access: 'write' },
    io,
    input.home.identity,
  );
  const roots: FileScopeRootGrant[] = [];
  for (const root of input.fileScope.roots ?? []) {
    roots.push(await resolveRoot(root, io));
  }
  const frozenRoots = Object.freeze(roots);
  return Object.freeze({
    mode: input.fileScope.mode,
    home,
    roots: frozenRoots,
    digest: digestGrant(input.fileScope.mode, home, frozenRoots),
  });
}

/** One checked target: canonical path, matched root and whether it already exists. */
export interface FileScopeTargetGrant {
  readonly path: string;
  readonly root: FileScopeRootGrant;
  readonly access: ToolFileAccess;
  readonly exists: boolean;
  readonly identity?: FileScopeIdentity;
}

export interface ResolveFileScopeTargetInput {
  readonly grant: FileScopeGrant;
  /** The model/runtime-supplied path; the caller must never trust it. */
  readonly path: string;
  readonly access: ToolFileAccess;
  /** The runtime's current working directory; a relative path resolves against it. */
  readonly cwd: string;
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

function internalPath(roots: readonly FileScopeRootGrant[], absolute: string): boolean {
  for (const root of roots) {
    if (isWithin(path.join(root.path, '.byok'), absolute) || isWithin(path.join(root.lexicalPath, '.byok'), absolute)) return true;
  }
  return false;
}

/**
 * Check one file target against a resolved grant. This is the primitive the
 * later scoped file tools will call; slice 2 only proves it with stable
 * fixtures and does not wire it into Pi's tools.
 *
 * The check is canonical check-then-open: every existing segment is lstat'ed
 * for symlinks, the nearest existing ancestor is canonicalized and contained,
 * dev+ino and nlink are checked, and an existing regular file is opened with
 * O_NOFOLLOW and rechecked with fstat. It is not race-free, and it is not an
 * OS sandbox.
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
  if (input.cwd.length === 0 || !path.isAbsolute(input.cwd) || /[\u0000\r\n]/u.test(input.cwd)) throw fail('path_syntax');
  const expanded = expandHome(input.path, osHome);
  const absolute = path.resolve(input.cwd, expanded);
  const allRoots = Object.freeze([input.grant.home, ...input.grant.roots]);
  if (internalPath(allRoots, absolute)) throw fail('internal_path');

  if (!path.isAbsolute(expanded)) {
    const cwdRoot = matchRoot(allRoots, path.resolve(input.cwd));
    if (cwdRoot === undefined) throw fail('cwd_outside_scope');
  }
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

  const relative = path.relative(root.path, matched.path);
  if (relative === '') throw fail('not_regular_file', root.id, input.access);
  const segments = relative.split(path.sep);
  let current = root.path;
  let existingCount = 0;
  let lastStat: FileScopeStat | undefined;
  let targetStat: FileScopeStat | undefined;
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
  const existingStat = targetStat ?? lastStat;
  if (existingStat !== undefined && existingStat.dev !== root.identity.dev) throw fail('cross_device', root.id, input.access);
  if (targetStat !== undefined) {
    if (targetStat.kind !== 'file') throw fail('not_regular_file', root.id, input.access);
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

  return Object.freeze({
    path: canonicalTarget,
    root,
    access: input.access,
    exists: targetStat !== undefined,
    ...(targetStat === undefined ? {} : { identity: Object.freeze({ dev: targetStat.dev, ino: targetStat.ino }) }),
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
  /** Adoption only: every root id the grant covers, home first. */
  readonly rootIds?: readonly string[];
  /** Denial only: the root that failed, when one was identified. */
  readonly rootId?: string;
  /** Denial only: the requested access, when one was identified. */
  readonly access?: ToolFileAccess;
  /** Denial only: the typed failure code. */
  readonly code?: FileScopeGuardCode;
  /** Denial only: the typed failure reason. */
  readonly reason?: FileScopeGuardReason;
}
