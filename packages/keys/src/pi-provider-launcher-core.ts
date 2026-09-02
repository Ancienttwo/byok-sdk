import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ByokKeysError } from './errors';
import { PI_PROJECTED_KEY_ENV } from './pi-provider-projection';
import {
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  type ExactProviderProfileBinding,
  type ModelProviderProfile,
  type ProviderProfileRef,
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
  /** Carried by the `--provider` flag: the exact local profile to launch. */
  profileRef: ProviderProfileRef;
  modelId: string;
  expectedBinding?: ExactProviderProfileBinding;
  validateOnly: boolean;
  sessionDir: string;
  secretServicePrefix?: string;
  macosKeychainPath?: string;
  piArgs: string[];
}

export function parsePiProviderLauncherOptions(
  args: string[],
): PiProviderLauncherOptions {
  const separator = args.indexOf('--');
  const ownArgs = separator < 0 ? args : args.slice(0, separator);
  const piArgs = separator < 0 ? [] : args.slice(separator + 1);

  const allowedFlags = new Set([
    '--pi-bin',
    '--profile-db',
    '--provider',
    '--model',
    '--profile-revision',
    '--profile-hash',
    '--required-capabilities',
    '--validate-only',
    '--session-dir',
    '--secret-service-prefix',
    '--macos-keychain-path',
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

  const rawProfileRef = required('--provider');
  const profileRef = ProviderProfileRefSchema.safeParse(rawProfileRef);
  if (!profileRef.success) {
    throw new Error(`provider profile ref ${rawProfileRef} is not a valid @byok-sdk/keys identifier`);
  }

  const modelId = required('--model');
  if (modelId.length > 160) throw new Error('--model exceeds 160 characters');

  const profileDbPath = required('--profile-db');
  const sessionDir = required('--session-dir');
  if (!path.isAbsolute(profileDbPath) || !path.isAbsolute(sessionDir)) {
    throw new Error('launcher profile database and session directory must be absolute paths');
  }

  const secretServicePrefix = values.get('--secret-service-prefix');
  const macosKeychainPath = values.get('--macos-keychain-path');
  if (macosKeychainPath !== undefined && !path.posix.isAbsolute(macosKeychainPath)) {
    throw new Error('--macos-keychain-path must be an absolute path');
  }
  const validateOnly = values.get('--validate-only') === 'true';
  if (values.has('--validate-only') && !['true', 'false'].includes(values.get('--validate-only')!)) {
    throw new Error('--validate-only must be true or false');
  }
  if (!validateOnly && piArgs.length === 0) {
    throw new Error('launcher requires Pi arguments after --');
  }
  const exactValues = [
    values.get('--profile-revision'),
    values.get('--profile-hash'),
    values.get('--required-capabilities'),
  ];
  if (exactValues.some((value) => value !== undefined) && exactValues.some((value) => value === undefined)) {
    throw new Error('exact provider binding requires revision, hash, and required capabilities together');
  }
  let expectedBinding: ExactProviderProfileBinding | undefined;
  if (exactValues[0] !== undefined) {
    if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(exactValues[0])) {
      throw new Error('--profile-revision must be canonical decimal');
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(exactValues[1]!)) {
      throw new Error('--profile-hash must be lowercase sha256');
    }
    let capabilities: unknown;
    try {
      capabilities = JSON.parse(exactValues[2]!);
    } catch {
      throw new Error('--required-capabilities must be a JSON array');
    }
    const parsedCapabilities = ProviderModelCapabilitySchema.array().max(8).safeParse(capabilities);
    if (!parsedCapabilities.success || new Set(parsedCapabilities.data).size !== parsedCapabilities.data.length) {
      throw new Error('--required-capabilities must contain unique supported capabilities');
    }
    expectedBinding = {
      profileRef: profileRef.data,
      profileRevision: exactValues[0],
      profileHash: exactValues[1]!,
      modelId,
      requiredCapabilities: parsedCapabilities.data,
    };
  }
  return {
    piBin: required('--pi-bin'),
    profileDbPath,
    profileRef: profileRef.data,
    modelId,
    ...(expectedBinding === undefined ? {} : { expectedBinding }),
    validateOnly,
    sessionDir,
    ...(secretServicePrefix ? { secretServicePrefix } : {}),
    ...(macosKeychainPath !== undefined ? { macosKeychainPath } : {}),
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
  const secret = await secrets.get(modelProviderSecretName(profile.profile_ref));
  if (!secret) {
    throw new ByokKeysError(
      'PROVIDER_SECRET_MISSING',
      `${profile.profile_ref} provider profile requires a secret in ${secrets.providerLabel}`,
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
