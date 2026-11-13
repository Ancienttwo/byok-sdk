import { spawn } from 'node:child_process';
import { systemExecutable } from '@byok-sdk/core/system-tool';
import { disposeOwnedProcessTree, withOwnedProcessTree } from '../adapters/process-tree.js';
import { COMMAND_TIMEOUT_MS } from '../util/command-timeouts.js';
import { PlatformCommandTimeoutError, type RunResult, type Runner } from '../util/exec-runner.js';

/**
 * Runs `executable` directly (never a shell) as the root of an owned process
 * tree and resolves with its exit code and output, whatever the code. It
 * rejects when the executable cannot start, ends on a signal or prints more
 * than 1 MiB, and after `timeoutMs` with {@link PlatformCommandTimeoutError},
 * once `disposeOwnedProcessTree` has stopped the tree (SIGTERM, then SIGKILL;
 * `taskkill /T /F` on Windows) and waited for it within its bounded grace.
 */
export function runBounded(executable: string, args: readonly string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
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
    const stop = (error: Error): void => {
      if (failure !== undefined || closed) return;
      fail(error);
      disposeOwnedProcessTree({ child, label: executable, isClosed: () => closed, waitClosed: () => closing })
        .catch((cause: unknown) => (error.cause = cause))
        .then(() => reject(error));
    };
    const collect = (index: 0 | 1) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(new Error(`${executable} printed more than 1 MiB`));
      else output[index].push(chunk);
    };
    child.stdout?.on('data', collect(0));
    child.stderr?.on('data', collect(1));
    const timer = setTimeout(() => stop(new PlatformCommandTimeoutError(`${executable} timed out`)), timeoutMs);
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
