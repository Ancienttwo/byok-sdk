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
// Uses the REAL `@byok-sdk/server` reference implementation (not a hand-rolled
// stub) to give the daemon something genuine to pair/connect against. That
// server is a self-hosted façade over the `@byok-sdk/cloud` kernel and serves
// the wire over HTTP only (WP3B Step 2 removed the WS attachment), so the
// daemon here runs the protocol §8 long-poll transport. What this script
// asserts is the LOCAL control socket, which is transport-independent — both
// `@byok-sdk/server` and `@hono/node-server` are already `@byok-sdk/client`
// devDependencies (see `src/__tests__/fixtures/real-server.ts`, which this
// mirrors) and are built by the same `bun run build` this script requires
// first.
//
// Usage: node packages/client/scripts/ipc-smoke.mjs
//   Requires @byok-sdk/client and @byok-sdk/server already built
//   (`bun run build` — @byok-sdk/protocol too, transitively).

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
  ['@byok-sdk/client', byokAgentBin],
  ['@byok-sdk/server', serverDistIndex],
]) {
  try {
    await fs.stat(file);
  } catch {
    console.error(`FAIL: ${file} not found -- run "bun run build" first (needed: ${label})`);
    process.exit(1);
  }
}

const { createByokServer } = await import(pathToFileURL(serverDistIndex).href);
const { serve } = await import(honoNodeServerSpecifier);

const productId = `byok-ipc-smoke-${process.pid}`;
const workDir = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'byok-ipc-smoke-')));
const storeDir = path.join(workDir, 'store');
const configPath = path.join(workDir, 'config.json');

// Default long-poll hold (~50s) on purpose: the daemon stops by aborting its
// in-flight `GET /byok/events` (`LongPollClient.stop()` aborts the loop's
// signal), so the `start` child must exit within seconds of `unpair` even
// while a poll is being held. A hold override here would hide a regression.
const byok = createByokServer({ productId });
/** @type {import('node:http').Server} */
let httpServer;
let startChild;
let startStderr = '';
let failed = false;
let lastCliPid;
const startedAt = performance.now();
let stepStartedAt = startedAt;
const httpSockets = new Set();
const pairRequests = [];

function log(line) {
  const now = performance.now();
  if (line.startsWith('==>')) stepStartedAt = now;
  const duration = line.startsWith('PASS:') ? ` duration_ms=${Math.ceil(now - stepStartedAt)}` : '';
  console.log(`[+${Math.ceil(now - startedAt)}ms] ${line}${duration}`);
}

function diagnostic(line) {
  console.error(`[+${Math.ceil(performance.now() - startedAt)}ms] ${line}`);
}

function connectionState() {
  return {
    sampled_ms: Math.ceil(performance.now() - startedAt),
    cliPid: lastCliPid, daemonPid: startChild?.pid, daemonExitCode: startChild?.exitCode,
    daemonSignal: startChild?.signalCode, serverListening: httpServer?.listening,
    pairRequests: pairRequests.map((entry) => ({ ...entry })),
    httpSockets: [...httpSockets].map((socket) => ({
      localPort: socket.localPort, remotePort: socket.remotePort,
      readyState: socket.readyState, destroyed: socket.destroyed,
      bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten,
    })),
  };
}

async function snapshotState() {
  diagnostic('--- IPC state after failure ---');
  diagnostic(JSON.stringify(connectionState()));
  for (const name of ['control.sock', 'control.token', 'device.json', 'mutex.sock', 'daemon-owner.json']) {
    const state = await fs.lstat(path.join(storeDir, name)).then(
      (stat) => ({ socket: stat.isSocket(), file: stat.isFile(), size: stat.size }),
      (error) => ({ error: error.code }),
    );
    diagnostic(`${name}: ${JSON.stringify(state)}`);
  }
}

async function snapshotProcesses() {
  const requestedAt = Math.ceil(performance.now() - startedAt);
  if (process.platform === 'win32') {
    return 'process snapshot unavailable on Windows';
  }
  try {
    // comm excludes argv: pairing codes and credential command stdin stay private.
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,etime=,stat=,comm='], { timeout: 1000 });
    const rows = stdout.trim().split('\n').map((line) => ({
      line, pid: Number(line.trim().split(/\s+/)[0]), ppid: Number(line.trim().split(/\s+/)[1]),
    }));
    const owned = new Set([process.pid]);
    for (let count = 0; count !== owned.size;) {
      count = owned.size;
      for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
    }
    return `--- process tree: requested_ms=${requestedAt} collected_ms=${Math.ceil(performance.now() - startedAt)} pid ppid etime stat comm ---\n` +
      rows.filter((row) => owned.has(row.pid)).map((row) => row.line).join('\n');
  } catch (error) {
    return `process snapshot failed: ${error.code ?? error.message}`;
  }
}

async function runCli(args, timeoutMs = 15000) {
  const started = performance.now();
  let snapshot;
  let beforeKill;
  // Reserve one second for best-effort sampling. Keep execFile's original
  // deadline and stream disposal, including pipes inherited by descendants.
  const timer = setTimeout(() => {
    beforeKill = connectionState();
    snapshot = snapshotProcesses();
  }, Math.max(0, timeoutMs - 1000));
  const command = execFileAsync(process.execPath, [byokAgentBin, ...args], {
    timeout: timeoutMs,
    env: process.env,
  });
  const child = command.child;
  lastCliPid = child.pid;
  try {
    const output = await command;
    log(`${args[0]}: pid=${child.pid} duration_ms=${Math.ceil(performance.now() - started)}`);
    return output;
  } catch (error) {
    clearTimeout(timer);
    diagnostic(`CLI failed: ${JSON.stringify({
      command: args[0], pid: child.pid, duration_ms: Math.ceil(performance.now() - started),
      timeoutMs, killed: child.killed, signal: error.signal ?? child.signalCode,
      code: error.code ?? child.exitCode, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
    })}`);
    if (beforeKill) diagnostic(`IPC state near deadline: ${JSON.stringify(beforeKill)}`);
    diagnostic(await (snapshot ?? snapshotProcesses()));
    // Do not include execFile's message: it contains the pairing code in argv.
    throw new Error(`${args[0]} failed (pid=${child.pid})`);
  } finally {
    clearTimeout(timer);
  }
}

async function timedCleanup(label, operation) {
  const started = performance.now();
  log(`cleanup ${label}: begin`);
  try {
    return await operation();
  } finally {
    log(`cleanup ${label}: duration_ms=${Math.ceil(performance.now() - started)}`);
  }
}

async function diagnosticFetch(request, env) {
  if (new URL(request.url).pathname !== '/byok/pair') return byok.hono.fetch(request, env);
  const started = performance.now();
  const entry = { arrived_ms: Math.ceil(started - startedAt) };
  pairRequests.push(entry);
  const onAbort = () => { entry.aborted_ms = Math.ceil(performance.now() - startedAt); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await byok.hono.fetch(request, env);
    entry.status = response.status;
    return response;
  } finally {
    entry.duration_ms = Math.ceil(performance.now() - started);
    request.signal.removeEventListener('abort', onAbort);
    log(`HTTP /byok/pair: arrived_ms=${entry.arrived_ms} duration_ms=${entry.duration_ms} status=${entry.status ?? 'error'}`);
  }
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
  log(`runtime: platform=${process.platform} arch=${process.arch} node=${process.version} pid=${process.pid}`);
  const port = await new Promise((resolve) => {
    httpServer = serve({ fetch: diagnosticFetch, port: 0 }, (info) => resolve(info.port));
    httpServer.on('connection', (socket) => {
      httpSockets.add(socket);
      socket.once('close', () => httpSockets.delete(socket));
    });
  });
  const serverUrl = `http://127.0.0.1:${port}`;
  log(`==> real @byok-sdk/server reference implementation listening at ${serverUrl}`);

  const { code: pairingCode } = await byok.pairing.createPairingCode({ productId });

  await fs.writeFile(
    configPath,
    JSON.stringify({ productName: 'IPC Smoke', productId, serverUrl, storeDir }, null, 2),
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
  await waitForStartupLine(startChild, '"lifecycle":{"phase":"running","connection":"open"}', 10000);
  log('PASS: daemon reported the open connection on stdout');

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
  await waitForChildExit(startChild, 5000);
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
  await snapshotState().catch((error) => diagnostic(`IPC snapshot failed: ${error.message}`));
  if (startStderr) {
    console.error('--- start child stderr ---');
    console.error(startStderr);
  }
} finally {
  // Best-effort cleanup regardless of where the assertions above failed.
  if (startChild && startChild.exitCode === null && startChild.signalCode === null) {
    await timedCleanup('start child kill', async () => { startChild.kill('SIGKILL'); });
  }
  if (httpServer) {
    await timedCleanup('HTTP server close', () => new Promise((resolve) => {
      httpServer.close(() => resolve(undefined));
      httpServer.closeAllConnections?.();
    }));
  }
  await timedCleanup('work directory remove', () => fs.rm(workDir, { recursive: true, force: true }).catch(() => {}));
}

process.exit(failed ? 1 : 0);
