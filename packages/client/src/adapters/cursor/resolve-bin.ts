import os from 'node:os';
import path from 'node:path';
import type { ResolvedBin } from '../codex/resolve-bin.js';
import { findRuntimeCommandOnPath, runtimeInvocationHost } from '../runtime-invocation.js';

export function resolveCursorBin(env: Readonly<Record<string, string | undefined>>): ResolvedBin {
  const override = process.env.BYOK_CURSOR_BIN;
  if (override) return { command: override, source: 'env' };
  const host = runtimeInvocationHost(env);
  const command = findRuntimeCommandOnPath('cursor-agent', host);
  if (command !== undefined) return { command, source: 'path' };
  const installed = path.join(env.HOME ?? os.homedir(), '.local', 'bin', 'cursor-agent');
  if (host.isExecutable(installed)) return { command: installed, source: 'path' };
  throw Object.assign(new Error('cursor-agent command not found'), { code: 'ENOENT' });
}

export function cursorVersionToken(output: string): string | undefined {
  return /\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,})\b/i.exec(output)?.[1];
}
