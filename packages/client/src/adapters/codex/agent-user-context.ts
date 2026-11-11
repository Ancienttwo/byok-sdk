import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentHomeResolutionError, ensureDirectoryNoSymlink } from '../../agent-home.js';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';

const PREFIX = 'codex Agent user context exclusion refused';
const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: `${PREFIX}: ${reason}` });

/**
 * The user `CODEX_HOME` entries an SDK-owned home links (#1565): the login and
 * the configuration, which a ChatGPT refresh and the user's provider setup
 * need, and the guardrails `rules/` and `hooks.json`. Everything else stays out:
 * `AGENTS.md`, `AGENTS.override.md`, `skills/`, `memories/` and the user's
 * thread store (`sessions/`, `archived_sessions/`).
 */
const LINKED = Object.freeze(['auth.json', 'config.toml', 'hooks.json', 'rules']);

/**
 * The Agent's own thread store, in its home: `<home>/.byok/codex/sessions` and
 * `archived_sessions`. It outlives each execution, so a later task of the same
 * Agent resumes its thread; it never holds the user's threads.
 */
const AGENT_STORE = Object.freeze(['sessions', 'archived_sessions']);

/** Codex's own resolution: a set `CODEX_HOME`, else `.codex` in the home directory. */
function userCodexHome(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  if (env.CODEX_HOME !== undefined && env.CODEX_HOME !== '') return env.CODEX_HOME;
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (home === undefined || home === '') throw refuse(`the runtime environment names no ${platform === 'win32' ? 'USERPROFILE' : 'HOME'} for the user CODEX_HOME`);
  return path.join(home, '.codex');
}

/**
 * Builds the SDK-owned `CODEX_HOME` of one Agent task in `dir` and returns it.
 * Each entry is a symbolic link, never a copy or a hard link: Codex writes a
 * refreshed login through the link (0.160 in place; 0.167 resolves the link
 * and replaces the target), so the user's `auth.json` keeps the live refresh
 * token. The thread store links to the Agent's own store in `agentHome`. A
 * task without a sealed Agent home, a user home without `auth.json`, and a
 * Windows account that may not create symbolic links (no Developer Mode, not
 * an administrator) refuse the start.
 */
export async function createCodexAgentHome(env: Readonly<Record<string, string | undefined>>, dir: string, agentHome: string | undefined, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (agentHome === undefined || agentHome === '') throw refuse('the task has no sealed Agent home for its thread store');
  let user: string;
  try {
    user = await fs.realpath(userCodexHome(env, platform));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw refuse('the user CODEX_HOME does not exist');
    throw error;
  }
  // Without the link, a later file-mode login would save auth.json in the SDK home and lose it at cleanup.
  if (!await fs.stat(path.join(user, 'auth.json')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) throw refuse('the user CODEX_HOME has no auth.json; log in to Codex with file credentials first');
  const home = path.join(dir, 'codex-home');
  await fs.mkdir(home, { mode: 0o700 });
  const link = async (target: string, name: string, type: 'dir' | 'file') => {
    try {
      await fs.symlink(target, path.join(home, name), type);
    } catch (error) {
      if (platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw refuse('Windows refused to create a symbolic link (EPERM); turn on Developer Mode or run the daemon as an administrator');
      }
      throw error;
    }
  };
  for (const name of LINKED) {
    const target = path.join(user, name);
    const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat !== undefined) await link(target, name, stat.isDirectory() ? 'dir' : 'file');
  }
  for (const name of AGENT_STORE) {
    // The Agent can write in its home: every component down to the store must be a real directory inside it.
    const target = await ensureDirectoryNoSymlink(agentHome, path.join(agentHome, '.byok', 'codex', name)).catch((error: unknown) => {
      if (error instanceof AgentHomeResolutionError) throw refuse('the Agent home thread store is not a real directory inside the Agent home');
      throw error;
    });
    await link(target, name, 'dir');
  }
  return home;
}

/**
 * Refuses an SDK-owned home whose effective credential store is not `file`.
 * `effective` is Codex's `config/read` answer. A keyring entry is keyed by the
 * home's path, so the SDK home would not find the user's login, and a keyring
 * save deletes `auth.json`, the link itself.
 */
export function assertCodexFileCredentials(effective: Readonly<Record<string, unknown>>): void {
  const config = effective.config;
  const store = typeof config === 'object' && config !== null ? (config as Record<string, unknown>).cli_auth_credentials_store : undefined;
  if (store === 'file') return;
  throw refuse(typeof store === 'string'
    ? `cli_auth_credentials_store is ${store}; an SDK-owned CODEX_HOME supports file credentials only`
    : 'config/read returned no readable cli_auth_credentials_store');
}
