/**
 * The one runner for short system commands whose output a caller reads: the
 * device credential providers, the machine identifier probe and the
 * Agent-home lease writer identity. A leaf, so reaching it brings no
 * credential custody along.
 */
import { assertNoNulSpawnInput, spawnStartError, systemExecutable } from '@byok-sdk/core/system-tool';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** A real provider-command outcome; signal termination has null exitCode and carries signal. */
export interface DeviceCommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one provider command. Start failures reject; returned exit codes are
 * real child outcomes, with null exitCode and signal for signal termination.
 * On `signal` abort the runner kills the child and rejects at once, without
 * waiting for its pipes to close.
 */
export type DeviceCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string,
  signal?: AbortSignal,
) => Promise<DeviceCommandResult>;

/**
 * Runs a trusted system tool or an absolute executable. NUL input is refused before spawn.
 * Start failures reject with only a trusted string code and `spawn failed: <code>`;
 * missing trusted tools use `SYSTEM_TOOL_UNAVAILABLE`. Original message, path,
 * spawnargs, env, cwd and cause are discarded. Classify with code, not exitCode 127:
 * exit codes, including 127, come only from children that actually started.
 * Signal termination returns null exitCode and signal; abort still rejects with signal.reason.
 */
export async function runDeviceCommand(
  executable: string,
  args: readonly string[],
  stdin?: string,
  signal?: AbortSignal,
): Promise<DeviceCommandResult> {
  signal?.throwIfAborted();
  assertNoNulSpawnInput(executable, args, process.env, undefined);
  return new Promise((resolve, reject) => {
    let file: string;
    try {
      file = systemExecutable(executable);
    } catch {
      reject(spawnStartError({ code: 'SYSTEM_TOOL_UNAVAILABLE' }));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(file, [...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(spawnStartError(error)); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      finish();
    };
    // Reject on abort itself, not on 'close': a grandchild that inherited the
    // pipes can hold them open after the child is killed.
    const onAbort = (): void => {
      child.kill('SIGKILL');
      settle(() => reject(signal!.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    // A killed child can no longer read stdin; its EPIPE is not a result.
    child.stdin.on('error', () => {});
    child.once('error', error => settle(() => reject(spawnStartError(error))));
    child.once('close', (exitCode, signal) => settle(() => resolve({ exitCode, ...(signal === null ? {} : { signal }), stdout, stderr })));
    child.stdin.end(stdin);
  });
}
