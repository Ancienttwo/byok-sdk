#!/usr/bin/env node
// packages/client/scripts/control-socket-check.mjs
//
// M4 Phase 2 addendum to the launchd/WinSW service-lifecycle smoke tests
// (templates/service/{launchd,winsw}/smoke-test.*): proves the daemon's
// control socket (packages/client/src/daemon/control-server.ts) also works
// when `byok-agent start` is launched BY the OS service manager, not just
// as a bare foreground process -- that end-to-end proof for a foreground
// process already lives in packages/client/scripts/ipc-smoke.mjs (run by
// its own dedicated `ipc-smoke` CI job on all three OSes); this closes the
// narrower remaining gap of "does it also work under a service's own
// environment/cwd".
//
// Lives alongside ipc-smoke.mjs (not under templates/service/) specifically
// so `@hono/node-server`/`@byok/server` -- both @byok/client devDependencies
// -- resolve normally via Node's ordinary node_modules walk; a script
// physically under templates/ has no such node_modules chain leading to
// them (confirmed empirically while writing this).
//
// Installs ONE MORE scratch, throwaway service instance (a distinct name
// from whatever lifecycle-mechanics service the caller is already running)
// whose program is the REAL `byok-agent start`, paired against a real,
// ephemeral @byok/server instance this script also boots -- same
// real-server approach as ipc-smoke.mjs, for the same reason (no
// hand-rolled protocol stub to keep in sync). Waits for the service to
// report running, runs `byok-agent status --config <path>` and asserts a
// live `live: pid=...` line, then uninstalls -- cleaning up unconditionally
// even on failure, same spirit as the lifecycle smoke tests this runs
// alongside.
//
// Usage: node packages/client/scripts/control-socket-check.mjs <name> [--winsw-bin <path>]
//   <name>        unique scratch service name/id (the caller's own
//                 lifecycle-mechanics service already uses a different
//                 PID/label-scoped name -- pass a distinct one here).
//   --winsw-bin   required on win32 only (see lifecycle/winsw.ts).

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, '..');
const clientDistIndex = path.join(clientDir, 'dist', 'index.js');
const byokAgentBin = path.join(clientDir, 'dist', 'bin', 'byok-agent.js');
const serverDistIndex = path.join(clientDir, '..', 'server', 'dist', 'index.js');

const [, , name, ...rest] = process.argv;
if (!name) {
  console.error('usage: control-socket-check.mjs <name> [--winsw-bin <path>]');
  process.exit(1);
}
const winswBinFlagIndex = rest.indexOf('--winsw-bin');
const winswBin = winswBinFlagIndex >= 0 ? rest[winswBinFlagIndex + 1] : undefined;

for (const [label, file] of [
  ['@byok/client', clientDistIndex],
  ['@byok/client (bin)', byokAgentBin],
  ['@byok/server', serverDistIndex],
]) {
  try {
    await fs.stat(file);
  } catch {
    console.error(`FAIL: ${file} not found -- run "pnpm -r build" first (needed: ${label})`);
    process.exit(1);
  }
}

const { createServiceLifecycle, nodeAgentProgram } = await import(pathToFileURL(clientDistIndex).href);
const { createByokServer } = await import(pathToFileURL(serverDistIndex).href);
const { serve } = await import('@hono/node-server');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-ctlsocket-check-'));
const storeDir = path.join(workDir, 'store');
const workspaceRoot = path.join(workDir, 'workspace');
const logDir = path.join(workDir, 'logs');
const configPath = path.join(workDir, 'config.json');
await fs.mkdir(workspaceRoot, { recursive: true });

const byok = createByokServer({ productId: name });
let httpServer;
let lifecycle;
let failed = false;

async function runCli(args, timeoutMs = 15000) {
  return execFileAsync(process.execPath, [byokAgentBin, ...args], { timeout: timeoutMs });
}

try {
  const port = await new Promise((resolve) => {
    httpServer = serve({ fetch: byok.hono.fetch, port: 0 }, (info) => {
      byok.attachWebSocket(httpServer);
      resolve(info.port);
    });
  });
  const serverUrl = `http://127.0.0.1:${port}`;
  console.log(`==> real @byok/server reference implementation listening at ${serverUrl}`);

  const { code: pairingCode } = byok.pairing.createPairingCode();
  await fs.writeFile(
    configPath,
    JSON.stringify({ productName: 'Control Socket Check', productId: name, serverUrl, workspaceRoot, storeDir }, null, 2),
    'utf8',
  );

  console.log('==> byok-agent pair');
  await runCli(['pair', pairingCode, '--server', serverUrl, '--config', configPath]);
  console.log('PASS: pair succeeded');

  console.log(`==> installing scratch service (name=${name}) running the REAL byok-agent start`);
  lifecycle = createServiceLifecycle({
    name,
    displayName: 'BYOK control socket check',
    program: nodeAgentProgram({ agentBin: byokAgentBin, configPath, nodeBin: process.execPath }),
    logDir,
    ...(winswBin ? { windows: { winswBin } } : {}),
  });
  await lifecycle.install();

  console.log('==> waiting for the service to report running');
  let running = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const status = await lifecycle.status();
    if (status.running) {
      running = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!running) throw new Error('service never reported running -- see logDir for the daemon\'s own stdout/stderr');
  console.log('PASS: service is running');

  console.log('==> byok-agent status --config <path> (a SEPARATE, short-lived invocation reaching the service-launched daemon)');
  const { stdout } = await runCli(['status', '--config', configPath]);
  console.log(stdout.trim());
  if (!/^live: pid=\d+/m.test(stdout)) {
    throw new Error('expected a live "live: pid=..." control-socket status line from the service-launched daemon');
  }
  console.log('PASS: control socket answered a live status request from a SERVICE-launched daemon');
} catch (err) {
  failed = true;
  console.error('FAIL:', err instanceof Error ? err.stack : err);
} finally {
  if (lifecycle) {
    await lifecycle.stop().catch(() => {});
    await lifecycle.uninstall().catch(() => {});
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
