#!/usr/bin/env node
// Native systemd user-manager proof. Requires a built client and reachable user D-Bus.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const systemctl = async (...args) => (await exec('systemctl', ['--user', ...args], {
  timeout: 20_000, env: { ...process.env, LC_ALL: 'C' },
})).stdout.trim();

assert.equal(process.platform, 'linux', 'systemd smoke requires native Linux; unsupported hosts fail');
assert.ok(process.env.XDG_RUNTIME_DIR, 'XDG_RUNTIME_DIR must point to this user\'s runtime directory');
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'DBUS_SESSION_BUS_ADDRESS must identify this user\'s bus');
// A successful manager query is mandatory; missing user managers never turn into a skip.
await systemctl('show-environment');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { createServiceLifecycle } = await import(pathToFileURL(path.join(repoRoot, 'packages/client/dist/index.js')).href);
const name = `byok-systemd-smoke-${randomUUID()}`;
const unit = `${name}.service`;
const unitPath = path.join(os.homedir(), '.config/systemd/user', unit);
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-systemd-smoke-'));
const storeDir = path.join(workDir, 'store with spaces');
const readyPath = path.join(workDir, 'ready.json');
const fixturePath = path.join(workDir, 'fixture.mjs');
const pids = new Set();
const errors = [];
let ownsUnit = false;

async function nativeState() {
  const text = await systemctl('show', unit, '--property=LoadState,ActiveState,SubState,MainPID,FragmentPath,UnitFileState');
  return Object.fromEntries(text.split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function inspect(expected) {
  const result = await lifecycle.inspect();
  assert.equal(result.state, expected, JSON.stringify(result));
  if (expected === 'exact') assert.equal(result.owner, 'smoke');
  console.log(`PASS: inspect ${expected}`);
}

// Poll only observations: Type=simple may report active before Node has executed the fixture.
async function running() {
  const deadline = Date.now() + 10_000;
  let observed;
  do {
    observed = await nativeState();
    if (Number(observed.MainPID) > 0) pids.add(Number(observed.MainPID));
    let ready;
    try { ready = JSON.parse(await fs.readFile(readyPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (observed.ActiveState === 'active' && observed.SubState === 'running' && ready?.pid === Number(observed.MainPID)) {
      assert.equal(observed.LoadState, 'loaded');
      assert.equal(observed.UnitFileState, 'enabled');
      assert.equal(observed.FragmentPath, unitPath);
      assert.equal(ready.marker, name);
      const command = await fs.readFile(`/proc/${ready.pid}/cmdline`, 'utf8');
      assert.ok(command.split('\0').includes(fixturePath), command);
      process.kill(ready.pid, 0);
      const status = await lifecycle.status();
      assert.equal(status.installed, true);
      assert.equal(status.running, true);
      assert.equal(status.determinate, true);
      console.log(`PASS: real systemd running PID ${ready.pid}`);
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`fixture did not become ready: ${JSON.stringify(observed)}`);
}

function assertExited() {
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `fixture PID ${pid} survived stop`);
  }
}

const lifecycle = createServiceLifecycle({
  name, displayName: 'BYOK systemd lifecycle smoke', owner: 'smoke', storeDir,
  logDir: path.join(workDir, 'logs'),
  program: { command: process.execPath, args: [fixturePath, readyPath, name] },
});

try {
  // Claim no pre-existing paths: cleanup below is limited to this generated identity.
  assert.equal((await nativeState()).LoadState, 'not-found');
  await assert.rejects(fs.lstat(unitPath), { code: 'ENOENT' });
  ownsUnit = true;
  await fs.writeFile(fixturePath, `import { writeFileSync, renameSync } from 'node:fs';
const target = process.argv[2];
writeFileSync(target + '.tmp', JSON.stringify({ pid: process.pid, marker: process.argv[3] }));
renameSync(target + '.tmp', target);
setInterval(() => {}, 60000);
`);
  await inspect('absent');
  await lifecycle.install();
  await inspect('exact');
  await running();

  await lifecycle.stop();
  assert.equal((await nativeState()).ActiveState, 'inactive');
  assertExited();
  const stopped = await lifecycle.status();
  assert.equal(stopped.installed, true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.determinate, true);
  await lifecycle.start();
  await running();

  const launcherPath = (await lifecycle.inspect()).launcherPath;
  // Exercise unit drift and a missing stable launcher independently.
  for (const damage of [() => fs.appendFile(unitPath, '\n# smoke drift\n'), () => fs.rm(launcherPath)]) {
    await lifecycle.stop();
    assertExited();
    await damage();
    await inspect('repairable');
    assert.deepEqual(await lifecycle.repair(), { status: 'repaired' });
    await inspect('exact');
    await running();
  }

  await lifecycle.uninstall();
  // Verify the reload explicitly: the SDK's removeFiles treats reload as best-effort.
  await systemctl('daemon-reload');
  await inspect('absent');
  assert.equal((await nativeState()).LoadState, 'not-found');
  assertExited();
  await assert.rejects(fs.lstat(unitPath), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(launcherPath), { code: 'ENOENT' });
  assert.equal((await lifecycle.inspect()).owner, undefined);
  const removed = await lifecycle.status();
  assert.equal(removed.installed, false);
  assert.equal(removed.running, false);
  assert.equal(removed.determinate, true);
} catch (error) {
  errors.push(error);
} finally {
  // Cleanup is independent of API success, with every failure retained. Never remove
  // a unit's control files until the manager confirms its process has stopped.
  let stopped = !ownsUnit;
  if (ownsUnit) {
    try {
      const state = await nativeState();
      if (Number(state.MainPID) > 0) pids.add(Number(state.MainPID));
      if (state.LoadState !== 'not-found') {
        await systemctl('stop', unit);
        assert.equal((await nativeState()).ActiveState, 'inactive');
      }
      assertExited();
      stopped = true;
      try {
        await fs.lstat(unitPath);
        await systemctl('disable', unit);
        await fs.rm(unitPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await systemctl('daemon-reload');
      assert.equal((await nativeState()).LoadState, 'not-found');
    } catch (error) { errors.push(new Error('systemd cleanup failed; inspect ' + unitPath, { cause: error })); }
  }
  if (stopped) {
    try { await fs.rm(workDir, { recursive: true }); }
    catch (error) { errors.push(new Error('fixture cleanup failed: ' + workDir, { cause: error })); }
  } else {
    errors.push(new Error(`preserved control files for unresolved service ${unit}: ${workDir}`));
  }
}
if (errors.length) throw new AggregateError(errors, 'systemd lifecycle smoke failed');
console.log('PASS: systemd lifecycle smoke and cleanup');
