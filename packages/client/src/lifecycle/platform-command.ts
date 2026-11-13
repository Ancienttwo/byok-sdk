import { spawn } from 'node:child_process';
import { systemExecutable } from '@byok-sdk/core/system-tool';
import { disposeOwnedProcessTree, withOwnedProcessTree } from '../adapters/process-tree.js';
import { COMMAND_TIMEOUT_MS, PlatformCommandTimeoutError } from '../util/command-timeouts.js';
import type { RunResult, Runner } from '../util/exec-runner.js';

/**
 * Runs `executable` directly (never a shell) as the root of an owned process
 * tree and resolves with its exit code and output, whatever the code. It
 * rejects when the executable cannot start, ends on a signal or prints more
 * than 1 MiB. After `timeoutMs` it stops the tree with
 * `disposeOwnedProcessTree` (SIGTERM, then SIGKILL; `taskkill /T /F` on
 * Windows) and rejects with {@link PlatformCommandTimeoutError}, whose
 * `exitConfirmed` is true only when that cleanup proved the tree gone within
 * the `disposal` bound. A cleanup that fails (taskkill cannot start, the
 * process table cannot be read, a process outlives SIGKILL) or does not
 * settle in time is unconfirmed, with any cleanup failure as `cause`.
 * Residual: on POSIX the cleanup reads the process table with a synchronous
 * `/bin/ps` call, which has no bound yet and blocks the event loop while it
 * runs (#2105). `platform` and `spawnFn` are the cleanup's test seams.
 */
export function runBounded(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  { cwd, platform, spawnFn }: { cwd?: string; platform?: NodeJS.Platform; spawnFn?: typeof spawn } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, withOwnedProcessTree({ cwd, stdio: ['ignore', 'pipe', 'pipe'] as const, windowsHide: true }));
    const output: [Buffer[], Buffer[]] = [[], []];
    let bytes = 0;
    let closed = false;
    let failure: Error | undefined;
    const closing = new Promise<void>((done) => child.once('close', () => done()));
    const fail = (error: Error): void => {
      failure ??= error;
      clearTimeout(timer);
    };
    const stop = (error?: Error): void => {
      if (failure !== undefined || closed) return;
      fail(error ?? new Error());
      let cause: unknown;
      let bound: NodeJS.Timeout | undefined;
      void Promise.race([
        disposeOwnedProcessTree({ child, label: executable, isClosed: () => closed, waitClosed: () => closing, platform, spawnFn }).then(
          () => true,
          (disposal: unknown) => ((cause = disposal), false),
        ),
        new Promise<false>((settle) => (bound = setTimeout(() => settle(false), COMMAND_TIMEOUT_MS.disposal))),
      ]).then((exitConfirmed) => {
        clearTimeout(bound);
        reject(error ?? new PlatformCommandTimeoutError(`${executable} timed out`, exitConfirmed, { cause }));
      });
    };
    const collect = (index: 0 | 1) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(new Error(`${executable} printed more than 1 MiB`));
      else output[index].push(chunk);
    };
    child.stdout?.on('data', collect(0));
    child.stderr?.on('data', collect(1));
    const timer = setTimeout(() => stop(), timeoutMs);
    child.once('error', (error) => {
      if (failure !== undefined) return;
      fail(error);
      reject(error);
    });
    void closing.then(() => {
      closed = true;
      if (failure !== undefined) return;
      clearTimeout(timer);
      if (child.exitCode === null) reject(new Error(`${executable} ended on a signal`));
      else resolve({ code: child.exitCode, stdout: Buffer.concat(output[0]).toString('utf8'), stderr: Buffer.concat(output[1]).toString('utf8') });
    });
  });
}

/**
 * The real {@link Runner}: {@link runBounded} at the `platform` bound. A bare
 * `command` is a system tool and starts from its trusted location, never
 * from `PATH`; one that has none rejects with `SystemToolUnavailableError`
 * (`@byok-sdk/core/system-tool`, #1304). Every command it runs is a native
 * executable, never a `.cmd`/`.bat` script, which Windows cannot start
 * without a shell.
 */
export const defaultRunner: Runner = async (command, args) => runBounded(systemExecutable(command), args, COMMAND_TIMEOUT_MS.platform);
