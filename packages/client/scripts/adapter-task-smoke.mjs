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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitFor(predicate, label, ms = timeoutMs) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  await assertFile(clientDistIndex, '@byok-sdk/client dist');
  await assertFile(serverDistIndex, '@byok-sdk/server dist');
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
  const systemRoot = process.env.SystemRoot;
  if (process.platform === 'win32') {
    assert(systemRoot, 'Windows smoke requires SystemRoot to execute system tools');
  }
  const platformEnvironment = process.platform === 'win32'
    ? {
        SystemRoot: systemRoot,
        USERPROFILE: home,
        TEMP: tmpDir,
        TMP: tmpDir,
      }
    : {
        TMPDIR: tmpDir,
        SHELL: process.env.SHELL ?? '/bin/sh',
      };
  originalEnvironment = replaceProcessEnvironment({
    PATH: hostPath,
    HOME: home,
    ...platformEnvironment,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  });
  assert(
    path.resolve(os.tmpdir()) === path.resolve(tmpDir),
    `synthetic temp authority escaped isolation: ${os.tmpdir()}`,
  );
  assert(
    path.resolve(os.homedir()) === path.resolve(home),
    `synthetic home authority escaped isolation: ${os.homedir()}`,
  );

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
  console.log(`real @byok-sdk/server listening at ${serverUrl}`);

  const fake = (runtime) => path.join(fixtureDir, `fake-${runtime}.mjs`);
  const spawnFixture = (command, args, options) =>
    process.platform === 'win32'
      ? spawn(process.execPath, [command, ...args], options)
      : spawn(command, args, options);
  const lifecycleAdapter = (adapter) =>
    process.platform === 'win32'
      ? {
          descriptor: adapter.descriptor,
          detect: async () => ({ present: true, version: 'fixture' }),
          prepare: (input) => adapter.prepare(input),
        }
      : adapter;
  let piSpawnCount = 0;
  const adapters = [
    lifecycleAdapter(new client.ClaudeAdapter({
      resolveBin: () => ({ command: fake('claude'), source: 'path' }),
      spawnFn: spawnFixture,
    })),
    lifecycleAdapter(new client.CodexAdapter({
      resolveBin: () => ({ command: fake('codex'), source: 'path' }),
      spawnFn: spawnFixture,
    })),
    lifecycleAdapter(new client.PiAdapter({
      resolveBin: () => ({ command: fake('pi'), source: 'path' }),
      spawnFn: (command, args, options) => {
        piSpawnCount += 1;
        return spawnFixture(command, args, options);
      },
    })),
  ];

  const pairingCode = byok.pairing.createPairingCode({ tenantId: 'tenant-smoke', productId }).code;
  daemon = client.createDaemonWithAdapters(
    {
      productName: 'Adapter Task Smoke',
      productId,
      serverUrl,
      workspaceRoot,
      storeDir,
      runtimeAllowlist: runtimes,
      runtimePreference: runtimes,
      runtimeEnvironment: {
        claude: { allow: ['FAKE_CLAUDE_PROCESS_TREE_FILE', 'FAKE_CLAUDE_HANG_AFTER_TOOL'] },
        codex: { allow: ['FAKE_CODEX_PROCESS_TREE_FILE', 'FAKE_CODEX_HANG'] },
        pi: { allow: ['FAKE_PI_PROCESS_TREE_FILE', 'FAKE_PI_HANG_AFTER_TOOL'] },
      },
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

  const preAdmissionPiSpawns = piSpawnCount;
  const rejected = await withTimeout(
    byok.dispatch({
      instruction: 'adapter task smoke: missing Pi BYOK launcher',
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
      policy: { mode: 'auto' },
    }),
    'Pi BYOK missing-launcher dispatch',
  );
  const rejectedEventsPromise = collectTaskEvents(rejected);
  const [rejectedEvents, rejectedResult] = await withTimeout(
    Promise.all([rejectedEventsPromise, rejected.result()]),
    'Pi BYOK missing-launcher lifecycle',
  );
  const rejectedSnapshot = byok.tasks.get(rejected.taskId);
  const rejectedLocalKinds = localEvents
    .filter((event) => event.taskId === rejected.taskId)
    .map((event) => event.kind);
  assert(rejectedResult.state === 'Failed', `missing launcher result was not Failed: ${JSON.stringify(rejectedResult)}`);
  assert(rejectedSnapshot?.state === 'Failed', `missing launcher task was not Failed: ${JSON.stringify(rejectedSnapshot)}`);
  assert(stateNames(rejectedEvents).includes('Failed'), `missing launcher did not reach Failed: ${JSON.stringify(rejectedEvents)}`);
  assert(rejectedLocalKinds.includes('failed'), `missing launcher did not project local failure: ${JSON.stringify(rejectedLocalKinds)}`);
  assert(!rejectedLocalKinds.includes('claimed') && !rejectedLocalKinds.includes('started'), `missing launcher published claim/start: ${JSON.stringify(rejectedLocalKinds)}`);
  assert(piSpawnCount === preAdmissionPiSpawns, `missing launcher spawned Pi before decline (${preAdmissionPiSpawns} -> ${piSpawnCount})`);
  console.log('PASS pi BYOK missing launcher: decline -> failed without claim/start/spawn');

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

  const lifecycleEnv = {
    claude: { receipt: 'FAKE_CLAUDE_PROCESS_TREE_FILE', hang: 'FAKE_CLAUDE_HANG_AFTER_TOOL' },
    codex: { receipt: 'FAKE_CODEX_PROCESS_TREE_FILE', hang: 'FAKE_CODEX_HANG' },
    pi: { receipt: 'FAKE_PI_PROCESS_TREE_FILE', hang: 'FAKE_PI_HANG_AFTER_TOOL' },
  };
  for (const runtime of runtimes) {
    const receiptFile = path.join(workDir, `${runtime}-process-tree.json`);
    const envNames = lifecycleEnv[runtime];
    process.env[envNames.receipt] = receiptFile;
    process.env[envNames.hang] = '1';
    try {
      const handle = await withTimeout(
        byok.dispatch({ instruction: `adapter lifecycle smoke: ${runtime}`, runtime, policy: { mode: 'auto' } }),
        `${runtime} lifecycle dispatch`,
      );
      await waitFor(
        () => localEvents.some((event) => event.taskId === handle.taskId && event.kind === 'started'),
        `${runtime} lifecycle start`,
      );
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      assert(processExists(receipt.rootPid), `${runtime} root was not live before cancellation`);
      assert(processExists(receipt.descendantPid), `${runtime} descendant was not live before cancellation`);
      await withTimeout(handle.cancel('lifecycle smoke cancellation'), `${runtime} lifecycle cancel`);
      await waitFor(() => daemon.status().activeTaskCount === 0, `${runtime} quiescent disposal`);
      assert(!processExists(receipt.rootPid), `${runtime} root remained live after TaskRunner released ownership`);
      assert(!processExists(receipt.descendantPid), `${runtime} descendant remained live after TaskRunner released ownership`);
      console.log(`PASS ${runtime} lifecycle: cancel -> quiescent root+descendant disposal`);
    } finally {
      delete process.env[envNames.receipt];
      delete process.env[envNames.hang];
    }
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
  await withTimeout(closeHttpServer(httpServer), 'HTTP server cleanup', 10_000).catch((error) => {
    console.error(`HTTP server cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (workDir) {
    await withTimeout(fs.rm(workDir, { recursive: true, force: true }), 'workspace cleanup', 10_000).catch((error) => {
      console.error(`workspace cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (originalEnvironment) restoreProcessEnvironment(originalEnvironment);
}

process.exit(failed ? 1 : 0);
