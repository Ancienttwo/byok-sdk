import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { assertNoNulSpawnInput, spawnStartError } from '@byok-sdk/core/system-tool';

/** A finished child process. A signal termination has null exitCode and carries signal. */
export interface CommandResult {
  exitCode: number | null;
  signal?: NodeJS.Signals;
  stderr: string;
  stdout: string;
}

/**
 * The injection seam the OS backends use. Runners return actual exit
 * codes or signal termination, and reject on start or input failures.
 */
export type CommandRunner = (
  executable: string,
  args: string[],
  stdin?: string,
) => Promise<CommandResult>;

/**
 * Spawn `executable`, close stdin after sending input, and collect output.
 * NUL command/args/env are refused before spawn; no cwd override is supplied.
 * Start failures reject with only a trusted string code and fixed message,
 * discarding original message/path/spawnargs/env/cwd/cause. Input failures
 * also retain only code, with name `CommandInputError` and a fixed message.
 * No exit code is synthesized: a signal termination returns null exitCode
 * and signal. Callers that probe availability must catch failures themselves.
 */
export async function runCommand(
  executable: string,
  args: string[],
  stdin?: string,
): Promise<CommandResult> {
  assertNoNulSpawnInput(executable, args, process.env, undefined);
  return new Promise((resolveResult, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { reject(spawnStartError(error)); return; }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => reject(spawnStartError(error)));
    child.stdin.on('error', error => {
      const failure = spawnStartError(error);
      failure.name = 'CommandInputError';
      failure.message = `command input failed: ${failure.code ?? 'unknown'}`;
      reject(failure);
    });
    child.on('close', (exitCode, signal) => {
      resolveResult({ exitCode, ...(signal === null ? {} : { signal }), stderr, stdout });
    });
    child.stdin.end(stdin);
  });
}
