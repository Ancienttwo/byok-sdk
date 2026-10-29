#!/usr/bin/env node
// Deterministic, real-server task-loop smoke for all three bundled adapters.
// The adapter processes are the existing fake CLI fixtures, selected through
// each adapter's public resolver seam; no vendor binary or model call is used.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, '..');
const clientDistIndex = path.join(clientDir, 'dist', 'index.js');
const serverDistIndex = path.join(clientDir, '..', 'server', 'dist', 'index.js');
const fixtureDir = path.join(clientDir, 'src', '__tests__', 'fixtures');
const runtimes = ['claude', 'codex', 'pi'];
const timeoutMs = 20_000;
// The client default Agent egress policy. The daemon below runs it (an empty
// `agentEgress`) and declines an offer that names any other policy.
const egressPolicy = {
  policyRevision: 'default-v1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 },
  reliable: { maxPendingEventsPerAgent: 256, maxPendingBytesPerAgent: 4 * 1024 * 1024, maxPendingBytesPerTenant: 16 * 1024 * 1024 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};
const terminalStates = new Set(['Complete', 'Failed', 'Cancelled']);

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
    throw new Error(`${label} not found at ${file}; run "bun run build" first`);
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

/**
 * Records every server state transition by taskId. A submitted execution has
 * no TaskHandle, so the server's event feed is its lifecycle; the server
 * announces the Offered state as `task.created`.
 */
function recordServerStates(byok) {
  const states = new Map();
  const feed = byok.events.subscribe()[Symbol.asyncIterator]();
  const done = (async () => {
    for (let next = await feed.next(); !next.done; next = await feed.next()) {
      const event = next.value;
      const state = event.kind === 'task.created' ? 'Offered' : event.kind === 'task.state' ? event.state : undefined;
      if (state !== undefined) states.set(event.taskId, [...(states.get(event.taskId) ?? []), state]);
    }
  })();
  return {
    of: (taskId) => states.get(taskId) ?? [],
    stop: async () => { await feed.return?.(); await done; },
  };
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

async function waitForAsync(predicate, label, ms = timeoutMs) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor(predicate, label, ms = timeoutMs) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// #763: npm installs claude and codex as shims only (on Windows: a .cmd, a
// .ps1 and an extensionless sh script; no .exe). Install fixture packages with
// the real npm so the shims are npm's own bytes. No vendor package and no
// model call.
const npmShimVersion = 'byok-npm-shim-fixture 1.0.0';

/** Installs one package of `files`, with `bin`, and returns the directory of its shims. */
async function installNpmPackage(workDir, name, files, bin) {
  const packageDir = path.join(workDir, name);
  const prefix = path.join(workDir, `${name}-prefix`);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin }));
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(packageDir, file), body);
  // On Windows npm itself is a .cmd shim. Run the npm CLI that ships next to
  // this Node instead; `bun run` points npm_execpath at bun, not npm.
  const npmCli = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(path.dirname(await fs.realpath(process.execPath)), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await assertFile(npmCli, 'npm CLI');
  const installed = spawnSync(process.execPath, [
    npmCli, 'install', '--global', '--install-links', '--prefix', prefix,
    '--cache', path.join(workDir, 'npm-cache'), '--no-audit', '--no-fund', '--no-update-notifier', packageDir,
  ], { encoding: 'utf8' });
  assert(installed.status === 0, `npm ${name} install failed: ${installed.error ?? installed.stderr}`);
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

/** Windows diagnostics only: the raw spawn error a shell-less execFile gets. */
function rawExecFileCode(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return result.error?.code ?? `exit ${result.status}`;
}

async function smokeNpmShimDetection(client, shimBin, hostPath) {
  const adapters = { claude: client.ClaudeAdapter, codex: client.CodexAdapter };
  const overrides = { claude: 'BYOK_CLAUDE_BIN', codex: 'BYOK_CODEX_BIN' };
  const shimFile = (runtime) => path.join(shimBin, process.platform === 'win32' ? `${runtime}.cmd` : runtime);
  // The shim directory joins the live PATH below, so detection reads PATH through the public policy.
  const runtimeEnvironment = { pass: ['PATH'] };
  const failures = [];
  for (const runtime of ['claude', 'codex']) {
    process.env.PATH = `${shimBin}${path.delimiter}${hostPath}`;
    if (process.platform === 'win32') {
      console.log(`npm shim ${runtime}: raw execFile by name -> ${rawExecFileCode(runtime)}; by .cmd path -> ${rawExecFileCode(shimFile(runtime))}`);
    }
    const viaPath = await new adapters[runtime]({ runtimeEnvironment }).detect();
    if (viaPath.kind !== 'available' || viaPath.version !== npmShimVersion) {
      failures.push(`${runtime} npm shim on PATH: ${JSON.stringify(viaPath)}`);
    }
    process.env.PATH = hostPath;
    process.env[overrides[runtime]] = shimFile(runtime);
    try {
      const viaOverride = await new adapters[runtime]({ runtimeEnvironment }).detect();
      if (viaOverride.kind !== 'available' || viaOverride.version !== npmShimVersion) {
        failures.push(`${runtime} npm shim as ${overrides[runtime]}: ${JSON.stringify(viaOverride)}`);
      }
    } finally {
      delete process.env[overrides[runtime]];
    }
  }
  process.env.PATH = hostPath;
  assert(failures.length === 0, `npm shim detection failed:\n  ${failures.join('\n  ')}`);
  console.log('PASS npm shims: claude and codex detected through PATH and through the override variable');
}

let failed = false;
let workDir;
let serverStates;
let scratchRoot;
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
  // Audit evidence may live under a long CI workspace path. Runtime sockets
  // need a separate, short, private root even when TMPDIR points at that path.
  scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(
    process.platform === 'win32' ? os.tmpdir() : '/tmp', 'byok-sm-',
  )));
  const home = path.resolve(suppliedHome ?? path.join(workDir, 'home'));
  const tmpDir = path.join(workDir, 'tmp');
  const storeDir = path.join(workDir, 'store');
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(tmpDir, { recursive: true, mode: 0o700 }),
  ]);

  // The detection fixture prints a version and exits 0 for any other argument.
  const npmShimBin = await installNpmPackage(workDir, 'byok-npm-shim-fixture', {
    'cli.js': `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log(${JSON.stringify(npmShimVersion)});\n`,
  }, { claude: 'cli.js', codex: 'cli.js' });
  // The task loop runs Claude and Codex through npm shims on every OS. Each bin
  // entry imports the fake CLI, so detection and launch both use the adapter's
  // own command resolution, with no spawnFn and no stand-in detect.
  const runtimeShimBin = await installNpmPackage(workDir, 'byok-npm-runtime-fixture', Object.fromEntries(
    ['claude', 'codex'].map((runtime) => [`${runtime}.mjs`,
      `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(path.join(fixtureDir, `fake-${runtime}.mjs`)).href)});\n`]),
  ), { claude: 'claude.mjs', codex: 'codex.mjs' });
  const runtimeShim = (runtime) => path.join(runtimeShimBin, process.platform === 'win32' ? `${runtime}.cmd` : runtime);
  console.log(`claude and codex task runs use npm shims: ${runtimeShim('claude')}, ${runtimeShim('codex')}`);

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
  await smokeNpmShimDetection(client, npmShimBin, hostPath);

  const productId = `byok-adapter-task-smoke-${process.pid}`;
  // The server is a self-hosted façade over the `@byok-sdk/cloud` kernel and
  // serves the wire over HTTP only (WP3B Step 2 removed the WS attachment), so
  // the daemon below runs the protocol §8 long-poll transport with the default
  // hold; stopping the daemon aborts the in-flight poll.
  byok = createByokServer({ productId });
  serverStates = recordServerStates(byok);
  const listening = await new Promise((resolve) => {
    httpServer = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => resolve(info));
  });
  const serverUrl = `http://127.0.0.1:${listening.port}`;
  console.log(`real @byok-sdk/server listening at ${serverUrl}`);

  const fake = (runtime) => path.join(fixtureDir, `fake-${runtime}.mjs`);
  const spawnFixture = (command, args, options) =>
    process.platform === 'win32'
      ? spawn(process.execPath, [command, ...args], options)
      : spawn(command, args, options);
  // Pi has no npm shim path here: Windows still cannot execFile its .mjs fixture.
  const lifecycleAdapter = (adapter) =>
    process.platform === 'win32'
      ? {
          descriptor: adapter.descriptor,
          detect: async () => ({ kind: 'available', version: 'fixture' }),
          prepare: (input) => adapter.prepare(input),
          runtimeEnvironment: () => adapter.runtimeEnvironment(),
        }
      : adapter;
  let piSpawnCount = 0;
  // Each fake reads its lifecycle variables, set on the live environment below, from its child environment.
  const fakeEnvironment = (runtime) => ({ pass: ['PATH', `FAKE_${runtime.toUpperCase()}_*`] });
  const adapters = [
    new client.ClaudeAdapter({ runtimeEnvironment: fakeEnvironment('claude'), resolveBin: () => ({ command: runtimeShim('claude'), source: 'path' }) }),
    new client.CodexAdapter({ runtimeEnvironment: fakeEnvironment('codex'), resolveBin: () => ({ command: runtimeShim('codex'), source: 'path' }) }),
    lifecycleAdapter(new client.PiAdapter({
      runtimeEnvironment: fakeEnvironment('pi'),
      resolveBin: () => ({ command: fake('pi'), source: 'path' }),
      spawnFn: (command, args, options) => {
        piSpawnCount += 1;
        return spawnFixture(command, args, options);
      },
    })),
  ];

  const pairingCode = (await byok.pairing.createPairingCode({ productId })).code;
  daemon = client.createDaemonWithAdapters(
    {
      localAgentRelease: { version: '0.0.0-adapter-smoke' },
      productName: 'Adapter Task Smoke',
      productId,
      serverUrl,
      storeDir,
      storage: { scratchRoot },
      runtimeAllowlist: runtimes,
      runtimePreference: runtimes,
      shutdownGraceMs: 2_000,
      agentHome: { hostStorageRoot: path.join(workDir, 'agent-home') },
      agentEgress: {},
    },
    adapters,
    {
      deviceCredentials: new InMemoryDeviceCredentialStore(),
      backoff: { baseMs: 10, maxMs: 100, factor: 1.5 },
      liveness: { timeoutMs: 5_000, checkIntervalMs: 250 },
      longPoll: { retryDelayMs: 10, idleDelayMs: 10 },
    },
  );
  const localEvents = [];
  unsubscribe = daemon.subscribe((event) => localEvents.push(event));

  await withTimeout(daemon.pair(pairingCode), 'pair');
  await withTimeout(daemon.start(), 'daemon start');
  // `lifecycle` open means the server accepted this run's `conn.hello` (#391).
  // Retain the independent server-side observation below so this public status
  // cannot become the smoke's only authority for a live transport.
  await waitFor(
    () => daemon.status().lifecycle.phase === 'running' && daemon.status().lifecycle.connection === 'open',
    'daemon long-poll transport',
  );
  const deviceId = daemon.status().deviceId;
  assert(deviceId !== undefined, 'daemon did not report a paired deviceId');
  await waitForAsync(
    async () => (await byok.machines.list()).some((machine) => machine.deviceId === deviceId && machine.connected),
    'server-observed device connection',
  );

  // Each task runs as its own Agent, in its own Agent home.
  const submit = async (taskId, payload) => {
    await byok.executions.submit({
      taskId,
      deviceId,
      payload: {
        agentRef: { agentId: taskId, profileRevision: '1' },
        session: { mode: 'fresh' },
        egressPolicy,
        terminalProjection: { mode: 'none' },
        ...payload,
      },
    });
    return { taskId };
  };
  const terminalResult = async (taskId, label) => {
    let result;
    await waitForAsync(async () => {
      const snapshot = await byok.tasks.get(taskId);
      result = snapshot?.result;
      return result !== undefined && terminalStates.has(snapshot.state);
    }, label);
    return result;
  };

  const preAdmissionPiSpawns = piSpawnCount;
  const rejected = await withTimeout(
    submit('adapter-smoke-pi-byok', {
      instruction: 'adapter task smoke: missing Pi BYOK launcher',
      runtime: 'pi',
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    }),
    'Pi BYOK missing-launcher submit',
  );
  const rejectedResult = await terminalResult(rejected.taskId, 'Pi BYOK missing-launcher lifecycle');
  // Server terminal receipt precedes the HTTP answer and the daemon's
  // journal-backed settlement. Observe the Host independently before reading it.
  await waitFor(
    () => localEvents.some((event) => event.taskId === rejected.taskId && event.kind === 'failed'),
    'Pi BYOK missing-launcher Host settlement',
  );
  const rejectedSnapshot = await byok.tasks.get(rejected.taskId);
  const rejectedLocalKinds = localEvents
    .filter((event) => event.taskId === rejected.taskId)
    .map((event) => event.kind);
  assert(rejectedResult.state === 'Failed', `missing launcher result was not Failed: ${JSON.stringify(rejectedResult)}`);
  assert(rejectedSnapshot?.state === 'Failed', `missing launcher task was not Failed: ${JSON.stringify(rejectedSnapshot)}`);
  assert(serverStates.of(rejected.taskId).includes('Failed'), `missing launcher did not reach Failed: ${JSON.stringify(serverStates.of(rejected.taskId))}`);
  assert(rejectedLocalKinds.includes('failed'), `missing launcher did not project local failure: ${JSON.stringify(rejectedLocalKinds)}`);
  assert(!rejectedLocalKinds.includes('claimed') && !rejectedLocalKinds.includes('started'), `missing launcher published claim/start: ${JSON.stringify(rejectedLocalKinds)}`);
  assert(piSpawnCount === preAdmissionPiSpawns, `missing launcher spawned Pi before decline (${preAdmissionPiSpawns} -> ${piSpawnCount})`);
  console.log('PASS pi BYOK missing launcher: decline -> failed without claim/start/spawn');

  for (const runtime of runtimes) {
    const handle = await withTimeout(
      submit(`adapter-smoke-${runtime}`, { instruction: `adapter task smoke: ${runtime}`, runtime }),
      `${runtime} submit`,
    );
    const result = await terminalResult(handle.taskId, `${runtime} task lifecycle`);
    await waitFor(
      () => localEvents.some((event) => event.taskId === handle.taskId && event.kind === 'completed'),
      `${runtime} Host terminal settlement`,
    );
    const snapshot = await byok.tasks.get(handle.taskId);
    const states = serverStates.of(handle.taskId);
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

    const offered = indexOfOrThrow(states, 'Offered', `${runtime} server states`);
    const claimed = indexOfOrThrow(states, 'Claimed', `${runtime} server states`);
    const started = indexOfOrThrow(states, 'Running', `${runtime} server states`);
    const complete = indexOfOrThrow(states, 'Complete', `${runtime} server states`);
    assert(offered < claimed && claimed < started && started < complete, `${runtime} server lifecycle order was ${JSON.stringify(states)}`);
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
        submit(`adapter-lifecycle-${runtime}`, { instruction: `adapter lifecycle smoke: ${runtime}`, runtime }),
        `${runtime} lifecycle submit`,
      );
      await waitFor(
        () => localEvents.some((event) => event.taskId === handle.taskId && event.kind === 'started'),
        `${runtime} lifecycle start`,
      );
      // The fixture blocks until this receipt is complete before emitting its
      // first frame, so a single read after `started` is sufficient — see
      // src/__tests__/fixtures/process-tree-receipt.mjs.
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      const tree = [
        ['root', receipt.rootPid],
        ['descendant', receipt.descendantPid],
        // Third level: a direct-child-only termination and a one-level sweep
        // are indistinguishable without it.
        ['grandchild', receipt.grandchildPid],
      ];
      for (const [level, pid] of tree) {
        assert(Number.isSafeInteger(pid) && pid > 0, `${runtime} receipt did not record a ${level} pid`);
        assert(processExists(pid), `${runtime} ${level} was not live before cancellation`);
      }
      await withTimeout(byok.tasks.cancel(handle.taskId, 'lifecycle smoke cancellation'), `${runtime} lifecycle cancel`);
      await waitFor(() => daemon.status().activeTaskCount === 0, `${runtime} quiescent disposal`);
      for (const [level, pid] of tree) {
        assert(!processExists(pid), `${runtime} ${level} remained live after TaskRunner released ownership`);
      }
      console.log(`PASS ${runtime} lifecycle: cancel -> quiescent root+descendant+grandchild disposal`);
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
  await serverStates?.stop();
  await byok?.close();
  await withTimeout(closeHttpServer(httpServer), 'HTTP server cleanup', 10_000).catch((error) => {
    console.error(`HTTP server cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (workDir) {
    await withTimeout(fs.rm(workDir, { recursive: true, force: true }), 'workspace cleanup', 10_000).catch((error) => {
      console.error(`workspace cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (scratchRoot) {
    await withTimeout(fs.rm(scratchRoot, { recursive: true, force: true }), 'scratch cleanup', 10_000).catch((error) => {
      console.error(`scratch cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (originalEnvironment) restoreProcessEnvironment(originalEnvironment);
}

process.exit(failed ? 1 : 0);
