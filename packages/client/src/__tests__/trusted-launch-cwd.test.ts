import { describe, expect, it, vi } from 'vitest';
import { realpathSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MCP_LAUNCH_CWD_SHELL_SCRIPT,
  mcpLaunchAttestation,
  inspectTrustedLaunchCwd,
  resolveMcpLaunchCwdLauncher,
  resolveTrustedLaunchCwd,
  wrapMcpServerWithLaunchCwd,
  type LaunchCwdShellStat,
  type LaunchCwdShellStatEntry,
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

describe('read-only installed cwd facts, without ACL certification', () => {
  it('may observe a writable directory without proving it safe, while the full checker independently refuses', async () => {
    const root = await tempRoot();
    const uid = process.getuid ? vi.spyOn(process, 'getuid').mockReturnValue(NOBODY_UID) : undefined;
    const open = vi.spyOn(fs, 'open');
    try {
      expect(await inspectTrustedLaunchCwd(root)).toEqual({ kind: 'resolved', dir: root });
      expect(open).not.toHaveBeenCalled();
      expect(await resolveTrustedLaunchCwd({ dir: root }, { getuid: () => NOBODY_UID }))
        .toEqual({ kind: 'unavailable', reason: 'configured_dir_is_writable' });
      expect(open).toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    } finally { uid?.mockRestore(); open.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('refuses observed missing, file, nonabsolute and symlink shapes without writes or alternate cwd', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'file'); const link = path.join(root, 'link');
    await fs.writeFile(file, 'fixture'); await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    const open = vi.spyOn(fs, 'open');
    try {
      expect(await inspectTrustedLaunchCwd(path.join(root, 'missing'))).toEqual({ kind: 'unavailable', reason: 'configured_dir_unreadable' });
      expect(await inspectTrustedLaunchCwd(file)).toEqual({ kind: 'unavailable', reason: 'configured_dir_not_a_directory' });
      expect(await inspectTrustedLaunchCwd('relative')).toEqual({ kind: 'unavailable', reason: 'configured_dir_not_absolute' });
      expect(await inspectTrustedLaunchCwd(link)).toEqual({ kind: 'unavailable', reason: 'configured_dir_is_a_symlink' });
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

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

  it('is unavailable on win32 when this account can write %SystemRoot% — an elevated daemon', async () => {
    // The Windows counterpart of the uid-0 case above, and the one an operator
    // actually hits: a daemon running as Administrator CAN create files in
    // `%SystemRoot%`, so the write probe succeeds and no boundary is proven.
    // The refusal is correct — every MCP launch is then refused with this
    // reason, and the fix is to run the daemon non-elevated or to configure
    // `DaemonConfig.mcpLaunchCwd.dir` at a directory that account cannot write.
    //
    // `%SystemRoot%` is stood in for by a directory this test really can write,
    // so the probe that rejects is a real write and not an assumption. The uid
    // is spoofed to one that owns nothing here because real win32 has no
    // `getuid` at all: the ownership half of the check is skipped there and the
    // write probe carries the rejection alone, which is what this pins.
    const systemRoot = await tempRoot();
    await expect(resolveTrustedLaunchCwd(undefined, {
      platform: 'win32',
      getuid: () => NOBODY_UID,
      env: { SystemRoot: systemRoot },
    })).resolves.toEqual({ kind: 'unavailable', reason: 'platform_default_is_writable' });
    expect((await fs.readdir(systemRoot)).filter((n) => n.startsWith('.byok-launch-cwd-probe-'))).toEqual([]);
  });
});


/** A shell stat triple that answers with exactly what a case needs to pin. */
function fakeShellStat(
  answers: {
    link?: Partial<LaunchCwdShellStatEntry>;
    target?: Partial<LaunchCwdShellStatEntry>;
    realpath?: string;
    throws?: boolean;
  },
): LaunchCwdShellStat {
  const root = { uid: 0, mode: 0o100755, isFile: true };
  return {
    lstat: () => {
      if (answers.throws === true) throw new Error('ENOENT');
      return { ...root, ...answers.link };
    },
    stat: () => ({ ...root, ...answers.target }),
    realpath: () => answers.realpath ?? '/bin/dash',
  };
}

describe('the POSIX shell bootstrap program', () => {
  it('chdirs through $0 and execs the remaining argv, in the one form every tested sh accepts', () => {
    // Pinned as a literal, not rebuilt from parts: `exec -- "$@"` — the obvious
    // "safer" spelling — is rejected outright by dash (`exec: --: not found`,
    // exit 127), so the exact text is a verified fact about real shells rather
    // than a style choice. `cd --` IS required: it keeps a directory named `-L`
    // from being read as an option.
    expect(MCP_LAUNCH_CWD_SHELL_SCRIPT).toBe('cd -- "$0" && exec "$@"');
  });
});

describe('resolveMcpLaunchCwdLauncher', () => {
  it.skipIf(process.platform === 'win32')(
    'bootstraps through this machine\'s real system shell, and names the shell rather than a script file',
    () => {
      const launcher = resolveMcpLaunchCwdLauncher();
      expect(launcher).toEqual({
        kind: 'shell',
        interpreter: realpathSync('/bin/sh'),
        script: MCP_LAUNCH_CWD_SHELL_SCRIPT,
      });
      // Non-vacuous: the interpreter is a real executable on this machine, and
      // it is the one the OS would have run for `/bin/sh`.
      expect(statSync(realpathSync('/bin/sh')).isFile()).toBe(true);
    },
  );

  it('refuses a shell this uid could have written, rather than bootstrapping through it', () => {
    // Owned by an ordinary uid, not root: a shell the agent can replace is a
    // shell that would be running the agent's own program.
    //
    // The ownership is INJECTED rather than read off a file this test creates.
    // A real file carries whatever the host's filesystem reports, and on
    // Windows that is uid 0 with mode 0o666 — which would land on the
    // write-bit rejection instead, so the ownership rejection this case exists
    // to pin would never run. The mode here keeps every write bit but the
    // owner's clear, so ownership is the only thing left that can reject.
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ link: { uid: 501 }, target: { uid: 501, mode: 0o100755 } }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_not_root_owned' });
    // And the same non-root owner behind a root-owned link: the target's own
    // ownership is checked too, not just the link's.
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ target: { uid: 501, mode: 0o100755 } }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_not_root_owned' });
  });

  it('refuses a root-owned shell that anyone but root can write', () => {
    // Group-writable, which a non-root test process cannot create on disk, so
    // the stat triple is injected while everything else stays real.
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ target: { mode: 0o100775 } }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_writable' });
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ target: { mode: 0o100757 } }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_writable' });
  });

  it('follows the /bin/sh symlink but refuses when the link itself is not root-owned', () => {
    // dash and busybox both sit behind a symlink named `sh`. Whoever owns the
    // LINK chooses the target, so the link is checked as well as what it names.
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ link: { uid: 1000 }, realpath: '/usr/bin/dash' }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_not_root_owned' });
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ realpath: '/usr/bin/dash' }),
    })).toEqual({ kind: 'shell', interpreter: '/usr/bin/dash', script: MCP_LAUNCH_CWD_SHELL_SCRIPT });
  });

  it('refuses a shell that is not a regular file, and one it cannot inspect at all', () => {
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ target: { isFile: false } }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_not_a_regular_file' });
    expect(resolveMcpLaunchCwdLauncher(undefined, {
      platform: 'linux',
      shellStat: fakeShellStat({ throws: true }),
    })).toEqual({ kind: 'unavailable', reason: 'launch_cwd_shell_unreadable' });
  });

  it('runs the shipped launcher script on a real Node host on win32', () => {
    expect(resolveMcpLaunchCwdLauncher(undefined, { platform: 'win32' })).toEqual({
      kind: 'node',
      interpreter: process.execPath,
      script: expect.stringMatching(/bin[/\\]byok-launch-cwd\.mjs$/u),
    });
  });

  it('refuses a win32 host that cannot run the launcher script it would be handed', () => {
    // A compiled-Bun product executable reads `$cwd/bunfig.toml` `preload`
    // before the launcher's first statement — the exact vector this boundary
    // closes — so there is no launcher for it and no fallback to one.
    Object.defineProperty(process.versions, 'bun', { value: '1.4.2', configurable: true });
    try {
      expect(resolveMcpLaunchCwdLauncher(undefined, { platform: 'win32' }))
        .toEqual({ kind: 'unavailable', reason: 'launch_cwd_launcher_unavailable' });
    } finally {
      delete (process.versions as Record<string, unknown>).bun;
    }
    // And a POSIX host of the same shape still has a trusted launcher, because
    // the shell bootstrap needs no Node at all.
    Object.defineProperty(process.versions, 'bun', { value: '1.4.2', configurable: true });
    try {
      expect(resolveMcpLaunchCwdLauncher(undefined, { platform: 'linux', shellStat: fakeShellStat({}) }))
        .toMatchObject({ kind: 'shell' });
    } finally {
      delete (process.versions as Record<string, unknown>).bun;
    }
  });

  it('takes an operator-attested interpreter on either platform, and refuses a relative one', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(resolveMcpLaunchCwdLauncher({ launcherInterpreter: '/usr/local/bin/node' }, { platform }))
        .toEqual({
          kind: 'node',
          interpreter: '/usr/local/bin/node',
          script: expect.stringMatching(/bin[/\\]byok-launch-cwd\.mjs$/u),
        });
    }
    expect(() => resolveMcpLaunchCwdLauncher({ launcherInterpreter: 'node' })).toThrow(/absolute executable path/u);
  });
});

describe('wrapMcpServerWithLaunchCwd', () => {
  const shell = { cwd: '/', launcher: { kind: 'shell', interpreter: '/bin/dash', script: MCP_LAUNCH_CWD_SHELL_SCRIPT } } as const;
  const node = { cwd: '/', launcher: { kind: 'node', interpreter: '/usr/bin/node', script: '/pkg/bin/byok-launch-cwd.mjs' } } as const;
  const args = ['a b', '"q"', "'q'", '$(id)', '`id`', ';rm -rf /', 'line\nbreak', '-n', '--', ''];

  it('hands the shell its program text and the target argv as positional parameters, never interpolated', () => {
    expect(wrapMcpServerWithLaunchCwd({ command: '/opt/server', args }, shell)).toEqual({
      command: '/bin/dash',
      args: ['-c', 'cd -- "$0" && exec "$@"', '/', '/opt/server', ...args],
    });
  });

  it('hands the Node launcher the same argv with no -c, since it is a script and not a shell', () => {
    expect(wrapMcpServerWithLaunchCwd({ command: '/opt/server', args }, node)).toEqual({
      command: '/usr/bin/node',
      args: ['/pkg/bin/byok-launch-cwd.mjs', '/', '/opt/server', ...args],
    });
  });

  it('leaves the task-scoped env alone and tolerates a server with no args', () => {
    expect(wrapMcpServerWithLaunchCwd({ command: '/opt/server', env: { A: '1' } }, shell)).toEqual({
      command: '/bin/dash',
      args: ['-c', 'cd -- "$0" && exec "$@"', '/', '/opt/server'],
      env: { A: '1' },
    });
  });

  it('refuses a target this launch shape cannot address unambiguously', () => {
    // A relative cwd is resolved by `cd` through CDPATH; a command starting
    // with `-` is read by `exec` as one of its own options; a relative command
    // is a PATH lookup done after the chdir, which is not the identity the
    // binding attested. None of the three is repaired here.
    expect(() => wrapMcpServerWithLaunchCwd({ command: '/opt/server' }, { ...shell, cwd: 'releases/1.2.3' }))
      .toThrow(/launch_cwd_binding_cwd_not_absolute/u);
    expect(() => wrapMcpServerWithLaunchCwd({ command: '-n' }, shell))
      .toThrow(/launch_cwd_target_command_option_like/u);
    expect(() => wrapMcpServerWithLaunchCwd({ command: 'salesko-agent' }, shell))
      .toThrow(/launch_cwd_target_command_not_absolute/u);
    // The same refusals on the Node launcher: the binding's meaning does not
    // change with the mechanism that carries it out.
    expect(() => wrapMcpServerWithLaunchCwd({ command: 'salesko-agent' }, node))
      .toThrow(/launch_cwd_target_command_not_absolute/u);
  });
});

describe('mcpLaunchAttestation', () => {
  it('records the directory, and an explicit null for a launcher that was not used', () => {
    expect(mcpLaunchAttestation({ cwd: '/' })).toEqual({ launchCwd: '/', launcher: null });
    expect(mcpLaunchAttestation({ cwd: '/', launcher: { kind: 'node', interpreter: '/n', script: '/s' } }))
      .toEqual({ launchCwd: '/', launcher: { kind: 'node', interpreter: '/n', script: '/s' } });
  });

  it('distinguishes a shell bootstrap from a Node launcher that was handed the same strings', () => {
    // Without `kind` in the bound value these two would be one attestation, and
    // a host that silently moved between launch mechanisms would not be drift.
    const asShell = mcpLaunchAttestation({ cwd: '/', launcher: { kind: 'shell', interpreter: '/x', script: '/y' } });
    const asNode = mcpLaunchAttestation({ cwd: '/', launcher: { kind: 'node', interpreter: '/x', script: '/y' } });
    expect(asShell).not.toEqual(asNode);
    expect(JSON.stringify(asShell)).not.toBe(JSON.stringify(asNode));
  });
});
