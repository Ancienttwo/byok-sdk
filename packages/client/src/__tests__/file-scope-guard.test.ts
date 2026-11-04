import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';
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
  return realpathSync.native(await tmpDir(prefix));
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
    attempt: { homeAccess: 'writer' }, home: { path: home, identity },
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
      fileScope: { mode: 'home' }, attempt: { homeAccess: 'writer' }, home: { path: home, identity: wrong },
    }))).toMatchObject({ code: 'file_scope_unavailable', reason: 'root_identity_changed', rootId: 'home' });
  });

  it('refuses unknown platforms without touching the filesystem', async () => {
    const { home, identity } = await fixture();
    expect(await guardReason(() => resolveFileScopeGrant({
      fileScope: { mode: 'home' }, attempt: { homeAccess: 'writer' }, home: { path: home, identity }, platform: 'freebsd',
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

  it('refuses .byok case variants for read and write without touching the internal file', async () => {
    const grant = await grantWith(await canonicalTmpDir('byok-guard-case-'));
    const internal = path.join(grant.home.path, '.byok');
    await fs.mkdir(internal);
    await fs.writeFile(path.join(internal, 'secret.txt'), 'unchanged');
    for (const target of ['.BYOK/secret.txt', '.Byok/secret.txt', '.BYOK/new.txt']) {
      for (const access of ['read', 'write'] as const) {
        expect(await guardReason(() => resolveFileScopeTarget({
          grant, path: path.join(grant.home.path, target), access, cwd: grant.home.path,
        }))).toMatchObject({ code: 'file_scope_denied', reason: 'internal_path' });
      }
    }
    await expect(fs.readFile(path.join(internal, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
    expect(await fs.readdir(internal)).toEqual(['secret.txt']);
  });

  it('refuses a path that only canonicalizes into .byok', async () => {
    const { home, identity } = await fixture();
    const grant = await resolveFileScopeGrant({ fileScope: { mode: 'home' }, attempt: { homeAccess: 'writer' }, home: { path: home, identity } });
    const alias = path.join(home, 'alias');
    await fs.mkdir(alias);
    const io: FileScopeIo = {
      ...nodeFileScopeIo,
      realpath: async (candidate) => candidate === alias ? path.join(home, '.byok', 'runs') : nodeFileScopeIo.realpath(candidate),
    };
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: path.join(alias, 'new.txt'), access: 'write', cwd: home, io,
    }))).toMatchObject({ code: 'file_scope_denied', reason: 'internal_path' });
  });

  async function readerGrant(): Promise<{ home: string; run: string; grant: FileScopeGrant }> {
    const { home, identity } = await fixture();
    const run = path.join(home, '.byok', 'runs', 'reader-1');
    await fs.mkdir(run, { recursive: true });
    const grant = await resolveFileScopeGrant({
      fileScope: { mode: 'home' }, attempt: { homeAccess: 'memory-reader', cwd: run }, home: { path: home, identity },
    });
    return { home, run, grant };
  }

  it('gives a memory reader a read-only home and its run root, and keeps the rest of .byok internal', async () => {
    const { home, run, grant } = await readerGrant();
    expect(grant.home.access).toBe('read');
    expect(grant.run).toEqual({ id: 'run', path: run, lexicalPath: run, access: 'write', identity: await identityOf(run) });
    await fs.writeFile(path.join(home, 'notes.md'), 'memory');
    await expect(resolveFileScopeTarget({ grant, path: path.join(home, 'notes.md'), access: 'read', cwd: run }))
      .resolves.toMatchObject({ root: { id: 'home' }, exists: true });
    await expect(resolveFileScopeTarget({ grant, path: 'out.txt', access: 'write', cwd: run }))
      .resolves.toMatchObject({ root: { id: 'run' }, path: path.join(run, 'out.txt'), exists: false });
    expect(await guardReason(() => resolveFileScopeTarget({ grant, path: path.join(home, 'notes.md'), access: 'write', cwd: run })))
      .toMatchObject({ code: 'file_scope_denied', reason: 'read_only', rootId: 'home' });
    for (const target of [
      path.join(home, '.byok', 'runs', 'other', 'x.txt'), path.join(home, '.byok', 'agent-home.lease'),
      path.join(run, '.byok', 'x.txt'), path.join(home, '.BYOK', 'runs', 'reader-1', 'x.txt'),
      // win32: a case-variant home prefix, an 8.3 profile prefix and the 8.3 name of .byok.
      ...(process.platform === 'win32' ? [
        path.join(home.toUpperCase(), '.byok', 'runs', 'reader-1', 'x.txt'),
        path.join(os.tmpdir(), path.basename(home), '.byok', 'runs', 'reader-1', 'x.txt'),
        path.join(home, 'BYOK~1', 'runs', 'reader-1', 'x.txt'),
      ] : []),
    ]) {
      expect(await guardReason(() => resolveFileScopeTarget({ grant, path: target, access: 'read', cwd: run })))
        .toMatchObject({ code: 'file_scope_denied', reason: 'internal_path' });
    }
  });

  it('refuses a run-root symlink into home and an alias that reaches the run root through home', async () => {
    const { home, run, grant } = await readerGrant();
    await fs.symlink(home, path.join(run, 'link'), 'dir');
    expect(await guardReason(() => resolveFileScopeTarget({ grant, path: path.join(run, 'link', 'x.txt'), access: 'write', cwd: run })))
      .toMatchObject({ code: 'file_scope_denied', reason: 'symlink', rootId: 'run' });
    await expect(fs.access(path.join(home, 'x.txt'))).rejects.toThrow();
    const alias = path.join(home, 'alias');
    await fs.mkdir(alias);
    const io: FileScopeIo = {
      ...nodeFileScopeIo,
      realpath: async (candidate) => candidate === alias ? run : nodeFileScopeIo.realpath(candidate),
    };
    expect(await guardReason(() => resolveFileScopeTarget({ grant, path: path.join(alias, 'x.txt'), access: 'read', cwd: run, io })))
      .toMatchObject({ code: 'file_scope_denied', reason: 'internal_path' });
  });

  it('expands ~ to the OS home and then treats it as outside the scope', async () => {
    const root = await canonicalTmpDir('byok-guard-tilde-');
    const grant = await grantWith(root);
    const osHome = await canonicalTmpDir('byok-guard-oshome-');
    expect(await guardReason(() => resolveFileScopeTarget({
      grant, path: '~/secret.txt', access: 'read', cwd: grant.home.path, osHome,
    }))).toMatchObject({ reason: 'outside_scope' });
  });

  it('refuses the win32 path syntax before any filesystem access', async () => {
    const grant = await grantWith(await canonicalTmpDir('byok-guard-win-'));
    const untouched = async (): Promise<never> => { throw new Error('unexpected filesystem access'); };
    const io: FileScopeIo = { lstat: untouched, stat: untouched, realpath: untouched, open: untouched };
    for (const target of [
      'a.txt:x', 'a.txt::$DATA', 'NUL', 'nul.txt', 'CON.txt', 'COM\u00b9', 'lpt0', 'CONIN$', 'trail.', 'space ', 'dir.\\x.txt',
      '\\\\server\\share\\x', '\\\\?\\C:\\work\\x', '//?/C:/work/x', '\\\\.\\C:\\work\\x', 'C:x', '\\x', '/x',
    ]) {
      expect(await guardReason(() => resolveFileScopeTarget({
        grant, path: target, access: 'write', cwd: 'C:\\work', platform: 'win32', io,
      })), target).toMatchObject({ code: 'file_scope_denied', reason: 'path_syntax' });
    }
  });
});

// Real NTFS behaviour (#1423 PR-2a evidence): 8.3 names exist on the runner's C:.
describe.runIf(process.platform === 'win32')('file-scope guard on win32 (#1423)', () => {
  async function homeGrant(): Promise<{ home: string; grant: FileScopeGrant }> {
    const { home, identity } = await fixture();
    return { home, grant: await resolveFileScopeGrant({ fileScope: { mode: 'home' }, attempt: { homeAccess: 'writer' }, home: { path: home, identity } }) };
  }

  it('canonicalizes 8.3 and case variants of a home path onto the long names', async () => {
    const { home, grant } = await homeGrant();
    const dir = path.join(home, 'Long Directory Alpha');
    await fs.mkdir(dir);
    const file = path.join(dir, 'Long File Name Alpha.txt');
    await fs.writeFile(file, 'alpha');
    // os.tmpdir() on the runner is C:\Users\RUNNER~1\…, an 8.3 spelling of the home's parent.
    const viaTmp = path.join(os.tmpdir(), path.basename(home));
    for (const variant of [
      path.join(home, 'LONGDI~1', 'LONGFI~1.TXT'), path.join(viaTmp, 'Long Directory Alpha', 'Long File Name Alpha.txt'),
      file.toUpperCase(), file[0]!.toLowerCase() + file.slice(1),
    ]) {
      await expect(resolveFileScopeTarget({ grant, path: variant, access: 'write', cwd: home }), variant)
        .resolves.toMatchObject({ path: file, exists: true, root: { id: 'home' } });
    }
    await expect(resolveFileScopeTarget({ grant, path: path.join(viaTmp, 'LONGDI~1', 'new.txt'), access: 'write', cwd: home }))
      .resolves.toMatchObject({ path: path.join(dir, 'new.txt'), exists: false });
    // An 8.3-form name with no long owner is an ordinary new name.
    await expect(resolveFileScopeTarget({ grant, path: 'LONGFI~7.TXT', access: 'write', cwd: home }))
      .resolves.toMatchObject({ path: path.join(home, 'LONGFI~7.TXT'), exists: false });
    await expect(resolveFileScopeTarget({ grant, path: '.', access: 'read', cwd: home, kind: 'directory' }))
      .resolves.toMatchObject({ path: home, exists: true });
  });

  it('refuses a junction escape, an 8.3 alias outside the root and the 8.3 name of .byok', async () => {
    const { home, grant } = await homeGrant();
    const outside = await canonicalTmpDir('byok-guard-win-outside-');
    await fs.symlink(outside, path.join(home, 'jn'), 'junction');
    expect(await guardReason(() => resolveFileScopeTarget({ grant, path: path.join(home, 'jn', 'new.txt'), access: 'write', cwd: home })))
      .toMatchObject({ code: 'file_scope_denied', reason: 'symlink' });
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toThrow();
    const parent = await canonicalTmpDir('byok-guard-win-alias-');
    const root = path.join(parent, 'root');
    await fs.mkdir(root);
    await fs.mkdir(path.join(parent, 'Outside Directory Name'));
    const rootGrant = await grantWith(root);
    expect(await guardReason(() => resolveFileScopeTarget({ grant: rootGrant, path: root + '\\..\\OUTSID~1\\x.txt', access: 'read', cwd: root })))
      .toMatchObject({ code: 'file_scope_denied', reason: 'outside_scope' });
    await fs.mkdir(path.join(home, '.byok'));
    for (const target of [path.join(home, 'BYOK~1', 'x.txt'), path.join(home, '.BYOK', 'x.txt')]) {
      expect(await guardReason(() => resolveFileScopeTarget({ grant, path: target, access: 'read', cwd: home })), target)
        .toMatchObject({ code: 'file_scope_denied', reason: 'internal_path' });
    }
  });

  // A second volume and mountvol exist on the GitHub Windows runner (D:, administrator).
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('refuses another volume, a junction to it and a volume mount point', async () => {
    const { home, grant } = await homeGrant();
    const other = realpathSync.native(await fs.mkdtemp(path.join(process.env.RUNNER_TEMP!, 'byok-guard-d-')));
    dirs.push(other);
    expect(path.parse(other).root).not.toBe(path.parse(home).root);
    await fs.writeFile(path.join(other, 'd.txt'), 'd');
    await fs.symlink(other, path.join(home, 'to-d'), 'junction');
    const mountvol = path.join(process.env.SystemRoot!, 'System32', 'mountvol.exe');
    const mount = path.join(home, 'mnt');
    await fs.mkdir(mount);
    // A recursive rm of the home must never walk into the mounted volume.
    dirs.splice(dirs.indexOf(home), 1);
    execFileSync(mountvol, [mount + '\\', execFileSync(mountvol, [path.parse(other).root, '/L'], { encoding: 'utf8' }).trim()]);
    try {
      expect(await guardReason(() => resolveFileScopeTarget({ grant, path: path.join(other, 'd.txt'), access: 'read', cwd: home })))
        .toMatchObject({ code: 'file_scope_denied', reason: 'outside_scope' });
      expect(await guardReason(() => resolveFileScopeTarget({ grant, path: path.join(home, 'to-d', 'd.txt'), access: 'read', cwd: home })))
        .toMatchObject({ code: 'file_scope_denied', reason: 'symlink' });
      const throughMount = path.join(mount, path.relative(path.parse(other).root, other), 'new.txt');
      expect(await guardReason(() => resolveFileScopeTarget({ grant, path: throughMount, access: 'write', cwd: home })))
        .toMatchObject({ code: 'file_scope_denied', reason: 'outside_scope' });
      await expect(fs.access(path.join(other, 'new.txt'))).rejects.toThrow();
    } finally {
      execFileSync(mountvol, [mount + '\\', '/D']);
    }
    dirs.push(home);
  });
});
