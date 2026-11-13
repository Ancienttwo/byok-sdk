import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundedRunner, PlatformCommandTimeoutError } from '../util/exec-runner';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('util/exec-runner: boundedRunner (#1971)', () => {
  it('resolves a non-zero exit with its output', async () => {
    const run = boundedRunner(10_000);
    await expect(run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']))
      .resolves.toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('after its bound, rejects with PlatformCommandTimeoutError only once the command and its child are gone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-runner-'));
    dirs.push(dir);
    const pids = path.join(dir, 'pids');
    // The command ignores SIGTERM and starts a child that holds its output open.
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid);
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const failure = await boundedRunner(2_000)(process.execPath, ['-e', script]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlatformCommandTimeoutError);
    expect(failure).toMatchObject({ timeoutMs: 2_000, cause: undefined });
    expect(Date.now() - started).toBeLessThan(10_000);
    const [command, child] = (await fs.readFile(pids, 'utf8')).split(' ').map(Number);
    expect(alive(command!)).toBe(false);
    expect(alive(child!)).toBe(false);
  });
});
