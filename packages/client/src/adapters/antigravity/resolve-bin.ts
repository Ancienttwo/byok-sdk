import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedBin } from '../codex/resolve-bin';
import { findRuntimeCommandOnPath, runtimeInvocationHost } from '../runtime-invocation';

function officialLocation(platform: NodeJS.Platform): string {
  if (platform !== 'win32') return path.posix.join(os.homedir(), '.local', 'bin', 'agy');
  const local = process.env.LOCALAPPDATA || path.win32.join(os.homedir(), 'AppData', 'Local');
  return path.win32.join(local, 'agy', 'bin', 'agy.exe');
}

/**
 * Resolve the Antigravity CLI, a standalone user install, not an npm package.
 * `BYOK_AGY_BIN` overrides everything; then `agy` on the runtime PATH; then the
 * official installer's location, because a GUI Host's PATH often omits it.
 */
export function resolveAgyBin(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): ResolvedBin {
  const override = process.env.BYOK_AGY_BIN;
  if (override) return { command: override, source: 'env' };
  const runtimeHost = runtimeInvocationHost(env);
  const host = { ...runtimeHost, platform, isFile: (file: string) =>
    (platform !== 'win32' || ['.com', '.exe'].includes(path.win32.extname(file).toLowerCase())) && runtimeHost.isFile(file) };
  const onPath = findRuntimeCommandOnPath('agy', host) !== undefined;
  const official = officialLocation(platform);
  return !onPath && existsSync(official) ? { command: official, source: 'path' } : { command: 'agy', source: 'path' };
}
