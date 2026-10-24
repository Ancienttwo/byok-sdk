import path from 'node:path';
import type { RuntimeOperationManifest } from '../../types';
import { RuntimeExecutionFailure } from '../../runtime-failure';

const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
// Claude matches excludes with picomatch after turning `\` into `/`, so glob
// syntax cannot be escaped; `?` stands in for it in a directory part.
const GLOB_SYNTAX = /[()[\]{}*?!@+|^$]/g;

export interface ClaudeAgentUserContextSettings {
  readonly claudeMdExcludes: readonly string[];
  readonly env: { readonly CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

/**
 * The `--settings` layer for an Agent task under `agentUserContext: 'excluded'`.
 *
 * It excludes the Claude config directory's `CLAUDE.md` and rules, and the
 * instruction files of every directory strictly above the Agent home (Claude's
 * walk stops before the filesystem root). Everything at and below the home
 * stays. Auto memory is turned off in the flag-layer `env`, the one place that
 * outranks a user `settings.json` `env` block.
 */
export function claudeAgentUserContextSettings(
  manifest: Pick<RuntimeOperationManifest, 'cwd' | 'lease'>,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homedir: () => string,
): ClaudeAgentUserContextSettings {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = manifest.lease?.canonicalHome;
  if (!home || !manifest.lease?.leaseId || !p.isAbsolute(home) || p.resolve(home) !== home) {
    throw refuse('claude Agent user-context exclusion requires a sealed canonical-home lease');
  }
  const within = (dir: string) => {
    const relative = p.relative(home, dir);
    return relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative);
  };
  if (manifest.cwd === undefined || !p.isAbsolute(manifest.cwd) || !within(manifest.cwd)) {
    throw refuse('claude Agent cwd is outside its sealed canonical home');
  }
  // The same user and config directory the child resolves from its own env.
  const configDir = env.CLAUDE_CONFIG_DIR ?? p.join((platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir(), '.claude');
  if (!p.isAbsolute(configDir)) throw refuse('claude config directory must be an absolute path');

  const file = (dir: string, ...names: string[]) => p.join(dir, ...names).replaceAll('\\', '/');
  const rules = (dir: string) => `${file(dir).replace(GLOB_SYNTAX, '?')}/**`;
  const excludes: string[] = [];
  // A config directory inside the home holds Agent-home files, which stay.
  if (!within(configDir)) excludes.push(file(configDir, 'CLAUDE.md'), rules(p.join(configDir, 'rules')));
  for (let dir = p.dirname(home); p.dirname(dir) !== dir; dir = p.dirname(dir)) {
    excludes.push(file(dir, 'CLAUDE.md'), file(dir, 'CLAUDE.local.md'), file(dir, '.claude', 'CLAUDE.md'), rules(p.join(dir, '.claude', 'rules')));
  }
  return { claudeMdExcludes: [...new Set(excludes)], env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } };
}
