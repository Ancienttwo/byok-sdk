import { spawn } from 'node:child_process';
import path from 'node:path';
import type { HostChild } from '../bridge/client.ts';

/** Variables that would point the Host's Node or Pi somewhere other than the shipped resources/host/. */
const FOREIGN_RUNTIME_VARIABLES = ['NODE_OPTIONS', 'NODE_PATH', 'PI_PACKAGE_DIR', 'BYOK_PI_BIN', 'ELECTRON_RUN_AS_NODE'] as const;

/** The Host child's environment: the app's own, without variables that redirect its runtime. */
export function hostEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of FOREIGN_RUNTIME_VARIABLES) delete env[name];
  return env;
}

/** Packaged mode: the SEA Host (scripts/package/bundle-host.mjs --format sea) in resources/host/, outside the asar. */
export function spawnPackagedHost(): HostChild {
  const executable = path.join(process.resourcesPath, 'host', process.platform === 'win32' ? 'host.exe' : 'host');
  return spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: hostEnvironment() });
}
