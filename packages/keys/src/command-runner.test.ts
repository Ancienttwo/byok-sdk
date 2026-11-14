import { spawn as nodeSpawn } from 'node:child_process';
import { inspect } from 'node:util';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { runCommand } from './command-runner';

/**
 * `runCommand` is the only place in this package that actually spawns a
 * process, so it is exercised against `process.execPath` — present on every
 * platform CI runs — rather than a shell builtin. No OS credential store is
 * touched here; the macOS backend receives an injected {@link CommandRunner}.
 */
describe('runCommand', () => {
  it('#2184 refuses NUL input before spawn with a slot-only diagnostic', async () => {
    vi.mocked(nodeSpawn).mockClear();
    await expect(runCommand(process.execPath, ['private-spawn-canary\0'])).rejects.toThrow('spawn argument 0 contains a NUL byte');
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async', 'input'])('#2184 sanitizes %s failures and retains classification codes', async mode => {
    for (const code of mode === 'input' ? ['EPIPE'] : ['ENOENT', 'EACCES', undefined]) {
      const canary = 'private-spawn-canary';
      const raw = Object.assign(new Error(canary), { code, path: canary, spawnargs: [canary], env: { SECRET: canary }, cwd: canary, cause: new Error(canary) });
      expect(inspect(raw, { showHidden: true, depth: null })).toContain(canary);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      vi.mocked(nodeSpawn).mockImplementationOnce(() => {
        if (mode === 'sync') throw raw;
        queueMicrotask(() => { (mode === 'input' ? child.stdin : child).emit('error', raw); child.emit('close', null); });
        return child as unknown as ReturnType<typeof nodeSpawn>;
      });
      const failure = await runCommand(process.execPath, []).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: mode === 'input' ? 'CommandInputError' : 'Error', message: `${mode === 'input' ? 'command input' : 'spawn'} failed: ${code ?? 'unknown'}`, code });
      expect(inspect(failure, { showHidden: true, depth: null })).not.toContain(canary);
      for (const key of ['path', 'spawnargs', 'env', 'cwd', 'cause']) expect(failure).not.toHaveProperty(key);
    }
  });

  it('reports early stdin closure as a sanitized input failure without crashing the caller', () => {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { runCommand } from ${JSON.stringify(new URL('./command-runner.ts', import.meta.url).href)};
      await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(0)'], 'x'.repeat(1024 * 1024)), { name: 'CommandInputError', code: 'EPIPE', message: 'command input failed: EPIPE' });
    `], { encoding: 'utf8' });
    expect(probe.status, probe.stderr).toBe(0);
  });

  it('captures stdout and a zero exit code', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      'process.stdout.write("out")',
    ]);
    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: 'out' });
  });

  it('captures stderr alongside a non-zero exit code', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      'process.stderr.write("bad"); process.exit(3)',
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('bad');
    expect(result.stdout).toBe('');
  });

  it('preserves exit code 44, which the macOS backend reads as "not found"', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      'process.exit(44)',
    ]);
    expect(result.exitCode).toBe(44);
  });

  it('feeds stdin to the child', async () => {
    const result = await runCommand(
      process.execPath,
      [
        '-e',
        'let b = ""; process.stdin.on("data", (c) => { b += c; }); process.stdin.on("end", () => process.stdout.write(b.toUpperCase()));',
      ],
      'hello',
    );
    expect(result.stdout).toBe('HELLO');
  });

  it('closes stdin when none is supplied so the child cannot hang', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      'process.stdin.on("end", () => process.stdout.write("closed")); process.stdin.resume();',
    ]);
    expect(result.stdout).toBe('closed');
  });

  it('#2184 reports a missing executable as a sanitized start rejection', async () => {
    await expect(runCommand('/nonexistent/byok-keys-missing-binary', []))
      .rejects.toMatchObject({ code: 'ENOENT', message: 'spawn failed: ENOENT' });
  });

  it('#2184 preserves a real exit 127', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.exit(127)']))
      .resolves.toEqual({ exitCode: 127, stdout: '', stderr: '' });
  });

  it.runIf(process.platform !== 'win32')('#2184 returns signal termination without inventing an exit code', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']))
      .resolves.toEqual({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' });
  });
});
