import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  FileScopeGuardError,
  resolveFileScopeTarget,
  type FileScopeGrant,
  type FileScopeIo,
  type FileScopeTargetGrant,
  type FileScopeTargetKind,
} from './file-scope-guard';
import type { FileScopeGuardCode, FileScopeGuardReason } from './file-scope-guard';
import { isScopedFileToolName, type ScopedFileToolName } from './file-scope-types';
import type { ToolFileAccess } from './tool-authorization';

export {
  SCOPED_FILE_TOOL_NAMES, isScopedFileToolName, type ScopedFileToolName,
} from './file-scope-types';

const MAX_READ_BYTES = 1_000_000;
const MAX_EDIT_BYTES = 10_000_000;
const MAX_PATH_CHARS = 4_096;
/** Output budgets shared by the discovery tools; native Pi uses 50 KiB too. */
const MAX_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_FIND_LIMIT = 1_000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_LS_LIMIT = 500;
const MAX_RESULT_LIMIT = 10_000;
const MAX_GREP_LINE_CHARS = 500;
/**
 * Lines of context each side of a match. One window this wide (2,001 lines)
 * of short lines with their path prefix already fills MAX_OUTPUT_BYTES, so a
 * larger value could only be cut by the output budget.
 */
const MAX_GREP_CONTEXT = 1_000;
const MAX_GREP_FILE_BYTES = 10_000_000;

/** One per-call denial the scoped tools report; allow is never reported (D12). */
export interface ScopedFileDenial {
  readonly toolCallId?: string;
  readonly toolName: ScopedFileToolName;
  readonly code: FileScopeGuardCode;
  readonly reason: FileScopeGuardReason;
  readonly rootId?: string;
  readonly access?: ToolFileAccess;
}

export interface ScopedFileToolHooks {
  /** Called exactly once for a denied call and never for a successful one. */
  readonly onDenial?: (denial: ScopedFileDenial) => void | Promise<void>;
}

export interface ScopedFileToolOptions extends ScopedFileToolHooks {
  readonly grant: FileScopeGrant;
  /** Injectable for the cross-device fixture; production uses Node built-ins. */
  readonly io?: FileScopeIo;
  /** Injectable platform for the Windows fail-closed fixture. */
  readonly platform?: NodeJS.Platform;
  /** Overrides os.homedir() for the tilde fixture. */
  readonly osHome?: string;
}

const REASON_TEXT: Readonly<Record<FileScopeGuardReason, string>> = Object.freeze({
  outside_scope: 'path is outside the authorized file scope',
  read_only: 'the matched root is read-only',
  symlink: 'a symlink is not allowed in a scoped path',
  hardlink: 'hard-linked files are not allowed',
  not_regular_file: 'the target is not a regular file or directory',
  cross_device: 'the target is on another device',
  path_syntax: 'the path syntax is invalid',
  cwd_outside_scope: 'the working directory is outside the authorized scope',
  internal_path: 'SDK internal paths are not accessible',
  root_identity_changed: 'the authorized root identity changed',
  unsupported_platform: 'file scope is not supported on this platform',
  root_missing: 'the authorized root is missing',
  not_directory: 'the authorized root is not a directory',
  io_error: 'the authorized root could not be inspected',
});

/** The one error text a scoped tool returns; it names the requested path, never a canonical or root path. */
export function formatScopedFileDenial(
  toolName: ScopedFileToolName,
  requestedPath: unknown,
  error: FileScopeGuardError,
): string {
  const shown = typeof requestedPath === 'string' ? JSON.stringify(requestedPath.slice(0, MAX_PATH_CHARS)) : 'the requested path';
  return error.code + ': ' + REASON_TEXT[error.reason] + ' (' + error.reason + ') for ' + toolName + ' ' + shown;
}

function denialOf(toolCallId: string | undefined, toolName: ScopedFileToolName, error: FileScopeGuardError): ScopedFileDenial {
  return Object.freeze({
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName,
    code: error.code,
    reason: error.reason,
    ...(error.rootId === undefined ? {} : { rootId: error.rootId }),
    ...(error.access === undefined ? {} : { access: error.access }),
  });
}

function checkedCwd(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : process.cwd();
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function readOnlyTool(toolName: ScopedFileToolName): boolean {
  return toolName === 'read' || toolName === 'find' || toolName === 'grep' || toolName === 'ls';
}

/** The path every discovery tool defaults to; read/write/edit still require one. */
function scopedPath(toolName: ScopedFileToolName, value: unknown): unknown {
  if (value === undefined && (toolName === 'find' || toolName === 'grep' || toolName === 'ls')) return '.';
  return value;
}

function scopedKind(toolName: ScopedFileToolName): FileScopeTargetKind {
  if (toolName === 'find' || toolName === 'ls') return 'directory';
  if (toolName === 'grep') return 'entry';
  return 'file';
}

async function resolveTarget(
  options: ScopedFileToolOptions,
  path: unknown,
  access: ToolFileAccess,
  cwd: unknown,
  kind: FileScopeTargetKind = 'file',
): Promise<FileScopeTargetGrant> {
  return resolveFileScopeTarget({
    grant: options.grant,
    path: typeof path === 'string' ? path : '',
    access,
    cwd: checkedCwd(cwd),
    kind,
    ...(options.io === undefined ? {} : { io: options.io }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.osHome === undefined ? {} : { osHome: options.osHome }),
  });
}

/**
 * The pre-execution check the Pi tool_call handler runs before the
 * auto-approval gate. It is the same guard primitive the tool itself uses
 * again immediately before IO; this pass exists so an out-of-scope call is
 * denied without ever asking the user to approve it (design priority 2 before
 * 3), not as a replacement for the execution check.
 */
export async function precheckScopedFileCall(
  options: ScopedFileToolOptions,
  call: { readonly toolName: string; readonly input: Readonly<Record<string, unknown>>; readonly cwd: string },
): Promise<void> {
  if (!isScopedFileToolName(call.toolName)) return;
  await resolveTarget(
    options,
    scopedPath(call.toolName, call.input.path),
    readOnlyTool(call.toolName) ? 'read' : 'write',
    call.cwd,
    scopedKind(call.toolName),
  );
}

async function guarded<T>(
  options: ScopedFileToolOptions,
  toolName: ScopedFileToolName,
  toolCallId: string,
  requestedPath: unknown,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Only the file-scope authority produces a scope denial. An ordinary IO
    // failure stays an ordinary tool error and is not recorded as a scope
    // decision (design A2).
    if (!(error instanceof FileScopeGuardError)) throw error;
    try {
      await options.onDenial?.(denialOf(toolCallId, toolName, error));
    } catch { /* The deny is already decided; an observer cannot grant it. */ }
    throw new Error(formatScopedFileDenial(toolName, requestedPath, error));
  }
}

function assertOpenedFile(stat: import('node:fs').BigIntStats, target: FileScopeTargetGrant): void {
  if (!stat.isFile()) throw new FileScopeGuardError('file_scope_denied', 'not_regular_file', { rootId: target.root.id, access: target.access });
  if (stat.nlink > 1n) throw new FileScopeGuardError('file_scope_denied', 'hardlink', { rootId: target.root.id, access: target.access });
  if (stat.dev !== target.root.identity.dev) throw new FileScopeGuardError('file_scope_denied', 'cross_device', { rootId: target.root.id, access: target.access });
  if (target.identity !== undefined && (stat.dev !== target.identity.dev || stat.ino !== target.identity.ino)) {
    throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: target.root.id, access: target.access });
  }
}

async function openGuarded(target: FileScopeTargetGrant, flags: number, mode?: number): Promise<import('node:fs/promises').FileHandle> {
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fs.open(target.path, flags | fsConstants.O_NOFOLLOW, mode);
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      throw new FileScopeGuardError('file_scope_denied', 'symlink', { rootId: target.root.id, access: target.access });
    }
    throw error;
  }
  try {
    assertOpenedFile(await handle.stat({ bigint: true }), target);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function applyEdits(
  source: string,
  edits: readonly { readonly oldText: string; readonly newText: string }[],
): string {
  if (edits.length === 0) throw new Error('edit requires at least one replacement');
  const matches: { start: number; end: number; newText: string }[] = [];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) throw new Error('edit ' + index + ': oldText must be a nonempty string');
    if (typeof edit.newText !== 'string') throw new Error('edit ' + index + ': newText must be a string');
    const first = source.indexOf(edit.oldText);
    if (first < 0) throw new Error('edit ' + index + ': oldText was not found');
    if (source.indexOf(edit.oldText, first + 1) >= 0) throw new Error('edit ' + index + ': oldText is not unique');
    matches.push({ start: first, end: first + edit.oldText.length, newText: edit.newText });
  }
  matches.sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index]!.start < matches[index - 1]!.end) throw new Error('edit replacements overlap');
  }
  let cursor = 0;
  let output = '';
  for (const match of matches) {
    output += source.slice(cursor, match.start) + match.newText;
    cursor = match.end;
  }
  return output + source.slice(cursor);
}

function boundedLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(value)));
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  const kept: string[] = [];
  let bytes = 0;
  for (const line of text.split('\n')) {
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length === 0 ? 0 : 1);
    if (bytes + cost > MAX_OUTPUT_BYTES) break;
    kept.push(line);
    bytes += cost;
  }
  return { text: kept.join('\n'), truncated: true };
}

function withNotices(text: string, notices: readonly string[]): string {
  return notices.length === 0 ? text : text + '\n\n[' + notices.join('. ') + ']';
}

function truncateMatchLine(value: string): { text: string; truncated: boolean } {
  const sanitized = value.replace(/\r/g, '');
  return sanitized.length <= MAX_GREP_LINE_CHARS
    ? { text: sanitized, truncated: false }
    : { text: sanitized.slice(0, MAX_GREP_LINE_CHARS) + '... [truncated]', truncated: true };
}

function posixRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const GLOB_SPECIAL = new Set(['\\', '^', '$', '+', '.', '|', '(', ')', '[', ']', '{', '}']);
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (GLOB_SPECIAL.has(char)) {
      source += '\\' + char;
    } else {
      source += char;
    }
  }
  return new RegExp('^' + source + '$', 'u');
}

function globMatcher(pattern: string): (relativePath: string) => boolean {
  const expression = globToRegExp(pattern);
  const fullPath = pattern.includes('/');
  return (relativePath: string) => expression.test(fullPath ? relativePath : basename(relativePath));
}

interface ScopedWalkEntry {
  readonly target: FileScopeTargetGrant;
  readonly relativePath: string;
}

/**
 * Walk one guarded directory without ever calling fs on an unchecked path.
 * Every entry is resolved by the same guard before it is visited; symlinks and
 * cross-device/internally denied entries are skipped rather than followed.
 * Returns false when the visitor stopped the walk.
 */
async function walkScopedDirectory(
  options: ScopedFileToolOptions,
  start: FileScopeTargetGrant,
  cwd: string,
  signal: AbortSignal | undefined,
  visit: (entry: ScopedWalkEntry) => boolean | Promise<boolean>,
): Promise<boolean> {
  const stack: FileScopeTargetGrant[] = [start];
  while (stack.length > 0) {
    if (signal !== undefined && signal.aborted) throw new Error('Operation aborted');
    const pending = stack.pop()!;
    // Re-check immediately before readdir: a discovered directory may have
    // been replaced while other entries were visited. A denial skips it; an
    // unavailable authority fails the whole call closed.
    let directory: FileScopeTargetGrant;
    try {
      directory = await resolveTarget(options, pending.path, 'read', cwd, 'directory');
    } catch (error) {
      if (error instanceof FileScopeGuardError && error.code === 'file_scope_denied') continue;
      throw error;
    }
    if (!directory.exists) continue;
    let names: string[];
    try {
      names = await fs.readdir(directory.path);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EACCES')) continue;
      throw error;
    }
    names.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
    for (const name of names) {
      if (signal !== undefined && signal.aborted) throw new Error('Operation aborted');
      if (name === '.byok') continue;
      let entry: FileScopeTargetGrant;
      try {
        entry = await resolveTarget(options, directory.path + sep + name, 'read', cwd, 'entry');
      } catch (error) {
        // Symlinks, hard links and internals are skipped during discovery; an
        // unavailable guard authority is not a skip.
        if (error instanceof FileScopeGuardError && error.code === 'file_scope_denied') continue;
        throw error;
      }
      if (!entry.exists || entry.kind === undefined) continue;
      const relativePath = posixRelative(start.path, entry.path);
      if (!(await visit({ target: entry, relativePath }))) return false;
      if (entry.kind === 'directory') stack.push(entry);
    }
  }
  return true;
}

async function readTextFile(
  target: FileScopeTargetGrant,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (signal !== undefined && signal.aborted) throw new Error('Operation aborted');
  const handle = await openGuarded(target, fsConstants.O_RDONLY);
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.size > BigInt(MAX_GREP_FILE_BYTES)) return undefined;
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      if (signal !== undefined && signal.aborted) throw new Error('Operation aborted');
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const data = buffer.subarray(0, offset);
    // Text-only: a NUL byte marks a binary file that this tool does not claim.
    if (data.includes(0)) return undefined;
    return data.toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Create the SDK-owned scoped file tools. Each tool re-runs the guard
 * immediately before touching a path; a guard failure becomes a typed tool
 * error and never a silent fallback to an unguarded fs call or a native tool.
 *
 * find/grep/ls discover only inside the same roots. They refuse a requested
 * path that leaves the scope and never follow a symlink entry; text-only grep
 * skips binary files instead of claiming image/binary support.
 */
export function createScopedFileTools(options: ScopedFileToolOptions): ToolDefinition[] {
  const readSchema = Type.Object({
    path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
    offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
  });
  const writeSchema = Type.Object({
    path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
    content: Type.String({ description: 'Content to write to the file' }),
  });
  const editSchema = Type.Object({
    path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({ description: 'Exact text for one targeted replacement; must be unique in the original file' }),
      newText: Type.String({ description: 'Replacement text for this targeted edit' }),
    })),
  });
  const findSchema = Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
    path: Type.Optional(Type.String({ description: 'Directory to search in (default: current directory)' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of results (default: 1000)' })),
  });
  const grepSchema = Type.Object({
    pattern: Type.String({ description: 'Search pattern (regex or literal string)' }),
    path: Type.Optional(Type.String({ description: 'File or directory to search (default: current directory)' })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false)' })),
    literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' })),
    context: Type.Optional(Type.Number({ description: 'Number of lines to show before and after each match (default: 0)' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of matches to return (default: 100)' })),
  });
  const lsSchema = Type.Object({
    path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of entries to return (default: 500)' })),
  });

  const read = defineTool({
    name: 'read',
    label: 'Read file',
    description: 'Read a text file inside the authorized file scope. Scoped file tools replace Pi native file tools for this task.',
    parameters: readSchema,
    async execute(toolCallId, { path, offset, limit }, _signal, _onUpdate, ctx) {
      return guarded(options, 'read', toolCallId, path, async () => {
        const target = await resolveTarget(options, path, 'read', ctx.cwd);
        if (!target.exists) throw new FileScopeGuardError('file_scope_denied', 'not_regular_file', { rootId: target.root.id, access: 'read' });
        const handle = await openGuarded(target, fsConstants.O_RDONLY);
        try {
          const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const truncated = bytesRead > MAX_READ_BYTES;
          let text = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES)).toString('utf8');
          let lines = text.split('\n');
          const start = offset === undefined ? 0 : Math.max(0, Math.trunc(offset) - 1);
          const end = limit === undefined ? lines.length : start + Math.max(0, Math.trunc(limit));
          lines = lines.slice(start, end);
          text = lines.join('\n');
          if (truncated) text += '\n\n[truncated at ' + MAX_READ_BYTES + ' bytes; use offset/limit]';
          return { content: [{ type: 'text' as const, text }], details: {} };
        } finally {
          await handle.close().catch(() => {});
        }
      });
    },
  });

  const write = defineTool({
    name: 'write',
    label: 'Write file',
    description: 'Write a text file inside the authorized file scope. Creates the file and its parent directories when missing.',
    parameters: writeSchema,
    async execute(toolCallId, { path, content }, _signal, _onUpdate, ctx) {
      return guarded(options, 'write', toolCallId, path, async () => {
        let target = await resolveTarget(options, path, 'write', ctx.cwd);
        let handle: import('node:fs/promises').FileHandle;
        if (target.exists) {
          // Open without O_TRUNC first: fstat must prove this is the same
          // regular, single-link file the guard checked before anything is
          // destroyed. Truncation happens only after that check.
          handle = await openGuarded(target, fsConstants.O_WRONLY);
        } else {
          await fs.mkdir(dirname(target.path), { recursive: true, mode: 0o700 });
          target = await resolveTarget(options, path, 'write', ctx.cwd);
          try {
            handle = await openGuarded(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o666);
          } catch (error) {
            if (!isErrno(error, 'EEXIST')) throw error;
            target = await resolveTarget(options, path, 'write', ctx.cwd);
            handle = await openGuarded(target, fsConstants.O_WRONLY);
          }
        }
        try {
          await handle.truncate(0);
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close().catch(() => {});
        }
        return { content: [{ type: 'text' as const, text: 'Wrote ' + Buffer.byteLength(content, 'utf8') + ' bytes to ' + path }], details: {} };
      });
    },
  });

  const edit = defineTool({
    name: 'edit',
    label: 'Edit file',
    description: 'Edit a text file inside the authorized file scope using exact, unique text replacements.',
    parameters: editSchema,
    async execute(toolCallId, { path, edits }, _signal, _onUpdate, ctx) {
      return guarded(options, 'edit', toolCallId, path, async () => {
        const target = await resolveTarget(options, path, 'write', ctx.cwd);
        if (!target.exists) throw new FileScopeGuardError('file_scope_denied', 'not_regular_file', { rootId: target.root.id, access: 'write' });
        let handle;
        try {
          handle = await openGuarded(target, fsConstants.O_RDWR);
        } catch (error) {
          if (!isErrno(error, 'ELOOP')) throw error;
          throw new FileScopeGuardError('file_scope_denied', 'symlink', { rootId: target.root.id, access: 'write' });
        }
        try {
          const before = await handle.stat({ bigint: true });
          if (before.size > BigInt(MAX_EDIT_BYTES)) {
            throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { rootId: target.root.id, access: 'write' });
          }
          const source = await handle.readFile({ encoding: 'utf8' });
          const updated = applyEdits(source, edits);
          const afterRead = await handle.stat({ bigint: true });
          if (afterRead.size !== before.size || afterRead.mtimeNs !== before.mtimeNs) {
            throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: target.root.id, access: 'write' });
          }
          const onDisk = await fs.lstat(target.path, { bigint: true });
          if (onDisk.isSymbolicLink() || onDisk.nlink > 1n || onDisk.dev !== before.dev || onDisk.ino !== before.ino) {
            throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: target.root.id, access: 'write' });
          }
          await handle.truncate(0);
          await handle.write(Buffer.from(updated, 'utf8'), 0, Buffer.byteLength(updated, 'utf8'), 0);
        } finally {
          await handle.close().catch(() => {});
        }
        return { content: [{ type: 'text' as const, text: 'Edited ' + path + ' (' + edits.length + ' replacement' + (edits.length === 1 ? '' : 's') + ')' }], details: {} };
      });
    },
  });

  const find = defineTool({
    name: 'find',
    label: 'Find files',
    description: 'Find files by glob pattern inside the authorized file scope. Returns paths relative to the search directory. Text-only; symlinks are not followed.',
    parameters: findSchema,
    async execute(toolCallId, { pattern, path, limit }, signal, _onUpdate, ctx) {
      return guarded(options, 'find', toolCallId, path, async () => {
        if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('find requires a nonempty pattern');
        const matcher = globMatcher(pattern);
        const search = await resolveTarget(options, scopedPath('find', path), 'read', ctx.cwd, 'directory');
        if (!search.exists || search.kind !== 'directory') throw new Error('Path not found: ' + String(scopedPath('find', path)));
        const effectiveLimit = boundedLimit(limit, DEFAULT_FIND_LIMIT);
        const results: string[] = [];
        let resultLimitReached = false;
        await walkScopedDirectory(options, search, checkedCwd(ctx.cwd), signal, ({ target, relativePath }) => {
          if (target.kind !== 'file') return true;
          if (!matcher(relativePath)) return true;
          results.push(relativePath);
          if (results.length >= effectiveLimit) {
            resultLimitReached = true;
            return false;
          }
          return true;
        });
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No files found matching pattern' }], details: {} };
        }
        const truncated = truncateOutput(results.join('\n'));
        const notices: string[] = [];
        if (resultLimitReached) notices.push(effectiveLimit + ' results limit reached');
        if (truncated.truncated) notices.push('50KB limit reached');
        return {
          content: [{ type: 'text' as const, text: withNotices(truncated.text, notices) }],
          details: {},
        };
      });
    },
  });

  const grep = defineTool({
    name: 'grep',
    label: 'Search contents',
    description: 'Search text file contents inside the authorized file scope. Returns matching lines with file paths and line numbers. Binary files are skipped.',
    parameters: grepSchema,
    async execute(toolCallId, { pattern, path, glob, ignoreCase, literal, context, limit }, signal, _onUpdate, ctx) {
      return guarded(options, 'grep', toolCallId, path, async () => {
        if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('grep requires a nonempty pattern');
        let expression: RegExp;
        try {
          expression = new RegExp(literal === true ? escapeRegExp(pattern) : pattern, ignoreCase === true ? 'iu' : 'u');
        } catch (error) {
          throw new Error('invalid grep pattern: ' + (error instanceof Error ? error.message : String(error)));
        }
        const matcher = typeof glob === 'string' && glob.length > 0 ? globMatcher(glob) : undefined;
        const search = await resolveTarget(options, scopedPath('grep', path), 'read', ctx.cwd, 'entry');
        const requested = String(scopedPath('grep', path));
        if (!search.exists) throw new Error('Path not found: ' + requested);
        const effectiveLimit = boundedLimit(limit, DEFAULT_GREP_LIMIT);
        const contextLines = typeof context === 'number' && Number.isFinite(context) && context > 0 ? Math.min(MAX_GREP_CONTEXT, Math.trunc(context)) : 0;
        const outputLines: string[] = [];
        let outputBytes = 0;
        let outputTruncated = false;
        let matchCount = 0;
        let lineTruncated = false;
        let resultLimitReached = false;

        // The byte budget is enforced as lines are collected, so a dense file
        // with a wide context cannot build more output than the tool returns.
        const emit = (displayPath: string, lineNumber: number, separator: ':' | '-', value: string): boolean => {
          const line = truncateMatchLine(value);
          const text = displayPath + separator + lineNumber + separator + ' ' + line.text;
          const cost = Buffer.byteLength(text, 'utf8') + (outputLines.length === 0 ? 0 : 1);
          if (outputBytes + cost > MAX_OUTPUT_BYTES) {
            outputTruncated = true;
            return false;
          }
          if (line.truncated) lineTruncated = true;
          outputLines.push(text);
          outputBytes += cost;
          return true;
        };

        /**
         * Emits each line at most once per file: before-context starts after
         * the last emitted line, and after-context is emitted as the scan
         * reaches it, so a match inside an earlier window keeps its ':' label.
         */
        const searchFile = async (target: FileScopeTargetGrant, displayPath: string): Promise<boolean> => {
          const file = await readTextFile(target, signal);
          if (file === undefined) return true;
          const lines = file.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n');
          let lastEmitted = -1;
          let afterContextEnd = -1;
          for (let index = 0; index < lines.length; index += 1) {
            if (signal !== undefined && signal.aborted) throw new Error('Operation aborted');
            if (!resultLimitReached && expression.test(lines[index]!)) {
              matchCount += 1;
              for (let current = Math.max(lastEmitted + 1, index - contextLines); current < index; current += 1) {
                if (!emit(displayPath, current + 1, '-', lines[current]!)) return false;
              }
              if (!emit(displayPath, index + 1, ':', lines[index]!)) return false;
              lastEmitted = index;
              afterContextEnd = index + contextLines;
              if (matchCount >= effectiveLimit) resultLimitReached = true;
            } else if (index <= afterContextEnd) {
              if (!emit(displayPath, index + 1, '-', lines[index]!)) return false;
              lastEmitted = index;
            } else if (resultLimitReached) {
              return false;
            }
          }
          return !resultLimitReached;
        };

        if (search.kind === 'file') {
          const fileTarget = await resolveTarget(options, search.path, 'read', ctx.cwd, 'file');
          await searchFile(fileTarget, basename(fileTarget.path));
        } else if (search.kind === 'directory') {
          await walkScopedDirectory(options, search, checkedCwd(ctx.cwd), signal, async ({ target, relativePath }) => {
            if (target.kind !== 'file') return true;
            if (matcher !== undefined && !matcher(relativePath)) return true;
            let fileTarget: FileScopeTargetGrant;
            try {
              fileTarget = await resolveTarget(options, target.path, 'read', ctx.cwd, 'file');
            } catch (error) {
              // A hard link/symlink is skipped during directory search; a
              // changed or unavailable root identity fails the call closed.
              if (error instanceof FileScopeGuardError && error.code === 'file_scope_denied') return true;
              throw error;
            }
            return searchFile(fileTarget, relativePath);
          });
        } else {
          throw new Error('Path not found: ' + requested);
        }

        if (matchCount === 0) {
          return { content: [{ type: 'text' as const, text: 'No matches found' }], details: {} };
        }
        const notices: string[] = [];
        if (resultLimitReached) notices.push(effectiveLimit + ' matches limit reached');
        if (outputTruncated) notices.push('50KB limit reached');
        if (lineTruncated) notices.push('Some lines truncated to ' + MAX_GREP_LINE_CHARS + ' chars');
        return {
          content: [{ type: 'text' as const, text: withNotices(outputLines.join('\n'), notices) }],
          details: {},
        };
      });
    },
  });

  const ls = defineTool({
    name: 'ls',
    label: 'List directory',
    description: 'List directory contents inside the authorized file scope. Returns entries sorted alphabetically, with "/" for directories. Symlinks are not followed.',
    parameters: lsSchema,
    async execute(toolCallId, { path, limit }, signal, _onUpdate, ctx) {
      return guarded(options, 'ls', toolCallId, path, async () => {
        const requested = String(scopedPath('ls', path));
        const directory = await resolveTarget(options, scopedPath('ls', path), 'read', ctx.cwd, 'directory');
        if (!directory.exists || directory.kind !== 'directory') throw new Error('Path not found: ' + requested);
        let names: string[];
        try {
          names = await fs.readdir(directory.path);
        } catch (error) {
          if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) throw new Error('Path not found: ' + requested);
          throw new Error('Cannot read directory: ' + (error instanceof Error ? error.message : String(error)));
        }
        names.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
        const effectiveLimit = boundedLimit(limit, DEFAULT_LS_LIMIT);
        const results: string[] = [];
        let entryLimitReached = false;
        for (const name of names) {
          if (signal !== undefined && signal.aborted) throw new Error('Operation aborted');
          if (name === '.byok') continue;
          if (results.length >= effectiveLimit) {
            entryLimitReached = true;
            break;
          }
          let entry: FileScopeTargetGrant;
          try {
            entry = await resolveTarget(options, directory.path + sep + name, 'read', ctx.cwd, 'entry');
          } catch (error) {
            // Symlinks and hard-linked files are not listed; an unavailable
            // guard authority is a failure, not a skip.
            if (error instanceof FileScopeGuardError && error.code === 'file_scope_denied') continue;
            throw error;
          }
          if (!entry.exists || entry.kind === undefined) continue;
          results.push(name + (entry.kind === 'directory' ? '/' : ''));
        }
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: '(empty directory)' }], details: {} };
        }
        const truncated = truncateOutput(results.join('\n'));
        const notices: string[] = [];
        if (entryLimitReached) notices.push(effectiveLimit + ' entries limit reached. Use limit=' + (effectiveLimit * 2) + ' for more');
        if (truncated.truncated) notices.push('50KB limit reached');
        return {
          content: [{ type: 'text' as const, text: withNotices(truncated.text, notices) }],
          details: {},
        };
      });
    },
  });

  return [read, write, edit, find, grep, ls];
}
