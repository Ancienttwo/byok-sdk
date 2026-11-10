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
  const command = findRuntimeCommandOnPath('agy', host);
  if (command !== undefined) return { command, source: 'path' };
  const official = officialLocation(platform);
  if (existsSync(official)) return { command: official, source: 'path' };
  throw Object.assign(new Error('agy runtime command not found'), { code: 'ENOENT' });
}
