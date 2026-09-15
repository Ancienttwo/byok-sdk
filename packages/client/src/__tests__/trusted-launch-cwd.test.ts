import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  mcpLaunchAttestation,
  resolveMcpLaunchCwdLauncher,
  resolveTrustedLaunchCwd,
  wrapMcpServerWithLaunchCwd,
} from '../daemon/trusted-launch-cwd';

/**
 * A uid that owns nothing under `os.tmpdir()` here, injected so an ownership
 * rejection cannot stand in for the write-probe rejection a case is pinning.
 * The probes themselves still run as the real uid, so what they measure is the
 * real filesystem.
 */
const NOBODY_UID = 65534;

async function tempRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-launch-cwd-')));
}

describe('resolveTrustedLaunchCwd', () => {
  it('resolves the platform default and leaves no probe file behind', async () => {
    const resolved = await resolveTrustedLaunchCwd();
    expect(resolved).toEqual({ kind: 'resolved', dir: process.platform === 'win32' ? expect.any(String) : '/' });
    if (resolved.kind !== 'resolved') return;
    const entries = await fs.readdir(resolved.dir);
    expect(entries.filter((name) => name.startsWith('.byok-launch-cwd-probe-'))).toEqual([]);
  });

  it('REJECTS a directory this same uid can write — the negative control', async () => {
    // Without this case every assertion above is vacuous: a resolver that
    // accepted anything would still "prove" a boundary. `os.tmpdir()` is the
    // exact shape of directory that looks isolated (0700, random name) and is
    // not, because the agent's tools run at this same uid.
    //
    // The uid is spoofed to one that owns nothing here so the OWNERSHIP check
    // cannot be what rejects this: the write probe has to carry it alone, which
    // is the thing this case exists to prove still works.
    const writable = await tempRoot();
    await expect(resolveTrustedLaunchCwd({ dir: writable }, { getuid: () => NOBODY_UID }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_is_writable' });
    // The rejection is a real write that happened and was cleaned up, not a
    // mode-bit inspection.
    expect((await fs.readdir(writable)).filter((n) => n.startsWith('.byok-launch-cwd-probe-'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'REJECTS a 0555 directory OWNED by this uid, whose mode its owner can simply change back',
    async () => {
      // A cleared write bit is not a boundary against the uid that owns the
      // directory: the agent runs at that uid and `chmod`ping it back is one
      // syscall. The resolver must refuse on ownership, before the probe's
      // EACCES can make this look isolated.
      const owned = path.join(await tempRoot(), 'release');
      await fs.mkdir(owned, 0o555);
      await expect(resolveTrustedLaunchCwd({ dir: owned }))
        .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_owned_by_current_uid' });

      // Non-vacuous: this same uid really can take the write bit back, which is
      // exactly why the EACCES the probe would have seen proves nothing here.
      await fs.chmod(owned, 0o755);
      await fs.writeFile(path.join(owned, 'bunfig.toml'), 'preload = ["./x.js"]\n');
      expect(await fs.readdir(owned)).toEqual(['bunfig.toml']);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'REJECTS a non-writable directory whose PARENT this uid can write — rename replaces it wholesale',
    async () => {
      // `rename(2)` needs write permission on the parent, not on the directory
      // being replaced. A 0555 leaf under a writable parent can therefore be
      // swapped for an attacker-controlled directory at the same path, so the
      // leaf's own mode says nothing. The uid is spoofed again so the leaf and
      // the parent both pass the ownership check and the ANCESTOR write probe
      // is what has to reject.
      const parent = await tempRoot();
      const leaf = path.join(parent, 'release');
      await fs.mkdir(leaf, 0o555);
      await expect(resolveTrustedLaunchCwd({ dir: leaf }, { getuid: () => NOBODY_UID }))
        .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_ancestor_writable' });

      // Non-vacuous: the replacement the rejection is about really is possible.
      const planted = path.join(parent, 'planted');
      await fs.mkdir(planted);
      await fs.rename(planted, leaf + '-moved');
      await fs.rm(leaf + '-moved', { recursive: true });
    },
  );

  it('rejects a symlink even when it points at a directory that would pass', async () => {
    const root = await tempRoot();
    const link = path.join(root, 'root-link');
    await fs.symlink('/', link);
    await expect(resolveTrustedLaunchCwd({ dir: link }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_is_a_symlink' });
  });

  it('rejects a path that is not a directory, and one that does not exist', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'a-file');
    await fs.writeFile(file, 'x');
    await expect(resolveTrustedLaunchCwd({ dir: file }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_not_a_directory' });
    await expect(resolveTrustedLaunchCwd({ dir: path.join(root, 'absent') }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_unreadable' });
  });

  it('rejects a relative configured directory', async () => {
    await expect(resolveTrustedLaunchCwd({ dir: 'relative/dir' }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_not_absolute' });
  });

  it('is unavailable as root, because no directory is unwritable by uid 0', async () => {
    await expect(resolveTrustedLaunchCwd(undefined, { getuid: () => 0 }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'root_cannot_prove_write_boundary' });
    // Even a configured directory that would otherwise pass: root is refused
    // before any candidate is looked at, so the reason names the real cause.
    await expect(resolveTrustedLaunchCwd({ dir: '/' }, { getuid: () => 0 }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'root_cannot_prove_write_boundary' });
  });

  it('reports the missing system root rather than guessing one on win32', async () => {
    await expect(resolveTrustedLaunchCwd(undefined, { platform: 'win32', getuid: () => 501, env: {} }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'no_platform_default_directory' });
  });
});

describe('resolveMcpLaunchCwdLauncher', () => {
  it('uses this plain-Node process as the interpreter and this package\'s own script', () => {
    const launcher = resolveMcpLaunchCwdLauncher();
    expect(launcher).toEqual({
      kind: 'resolved',
      interpreter: process.execPath,
      script: expect.stringMatching(/bin[/\\]byok-launch-cwd\.mjs$/u),
    });
  });

  it('prefers an operator-attested interpreter and refuses a relative one', () => {
    expect(resolveMcpLaunchCwdLauncher({ launcherInterpreter: '/usr/local/bin/node' }))
      .toMatchObject({ kind: 'resolved', interpreter: '/usr/local/bin/node' });
    expect(() => resolveMcpLaunchCwdLauncher({ launcherInterpreter: 'node' })).toThrow(/absolute executable path/u);
  });
});

describe('wrapMcpServerWithLaunchCwd', () => {
  const binding = {
    cwd: '/',
    launcher: { interpreter: '/usr/bin/node', script: '/pkg/bin/byok-launch-cwd.mjs' },
  } as const;

  it('carries every argument through structurally, shell metacharacters included', () => {
    const args = ['a b', '"q"', "'q'", '$(id)', '`id`', ';rm -rf /', 'line\nbreak', '-n', '--', ''];
    expect(wrapMcpServerWithLaunchCwd({ command: '/opt/server', args }, binding)).toEqual({
      command: '/usr/bin/node',
      args: ['/pkg/bin/byok-launch-cwd.mjs', '/', '/opt/server', ...args],
    });
  });

  it('leaves the task-scoped env alone and tolerates a server with no args', () => {
    expect(wrapMcpServerWithLaunchCwd({ command: '/opt/server', env: { A: '1' } }, binding)).toEqual({
      command: '/usr/bin/node',
      args: ['/pkg/bin/byok-launch-cwd.mjs', '/', '/opt/server'],
      env: { A: '1' },
    });
  });
});

describe('mcpLaunchAttestation', () => {
  it('records the directory, and an explicit null for a launcher that was not used', () => {
    expect(mcpLaunchAttestation({ cwd: '/' })).toEqual({ launchCwd: '/', launcher: null });
    expect(mcpLaunchAttestation({ cwd: '/', launcher: { interpreter: '/n', script: '/s' } }))
      .toEqual({ launchCwd: '/', launcher: { interpreter: '/n', script: '/s' } });
  });
});
