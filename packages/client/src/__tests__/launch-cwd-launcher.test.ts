import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  launchCwdScriptPath,
  resolveMcpLaunchCwdLauncher,
  wrapMcpServerWithLaunchCwd,
} from '../daemon/trusted-launch-cwd';
import { LOADER_ENV_DENY_PATTERNS } from '../daemon/environment';
import type { McpStdioServerConfig } from '../types';

const LAUNCHER = launchCwdScriptPath();

/**
 * WHY THE LAUNCH DIRECTORY HERE IS TEST-OWNED, AND NOT `resolveTrustedLaunchCwd()`.
 *
 * The properties this file pins are the LAUNCHER's: that it chdirs before it
 * execs, that argv arrives byte-identical, that the target's exit code and
 * death-by-signal pass through, that a loader environment variable or a
 * non-empty interpreter argv is refused, and that a directory it cannot change
 * into is refused before the target ever runs. None of those depend on WHICH
 * directory it was handed — the launcher is given a directory and obeys it.
 *
 * Whether a given directory can be PROVEN non-writable is a separate,
 * daemon-side authority decision with its own suite
 * (`trusted-launch-cwd.test.ts`). Binding this file to that decision made the
 * launcher untestable on a host where the proof legitimately fails: on
 * windows-latest the CI runner executes as Administrator, so the platform
 * default `%SystemRoot%` IS writable and `resolveTrustedLaunchCwd()` correctly
 * returns `platform_default_is_writable` (the same posture as uid 0 on POSIX).
 * That refusal is correct behaviour, not a launcher defect — but with the
 * fixture resolving through it, 8 of these 10 cases died at the fixture; the
 * launcher's only Windows execution in that run was the chdir-refusal case, and
 * it never reached a successful exec of a target (run 34960882911).
 *
 * So the launch cwd below is a directory this test owns. It is deliberately one
 * the test process CAN write: that makes the point explicit — the launcher's
 * behaviour is identical regardless of the directory's trust status, which is
 * precisely why the trust decision belongs to the daemon and not here.
 *
 * SCOPE, stated plainly so no reader upgrades it: `launchDir()` is a LAUNCHER
 * FIXTURE. It is not a trusted directory, nothing in the product accepts it as
 * one, and a green run of this file is NOT an end-to-end trusted-launch PASS.
 * What these cases prove is the launcher's argv, cwd and exit/signal semantics.
 * They prove nothing about directory trust.
 */
async function launchDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-launch-cwd-target-')));
}

/**
 * A target that reports EXACTLY what it was given: the argv it received after
 * its own script path, and the directory it started in. Everything this suite
 * asserts about the launcher is read back out of a real child process.
 */
const TARGET = `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd() }));
if (process.argv.includes('--hang')) setInterval(() => {}, 1000);
else process.exit(Number(process.env.TARGET_EXIT ?? '0'));
`;

async function fixture(): Promise<{ dir: string; target: string; out: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-launcher-')));
  const target = path.join(dir, 'target.mjs');
  await fs.writeFile(target, TARGET);
  return { dir, target, out: path.join(dir, 'report.json') };
}

interface Run { code: number | null; signal: NodeJS.Signals | null; stderr: string }

function run(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; execArgv?: readonly string[]; onSpawn?: (pid: number) => void } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(options.execArgv ?? []), LAUNCHER, ...args],
      {
        // A clean env by default: the launcher's own loader environment is
        // part of what it refuses on, so a stray NODE_OPTIONS on the
        // developer's shell must not decide these results.
        env: options.env ?? { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: path.dirname(LAUNCHER),
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

describe('bin/byok-launch-cwd.mjs', () => {
  it('execs the target in the launch directory it was given, never in its own', async () => {
    const { target, out } = await fixture();
    const dir = await launchDir();
    const result = await run([dir, process.execPath, target, out]);
    expect(result).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { cwd: string };
    expect(await fs.realpath(report.cwd)).toBe(await fs.realpath(dir));
    expect(report.cwd).not.toBe(path.dirname(LAUNCHER));
  });

  it('forwards every argument byte-identically, shell metacharacters included', async () => {
    const { target, out } = await fixture();
    const argv = ['a b', '"double"', "'single'", '$(id)', '`id`', ';rm -rf /', 'new\nline', '-n', '--', '', 'tab\there'];
    const result = await run([await launchDir(), process.execPath, target, out, ...argv]);
    expect(result.code).toBe(0);
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { argv: string[] };
    expect(report.argv).toEqual(argv);
  });

  it('forwards the target exit code', async () => {
    const { target, out } = await fixture();
    const result = await run([await launchDir(), process.execPath, target, out], {
      env: { PATH: process.env.PATH ?? '', TARGET_EXIT: '37' },
    });
    expect(result.code).toBe(37);
  });

  it('forwards SIGTERM to the target and dies of the same signal', async () => {
    const { target, out } = await fixture();
    let pid: number | undefined;
    const finished = run([await launchDir(), process.execPath, target, out, '--hang'], {
      onSpawn: (spawned) => { pid = spawned; },
    });
    await expect.poll(async () => {
      try {
        await fs.access(out);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5_000 }).toBe(true);
    process.kill(pid!, 'SIGTERM');
    await expect(finished).resolves.toMatchObject({ signal: 'SIGTERM' });
  });

  it('refuses to launch when a loader environment variable is set', async () => {
    const { target, out } = await fixture();
    // Benign VALUES on purpose: what is asserted is that the launcher refuses
    // on the NAME, before it can matter what the value would have done.
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'BUN_CONFIG_PRELOAD', 'DYLD_FRAMEWORK_PATH', 'LD_LIBRARY_PATH']) {
      const result = await run([await launchDir(), process.execPath, target, out], {
        env: { PATH: process.env.PATH ?? '', [name]: name === 'NODE_OPTIONS' ? '--title=x' : path.dirname(LAUNCHER) },
      });
      expect(result.code, name).toBe(78);
      expect(result.stderr).toContain(name);
    }
    await expect(fs.access(out)).rejects.toThrow();
  });

  it('refuses to launch when its own interpreter argv is not empty', async () => {
    const { target, out } = await fixture();
    const result = await run([await launchDir(), process.execPath, target, out], { execArgv: ['--title=injected'] });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/non-empty interpreter argv/u);
    await expect(fs.access(out)).rejects.toThrow();
  });

  it('refuses a directory it cannot change into, and never execs the target', async () => {
    const { dir, target, out } = await fixture();
    const result = await run([path.join(dir, 'absent'), process.execPath, target, out]);
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/could not change directory/u);
    await expect(fs.access(out)).rejects.toThrow();
  });
});

/**
 * The 17 argument classes the shell bootstrap was verified against on dash
 * 0.5.12, bash 5.2.37 invoked as `sh`, busybox ash and macOS `/bin/sh`. Each
 * one is a shape that a shell WOULD have mangled had the launcher pasted it
 * into a command line instead of passing it as a positional parameter.
 */
const ARGV_CLASSES = [
  'a b',
  'tab\there',
  'new\nline',
  '"double"',
  "'single'",
  '$HOME',
  '`id`',
  '*',
  '-n',
  '--',
  '',
  'back\\slash',
  ';rm -rf /',
  '&& echo pwned',
  '~',
  'ünïcödé — ✓',
  '%s',
];

/**
 * A target that reports the bytes it actually received. argv is hex-encoded so
 * the assertion is on bytes, not on anything a terminal, a JSON reader or a
 * shell could have normalised on the way back.
 */
const BYTE_TARGET = `
import fs from 'node:fs';
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
fs.writeFileSync(process.argv[2], JSON.stringify({
  argv: process.argv.slice(3).map(hex),
  cwd: fs.realpathSync(process.cwd()),
}));
process.exit(42);
`;

function spawnWrapped(server: McpStdioServerConfig, cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, [...(server.args ?? [])], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

/**
 * The launcher this machine would really be handed, exercised end to end as a
 * real process pair: the POSIX `/bin/sh` bootstrap on ubuntu-latest and
 * macos-latest, `bin/byok-launch-cwd.mjs` on windows-latest. This file is
 * included in the macos-latest and windows-latest job configuration
 * (`.github/workflows/ci.yml`) — that is scheduling, not a result. Windows
 * evidence exists only once the windows-latest leg has run green on a pushed
 * candidate; until then the win32 launcher is code path + unit tests only,
 * which is what `docs/spec.md` states. Deliberately NOT skipped anywhere: the
 * windows leg is the only real Windows host this boundary can ever be run on.
 *
 * The binding is constructed directly, from this file's own `launchDir()` and
 * `resolveMcpLaunchCwdLauncher()`, rather than through a daemon: what is under
 * test here is the launcher, and the directory proof has its own suite
 * (`trusted-launch-cwd.test.ts`) — see the note on `launchDir` above for why
 * this file must not route its fixture through that proof.
 */
describe('the launcher this host resolves, as a real process', () => {
  it('starts the target in the launch directory it was given, not in the directory it was spawned from', async () => {
    const { dir, out } = await fixture();
    const target = path.join(dir, 'byte-target.mjs');
    await fs.writeFile(target, BYTE_TARGET);
    const launchCwd = await launchDir();
    const launcher = resolveMcpLaunchCwdLauncher();
    if (launcher.kind === 'unavailable') throw new Error(`no launcher on this host: ${launcher.reason}`);

    const wrapped = wrapMcpServerWithLaunchCwd(
      { command: process.execPath, args: [target, out] },
      { cwd: launchCwd, launcher },
    );
    // Spawned from the fixture directory, which is exactly what the child must
    // NOT report: without the launcher it would inherit this cwd.
    const result = await spawnWrapped(wrapped, dir);

    expect(result.stderr).toBe('');
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { cwd: string };
    expect(report.cwd).toBe(await fs.realpath(launchCwd));
    expect(report.cwd).not.toBe(dir);
  });

  it('delivers all 17 argument classes byte-identical, and the target\'s own exit code', async () => {
    const { dir, out } = await fixture();
    const target = path.join(dir, 'byte-target.mjs');
    await fs.writeFile(target, BYTE_TARGET);
    const launcher = resolveMcpLaunchCwdLauncher();
    if (launcher.kind === 'unavailable') throw new Error(`no launcher on this host: ${launcher.reason}`);

    const wrapped = wrapMcpServerWithLaunchCwd(
      { command: process.execPath, args: [target, out, ...ARGV_CLASSES] },
      { cwd: await launchDir(), launcher },
    );
    const result = await spawnWrapped(wrapped, dir);

    // 42 rather than 0: a launcher that swallowed the status and reported
    // success would pass a `code === 0` assertion while hiding every failure
    // the server ever reports.
    expect(result).toMatchObject({ code: 42, signal: null });
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { argv: string[] };
    expect(report.argv).toEqual(ARGV_CLASSES.map((arg) => Buffer.from(arg, 'utf8').toString('hex')));
  });
});

describe('the loader deny list', () => {
  it('names the same variables in the launcher script and in the environment builder', async () => {
    // Two copies exist on purpose — the launcher ships as standalone source and
    // imports nothing of this package — so the copies are pinned to each other
    // here rather than left to drift.
    const source = await fs.readFile(LAUNCHER, 'utf8');
    const block = /const LOADER_ENV_DENY = \[([^\]]*)\]/u.exec(source);
    expect(block).not.toBeNull();
    const launcherNames = [...block![1]!.matchAll(/\/\^([A-Z0-9_]+)(\$)?\//gu)]
      .map(([, name, anchored]) => (anchored === undefined ? `${name}*` : name));
    expect([...launcherNames].sort()).toEqual([...LOADER_ENV_DENY_PATTERNS].sort());
  });
});
