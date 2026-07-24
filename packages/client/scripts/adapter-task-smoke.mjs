#!/usr/bin/env node
// Deterministic, real-server task-loop smoke for all three bundled adapters.
// The adapter processes are the existing fake CLI fixtures, selected through
// each adapter's public resolver seam; no vendor binary or model call is used.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, '..');
const clientDistIndex = path.join(clientDir, 'dist', 'index.js');
const serverDistIndex = path.join(clientDir, '..', 'server', 'dist', 'index.js');
const fixtureDir = path.join(clientDir, 'src', '__tests__', 'fixtures');
const runtimes = ['claude', 'codex', 'pi'];
const timeoutMs = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withTimeout(promise, label, ms = timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function assertFile(file, label) {
  try {
    await fs.stat(file);
  } catch {
    throw new Error(`${label} not found at ${file}; run "pnpm -r build" first`);
  }
}

function replaceProcessEnvironment(next) {
  const original = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, next);
  return original;
}

function restoreProcessEnvironment(original) {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, original);
}

function closeHttpServer(httpServer) {
  if (!httpServer) return Promise.resolve();
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections?.();
  });
}

async function collectTaskEvents(handle) {
  const events = [];
  for await (const event of handle.events()) {
    events.push(event);
  }
  return events;
}

function stateNames(events) {
  return events.filter((event) => event.kind === 'state').map((event) => event.state);
}

function indexOfOrThrow(values, value, label) {
  const index = values.indexOf(value);
  assert(index !== -1, `${label} did not include ${value}; got ${JSON.stringify(values)}`);
  return index;
}

let failed = false;
let workDir;
let daemon;
let byok;
let httpServer;
let unsubscribe;
let originalEnvironment;
const suppliedHome = process.env.BYOK_SMOKE_HOME;

try {
  await assertFile(clientDistIndex, '@byok/client dist');
  await assertFile(serverDistIndex, '@byok/server dist');
  for (const runtime of runtimes) {
    await assertFile(path.join(fixtureDir, `fake-${runtime}.mjs`), `${runtime} fixture`);
  }

  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-adapter-task-smoke-'));
  const home = path.resolve(suppliedHome ?? path.join(workDir, 'home'));
  const tmpDir = path.join(workDir, 'tmp');
  const storeDir = path.join(workDir, 'store');
  const workspaceRoot = path.join(workDir, 'workspace');
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(tmpDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
  ]);

  // Do not let a developer's ambient credential/config variables reach a fake
  // runtime. Keep only the platform values needed to execute Node and create
  // the isolated temp files; the daemon's environment allowlist is exercised on
  // top of this already-synthetic ambient environment.
  const hostPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  originalEnvironment = replaceProcessEnvironment({
    PATH: hostPath,
    HOME: home,
    TMPDIR: tmpDir,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    SHELL: process.env.SHELL ?? '/bin/sh',
  });

  const [{ createByokServer }, { serve }, client] = await Promise.all([
    import(pathToFileURL(serverDistIndex).href),
    import('@hono/node-server'),
    import(pathToFileURL(clientDistIndex).href),
  ]);

  const productId = `byok-adapter-task-smoke-${process.pid}`;
  byok = createByokServer({ productId, heartbeatIntervalMs: 100 });
  const listening = await new Promise((resolve) => {
    httpServer = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => {
      byok.attachWebSocket(httpServer);
      resolve(info);
    });
  });
  const serverUrl = `http://127.0.0.1:${listening.port}`;
  console.log(`real @byok/server listening at ${serverUrl}`);

  const fake = (runtime) => path.join(fixtureDir, `fake-${runtime}.mjs`);
  const adapters = [
    new client.ClaudeAdapter({ resolveBin: () => ({ command: fake('claude'), source: 'path' }) }),
    new client.CodexAdapter({ resolveBin: () => ({ command: fake('codex'), source: 'path' }) }),
    new client.PiAdapter({ resolveBin: () => ({ command: fake('pi'), source: 'path' }) }),
  ];

  const pairingCode = byok.pairing.createPairingCode().code;
  daemon = client.createDaemonWithAdapters(
    {
      productName: 'Adapter Task Smoke',
      productId,
      serverUrl,
      workspaceRoot,
      storeDir,
      runtimeAllowlist: runtimes,
      runtimePreference: runtimes,
      shutdownGraceMs: 2_000,
    },
    adapters,
    {
      backoff: { baseMs: 10, maxMs: 100, factor: 1.5 },
      liveness: { timeoutMs: 5_000, checkIntervalMs: 250 },
    },
  );
  const localEvents = [];
  unsubscribe = daemon.subscribe((event) => localEvents.push(event));

  await withTimeout(daemon.pair(pairingCode), 'pair');
  await withTimeout(daemon.start(), 'daemon start');
  assert(daemon.status().connected, 'daemon did not reach connected state');

  for (const runtime of runtimes) {
    const handle = await withTimeout(
      byok.dispatch({ instruction: `adapter task smoke: ${runtime}`, runtime, policy: { mode: 'auto' } }),
      `${runtime} dispatch`,
    );
    const taskEventsPromise = collectTaskEvents(handle);
    const [serverEvents, result] = await withTimeout(
      Promise.all([taskEventsPromise, handle.result()]),
      `${runtime} task lifecycle`,
    );
    const snapshot = byok.tasks.get(handle.taskId);
    const serverStates = stateNames(serverEvents);
    const localTask = daemon.tasks().find((task) => task.taskId === handle.taskId);
    const localClaim = localEvents.find((event) => event.taskId === handle.taskId && event.kind === 'claimed');
    const localKinds = localEvents
      .filter((event) => event.taskId === handle.taskId)
      .map((event) => event.kind);

    assert(result.state === 'Complete', `${runtime} result was not Complete: ${JSON.stringify(result)}`);
    assert(snapshot?.state === 'Complete', `${runtime} server task was not Complete: ${JSON.stringify(snapshot)}`);
    assert(snapshot.claimedRuntime === runtime, `${runtime} server claimedRuntime mismatch: ${JSON.stringify(snapshot)}`);
    assert(localTask?.state === 'Complete', `${runtime} local observer task was not Complete: ${JSON.stringify(localTask)}`);
    assert(localClaim?.claimedRuntime === runtime, `${runtime} local claimed event runtime mismatch: ${JSON.stringify(localClaim)}`);
    assert(localTask?.claimedRuntime === runtime, `${runtime} local observer claimedRuntime mismatch: ${JSON.stringify(localTask)}`);

    const offered = indexOfOrThrow(serverStates, 'Offered', `${runtime} server states`);
    const claimed = indexOfOrThrow(serverStates, 'Claimed', `${runtime} server states`);
    const started = indexOfOrThrow(serverStates, 'Running', `${runtime} server states`);
    const complete = indexOfOrThrow(serverStates, 'Complete', `${runtime} server states`);
    assert(offered < claimed && claimed < started && started < complete, `${runtime} server lifecycle order was ${JSON.stringify(serverStates)}`);
    for (const kind of ['offered', 'claimed', 'started', 'completed']) {
      assert(localKinds.includes(kind), `${runtime} local observer omitted ${kind}: ${JSON.stringify(localKinds)}`);
    }

    console.log(
      `PASS ${runtime}: offer -> claim(${runtime}) -> started -> complete; ` +
        `server claimedRuntime=${snapshot.claimedRuntime}; local observer claimedRuntime=${localTask.claimedRuntime}`,
    );
  }

  console.log('adapter-task-smoke: PASS');
} catch (error) {
  failed = true;
  console.error('adapter-task-smoke: FAIL');
  console.error(error instanceof Error ? error.stack : error);
} finally {
  unsubscribe?.();
  if (daemon) {
    await withTimeout(daemon.stop(), 'daemon cleanup', 10_000).catch((error) => {
      console.error(`daemon cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  byok?.stop();
  await closeHttpServer(httpServer);
  if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  if (originalEnvironment) restoreProcessEnvironment(originalEnvironment);
}

process.exit(failed ? 1 : 0);
