import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileScopeGuardError,
  nodeFileScopeIo,
  resolveFileScopeGrant,
  resolveFileScopeTarget,
  type FileScopeGrant,
  type FileScopeIdentity,
  type FileScopeIo,
} from '../file-scope-guard';

const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function canonicalTmpDir(prefix: string): Promise<string> {
  return fs.realpath(await tmpDir(prefix));
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function identityOf(filePath: string): Promise<FileScopeIdentity> {
  const value = await fs.stat(filePath, { bigint: true });
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

async function fixture(): Promise<{ home: string; identity: FileScopeIdentity }> {
  const home = await canonicalTmpDir('byok-guard-home-');
  return { home, identity: await identityOf(home) };
}

async function grantWith(root: string, access: 'read' | 'write' = 'write'): Promise<FileScopeGrant> {
  const { home, identity } = await fixture();
  return resolveFileScopeGrant({
    fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: root, access }] },
    home: { path: home, identity },
  });
}

async function guardReason(run: () => Promise<unknown>): Promise<{ code: string; reason: string; rootId?: string }> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FileScopeGuardError);
  return caught as FileScopeGuardError;
}

describe('file-scope guard root resolution (#1061 slice 2)', () => {
  it('captures a real directory root and its dev+ino identity', async () => {
    const root = await canonicalTmpDir('byok-guard-root-');
    const grant = await grantWith(root);
    expect(grant.home.id).toBe('home');
    expect(grant.home.access).toBe('write');
    expect(grant.roots).toEqual([{
      id: 'repo', path: root, lexicalPath: root, access: 'write', identity: await identityOf(root),
    }]);
    expect(grant.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.roots[0])).toBe(true);
  });

  it('refuses a missing root before it can be used', async () => {
    const missing = path.join(await canonicalTmpDir('byok-guard-missing-'), 'gone');
    expect(await guardReason(() => grantWith(missing)))
      .toMatchObject({ code: 'file_scope_unavailable', reason: 'root_missing', rootId: 'repo' });
  });

  it('refuses a root that is itself a symlink', async () => {
    const target = await canonicalTmpDir('byok-guard-target-');
    const link = path.join(await canonicalTmpDir('byok-guard-link-'), 'linked');
    await fs.symlink(target, link, 'dir');
    expect(await guardReason(() => grantWith(link)))
      .toMatchObject({ code: 'file_scope_unavailable', reason: 'symlink', rootId: 'repo' });
  });

  it('refuses a root whose canonical identity no longer matches the writer lease', async () => {
    const { home, identity } = await fixture();
    const wrong = Object.freeze({ dev: identity.dev, ino: identity.ino + 1n });
    expect(await guardReason(() => resolveFileScopeGrant({
      fileScope: { mode: 'home' }, home: { path: home, identity: wrong },
    }))).toMatchObject({ code: 'file_scope_unavailable', reason: 'root_identity_changed', rootId: 'home' });
  });

  it('refuses Windows and unknown platforms without touching the filesystem', async () => {
    const { home, identity } = await fixture();
    expect(await guardReason(() => resolveFileScopeGrant({
      fileScope: { mode: 'home' }, home: { path: home, identity }, platform: 'win32',
    }))).toMatchObject({ code: 'file_scope_unsupported', reason: 'unsupported_platform' });
    expect(await guardReason(() => resolveFileScopeGrant({
      fileScope: { mode: 'home' }, home: { path: home, identity }, platform: 'freebsd',
    }))).toMatchObject({ code: 'file_scope_unsupported', reason: 'unsupported_platform' });
  });
});

describe('file-scope guard target checks (#1061 slice 2)', () => {
  it('accepts an existing regular file inside the root and reports its identity', async () => {
    const root = await canonicalTmpDir('byok-guard-target-ok-');
    const file = path.join(root, 'notes.md');
    await fs.writeFile(file, 'hello');
    const grant = await grantWith(root);
    const target = await resolveFileScopeTarget({ grant, path: file, access: 'write', cwd: grant.home.path });
    expect(target).toMatchObject({ path: file, access: 'write', exists: true, root: expect.objectContaining({ id: 'repo' }) });
    expect(target.identity).toEqual(await identityOf(file));
  });

  it('returns a canonical path for a not-yet-created write target without creating it', async () => {
    const root = await canonicalTmpDir('byok-guard-target-new-');
    const file = path.join(root, 'new.md');
    const grant = await grantWith(root);
    const target = await resolveFileScopeTarget({ grant, path: file, access: 'write', cwd: grant.home.path });
    expect(target).toMatchObject({ path: file, exists: false });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a mid-path symlink and never touches the outside sentinel', async () => {
    const root = await canonicalTmpDir('byok-guard-mid-root-');
    const outside = await canonicalTmpDir('byok-guard-mid-outside-');
    const sentinel = path.join(outside, 'secret.txt');
    await fs.writeFile(sentinel, 'unchanged');
    await fs.symlink(outside, path.join(root, 'link'), 'dir');
    const grant = await grantWith(root);
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: path.join(root, 'link', 'secret.txt'), access: 'read', cwd: grant.home.path,
    }))).toMatchObject({ code: 'file_scope_denied', reason: 'symlink', rootId: 'repo' });
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('unchanged');
  });

  it('refuses a hard link for read and write', async () => {
    const root = await canonicalTmpDir('byok-guard-hardlink-');
    const original = path.join(root, 'original.txt');
    const alias = path.join(root, 'alias.txt');
    await fs.writeFile(original, 'data');
    await fs.link(original, alias);
    const grant = await grantWith(root);
    for (const access of ['read', 'write'] as const) {
      expect(await guardReason(() => resolveFileScopeTarget({
        grant, path: alias, access, cwd: grant.home.path,
      }))).toMatchObject({ reason: 'hardlink', rootId: 'repo' });
    }
  });

  it('refuses a target on another device', async () => {
    const root = await canonicalTmpDir('byok-guard-cross-');
    const file = path.join(root, 'cross.txt');
    await fs.writeFile(file, 'data');
    const grant = await grantWith(root);
    // A real second mount cannot be created unprivileged in a unit test; the
    // IO seam reports the exact stat a mount point would have.
    const io: FileScopeIo = {
      ...nodeFileScopeIo,
      lstat: async (candidate: string) => {
        const value = await nodeFileScopeIo.lstat(candidate);
        return candidate === file ? { ...value, dev: value.dev + 1n } : value;
      },
    };
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: file, access: 'read', cwd: grant.home.path, io,
    }))).toMatchObject({ reason: 'cross_device', rootId: 'repo' });
  });

  it('refuses a read-only root write before opening anything', async () => {
    const root = await canonicalTmpDir('byok-guard-readonly-');
    const file = path.join(root, 'read.txt');
    await fs.writeFile(file, 'data');
    const grant = await grantWith(root, 'read');
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: file, access: 'write', cwd: grant.home.path,
    }))).toMatchObject({ reason: 'read_only', rootId: 'repo', access: 'write' });
  });

  it('refuses outside paths, .byok internals, and a cwd outside every root', async () => {
    const root = await canonicalTmpDir('byok-guard-outside-');
    const outside = await canonicalTmpDir('byok-guard-outside-file-');
    const grant = await grantWith(root);
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: path.join(outside, 'x.txt'), access: 'read', cwd: grant.home.path,
    }))).toMatchObject({ reason: 'outside_scope' });
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: path.join(grant.home.path, '.byok', 'agent-home.lease'), access: 'read', cwd: grant.home.path,
    }))).toMatchObject({ reason: 'internal_path' });
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: 'relative.txt', access: 'read', cwd: outside,
    }))).toMatchObject({ reason: 'cwd_outside_scope' });
  });

  it('expands ~ to the OS home and then treats it as outside the scope', async () => {
    const root = await canonicalTmpDir('byok-guard-tilde-');
    const grant = await grantWith(root);
    const osHome = await canonicalTmpDir('byok-guard-oshome-');
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: '~/secret.txt', access: 'read', cwd: grant.home.path, osHome,
    }))).toMatchObject({ reason: 'outside_scope' });
  });

  it('refuses Windows before target resolution', async () => {
    const root = await canonicalTmpDir('byok-guard-win-');
    const grant = await grantWith(root);
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: path.join(root, 'x'), access: 'read', cwd: grant.home.path, platform: 'win32',
    }))).toMatchObject({ code: 'file_scope_unsupported', reason: 'unsupported_platform' });
  });
});
