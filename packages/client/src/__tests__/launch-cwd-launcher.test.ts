import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
 * death-by-signal pass through, that the target does not outlive a terminated
 * launcher, that a loader environment variable or a
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
 * its own script path, the directory it started in, and its own identity — its
 * pid and the pid of the launcher that exec'd it (`ppid`). Everything this
 * suite asserts about the launcher is read back out of a real child process.
 *
 * The identity fields exist for the signal case: the only way to say what
 * happened to the TARGET when the launcher was terminated is to hold the
 * target's pid before the kill and probe that pid afterwards.
 */
const TARGET = `
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], JSON.stringify({
  argv: process.argv.slice(3),
  cwd: process.cwd(),
  pid: process.pid,
  ppid: process.ppid,
}));
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

/**
 * Is this pid still a running process on THIS host?
 *
 * POSIX: signal 0 is the standard existence probe — `ESRCH` is the only answer
 * that means "gone"; `EPERM` means it exists and is not ours, which is still
 * alive. The target is a GRANDchild of this process (launcher in between), so
 * it is never a zombie of ours: once the launcher dies the target is reparented
 * and reaped by init, and `ESRCH` is an unambiguous terminal state.
 *
 * win32: there are no POSIX signals and no zombies; a terminated process leaves
 * the table, so `tasklist` filtered on the pid is the terminal-state read. It
 * must never answer "gone" for a reason other than the pid being absent, so
 * ONLY exit code 0 is allowed to produce a verdict: any non-zero code, and a
 * `null` code (the probe itself was killed by a signal), REJECTS and carries a
 * bounded slice of stdout and stderr so the failure names what the probe said.
 * A probe that exited non-zero has not observed the process table, whatever it
 * happened to print — resolving `false` from that output is a false "clean
 * kill" verdict, which is exactly the answer this suite must never invent.
 *
 * `deps` exists so those refusals are testable on every host. Its default is
 * the production shape — this process's real platform and the real `spawn` —
 * so an uninjected call behaves exactly as it does on a Windows runner.
 */
interface ProbeChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
}

interface ProbeDeps {
  platform: NodeJS.Platform | string;
  spawnFn: typeof spawn;
}

/** First 200 chars, so a failure message carries evidence without carrying a dump. */
const slice = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

function isRunning(
  pid: number,
  deps: ProbeDeps = { platform: process.platform, spawnFn: spawn },
): Promise<boolean> {
  if (deps.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.resolve((error as NodeJS.ErrnoException).code !== 'ESRCH');
    }
  }
  return new Promise((resolve, reject) => {
    const probe = deps.spawnFn('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as ProbeChild;
    let stdout = '';
    let stderr = '';
    probe.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    probe.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    probe.once('error', (error) => reject(new Error(`tasklist probe for pid ${pid} could not run: ${error.message}`)));
    probe.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `tasklist probe for pid ${pid} exited ${code} and did not observe the process table; `
          + `stdout=${JSON.stringify(slice(stdout))} stderr=${JSON.stringify(slice(stderr))}`,
        ));
        return;
      }
      // Exit 0 only. tasklist exits 0 with an "INFO: No tasks..." line when the
      // filter matches nothing; the quoted CSV pid field is the positive match.
      resolve(stdout.includes(`"${pid}"`));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Poll `isRunning` until it says gone, or the bounded window runs out. */
async function stillRunningAfter(pid: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (!(await isRunning(pid))) return false;
    if (Date.now() >= deadline) return true;
    await sleep(50);
  }
}

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

  /**
   * What this case measures: the fate of BOTH processes when the launcher is
   * terminated. The target's pid is captured from its own report BEFORE the
   * kill, and its terminal state is read afterwards by probing that pid — not
   * inferred from the launcher's exit.
   *
   * The launcher assertion differs by platform because the KILL differs, not
   * because the requirement is softer. POSIX delivers SIGTERM, the launcher's
   * handler forwards it and the launcher re-raises, so `signal === 'SIGTERM'`
   * is the exact expected death. win32 has no POSIX signals:
   * `process.kill(pid, 'SIGTERM')` is `TerminateProcess`, the JS handler at
   * `bin/byok-launch-cwd.mjs:90-93` may never run, and the OS reports an exit
   * code rather than a signal — so the launcher assertion there is that it was
   * terminated at all.
   *
   * The TARGET assertion is identical on every platform and is never loosened:
   * a target that outlives the launcher is a real orphan and this case fails
   * naming the surviving pid and the platform. The cleanup kill below happens
   * only after that verdict is decided; it is housekeeping, never evidence.
   */
  it('forwards SIGTERM to the target, and the target does not outlive the launcher', async () => {
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

    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { pid: number; ppid: number };
    const targetPid = report.pid;
    // Captured before the kill: after it, the target may be unidentifiable.
    console.log(`platform=${process.platform} launcher pid=${pid} target pid=${targetPid} target ppid=${report.ppid}`);
    expect(report.ppid, 'the target must be a direct child of the launcher').toBe(pid);

    // The "gone" verdict below is only worth anything against a pid the SAME
    // probe first reported alive: if the probe cannot see a running target it
    // would also report a dead one as gone, and the case would pass vacuously.
    expect(
      await isRunning(targetPid),
      `target pid ${targetPid} was not reported alive by the probe before the kill on ${process.platform}`,
    ).toBe(true);

    try {
      process.kill(pid!, 'SIGTERM');
      const result = await finished;
      if (process.platform === 'win32') {
        expect(
          result.signal !== null || (result.code !== null && result.code !== 0),
          `the launcher must have been terminated, saw ${JSON.stringify(result)}`,
        ).toBe(true);
      } else {
        expect(result).toMatchObject({ signal: 'SIGTERM' });
      }

      const orphan = await stillRunningAfter(targetPid, 2_000);
      expect(
        orphan,
        `target pid ${targetPid} was still running 2s after the launcher (pid ${pid}) died on ${process.platform}: the launcher leaked an orphan`,
      ).toBe(false);
    } finally {
      // Runs only after the verdict above is decided. A cleanup kill is not
      // termination evidence, and it announces itself when it had to happen.
      if (await isRunning(targetPid).catch(() => false)) {
        try {
          process.kill(targetPid, 'SIGKILL');
        } catch { /* already gone between the probe and the kill */ }
            console.log(`cleanup: killed surviving target ${targetPid}`);
      }
    }
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

/**
 * The win32 probe's refusals, exercised on EVERY platform by injecting the
 * platform and a fake `spawn` — the real `tasklist` branch is otherwise
 * unreachable off Windows, which is how a probe that resolves "gone" from a
 * failed run reaches CI unnoticed.
 */
function fakeTasklist(
  outcome: { stdout?: string; stderr?: string; code: number | null },
): typeof spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // After the caller has attached its listeners on this same turn.
    setTimeout(() => {
      if (outcome.stdout !== undefined) child.stdout.emit('data', Buffer.from(outcome.stdout, 'utf8'));
      if (outcome.stderr !== undefined) child.stderr.emit('data', Buffer.from(outcome.stderr, 'utf8'));
      child.emit('close', outcome.code);
    }, 0);
    return child;
  }) as unknown as typeof spawn;
}

const WIN32 = (spawnFn: typeof spawn): ProbeDeps => ({ platform: 'win32', spawnFn });

describe('the win32 existence probe', () => {
  it('a tasklist probe that exits non-zero cannot report the target as gone', async () => {
    // Non-empty output that does not contain the pid: the exact shape the old
    // `code !== 0 && stdout === ''` guard waved through as a clean kill.
    await expect(isRunning(4242, WIN32(fakeTasklist({
      stdout: 'ERROR: The search filter cannot be recognized.\r\n',
      stderr: 'access denied\r\n',
      code: 1,
    })))).rejects.toThrow(/exited 1 and did not observe the process table/u);
  });

  it('a tasklist probe killed by a signal cannot report the target as gone', async () => {
    await expect(isRunning(4242, WIN32(fakeTasklist({ stdout: 'partial', code: null }))))
      .rejects.toThrow(/exited null and did not observe the process table/u);
  });

  it('carries a bounded slice of what the failed probe said', async () => {
    await expect(isRunning(4242, WIN32(fakeTasklist({ stdout: 'x'.repeat(500), stderr: 'y'.repeat(500), code: 9 }))))
      .rejects.toThrow(/stdout="x{200}…" stderr="y{200}…"/u);
  });

  it('reads the verdict out of a clean run: the quoted pid is alive, "no tasks" is gone', async () => {
    await expect(isRunning(4242, WIN32(fakeTasklist({
      stdout: '"node.exe","4242","Console","1","12,345 K"\r\n',
      code: 0,
    })))).resolves.toBe(true);
    await expect(isRunning(4242, WIN32(fakeTasklist({
      stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
      code: 0,
    })))).resolves.toBe(false);
  });

  it('rejects when the probe could not be run at all', async () => {
    const spawnFn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => { child.emit('error', new Error('spawn tasklist ENOENT')); }, 0);
      return child;
    }) as unknown as typeof spawn;
    await expect(isRunning(4242, WIN32(spawnFn))).rejects.toThrow(/could not run: spawn tasklist ENOENT/u);
  });
});
