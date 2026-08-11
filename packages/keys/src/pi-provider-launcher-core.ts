import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ByokKeysError } from './errors';
import { PI_PROJECTED_KEY_ENV } from './pi-provider-projection';
import {
  MODEL_PROVIDER_IDS,
  type ModelProviderId,
  type ModelProviderProfile,
} from './provider-profile';
import { type SecretStore, modelProviderSecretName } from './secret-store';

const PI_CHILD_BASE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'TZ',
  'TERM',
  'SHELL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
] as const;

const PI_CHILD_WINDOWS_ENV_NAMES = [
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'windir',
  'SYSTEMDRIVE',
  'PROGRAMFILES',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

export interface PiProviderLauncherOptions {
  piBin: string;
  profileDbPath: string;
  providerId: ModelProviderId;
  modelId: string;
  sessionDir: string;
  secretServicePrefix?: string;
  piArgs: string[];
}

export function parsePiProviderLauncherOptions(
  args: string[],
): PiProviderLauncherOptions {
  const separator = args.indexOf('--');
  if (separator < 0) throw new Error('launcher arguments must end with -- <pi args>');
  const ownArgs = args.slice(0, separator);
  const piArgs = args.slice(separator + 1);
  if (piArgs.length === 0) throw new Error('launcher requires Pi arguments after --');

  const allowedFlags = new Set([
    '--pi-bin',
    '--profile-db',
    '--provider',
    '--model',
    '--session-dir',
    '--secret-service-prefix',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < ownArgs.length; index += 2) {
    const flag = ownArgs[index];
    const value = ownArgs[index + 1];
    if (!flag || !allowedFlags.has(flag)) {
      throw new Error(`unknown launcher argument ${flag ?? '<missing>'}`);
    }
    if (values.has(flag)) throw new Error(`launcher argument ${flag} may only be provided once`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (/[\u0000\r\n]/u.test(value)) {
      throw new Error(`${flag} must be a single-line value`);
    }
    values.set(flag, value);
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };

  const rawProviderId = required('--provider');
  if (!MODEL_PROVIDER_IDS.includes(rawProviderId as ModelProviderId)) {
    throw new Error(`provider ${rawProviderId} is not configured by @byok-sdk/keys`);
  }

  const modelId = required('--model');
  if (modelId.length > 160) throw new Error('--model exceeds 160 characters');

  const profileDbPath = required('--profile-db');
  const sessionDir = required('--session-dir');
  if (!path.isAbsolute(profileDbPath) || !path.isAbsolute(sessionDir)) {
    throw new Error('launcher profile database and session directory must be absolute paths');
  }

  const secretServicePrefix = values.get('--secret-service-prefix');
  return {
    piBin: required('--pi-bin'),
    profileDbPath,
    providerId: rawProviderId as ModelProviderId,
    modelId,
    sessionDir,
    ...(secretServicePrefix ? { secretServicePrefix } : {}),
    piArgs,
  };
}

/**
 * Resolve only the credential the validated profile requires. In particular,
 * an auth-free local provider must remain usable on hosts without an OS
 * credential backend; constructing a keychain there would invent a false
 * dependency and turn an explicit `auth_mode: none` into a hidden fallback.
 */
export async function resolvePiProviderSecret(
  profile: ModelProviderProfile,
  createStore: () => SecretStore,
): Promise<string | undefined> {
  if (profile.auth_mode === 'none') return undefined;

  const secrets = createStore();
  if (!(await secrets.available())) {
    throw new ByokKeysError(
      'KEYCHAIN_UNAVAILABLE',
      `${secrets.providerLabel} is unavailable`,
    );
  }
  const secret = await secrets.get(modelProviderSecretName(profile.provider_id));
  if (!secret) {
    throw new ByokKeysError(
      'PROVIDER_SECRET_MISSING',
      `${profile.provider_id} provider requires a secret in ${secrets.providerLabel}`,
    );
  }
  return secret;
}

/** Build Pi's child environment from a closed platform baseline plus one exact key. */
export function buildPiProviderChildEnvironment(options: {
  ambient: NodeJS.ProcessEnv;
  projectionDir: string;
  sessionDir: string;
  secret: string | undefined;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const exactNames = new Set<string>([
    ...PI_CHILD_BASE_ENV_NAMES,
    ...(platform === 'win32' ? PI_CHILD_WINDOWS_ENV_NAMES : []),
  ].map((name) => platform === 'win32' ? name.toUpperCase() : name));
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.ambient)) {
    if (value === undefined) continue;
    const platformName = platform === 'win32' ? name.toUpperCase() : name;
    const isExact = exactNames.has(platformName);
    const isPrefixed = platform === 'win32'
      ? platformName.startsWith('LC_') || platformName.startsWith('XDG_')
      : name.startsWith('LC_') || name.startsWith('XDG_');
    if (isExact || isPrefixed) result[name] = value;
  }
  result.PI_CODING_AGENT_DIR = options.projectionDir;
  result.PI_CODING_AGENT_SESSION_DIR = options.sessionDir;
  if (options.secret !== undefined) {
    result[PI_PROJECTED_KEY_ENV] = options.secret;
  }
  return result;
}

/**
 * Create the configured session directory owner-only without mutating the
 * mode of an existing host-owned directory. The path is operator config, so
 * an accidental `/`, home, or shared-directory value must never become a
 * recursive chmod sink.
 */
export async function ensurePiSessionDirectory(sessionDir: string): Promise<void> {
  const firstCreated = await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if (firstCreated !== undefined) {
    await fs.chmod(sessionDir, 0o700).catch(() => {});
  }
  const stat = await fs.stat(sessionDir);
  if (!stat.isDirectory()) {
    throw new Error('Pi session path must be a directory');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(
      'existing Pi session directory must already be owner-only; refusing to change host-owned permissions',
    );
  }
}
