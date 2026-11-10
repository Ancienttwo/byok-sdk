import os from 'node:os';
import path from 'node:path';
import type { ResolvedBin } from '../codex/resolve-bin';
import { findRuntimeCommandOnPath, runtimeInvocationHost } from '../runtime-invocation';

/** Explicit override, then the runtime PATH, then the official installer directory. Never installs. */
export function resolveOpenCodeBin(env: Readonly<Record<string, string | undefined>>, platform = process.platform): ResolvedBin {
  const override = process.env.BYOK_OPENCODE_BIN;
  if (override) return { command: override, source: 'env' };
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const host = { ...runtimeInvocationHost(env), platform };
  const command = findRuntimeCommandOnPath('opencode', host);
  if (command !== undefined) return { command, source: 'path' };
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const official = paths.join(home, '.opencode', 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode');
  if (host.isExecutable(official)) return { command: official, source: 'path' };
  throw Object.assign(new Error('opencode runtime command not found'), { code: 'ENOENT' });
}
