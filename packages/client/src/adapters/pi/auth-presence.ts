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

/**
 * Pi's `models.json` reader (`utils/json.js` `stripJsonComments()`): drops
 * `//` line comments and trailing commas outside string literals.
 */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ''));
}

/** A JSON object, `'absent'` for a missing file, or `'invalid'` for any other read or parse failure. */
async function readJsonObject(file: string, options: { readonly comments?: boolean } = {}): Promise<Record<string, unknown> | 'absent' | 'invalid'> {
  try {
    const text = (await fs.readFile(file, 'utf8')).replace(/^﻿/u, '');
    const parsed: unknown = JSON.parse(options.comments === true ? stripJsonComments(text) : text);
    return isObject(parsed) ? parsed : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid';
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A `models.json` provider carries its own credential when it has an `apiKey`
 * string of pi's schema shape (non-empty). The value may be a literal, an
 * env-var template or a `!command`; it is neither resolved nor executed, and
 * only its type and length are inspected.
 */
function hasConfiguredApiKey(provider: unknown): boolean {
  return isObject(provider) && typeof provider.apiKey === 'string' && provider.apiKey.length > 0;
}

/**
 * Pi's non-secret login-state observation, its equivalent of
 * `claude auth status`'s `loggedIn`. True when a known provider credential
 * env var *name* is set, or when the global `settings.json` `defaultProvider`
 * (any provider when `settings.json` is absent or configures no default) has
 * a usable login record in pi's agent-dir `auth.json` or an `apiKey` in its
 * agent-dir `models.json`. An unreadable or malformed `auth.json` or
 * `settings.json` observes `false`, as pi itself fails on such an `auth.json`;
 * a missing or malformed `models.json` contributes nothing, as pi ignores it.
 * This never throws and never returns, logs, or keeps any credential value.
 */
export async function probePiAuthPresent(env: Env): Promise<boolean> {
  if (PROVIDER_CREDENTIAL_ENV_NAMES.some((name) => env[name] !== undefined)) return true;
  try {
    const agentDir = resolvePiAgentDir(env);
    const auth = await readJsonObject(path.join(agentDir, 'auth.json'));
    if (auth === 'invalid') return false;
    const settings = await readJsonObject(path.join(agentDir, 'settings.json'));
    if (settings === 'invalid') return false;
    const models = await readJsonObject(path.join(agentDir, 'models.json'), { comments: true });
    const logins = auth === 'absent' ? {} : auth;
    const providers = typeof models === 'string' || !isObject(models.providers) ? {} : models.providers;
    const defaultProvider = settings === 'absent' ? undefined : settings.defaultProvider;
    if (typeof defaultProvider === 'string' && defaultProvider.length > 0) {
      return (Object.hasOwn(logins, defaultProvider) && isStoredLogin(logins[defaultProvider]))
        || (Object.hasOwn(providers, defaultProvider) && hasConfiguredApiKey(providers[defaultProvider]));
    }
    return Object.values(logins).some(isStoredLogin) || Object.values(providers).some(hasConfiguredApiKey);
  } catch {
    return false;
  }
}
