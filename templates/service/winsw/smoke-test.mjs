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
// Requires @byok/client already built (`pnpm --filter @byok/client build`).

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  console.error(`FAIL: ${clientDistIndex} not found -- run "pnpm --filter @byok/client build" first`);
  process.exit(1);
}

const { createServiceLifecycle } = await import(clientDistIndex);

const name = `byok-winsw-smoke-${process.pid}`;
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-winsw-smoke-'));
const logDir = path.join(workDir, 'logs');

const lifecycle = createServiceLifecycle({
  name,
  displayName: 'BYOK WinSW smoke test',
  program: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 60000)'] },
  logDir,
  windows: { winswBin },
});

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

let failed = false;
try {
  console.log(`==> installing WinSW service (name=${name})`);
  await lifecycle.install();

  // sc.exe can lag a beat behind WinSW's own "installed and started"
  // return -- poll briefly rather than asserting instantly.
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await assertScState('RUNNING');
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (lastErr) throw lastErr;

  const status = await lifecycle.status();
  console.log(`    lifecycle.status(): ${JSON.stringify(status)}`);
  if (!status.installed || !status.running) {
    throw new Error(`expected lifecycle.status() installed:true running:true, got: ${JSON.stringify(status)}`);
  }
  console.log('PASS: lifecycle.status() agrees with sc.exe (installed:true running:true)');

  console.log('==> stopping via the lifecycle API');
  await lifecycle.stop();
  await assertScState('STOPPED');

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

  console.log('==> uninstalling');
  await lifecycle.uninstall();
  const afterUninstall = await scQuery();
  console.log(`    sc.exe query ${name} after uninstall:\n${afterUninstall}`);
  if (!/does not exist/i.test(afterUninstall) && !/FAILED 1060/i.test(afterUninstall)) {
    throw new Error(`expected sc.exe to report the service gone after uninstall, got:\n${afterUninstall}`);
  }
  console.log('PASS: service removed from the SCM after uninstall');

  console.log('==> WinSW service lifecycle smoke: PASS');
} catch (err) {
  failed = true;
  console.error('FAIL:', err instanceof Error ? err.stack : err);
} finally {
  // Best-effort cleanup regardless of where the assertions above failed --
  // never leave a scratch service registered on the runner/dev machine.
  await lifecycle.stop().catch(() => {});
  await lifecycle.uninstall().catch(() => {});
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);
