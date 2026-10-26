import { InMemoryDeviceCredentialStore } from '../../scripts/testing/device-credentials.mjs';
// Quickstart smoke (#389 item 2, #384 item 1, #418): the README's "Run it" loop
// against the unmodified `server.ts`, with every network and lifecycle default
// left alone and a stub runtime in place of a real agent. No `longPollHoldMs`
// or other long-poll override anywhere: the server holds an empty poll ~50s, so
// anything that waits on a returned poll instead of the accepted `conn.hello`
// misses a 5s deadline on every run. Linux CI only (the `build-test` job); the
// ipc-smoke job covers the CLI on all three OSes.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotStubAdapter } from './goal-btw.test-support';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
// The README's daemon config uses this product id; `server.ts` defaults to it too.
const PRODUCT_ID = 'byok-example-basic';
// Every deadline is at most a tenth of the 50s default hold, so a dependence on
// the hold fails every run instead of flaking.
const DEADLINE_MS = 5_000;
const START_DEADLINE_MS = 2_000;
const OPEN = { phase: 'running', connection: 'open' } as const;

/** Start the unmodified `server.ts` with the example's tsx and resolve its listening URL. */
function startExampleServer(): Promise<{ child: ChildProcess; url: string }> {
  // Only PORT is set (0 = ephemeral), so parallel CI runs never collide on 8787.
  // tsx is loaded with --import rather than through its CLI wrapper: the wrapper
  // re-sends a signal when the child does not confirm it within 30 ms, which
  // kills a server that is shutting down gracefully (exit 143) on a loaded runner.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
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

/** SIGTERM the server and resolve with how it ended; kill it if it ignores the signal. */
function stopExampleServer(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; forced: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, forced: false });
  }
  return new Promise((resolve) => {
    let forced = false;
    const force = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, DEADLINE_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(force);
      resolve({ code, signal, forced });
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

  it('pairs, reports ready, delivers a task, and stops cleanly', async () => {
    server = await startExampleServer();
    // Under the per-run TMPDIR root of scripts/vitest/tmp-root.mjs.
    root = await mkdtemp(path.join(tmpdir(), 'qs-'));
    const adapter = new BotStubAdapter();
    // The README daemon config; no network or lifecycle overrides.
    daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-example-stub' },
      productName: 'BYOK Example',
      productId: PRODUCT_ID,
      serverUrl: server.url,
      storeDir: path.join(root, 'store'),
      agentHome: { hostStorageRoot: path.join(root, 'home') },
      agentEgress: {},
    }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });

    // Step 1 of the README: the page's "Create pairing code" button.
    const pairing = await fetch(`${server.url}/api/pair`, { method: 'POST' });
    expect(pairing.status).toBe(200);
    const { code } = (await pairing.json()) as { code: string };
    const { deviceId } = await daemon.pair(code);

    // Step 2: start() resolves on local startup; the client's ready fact is `lifecycle` open.
    const startedAt = Date.now();
    await daemon.start();
    expect(Date.now() - startedAt).toBeLessThan(START_DEADLINE_MS);
    await vi.waitFor(() => {
      expect(daemon!.status().lifecycle).toEqual(OPEN);
    }, { timeout: DEADLINE_MS, interval: 25 });

    // ...and the machine is listed with the runtime the daemon reported.
    await vi.waitFor(async () => {
      const machines = (await (await fetch(`${server!.url}/api/machines`)).json()) as Array<{ deviceId: string; runtimes?: Array<{ id: string }> }>;
      expect(machines.find((machine) => machine.deviceId === deviceId)?.runtimes?.map((runtime) => runtime.id)).toEqual(['pi']);
    }, { timeout: DEADLINE_MS, interval: 50 });

    // Step 3: dispatch. A poll that is open but never polled again would never see this.
    const dispatched = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, instruction: 'quickstart smoke', runtime: 'pi' }),
    });
    expect(dispatched.status).toBe(200);
    const { taskId } = (await dispatched.json()) as { taskId: string };
    await vi.waitFor(() => {
      expect(adapter.sessions.has(taskId)).toBe(true);
    }, { timeout: DEADLINE_MS, interval: 25 });
    adapter.sessions.get(taskId)!.emit({ type: 'progress', text: 'stub done' });
    adapter.sessions.get(taskId)!.emit({ type: 'turn_end' });
    await vi.waitFor(async () => {
      const task = (await (await fetch(`${server!.url}/api/tasks/${taskId}`)).json()) as { state: string };
      expect(task.state).toBe('Complete');
    }, { timeout: DEADLINE_MS, interval: 50 });

    // Shutdown: the daemon stops with a poll in flight, the server exits 0 on SIGTERM.
    const stoppedAt = Date.now();
    await daemon.stop();
    expect(Date.now() - stoppedAt).toBeLessThan(DEADLINE_MS);
    const ended = await stopExampleServer(server.child);
    expect(ended).toEqual({ code: 0, signal: null, forced: false });
  }, 30_000);
});
