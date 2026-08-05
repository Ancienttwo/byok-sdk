import { describe, expect, it } from 'vitest';

import { runCommand } from './command-runner';

/**
 * `runCommand` is the only place in this package that actually spawns a
 * process, so it is exercised against `process.execPath` — present on every
 * platform CI runs — rather than a shell builtin. No OS credential store is
 * touched here; the two backends receive an injected {@link CommandRunner}.
 */
describe('runCommand', () => {
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

  it('preserves exit code 44, which both backends read as "not found"', async () => {
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

  it('reports a missing executable as exit code 127 rather than rejecting', async () => {
    const result = await runCommand(
      '/nonexistent/byok-keys-missing-binary',
      [],
    );
    expect(result).toEqual({
      exitCode: 127,
      stderr: 'command unavailable',
      stdout: '',
    });
  });
});
