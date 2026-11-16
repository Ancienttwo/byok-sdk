import path from 'node:path';
import { createOwnedRuntimeHome } from '../owned-runtime-home.js';
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
 * Codex writes a refreshed login through the link (0.160 in place; 0.167
 * resolves the link and replaces the target), so the user's `auth.json` keeps
 * the live refresh token. The thread store links to the Agent's own store in
 * `agentHome`. A task without a sealed Agent home, a user home without
 * `auth.json`, and a Windows account that may not create symbolic links (no
 * Developer Mode, not an administrator) refuse the start.
 */
export function createCodexAgentHome(env: Readonly<Record<string, string | undefined>>, dir: string, agentHome: string | undefined, platform: NodeJS.Platform = process.platform): Promise<string> {
  return createOwnedRuntimeHome({
    refusalPrefix: PREFIX,
    name: 'codex-home',
    userHome: () => userCodexHome(env, platform),
    userHomeLabel: 'CODEX_HOME',
    linked: LINKED,
    // Without the link, a later file-mode login would save auth.json in the SDK home and lose it at cleanup.
    required: [{ entry: 'auth.json', reason: 'the user CODEX_HOME has no auth.json; log in to Codex with file credentials first' }],
    agentStore: { agentHome, root: path.join('.byok', 'codex'), entries: AGENT_STORE, label: 'thread store' },
  }, dir, platform);
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
