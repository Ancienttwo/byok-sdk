import { spawn } from 'node:child_process';

const INSPECT_TIMEOUT_MS = 5000;
const INSPECT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Runs `grok inspect --json` through the spawn that starts the agent, with
 * the agent's command, cwd and environment, so it reports the configuration
 * the agent will load. Returns its stdout, or `undefined` on a non-zero exit,
 * a spawn error, more than 16 MiB of output or 5 s without an exit.
 */
export async function runGrokInspect(spawnFn: typeof spawn, command: string, cwd: string, env: Readonly<Record<string, string>>): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(command, ['inspect', '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(undefined); }, INSPECT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= INSPECT_MAX_BYTES) chunks.push(chunk);
      else { child.kill('SIGKILL'); finish(undefined); }
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
  });
}
