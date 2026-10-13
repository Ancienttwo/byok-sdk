// Quickstart smoke test (#389 item 2, #384 item 1): the README's "Run it" loop
// against the example server exactly as `dev` starts it, with every default
// left alone. No `longPollHoldMs` override anywhere: the server holds an empty
// poll ~50s, and the daemon still reaches `lifecycle` open promptly because
// readiness is the accepted `conn.hello`, not a returned poll (#391).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotStubAdapter } from './goal-btw.test-support';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
// The README's daemon config uses this product id; `server.ts` defaults to it too.
const PRODUCT_ID = 'byok-example-basic';
const SETTLE_BOUND_MS = 5_000;
const OPEN = { phase: 'running', connection: 'open' } as const;

/** Start `server.ts` the way `bun run dev` does and resolve its listening URL. */
function startExampleServer(): Promise<{ child: ChildProcess; url: string }> {
  // Only PORT is set (0 = ephemeral), so parallel CI runs never collide on 8787.
  const child = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: exampleDir,
    env: { ...process.env, PORT: '0', BYOK_STORE: undefined, BYOK_EXAMPLE_PRODUCT_ID: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on http:\/\/localhost:(\d+)/.exec(output);
      if (match) resolve({ child, url: `http://127.0.0.1:${match[1]}` });
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => reject(new Error(`example server exited early (${code}):\n${output}`)));
  });
}

function stopExampleServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

describe('examples/basic quickstart with default settings', () => {
  let server: { child: ChildProcess; url: string } | undefined;
  let daemon: Daemon | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await daemon?.stop();
    if (server) await stopExampleServer(server.child);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('pairs a daemon, settles it within the bound, and lists it as connected', async () => {
    server = await startExampleServer();
    root = await mkdtemp(path.join(tmpdir(), 'qs-'));
    // The README daemon config, with no long-poll overrides.
    daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-example-stub' },
      productName: 'BYOK Example',
      productId: PRODUCT_ID,
      serverUrl: server.url,
      workspaceRoot: path.join(root, 'workspace'),
      storeDir: path.join(root, 'store'),
    }, [new BotStubAdapter()]);

    // Step 1 of the README: the page's "Create pairing code" button.
    const pairing = await fetch(`${server.url}/api/pair`, { method: 'POST' });
    expect(pairing.status).toBe(200);
    const { code } = (await pairing.json()) as { code: string };
    const { deviceId } = await daemon.pair(code);

    // Step 2: `byok-agent start` logs `daemon started` once start() resolves;
    // the connection then reports open through `lifecycle` (#391).
    const startedAt = Date.now();
    await daemon.start();
    expect(Date.now() - startedAt).toBeLessThan(SETTLE_BOUND_MS);
    await vi.waitFor(() => {
      expect(daemon!.status().lifecycle).toEqual(OPEN);
    }, { timeout: SETTLE_BOUND_MS - (Date.now() - startedAt), interval: 50 });

    // ...and the machine appears under "Connected machines".
    await vi.waitFor(async () => {
      const machines = (await (await fetch(`${server!.url}/api/machines`)).json()) as Array<{ deviceId: string; connected: boolean }>;
      expect(machines.find((machine) => machine.deviceId === deviceId)?.connected).toBe(true);
    }, { timeout: 2_000, interval: 100 });
    expect(daemon.status().lifecycle).toEqual(OPEN);
  }, 30_000);
});
