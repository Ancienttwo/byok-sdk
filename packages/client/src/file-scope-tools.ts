import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  FileScopeGuardError,
  resolveFileScopeTarget,
  type FileScopeGrant,
  type FileScopeIo,
  type FileScopeTargetGrant,
} from './file-scope-guard';
import type { FileScopeGuardCode, FileScopeGuardReason } from './file-scope-guard';
import type { ToolFileAccess } from './tool-authorization';

/** The only file tools this first scoped slice replaces. */
export const SCOPED_FILE_TOOL_NAMES = Object.freeze(['read', 'write', 'edit'] as const);
export type ScopedFileToolName = (typeof SCOPED_FILE_TOOL_NAMES)[number];

const SCOPED_FILE_TOOL_NAME_SET: ReadonlySet<string> = new Set(SCOPED_FILE_TOOL_NAMES);
export function isScopedFileToolName(value: string): value is ScopedFileToolName {
  return SCOPED_FILE_TOOL_NAME_SET.has(value);
}

const MAX_READ_BYTES = 1_000_000;
const MAX_EDIT_BYTES = 10_000_000;
const MAX_PATH_CHARS = 4_096;

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
  not_regular_file: 'the target is not a regular file',
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

async function resolveTarget(
  options: ScopedFileToolOptions,
  path: unknown,
  access: ToolFileAccess,
  cwd: unknown,
): Promise<FileScopeTargetGrant> {
  return resolveFileScopeTarget({
    grant: options.grant,
    path: typeof path === 'string' ? path : '',
    access,
    cwd: checkedCwd(cwd),
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
  await resolveTarget(options, call.input.path, call.toolName === 'read' ? 'read' : 'write', call.cwd);
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

/**
 * Create the SDK-owned scoped file tools. Each tool re-runs the guard
 * immediately before touching the file; a guard failure becomes a typed tool
 * error and never a silent fallback to an unguarded fs call.
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

  return [read, write, edit];
}
