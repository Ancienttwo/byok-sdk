import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchCwdScriptPath, resolveTrustedLaunchCwd } from '../daemon/trusted-launch-cwd';

const LAUNCHER = launchCwdScriptPath();

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

async function trusted(): Promise<string> {
  const resolved = await resolveTrustedLaunchCwd();
  if (resolved.kind !== 'resolved') throw new Error(`no trusted directory here: ${resolved.reason}`);
  return resolved.dir;
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
  it('execs the target in the trusted directory, never in its own', async () => {
    const { target, out } = await fixture();
    const dir = await trusted();
    const result = await run([dir, process.execPath, target, out]);
    expect(result).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { cwd: string };
    expect(await fs.realpath(report.cwd)).toBe(await fs.realpath(dir));
    expect(report.cwd).not.toBe(path.dirname(LAUNCHER));
  });

  it('forwards every argument byte-identically, shell metacharacters included', async () => {
    const { target, out } = await fixture();
    const argv = ['a b', '"double"', "'single'", '$(id)', '`id`', ';rm -rf /', 'new\nline', '-n', '--', '', 'tab\there'];
    const result = await run([await trusted(), process.execPath, target, out, ...argv]);
    expect(result.code).toBe(0);
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as { argv: string[] };
    expect(report.argv).toEqual(argv);
  });

  it('forwards the target exit code', async () => {
    const { target, out } = await fixture();
    const result = await run([await trusted(), process.execPath, target, out], {
      env: { PATH: process.env.PATH ?? '', TARGET_EXIT: '37' },
    });
    expect(result.code).toBe(37);
  });

  it('forwards SIGTERM to the target and dies of the same signal', async () => {
    const { target, out } = await fixture();
    let pid: number | undefined;
    const finished = run([await trusted(), process.execPath, target, out, '--hang'], {
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
      const result = await run([await trusted(), process.execPath, target, out], {
        env: { PATH: process.env.PATH ?? '', [name]: name === 'NODE_OPTIONS' ? '--title=x' : path.dirname(LAUNCHER) },
      });
      expect(result.code, name).toBe(78);
      expect(result.stderr).toContain(name);
    }
    await expect(fs.access(out)).rejects.toThrow();
  });

  it('refuses to launch when its own interpreter argv is not empty', async () => {
    const { target, out } = await fixture();
    const result = await run([await trusted(), process.execPath, target, out], { execArgv: ['--title=injected'] });
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
