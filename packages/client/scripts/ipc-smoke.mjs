#!/usr/bin/env node
// packages/client/scripts/ipc-smoke.mjs
//
// M4 Phase 2 real, end-to-end proof that the daemon's local control socket
// (Unix domain socket / Windows named pipe — see
// packages/client/src/daemon/control-server.ts,
// packages/client/src/daemon/control-protocol.ts) actually works once
// EVERYTHING is really built and driven through the REAL packaged
// `byok-agent` CLI, the same way an operator would run it — not a unit test
// against in-process fakes (those already live under
// packages/client/src/__tests__/). This is what
// `.github/workflows/ci.yml`'s `ipc-smoke` job runs on every push, on all
// three OSes (ubuntu/macos/windows-latest), the same way
// `templates/packaging/*/smoke-test.sh` and
// `templates/service/{launchd,winsw}/smoke-test.*` prove their own
// guarantees on real runners rather than mocks.
//
// What it proves:
//   1. `byok-agent pair` + `byok-agent start` (a real child process) bring
//      up a real control socket (or pipe) at the deterministic path/name
//      `control-protocol.ts` derives.
//   2. `byok-agent status` (a SEPARATE, short-lived CLI invocation) reaches
//      that running daemon live over the socket and reports a `live: pid=...`
//      line — not just the persisted-state fallback.
//   3. `byok-agent unpair --yes` (another separate invocation) performs a
//      real live unpair: sends `shutdown` over the socket, waits for the
//      daemon to actually exit, and reports so.
//   4. The `start` child process actually terminates on its own (no signal
//      ever sent to it) — the exact "must not leave the process hanging"
//      guarantee M4 Phase 2 calls for.
//   5. The control socket/pipe and its token file are gone afterward.
//
// Uses the REAL `@byok/server` reference implementation (not a hand-rolled
// stub) to give the daemon something genuine to pair/connect against — both
// `@byok/server` and `@hono/node-server` are already `@byok/client`
// devDependencies (see `src/__tests__/fixtures/real-server.ts`, which this
// mirrors) and are built by the same `pnpm -r build` this script requires
// first.
//
// Usage: node packages/client/scripts/ipc-smoke.mjs
//   Requires @byok/client and @byok/server already built
//   (`pnpm -r build` — @byok/protocol too, transitively).

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, '..');
const byokAgentBin = path.join(clientDir, 'dist', 'bin', 'byok-agent.js');
const serverDistIndex = path.join(clientDir, '..', 'server', 'dist', 'index.js');
const honoNodeServerSpecifier = '@hono/node-server';

for (const [label, file] of [
  ['@byok/client', byokAgentBin],
  ['@byok/server', serverDistIndex],
]) {
  try {
    await fs.stat(file);
  } catch {
    console.error(`FAIL: ${file} not found -- run "pnpm -r build" first (needed: ${label})`);
    process.exit(1);
  }
}

const { createByokServer } = await import(pathToFileURL(serverDistIndex).href);
const { serve } = await import(honoNodeServerSpecifier);

const productId = `byok-ipc-smoke-${process.pid}`;
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-ipc-smoke-'));
const storeDir = path.join(workDir, 'store');
const workspaceRoot = path.join(workDir, 'workspace');
const configPath = path.join(workDir, 'config.json');
await fs.mkdir(workspaceRoot, { recursive: true });

const byok = createByokServer({ productId });
/** @type {import('node:http').Server} */
let httpServer;
let startChild;
let startStderr = '';
let failed = false;

function log(line) {
  console.log(line);
}

async function runCli(args, timeoutMs = 15000) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [byokAgentBin, ...args], {
    timeout: timeoutMs,
    env: process.env,
  });
  return { stdout, stderr };
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForStartupLine(child, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${marker}" on stdout`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited early (code=${code}) before printing "${marker}"`));
    });
  });
}

try {
  const port = await new Promise((resolve) => {
    httpServer = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => {
      byok.attachWebSocket(httpServer);
      resolve(info.port);
    });
  });
  const serverUrl = `http://127.0.0.1:${port}`;
  log(`==> real @byok/server reference implementation listening at ${serverUrl}`);

  const { code: pairingCode } = byok.pairing.createPairingCode();

  await fs.writeFile(
    configPath,
    JSON.stringify({ productName: 'IPC Smoke', productId, serverUrl, workspaceRoot, storeDir }, null, 2),
    'utf8',
  );

  log('==> byok-agent pair');
  await runCli(['pair', pairingCode, '--server', serverUrl, '--config', configPath]);
  log('PASS: pair succeeded');

  log('==> byok-agent start (background)');
  startChild = spawn(process.execPath, [byokAgentBin, 'start', '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startChild.stderr.on('data', (chunk) => {
    startStderr += chunk.toString('utf8');
  });
  await waitForStartupLine(startChild, 'daemon started:', 10000);
  log('PASS: daemon started and reported readiness on stdout');

  log('==> byok-agent status (separate short-lived invocation)');
  const statusOutput = await runCli(['status', '--config', configPath]);
  log(statusOutput.stdout.trim());
  if (!/^live: pid=\d+/m.test(statusOutput.stdout)) {
    throw new Error('expected a "live: pid=..." line in status output -- the control socket did not answer live');
  }
  if (!statusOutput.stdout.includes(`live: pid=${startChild.pid} `)) {
    throw new Error(`expected the live status pid to match the running start child (${startChild.pid})`);
  }
  log('PASS: status reached the running daemon live over the control socket');

  log('==> byok-agent unpair --yes (sends shutdown over the control socket, waits for exit)');
  const unpairOutput = await runCli(['unpair', '--yes', '--config', configPath], 20000);
  log(unpairOutput.stdout.trim());
  if (!unpairOutput.stdout.includes('confirmed exited')) {
    throw new Error(`expected unpair to report a confirmed live exit, got: ${unpairOutput.stdout}`);
  }
  log('PASS: unpair performed a live control-socket shutdown and confirmed exit');

  log('==> waiting for the start child process to actually terminate on its own (no signal sent)');
  await waitForChildExit(startChild, 10000);
  log(`PASS: start child (pid=${startChild.pid}) exited on its own — exitCode=${startChild.exitCode}`);

  log('==> asserting the control socket/pipe and its token file are gone');
  const tokenPath = path.join(storeDir, 'control.token');
  await fs.stat(tokenPath).then(
    () => {
      throw new Error(`expected ${tokenPath} to be removed after shutdown`);
    },
    () => {},
  );
  if (process.platform !== 'win32') {
    const socketPath = path.join(storeDir, 'control.sock');
    await fs.stat(socketPath).then(
      () => {
        throw new Error(`expected ${socketPath} to be removed after shutdown`);
      },
      () => {},
    );
  }
  log('PASS: control socket/pipe + token file cleaned up');

  log('==> ipc-smoke: PASS');
} catch (err) {
  failed = true;
  console.error('FAIL:', err instanceof Error ? err.stack : err);
  if (startStderr) {
    console.error('--- start child stderr ---');
    console.error(startStderr);
  }
} finally {
  // Best-effort cleanup regardless of where the assertions above failed.
  if (startChild && startChild.exitCode === null && startChild.signalCode === null) {
    startChild.kill('SIGKILL');
  }
  if (httpServer) {
    await new Promise((resolve) => {
      httpServer.close(() => resolve(undefined));
      httpServer.closeAllConnections?.();
    });
  }
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);
