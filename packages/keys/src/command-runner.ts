import { spawn } from 'node:child_process';

/** A finished child process, ported from `aip-main-open@c6a5385` `index.ts:284-288`. */
export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * The injection seam both OS backends are written against. Unit tests supply a
 * fake so no test ever reads or writes a real credential store; production code
 * gets {@link runCommand}.
 */
export type CommandRunner = (
  executable: string,
  args: string[],
  stdin?: string,
) => Promise<CommandResult>;

/**
 * Spawn `executable`, feed it `stdin`, and collect its output
 * (`index.ts:2498-2527`).
 *
 * It never rejects: a missing executable resolves as exit code 127 so the
 * backends' `available()` probes can treat "no such binary" the same way they
 * treat "binary said no". Stdin is always closed, otherwise a child that reads
 * to EOF would hang forever.
 */
export async function runCommand(
  executable: string,
  args: string[],
  stdin?: string,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      resolveResult({
        exitCode: 127,
        stderr: 'command unavailable',
        stdout: '',
      });
    });
    child.on('close', (code) => {
      resolveResult({ exitCode: code ?? 1, stderr, stdout });
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}
