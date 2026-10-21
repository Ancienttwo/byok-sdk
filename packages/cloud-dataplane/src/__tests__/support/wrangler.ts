/**
 * Wrangler plumbing shared by the worker packaging, E2E and Topology H tests.
 *
 * Resolving wrangler's bin from the installed package — rather than relying
 * on PATH or `bunx`/`npx` — keeps the spawn deterministic in CI: the version
 * under test is the one pinned in this package's devDependencies, executed
 * under the same Node that runs vitest.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const PACKAGE_DIR = fileURLToPath(new URL('../../..', import.meta.url));
export const WORKER_SMOKE_DIR = path.join(PACKAGE_DIR, 'worker-smoke');
export const H_WORKER_DIR = path.join(PACKAGE_DIR, 'src', '__tests__', 'fixtures', 'h-worker');

/** The `.js` entry of the installed wrangler CLI, for `spawn(node, [entry, ...])`. */
export function wranglerEntry(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('wrangler/package.json', { paths: [PACKAGE_DIR] });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: Record<string, string> };
  const relative = manifest.bin['wrangler'];
  if (relative === undefined) throw new Error('installed wrangler exposes no wrangler bin');
  return path.join(path.dirname(manifestPath), relative);
}

/** The environment every wrangler invocation in these tests runs under. */
export function wranglerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
}

/** Reserves an ephemeral 127.0.0.1 port and gives it back. */
function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port to probe'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** One `wrangler dev` (local workerd) serving the fixture in `cwd`. */
export interface WranglerDev {
  readonly base: string;
  /** Everything wrangler and workerd printed so far, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Starts `wrangler dev` over the fixture in `cwd` and resolves once it serves.
 *
 * Readiness is the fixture's own 404 route list. Miniflare state goes to a
 * scratch `--persist-to` directory, never into the repository. Each `vars`
 * entry is one `--var NAME:value`; wrangler splits on the FIRST colon only.
 * `env` adds to `wranglerEnv()`, for settings wrangler reads only from its
 * environment, such as a Hyperdrive local connection string.
 */
export async function startWranglerDev(
  cwd: string,
  vars: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<WranglerDev> {
  const port = await probeFreePort();
  const base = `http://127.0.0.1:${port}`;
  const persistDir = mkdtempSync(path.join(os.tmpdir(), 'byok-worker-dev-'));
  let output = '';
  // Detached so the whole process group (wrangler + workerd) dies with one
  // kill in stop(); wrangler's own SIGTERM handling forwards it.
  const child = spawn(
    process.execPath,
    [
      wranglerEntry(),
      'dev',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      persistDir,
      ...vars.flatMap((entry) => ['--var', entry]),
    ],
    { cwd, env: { ...wranglerEnv(), ...env }, detached: true },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const killGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* the group is already gone */
    }
  };
  const stop = async (): Promise<void> => {
    // Deterministic teardown: a grace window for wrangler to forward SIGTERM
    // to workerd, then SIGKILL for the group. The scratch state and the
    // `.wrangler/` cache next to the config go only after the group is gone.
    if (child.exitCode === null && child.signalCode === null) {
      killGroup('SIGTERM');
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 15_000;
        const poll = (): void => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            killGroup('SIGKILL');
            resolve();
            return;
          }
          setTimeout(poll, 200);
        };
        poll();
      });
    }
    rmSync(persistDir, { recursive: true, force: true });
    rmSync(path.join(cwd, '.wrangler'), { recursive: true, force: true });
  };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`wrangler dev exited early (code ${child.exitCode}):\n${output}`);
    }
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 404) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler dev never became ready:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { base, output: () => output, stop };
}
