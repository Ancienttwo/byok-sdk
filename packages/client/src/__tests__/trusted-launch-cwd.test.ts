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
    const writable = await tempRoot();
    await expect(resolveTrustedLaunchCwd({ dir: writable }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'configured_dir_is_writable' });
    // The rejection is a real write that happened and was cleaned up, not a
    // mode-bit inspection.
    expect((await fs.readdir(writable)).filter((n) => n.startsWith('.byok-launch-cwd-probe-'))).toEqual([]);
  });

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
