import path from 'node:path';
import type { ToolFileAccess } from './tool-authorization';
import type { FileScopeGrant, FileScopeIdentity, FileScopeRootGrant } from './file-scope-guard';

/**
 * The JSON-safe form of a FileScopeGrant that travels in the digest-bound Pi
 * launch config. BigInts are decimal strings because JSON has no bigint; the
 * host parses them back and re-verifies every root before it creates a
 * session.
 *
 * This module is deliberately free of filesystem imports: the adapter only
 * serializes an already-resolved grant, and importing the guard (and its
 * fs/promises primitives) on that path would make a pure launch-write pull in
 * filesystem I/O. Verification stays in file-scope-launch.ts.
 */
export interface SerializedFileScopeRoot {
  readonly id: string;
  readonly path: string;
  readonly lexicalPath: string;
  readonly access: ToolFileAccess;
  readonly dev: string;
  readonly ino: string;
}

export interface SerializedFileScopeGrant {
  readonly mode: 'home' | 'workspaces';
  readonly home: SerializedFileScopeRoot;
  readonly roots: readonly SerializedFileScopeRoot[];
  readonly digest: string;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const UINT = /^[0-9]+$/u;
const MAX_ID_CHARS = 128;

function hasControl(value: string): boolean {
  for (const char of value) if (char === String.fromCharCode(0) || char === String.fromCharCode(13) || char === String.fromCharCode(10)) return true;
  return false;
}

function serializeRoot(root: FileScopeRootGrant): SerializedFileScopeRoot {
  return Object.freeze({
    id: root.id,
    path: root.path,
    lexicalPath: root.lexicalPath,
    access: root.access,
    dev: root.identity.dev.toString(10),
    ino: root.identity.ino.toString(10),
  });
}

/** Convert a verified grant to the only shape the launch file may carry. */
export function serializeFileScopeGrant(grant: FileScopeGrant): SerializedFileScopeGrant {
  return Object.freeze({
    mode: grant.mode,
    home: serializeRoot(grant.home),
    roots: Object.freeze(grant.roots.map(serializeRoot)),
    digest: grant.digest,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value)
    ? value : '';
}

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || hasControl(value)
    || !path.isAbsolute(value) || path.resolve(value) !== value) return '';
  return value;
}

function identity(value: Record<string, unknown>, fail: (message: string) => never): FileScopeIdentity {
  const { dev, ino } = value;
  if (typeof dev !== 'string' || !UINT.test(dev) || typeof ino !== 'string' || !UINT.test(ino)) {
    return fail('file scope root identity must be decimal dev and ino strings');
  }
  return Object.freeze({ dev: BigInt(dev), ino: BigInt(ino) });
}

function parseRoot(value: unknown, label: string, fail: (message: string) => never): {
  readonly id: string;
  readonly path: string;
  readonly lexicalPath: string;
  readonly access: ToolFileAccess;
  readonly identity: FileScopeIdentity;
} {
  if (!record(value) || Object.keys(value).some((key) => !['id', 'path', 'lexicalPath', 'access', 'dev', 'ino'].includes(key))) {
    return fail('file scope ' + label + ' must contain exactly id, path, lexicalPath, access, dev and ino');
  }
  const id = text(value.id, MAX_ID_CHARS);
  if (id === '') fail('file scope ' + label + ' id must be a nonempty single-line string of at most ' + MAX_ID_CHARS + ' characters');
  const canonical = absolutePath(value.path);
  if (canonical === '') fail('file scope ' + label + ' path must be a normalized absolute path');
  const lexical = absolutePath(value.lexicalPath);
  if (lexical === '') fail('file scope ' + label + ' lexicalPath must be a normalized absolute path');
  if (value.access !== 'read' && value.access !== 'write') fail('file scope ' + label + ' access must be read or write');
  return Object.freeze({
    id,
    path: canonical,
    lexicalPath: lexical,
    access: value.access,
    identity: identity(value, fail),
  });
}

/** Validate the serialized grant shape without touching the filesystem. */
export function parseSerializedFileScopeGrant(
  value: unknown,
  fail: (message: string) => never,
): SerializedFileScopeGrant {
  if (!record(value) || Object.keys(value).some((key) => !['mode', 'home', 'roots', 'digest'].includes(key))) {
    fail('file scope grant must contain exactly mode, home, roots and digest');
  }
  if (value.mode !== 'home' && value.mode !== 'workspaces') fail('file scope grant mode must be home or workspaces');
  if (typeof value.digest !== 'string' || !SHA256.test(value.digest)) fail('file scope grant digest must be a sha256 hex string');
  const home = parseRoot(value.home, 'home', fail);
  if (home.id !== 'home' || home.access !== 'write') fail('file scope home root must be id "home" with write access');
  if (!Array.isArray(value.roots)) fail('file scope grant roots must be an array');
  if (value.mode === 'home' && value.roots.length !== 0) fail('file scope grant with mode home must not carry workspace roots');
  if (value.mode === 'workspaces' && value.roots.length === 0) fail('file scope grant with mode workspaces requires roots');
  if (value.roots.length > 32) fail('file scope grant must contain at most 32 workspace roots');
  const ids = new Set<string>(['home']);
  const paths = new Set<string>();
  const roots: SerializedFileScopeRoot[] = [];
  for (const entry of value.roots) {
    const root = parseRoot(entry, 'root', fail);
    if (root.id === 'home') fail('file scope workspace root must not reuse the reserved home id');
    if (ids.has(root.id)) fail('duplicate file scope root id: ' + root.id);
    if (paths.has(root.path)) fail('duplicate file scope root path: ' + root.id);
    ids.add(root.id);
    paths.add(root.path);
    roots.push(Object.freeze({
      id: root.id, path: root.path, lexicalPath: root.lexicalPath, access: root.access,
      dev: root.identity.dev.toString(10), ino: root.identity.ino.toString(10),
    }));
  }
  return Object.freeze({
    mode: value.mode,
    home: Object.freeze({
      id: home.id, path: home.path, lexicalPath: home.lexicalPath, access: home.access,
      dev: home.identity.dev.toString(10), ino: home.identity.ino.toString(10),
    }),
    roots: Object.freeze(roots),
    digest: value.digest,
  });
}
