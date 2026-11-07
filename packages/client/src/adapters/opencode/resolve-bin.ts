import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedBin } from '../codex/resolve-bin';

/** Explicit override, then the runtime PATH, then the official installer directory. Never installs. */
export function resolveOpenCodeBin(env: Readonly<Record<string, string | undefined>>, platform = process.platform): ResolvedBin {
  const override = process.env.BYOK_OPENCODE_BIN;
  if (override) return { command: override, source: 'env' };
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode'] : ['opencode'];
  const executable = (file: string): boolean => {
    try { accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
  };
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      const command = paths.resolve(dir, name);
      if (executable(command)) return { command, source: 'path' };
    }
  }
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const official = paths.join(home, '.opencode', 'bin', names[0]!);
  return { command: executable(official) ? official : 'opencode', source: 'path' };
}
