import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_CREDENTIAL_ENV_NAMES } from '../provider-credential-environment';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Pi's own agent directory, resolved exactly as the pinned pi does
 * (`config.js` `getAgentDir()` + `utils/paths.js` `normalizePath()`): a
 * non-empty `PI_CODING_AGENT_DIR` with `~` and `file://` expanded, otherwise
 * `<home>/.pi/agent`. The ambient (non-keys) Pi launch inherits this same
 * environment, so detection observes the directory Pi itself would read.
 */
export function resolvePiAgentDir(env: Env): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (!override) return path.join(os.homedir(), '.pi', 'agent');
  if (override === '~') return os.homedir();
  if (override.startsWith('~/') || (process.platform === 'win32' && override.startsWith('~\\'))) {
    return path.join(os.homedir(), override.slice(2));
  }
  if (override.startsWith('file://')) return fileURLToPath(override);
  return override;
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/u, ''));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A usable pi login record has the shape pi's own `ReadOnlyAuthStorage`
 * admits: an `api_key` entry with a non-empty `key`, or an `oauth` entry with
 * `access`/`refresh` strings and a finite `expires`. Only types and presence
 * are inspected; no value is compared, returned, or retained.
 */
function isStoredLogin(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (record.type === 'api_key') return typeof record.key === 'string' && record.key.length > 0;
  return record.type === 'oauth'
    && typeof record.access === 'string'
    && typeof record.refresh === 'string'
    && typeof record.expires === 'number'
    && Number.isFinite(record.expires);
}

/**
 * Pi's non-secret login-state observation, its equivalent of
 * `claude auth status`'s `loggedIn`. True when a known provider credential
 * env var *name* is set, or when pi's agent-dir `auth.json` holds a usable
 * login record for the global `settings.json` `defaultProvider` (any
 * provider when no default is configured). Missing, unreadable, or malformed
 * files observe `false`; this never throws and never returns, logs, or keeps
 * any credential value.
 */
export async function probePiAuthPresent(env: Env): Promise<boolean> {
  if (PROVIDER_CREDENTIAL_ENV_NAMES.some((name) => env[name] !== undefined)) return true;
  try {
    const agentDir = resolvePiAgentDir(env);
    const auth = await readJsonObject(path.join(agentDir, 'auth.json'));
    if (auth === undefined) return false;
    const settings = await readJsonObject(path.join(agentDir, 'settings.json'));
    const defaultProvider = settings?.defaultProvider;
    if (typeof defaultProvider === 'string' && defaultProvider.length > 0) {
      return Object.hasOwn(auth, defaultProvider) && isStoredLogin(auth[defaultProvider]);
    }
    return Object.values(auth).some(isStoredLogin);
  } catch {
    return false;
  }
}
