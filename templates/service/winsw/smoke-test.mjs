#!/usr/bin/env node
// templates/service/winsw/smoke-test.mjs
//
// Real, end-to-end proof that a generated WinSW service descriptor actually
// installs/runs/stops/uninstalls as a genuine Windows Service — the "real
// verification" M3-4 calls for, since this SDK's own dev machines can't run
// WinSW at all. This is what `.github/workflows/ci.yml`'s
// `windows-service-smoke` job runs on a real `windows-latest` runner; it is
// also a copy-paste-runnable recipe for a product to verify their own WinSW
// bundling the same way (same spirit as `templates/packaging/*/smoke-test.sh`).
//
// Runs a harmless placeholder command (`node -e 'setInterval(() => {},
// 60000)'`) rather than the real `byok-agent start`, deliberately: this
// proves the SERVICE LIFECYCLE MECHANICS (WinSW XML generation, `winsw
// install`/`start`/`stop`/`uninstall`, SCM crash-restart via `<onfailure>`)
// in isolation from whether the daemon is actually paired to a server,
// which is a separate concern already covered by this repo's own
// daemon/*.test.ts suite. `byok-agent install` (the real CLI subcommand —
// see `packages/client/src/bin/commands/service.ts`) points the SAME
// generator at the real `byok-agent start --config <path>` command by
// default; only this smoke substitutes a deterministic placeholder so
// "assert RUNNING" never races against the daemon's own (expected, in this
// throwaway setup) pairing failure.
//
// Usage (Windows only):
//   WINSW_BIN=C:\path\to\WinSW-x64.exe node templates/service/winsw/smoke-test.mjs
//
// Requires @byok-sdk/client already built (`bun run --filter @byok-sdk/client build`).

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

if (process.platform !== 'win32') {
  console.log(`SKIP: WinSW is Windows-only (this host is ${process.platform})`);
  process.exit(0);
}

const winswBin = process.env.WINSW_BIN;
if (!winswBin) {
  console.error('FAIL: WINSW_BIN env var not set (path to a WinSW executable, e.g. WinSW-x64.exe)');
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const clientDistIndex = path.join(repoRoot, 'packages', 'client', 'dist', 'index.js');

try {
  await fs.stat(clientDistIndex);
} catch {
  console.error(`FAIL: ${clientDistIndex} not found -- run "bun run --filter @byok-sdk/client build" first`);
  process.exit(1);
}

// Node's dynamic `import()` requires a proper URL, not a bare filesystem
// path — on POSIX an absolute path happens to also parse as a (relative)
// specifier and mostly works, but on Windows an absolute path like
// `D:\a\...\index.js` is misread as a URL with scheme "d:", which throws
// `ERR_UNSUPPORTED_ESM_URL_SCHEME` (empirically confirmed: this is exactly
// what failed the first version of this script in CI on windows-latest).
// `pathToFileURL` converts a native absolute path to a correct `file://`
// URL on every platform, which `import()` always accepts.
const { createServiceLifecycle, ensureSecureDir } = await import(pathToFileURL(clientDistIndex).href);

const name = `byok-winsw-smoke-${process.pid}`;
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-winsw-smoke-'));
const logDir = path.join(workDir, 'logs');

const lifecycle = createServiceLifecycle({
  name,
  displayName: 'BYOK WinSW smoke test',
  program: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 60000)'] },
  storeDir: path.join(workDir, 'store'),
  logDir,
  owner: 'smoke',
  windows: { winswBin },
});
const xmlPath = path.join(logDir, `${name}.xml`);
const exePath = path.join(logDir, `${name}.exe`);

// WinSW's `<id>.out.log`/`<id>.err.log`/`<id>.wrapper.log` hold the service's
// own output; `workDir` is removed below, so a failed run prints them first.
async function printServiceLogs() {
  let names;
  try {
    names = (await fs.readdir(logDir)).filter((entry) => entry.endsWith('.log')).sort();
  } catch (err) {
    console.error(`(no service logs: ${err instanceof Error ? err.message : err})`);
    return;
  }
  for (const entry of names) {
    console.error(`----- ${path.join(logDir, entry)} -----`);
    console.error((await fs.readFile(path.join(logDir, entry), 'utf8')).trimEnd());
  }
}

async function expectUnitState(expected) {
  const { state } = await lifecycle.inspect();
  if (state !== expected) throw new Error(`expected unit state ${expected}, got ${state}`);
  console.log(`PASS: unit state ${expected}`);
}

async function scQuery() {
  try {
    const { stdout } = await execFileAsync('sc.exe', ['query', name]);
    return stdout;
  } catch (err) {
    return err.stdout || err.message;
  }
}

async function assertScState(expected) {
  const output = await scQuery();
  console.log(`    sc.exe query ${name}:\n${output}`);
  if (!new RegExp(`STATE\\b.*\\b${expected}\\b`, 'i').test(output)) {
    throw new Error(`expected sc.exe query state ${expected}, got:\n${output}`);
  }
  console.log(`PASS: sc.exe reports ${expected}`);
}

/**
 * sc.exe can lag a beat behind WinSW's own return (install/start return before
 * the SCM reports RUNNING; `winsw stop` returns while the service is still
 * STOP_PENDING), so poll briefly: up to 10 x 1 s, then fail with the last
 * observed `sc.exe query` output.
 */
async function waitForScState(expected) {
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await assertScState(expected);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastErr;
}

/**
 * Finding F7: real, win32-only proof that `ensureSecureDir` (the one
 * chokepoint `DeviceStore.save()`/`control-server.ts`'s `startControlServer`
 * both funnel `storeDir` creation through — see `util/secure-dir.ts`) genuinely
 * removes inherited ACEs and grants the current user/SYSTEM/Administrators
 * via a real `icacls` invocation, not just that this codebase's own darwin/
 * linux-run unit tests (`secure-dir.test.ts`, which inject a fake `run` and
 * `platform` since neither a real Windows host nor a real `icacls` binary is
 * available there) believe it constructs the right argv. Deliberately
 * conservative: only checks for the ABSENCE of the `(I)` (inherited) flag and
 * the PRESENCE of the three expected principal names in `icacls`'s own
 * read-back output — not a byte-for-byte ACL comparison, which would be
 * brittle across Windows/icacls versions and locales.
 */
async function assertStoreDirAclHardened() {
  console.log('==> finding F7: storeDir Windows ACL hardening (icacls)');
  const aclWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-acl-smoke-'));
  const secureDir = path.join(aclWorkDir, 'store');
  try {
    await ensureSecureDir(secureDir);

    const { stdout: icaclsOutput } = await execFileAsync('icacls', [secureDir]);
    console.log(`    icacls ${secureDir}:\n${icaclsOutput}`);

    if (/\(I\)/.test(icaclsOutput)) {
      throw new Error(`expected icacls to report NO inherited (I) ACEs after ensureSecureDir, got:\n${icaclsOutput}`);
    }

    const currentUser = os.userInfo().username;
    const missing = [];
    if (!icaclsOutput.toLowerCase().includes(currentUser.toLowerCase())) missing.push(`current user (${currentUser})`);
    if (!/\bSYSTEM\b/i.test(icaclsOutput)) missing.push('SYSTEM');
    if (!/\bAdministrators\b/i.test(icaclsOutput)) missing.push('Administrators');
    if (missing.length > 0) {
      throw new Error(`expected icacls to grant ${missing.join(', ')}, got:\n${icaclsOutput}`);
    }

    console.log('PASS: storeDir has no inherited ACEs and grants the current user/SYSTEM/Administrators');
  } finally {
    await fs.rm(aclWorkDir, { recursive: true, force: true }).catch(() => {});
  }
}

let failed = false;
try {
  await assertStoreDirAclHardened();

  console.log(`==> installing WinSW service (name=${name})`);
  await lifecycle.install();

  await waitForScState('RUNNING');

  const status = await lifecycle.status();
  console.log(`    lifecycle.status(): ${JSON.stringify(status)}`);
  if (!status.installed || !status.running) {
    throw new Error(`expected lifecycle.status() installed:true running:true, got: ${JSON.stringify(status)}`);
  }
  console.log('PASS: lifecycle.status() agrees with sc.exe (installed:true running:true)');

  // #1097: a hand-edited descriptor is repairable; repair restarts onto the rewritten one.
  await expectUnitState('exact');
  await fs.appendFile(xmlPath, '<!-- hand edit -->\n');
  await expectUnitState('repairable');
  console.log(`    repair(): ${JSON.stringify(await lifecycle.repair())}`);
  await waitForScState('RUNNING');
  await expectUnitState('exact');

  console.log('==> stopping via the lifecycle API');
  await lifecycle.stop();
  await waitForScState('STOPPED');

  console.log('==> starting again via the lifecycle API');
  await lifecycle.start();
  let restarted = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const output = await scQuery();
    if (/STATE\b.*\bRUNNING\b/i.test(output)) {
      restarted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!restarted) throw new Error('expected the service to be RUNNING again after an explicit start');
  console.log('PASS: RUNNING again after explicit start');

  // #1097: the wrapper exe is part of the installed unit. A stopped service
  // whose <id>.exe is missing, or holds other bytes, is repairable, and repair
  // puts winswBin back without running the bad exe. The stopped image is
  // renamed aside (Windows releases a stopped image asynchronously; a rename
  // does not wait for that) into this smoke's own workDir.
  for (const [index, corrupt] of [[1, undefined], [2, 'not a WinSW executable']]) {
    console.log(`==> cold repair ${index}: stopped service, wrapper exe ${corrupt === undefined ? 'missing' : 'replaced with invalid bytes'}`);
    await lifecycle.stop();
    await waitForScState('STOPPED');
    await fs.rename(exePath, path.join(workDir, `moved-wrapper-${index}.exe`));
    if (corrupt !== undefined) await fs.writeFile(exePath, corrupt);
    await expectUnitState('repairable');
    console.log(`    repair(): ${JSON.stringify(await lifecycle.repair())}`);
    await waitForScState('RUNNING');
    await expectUnitState('exact');
  }

  console.log('==> uninstalling');
  await lifecycle.uninstall();
  const afterUninstall = await scQuery();
  console.log(`    sc.exe query ${name} after uninstall:\n${afterUninstall}`);
  if (!/does not exist/i.test(afterUninstall) && !/FAILED 1060/i.test(afterUninstall)) {
    throw new Error(`expected sc.exe to report the service gone after uninstall, got:\n${afterUninstall}`);
  }
  console.log('PASS: service removed from the SCM after uninstall');

  // #1097: a marker-less descriptor at our path is foreign and never touched.
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(xmlPath, '<service><id>someone-else</id></service>\n');
  await expectUnitState('foreign');
  try {
    await lifecycle.install();
    throw new Error('install accepted a foreign unit');
  } catch (error) {
    if (error?.code !== 'service_unit_unmarked') throw error;
  }
  if (!(await fs.readFile(xmlPath, 'utf8')).includes('someone-else')) throw new Error('install changed a foreign unit');
  await fs.rm(xmlPath);
  console.log('PASS: foreign unit refused and left untouched');

  console.log('==> WinSW service lifecycle smoke: PASS');

  // M4 Phase 2 addendum: the checks above deliberately run a harmless
  // placeholder command (see the header comment) to isolate service
  // lifecycle MECHANICS from the daemon/control-socket concern -- this
  // separate, throwaway service instance runs the REAL `byok-agent start`
  // (paired against a real, ephemeral @byok-sdk/server this helper also boots)
  // and proves `byok-agent status` reaches its control socket live over a
  // Windows named pipe. See
  // packages/client/scripts/control-socket-check.mjs's own header comment.
  console.log('==> M4 Phase 2: control socket check (separate scratch service running the real byok-agent)');
  const controlSocketCheck = path.join(repoRoot, 'packages', 'client', 'scripts', 'control-socket-check.mjs');
  const checkExitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [controlSocketCheck, `${name}-ctlsocket`, '--winsw-bin', winswBin], {
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  if (checkExitCode !== 0) {
    throw new Error(`control-socket-check.mjs exited with code ${checkExitCode}`);
  }
} catch (err) {
  failed = true;
  console.error('FAIL:', err instanceof Error ? err.stack : err);
} finally {
  // Best-effort cleanup regardless of where the assertions above failed --
  // never leave a scratch service registered on the runner/dev machine.
  await lifecycle.stop().catch(() => {});
  if (failed) await printServiceLogs();
  await lifecycle.uninstall().catch(() => {});
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);
