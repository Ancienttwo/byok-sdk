import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RuntimeExecutionFailure } from '../../runtime-failure';

const PREFIX = 'codex Agent user context exclusion refused';
const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason: `${PREFIX}: ${reason}` });

/**
 * The user `CODEX_HOME` entries an SDK-owned home links (#1565): the login,
 * the configuration, the guardrails (`rules/`, `hooks.json`) and the thread
 * store, so a resume finds its thread where it always was. Everything else,
 * `AGENTS.md`, `AGENTS.override.md`, `skills/` and `memories/` among it, stays
 * out.
 */
const LINKED = Object.freeze(['auth.json', 'config.toml', 'hooks.json', 'rules', 'sessions', 'archived_sessions']);

/** Codex's own resolution: a set `CODEX_HOME`, else `.codex` in the home directory. */
function userCodexHome(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  if (env.CODEX_HOME !== undefined && env.CODEX_HOME !== '') return env.CODEX_HOME;
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (home === undefined || home === '') throw refuse(`the runtime environment names no ${platform === 'win32' ? 'USERPROFILE' : 'HOME'} for the user CODEX_HOME`);
  return path.join(home, '.codex');
}

/**
 * Builds the SDK-owned `CODEX_HOME` of one Agent task in `dir` and returns it.
 * Each entry is a symbolic link to the user's own, never a copy or a hard
 * link: Codex writes a refreshed login through the link (0.160 in place;
 * 0.167 resolves the link and replaces the target), so the user's
 * `auth.json` keeps the live refresh token. The thread store is created in the
 * user home when it is missing, so a thread never lives only in the
 * execution's scratch. A user home without `auth.json` refuses the start. A Windows account that may not create symbolic links
 * (no Developer Mode, not an administrator) refuses the start.
 */
export async function createCodexAgentHome(env: Readonly<Record<string, string | undefined>>, dir: string, platform: NodeJS.Platform = process.platform): Promise<string> {
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
  await fs.mkdir(path.join(user, 'sessions'), { recursive: true });
  const home = path.join(dir, 'codex-home');
  await fs.mkdir(home, { mode: 0o700 });
  for (const name of LINKED) {
    const target = path.join(user, name);
    const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat === undefined) continue;
    try {
      await fs.symlink(target, path.join(home, name), stat.isDirectory() ? 'dir' : 'file');
    } catch (error) {
      if (platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw refuse('Windows refused to create a symbolic link (EPERM); turn on Developer Mode or run the daemon as an administrator');
      }
      throw error;
    }
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
