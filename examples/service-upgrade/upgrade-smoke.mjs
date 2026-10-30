// #1097 upgrade smoke: a real service under this OS's manager (launchd,
// systemd --user, WinSW), installed and upgraded from payloads through
// createServiceInstallation, once by `byok-agent install --payload` (owner
// `cli`) and once by app-installer.ts (owner `app`). Each run:
//
//   install v1 → pair through the service (serviceEnrollment) → running
//   [Windows: taskkill /F the daemon → the SCM restarts it → running]
//   upgrade v2 → switched
//   upgrade v3, which passes the precheck, corrupts the journal and exits 1
//     → health check fails → v2 and its store snapshot restored → running
//   rollback → v1 and the v2 upgrade's snapshot → running
//   uninstall → no service, no versions; the store stays
//
// On Windows the cli run keeps its store on an 8.3 short-name path and the app
// run on a path longer than 260 characters (#1030).
//
//   node examples/service-upgrade/upgrade-smoke.mjs        (WINSW_BIN=<WinSW-x64.exe> on Windows)
//
// Requires `bun run build`. On Linux the user manager must be running
// (`loginctl enable-linger`); a missing one fails the run.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { byokSdkPackaging } from '@byok-sdk/client/packaging';
import { createByokServer, listenLoopback } from '@byok-sdk/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentCli = path.resolve(here, '../../packages/client/dist/bin/byok-agent.js');
const installer = path.join(here, 'app-installer.ts');
const isWindows = process.platform === 'win32';
const winswBin = process.env.WINSW_BIN;
if (isWindows && winswBin === undefined) throw new Error('set WINSW_BIN to the WinSW-x64.exe path');
// Unix sockets live under the store; keep the base short outside Windows.
const work = realpathSync(mkdtempSync(path.join(isWindows ? os.tmpdir() : '/tmp', 'byok-upg-')));

function log(line) {
  console.log(`[upgrade-smoke] ${line}`);
}

function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: here, timeout: options.timeoutMs ?? 300_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code ?? 1, stdout, stderr });
    });
  });
}

async function ok(args, options) {
  const result = await run(args, options);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

async function writePayload(owner, id, files) {
  const dir = path.join(work, 'payloads', `${owner}-${id}`);
  const digests = {};
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
    digests[name] = createHash('sha256').update(content).digest('hex');
  }
  await fs.writeFile(path.join(dir, 'byok-payload.json'), JSON.stringify({ format: 'byok-service-payload', version: 1, id, files: digests }));
  return dir;
}

async function until(read, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The live daemon pid once `status` reports `phase` (any phase when omitted). */
function livePid(variant, phase = '') {
  return until(async () => {
    const { stdout } = await run([agentCli, 'status', '--config', variant.config]);
    const match = new RegExp(`^live: pid=(\\d+) .*${phase}`, 'mu').exec(stdout);
    return match ? Number(match[1]) : undefined;
  }, `${variant.name} ${phase || 'live'}`);
}

function runningPid(variant) {
  return livePid(variant, '\\brunning\\b');
}

function shortPath(dir) {
  const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8' }).trim();
  assert.notEqual(short.toLowerCase(), dir.toLowerCase(), `${dir} has no 8.3 short name on this volume`);
  return short;
}

async function storeFor(owner) {
  if (isWindows && owner === 'cli') {
    const dir = path.join(work, 'store with a long name');
    await fs.mkdir(dir, { recursive: true });
    return path.join(shortPath(dir), 'store');
  }
  if (isWindows) {
    let dir = path.join(work, 'long');
    while (dir.length <= 280) dir = path.join(dir, 'a-directory-name-for-a-path-past-max-path');
    return dir;
  }
  return path.join(work, `${owner}-store`);
}

/** The commands of one run: the CLI drives the `cli` installation, app-installer.ts the `app` one. */
function commands(variant) {
  const service = ['--config', variant.config, '--name', variant.name];
  const windows = isWindows ? ['--winsw-bin', winswBin, '--winsw-install-dir', variant.winswDir] : [];
  if (variant.owner === 'cli') {
    return {
      install: (payload) => [agentCli, 'install', '--payload', payload, '--install-root', variant.installRoot, ...service, ...windows],
      upgrade: (payload) => [agentCli, 'upgrade', 'apply', payload, '--json', ...service, ...windows],
      rollback: () => [agentCli, 'upgrade', 'rollback', '--json', ...service, ...windows],
      uninstall: () => [agentCli, 'uninstall', ...service, ...windows],
    };
  }
  const app = (action, payload) => [installer, action, '--install-root', variant.installRoot, ...service, ...windows, ...(payload ? ['--payload', payload] : [])];
  return { install: (p) => app('install', p), upgrade: (p) => app('upgrade', p), rollback: () => app('rollback'), uninstall: () => app('uninstall') };
}

async function receipt(variant) {
  return JSON.parse(await ok([agentCli, 'upgrade', 'status', '--json', '--config', variant.config, '--name', variant.name]));
}

async function smoke(owner, server, payloads) {
  const storeDir = await storeFor(owner);
  const variant = {
    owner, productId: server.productId, name: server.productId, storeDir,
    config: path.join(work, `${owner}.json`),
    installRoot: path.join(work, `${owner}-app`),
    winswDir: path.join(work, `${owner}-winsw`),
  };
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(variant.config, JSON.stringify({
    productName: 'Upgrade Smoke', productId: server.productId, serverUrl: server.url, storeDir, serviceEnrollment: { enabled: true },
  }, null, 2));
  const cmd = commands(variant);
  log(`${owner}: store ${storeDir} (${storeDir.length} chars)`);
  try {
    await lifecycle(variant, cmd, server, payloads);
  } catch (error) {
    await diagnose(variant);
    // Leave no service registered on the machine; the failure stays the result.
    await run(cmd.uninstall());
    throw error;
  }
}

/** What a failed run leaves to read: the CLI's view and the tail of every service log. */
async function diagnose(variant) {
  const { stdout, stderr } = await run([agentCli, 'status', '--config', variant.config]);
  console.log(`--- ${variant.owner} status\n${stdout}${stderr}`);
  const logDir = path.join(variant.storeDir, 'service-logs');
  for (const name of await fs.readdir(logDir).catch(() => [])) {
    const text = await fs.readFile(path.join(logDir, name), 'utf8').catch(() => '');
    console.log(`--- ${variant.owner} ${name}\n${text.split('\n').slice(-40).join('\n')}`);
  }
}

async function lifecycle(variant, cmd, server, payloads) {
  const { owner, storeDir } = variant;

  await ok(cmd.install(payloads.v1));
  // Pair through the service: a pair that finds no live service enrolls in this process instead.
  await livePid(variant);
  const { code } = await server.byok.pairing.createPairingCode({ productId: server.productId });
  await ok([agentCli, 'pair', code, '--server', server.url, '--config', variant.config]);
  let pid = await runningPid(variant);
  log(`${owner}: v1 running pid=${pid}`);

  if (isWindows) {
    execFileSync('taskkill', ['/F', '/PID', String(pid)]);
    const killed = pid;
    pid = await until(async () => {
      const next = await runningPid(variant);
      return next !== killed ? next : undefined;
    }, `${owner} restart after taskkill /F`);
    log(`${owner}: taskkill /F ${killed} → SCM restarted pid=${pid}`);
  }

  await ok(cmd.upgrade(payloads.v2));
  assert.deepEqual([(await receipt(variant)).current, (await receipt(variant)).receipt.state], ['2.0.0', 'switched']);
  await runningPid(variant);
  log(`${owner}: upgraded to v2`);

  const failed = await run(cmd.upgrade(payloads.v3));
  assert.notEqual(failed.code, 0, 'the v3 upgrade must fail');
  const after = await receipt(variant);
  assert.equal(after.current, '2.0.0');
  assert.deepEqual([after.receipt.state, after.receipt.code, after.receipt.to], ['rolled-back', 'health_check_failed', '3.0.0']);
  await runningPid(variant);
  log(`${owner}: v3 failed its health check; v2 and its store snapshot restored`);

  await ok(cmd.rollback());
  const rolled = await receipt(variant);
  assert.deepEqual([rolled.current, rolled.receipt.state, rolled.receipt.from], ['1.0.0', 'rolled-back', '1.0.0']);
  await runningPid(variant);
  log(`${owner}: rolled back to v1`);

  await ok(cmd.uninstall());
  // macOS and Linux keep the enrollment in the user's keychain or Secret Service; leave none behind.
  // On Windows it is in the service account's Credential Manager, which this user cannot reach.
  if (!isWindows) {
    // The manager unloads the service before its daemon has released the store.
    await until(async () => (/^live status: daemon not reachable/mu.test((await run([agentCli, 'status', '--config', variant.config])).stdout) ? true : undefined),
      `${variant.name} exit`);
    await ok([agentCli, 'unpair', '--yes', '--config', variant.config]);
  }
  const left = await fs.readdir(variant.installRoot);
  assert.deepEqual(left, [], `install root after uninstall: ${left.join(', ')}`);
  await fs.access(path.join(storeDir, 'daemon.db'));
  log(`${owner}: uninstalled; the store stays`);
}

try {
  log(`platform=${process.platform} node=${process.version}`);
  const bundle = path.join(work, 'bundle', 'byok-agent.mjs');
  // tsup drops the `node:` prefix from the CLI's builtins, and esbuild does not list bare `readline/promises` as one.
  await build({ entryPoints: [agentCli], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle,
    external: ['readline/promises'], logLevel: 'silent', plugins: [byokSdkPackaging({ format: 'esm' })] });
  const agent = await fs.readFile(bundle);
  // v3 passes the precheck with the real build, then breaks every start.
  const broken = (journal) => [
    "import { writeFileSync } from 'node:fs';",
    "if (process.argv[2] === 'upgrade') await import('./real.mjs');",
    `else { writeFileSync(${JSON.stringify(journal)}, 'not a database'); process.exit(1); }`,
  ].join('\n');

  // Each run is its own product: an OS credential entry is per product, and one store's enrollment is not another's.
  for (const owner of ['cli', 'app']) {
    const productId = `byok-upgrade-smoke-${process.pid}-${owner}`;
    const byok = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(work, `${owner}-server.sqlite`) } });
    let port = null;
    const listener = await listenLoopback({ portStore: { read: async () => port, claim: async (candidate) => (port ??= candidate) },
      createHandler: () => (request) => byok.hono.fetch(request) });
    try {
      const journal = path.join(await storeFor(owner), 'daemon.db');
      const payloads = {
        v1: await writePayload(owner, '1.0.0', { 'byok-agent.mjs': agent }),
        v2: await writePayload(owner, '2.0.0', { 'byok-agent.mjs': agent }),
        v3: await writePayload(owner, '3.0.0', { 'byok-agent.mjs': broken(journal), 'real.mjs': agent }),
      };
      await smoke(owner, { byok, productId, url: listener.serverUrl }, payloads);
    } finally {
      await listener.close();
      await byok.close();
    }
  }
  log('passed');
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
