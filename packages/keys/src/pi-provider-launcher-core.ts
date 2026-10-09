import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { runCommand, type CommandRunner } from './command-runner';
import { configurationPendingError, withConfigurationLock } from './custody';
import { ByokKeysError } from './errors';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import {
  PI_LAUNCHER_RUNTIME_ENTRIES, PI_PROJECTED_KEY_ENV, buildPiPreparedArgs, buildPiProviderArgs,
  buildPiProviderProjection, type PiLauncherRuntimeEntry,
} from './pi-provider-projection';
import type { ProviderProfileStore } from './profile-store';
import {
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  assertExactProviderProfileBinding,
  exactProviderProfileBinding,
  type ExactProviderProfileBinding,
  type ModelProviderProfile,
  type ProviderProfileRef,
} from './provider-profile';
import { type SecretStore, modelProviderSecretName } from './secret-store';

export interface PiProviderLauncherOptions {
  piBin: string;
  /** Explicit script entry for the selected interpreter; never inferred from a filename. */
  piEntry?: string;
  /**
   * The fixed argv after the entry. A single-file product re-enters itself
   * with `__byok_sdk_helper <kind>`. Empty for the installed SDK package.
   */
  piFixedArgs: string[];
  /** The cwd the Pi child starts in. Required for a launch. */
  piCwd?: string;
  /** The client-owned empty 0700 directory the provider projection goes into. Required for a launch. */
  piProjectionDir?: string;
  piConfigDigest?: string;
  /** Which of this launcher's two child grammars applies; never defaulted. */
  runtimeEntry: PiLauncherRuntimeEntry;
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

/**
 * `--pi-fixed-args`: the single-file re-entry prefix. Its only valid value is
 * `["__byok_sdk_helper", <runtime entry>]`, for the parsed `--runtime-entry`.
 */
function parsePiFixedArgs(raw: string | undefined, runtimeEntry: PiLauncherRuntimeEntry): string[] {
  if (raw === undefined) return [];
  const expected = ['__byok_sdk_helper', runtimeEntry];
  if (raw !== JSON.stringify(expected)) {
    throw new Error(`--pi-fixed-args must be exactly ${JSON.stringify(expected)} for --runtime-entry ${runtimeEntry}`);
  }
  return expected;
}

export function parsePiProviderLauncherOptions(
  args: string[],
): PiProviderLauncherOptions {
  const separator = args.indexOf('--');
  const ownArgs = separator < 0 ? args : args.slice(0, separator);
  const piArgs = separator < 0 ? [] : args.slice(separator + 1);

  const allowedFlags = new Set([
    '--pi-bin',
    '--pi-entry',
    '--pi-fixed-args',
    '--pi-cwd',
    '--pi-projection-dir',
    '--pi-config-digest',
    '--runtime-entry',
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

  // Read before anything else this parser decides: the entry selects the child
  // grammar, so a client too old to state it must fail here rather than have
  // one chosen for it.
  const rawRuntimeEntry = required('--runtime-entry');
  if (!(PI_LAUNCHER_RUNTIME_ENTRIES as readonly string[]).includes(rawRuntimeEntry)) {
    throw new Error(`--runtime-entry must be one of [${PI_LAUNCHER_RUNTIME_ENTRIES.join(', ')}]`);
  }
  const runtimeEntry = rawRuntimeEntry as PiLauncherRuntimeEntry;

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
  const piEntry = values.get('--pi-entry');
  if (piEntry !== undefined && (!path.isAbsolute(piEntry) || /[\u0000\r\n]/u.test(piEntry))) {
    throw new Error('--pi-entry requires an absolute single-line path');
  }
  const piFixedArgs = parsePiFixedArgs(values.get('--pi-fixed-args'), runtimeEntry);
  let piCwd: string | undefined;
  let piProjectionDir: string | undefined;
  if (!validateOnly || ['--pi-cwd', '--pi-projection-dir'].some((flag) => values.has(flag))) {
    piCwd = required('--pi-cwd');
    piProjectionDir = required('--pi-projection-dir');
    if (!path.isAbsolute(piCwd) || !path.isAbsolute(piProjectionDir)) {
      throw new Error('--pi-cwd and --pi-projection-dir require absolute paths');
    }
  }
  const piConfigDigest = values.get('--pi-config-digest');
  if ((!validateOnly || piConfigDigest !== undefined) && !/^[0-9a-f]{64}$/u.test(piConfigDigest ?? '')) {
    throw new Error('--pi-config-digest requires 64 lowercase hexadecimal characters');
  }
  if (piArgs.some(arg => arg === '--config-digest' || arg.startsWith('--config-digest='))) {
    throw new Error('delegated --config-digest override is forbidden');
  }
  return {
    ...(piConfigDigest === undefined ? {} : { piConfigDigest }),
    ...(piEntry === undefined ? {} : { piEntry }),
    piFixedArgs,
    runtimeEntry,
    piBin: required('--pi-bin'),
    ...(piCwd === undefined ? {} : { piCwd, piProjectionDir }),
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
 * What a profile must declare before it may parent a prepared host.
 *
 * Both refusals are about the prepared lane's own compile support set, not
 * about custody: a prepared artifact is `openai-completions` bytes compiled by
 * the device, and the host resolves a key for the projected provider before it
 * will consume one. An `anthropic` adapter projects `anthropic-messages`, which
 * the prepared compiler never emits, and an `auth_mode: 'none'` profile has
 * no key for the host to resolve, so the host would refuse with
 * `prepared_provider_credential_unavailable` AFTER a child had already been
 * spawned. Refusing here means the admission (`--validate-only true`) answers
 * the same question the launch would, before any process exists. The
 * projection refuses a keyless profile for this entry too.
 *
 * Deliberately NOT a silent narrowing of the profile: nothing here rewrites the
 * adapter or invents a credential.
 */
export function assertPiPreparedProviderProfile(profile: ModelProviderProfile): void {
  if (profile.adapter === 'anthropic') {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      `${profile.profile_ref} speaks the anthropic adapter; the prepared runtime entry compiles openai-completions only`,
    );
  }
  if (profile.auth_mode === 'none') {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      `${profile.profile_ref} declares auth_mode "none"; the prepared runtime entry requires a provider credential`,
    );
  }
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

function assertSameProfileRecord(current: ModelProviderProfile | undefined, expected: ModelProviderProfile): ModelProviderProfile {
  if (current === undefined) {
    throw new ByokKeysError('PROVIDER_PROFILE_CONFLICT', `${expected.profile_ref} provider profile was removed before its credential was read`);
  }
  const actual = exactProviderProfileBinding(current, []);
  const wanted = exactProviderProfileBinding(expected, []);
  if (
    actual.profileRevision !== wanted.profileRevision
    || actual.profileHash !== wanted.profileHash
    || actual.modelId !== wanted.modelId
  ) {
    throw new ByokKeysError('PROVIDER_PROFILE_CONFLICT', `${expected.profile_ref} provider profile changed before its credential was read`);
  }
  return current;
}

/**
 * The launcher's credential read, as one custody snapshot (plan D5, A4):
 * under the configuration lock, re-read the profile and require it to be the
 * exact record the projection was built from, refuse while a pending marker
 * exists, and only then read the key. A concurrent or interrupted credential
 * change can therefore never yield "old profile + new key".
 */
export async function readProviderCustodySnapshot(options: {
  profiles: ProviderProfileStore;
  profile: ModelProviderProfile;
  createSecretStore: () => SecretStore;
}): Promise<string | undefined> {
  return withConfigurationLock(options.profiles, async () => {
    const current = assertSameProfileRecord(await options.profiles.get(options.profile.profile_ref), options.profile);
    if ((await options.profiles.getPending(current.profile_ref)) !== undefined) throw configurationPendingError();
    return resolvePiProviderSecret(current, options.createSecretStore);
  });
}

/** Admission (`--validate-only`): the same snapshot check without reading the key. */
export async function assertProviderCustodyIdle(options: {
  profiles: ProviderProfileStore;
  profile: ModelProviderProfile;
}): Promise<void> {
  await withConfigurationLock(options.profiles, async () => {
    const current = assertSameProfileRecord(await options.profiles.get(options.profile.profile_ref), options.profile);
    if ((await options.profiles.getPending(current.profile_ref)) !== undefined) throw configurationPendingError();
  });
}

/** Fixed names of the ambient environment the keys launcher passes to its Pi child. */
export const KEYS_PI_INHERITED_ENV_NAMES = Object.freeze([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'TERM', 'SHELL',
  // A single-file product that bundles Pi names its Pi asset root here.
  'PI_PACKAGE_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
] as const);
/** The additional inherited names on win32. */
export const KEYS_PI_WINDOWS_ENV_NAMES = Object.freeze([
  'SystemRoot', 'COMSPEC', 'PATHEXT', 'windir', 'SYSTEMDRIVE', 'PROGRAMFILES', 'APPDATA', 'LOCALAPPDATA',
] as const);

/** The inherited part of the Pi child environment: the fixed names plus `LC_*` and `XDG_*`. */
export function projectKeysPiInheritedEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const normalize = (name: string): string => platform === 'win32' ? name.toUpperCase() : name;
  const names = new Set<string>([...KEYS_PI_INHERITED_ENV_NAMES, ...(platform === 'win32' ? KEYS_PI_WINDOWS_ENV_NAMES : [])].map(normalize));
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    const normalized = normalize(name);
    if (names.has(normalized) || normalized.startsWith('LC_') || normalized.startsWith('XDG_')) result[name] = value;
  }
  return result;
}

/**
 * The Pi child environment: the inherited names (with `PI_PACKAGE_DIR`), then
 * the two Pi directories this launch owns, then the projected key. No ambient
 * agent or session directory survives.
 */
export function buildPiProviderChildEnvironment(options: {
  ambient: NodeJS.ProcessEnv;
  projectionDir: string;
  sessionDir: string;
  secret: string | undefined;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const result: Record<string, string> = {
    ...projectKeysPiInheritedEnvironment(options.ambient, options.platform),
    PI_CODING_AGENT_DIR: options.projectionDir,
    PI_CODING_AGENT_SESSION_DIR: options.sessionDir,
  };
  if (options.secret !== undefined) result[PI_PROJECTED_KEY_ENV] = options.secret;
  return result;
}

const WINDOWS_PROJECTION_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $acl = Get-Acl -LiteralPath ([string]$request.path)
  $sidType = [System.Security.Principal.SecurityIdentifier]
  $rules = @($acl.Access | ForEach-Object {
    $sid = if ($_.IdentityReference -is [System.Security.Principal.SecurityIdentifier]) { $_.IdentityReference.Value } else { try { $_.IdentityReference.Translate($sidType).Value } catch { $null } }
    [ordered]@{
      sid = $sid
      allow = $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
      fullControl = ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
      inherits = ($_.InheritanceFlags -band 3) -eq 3 -and $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
    }
  })
  [ordered]@{
    reparsePoint = ((Get-Item -LiteralPath ([string]$request.path) -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    owner = $acl.GetOwner($sidType).Value
    currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    protected = $acl.AreAccessRulesProtected
    rules = $rules
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [Console]::Error.WriteLine('Pi projection ACL query failed')
  exit 1
}
`;

/** Read-only Windows equivalent of uid + 0700; never repairs host ACLs. */
export async function assertWindowsPiProjectionAcl(
  directory: string,
  options: { systemRoot?: string; run?: CommandRunner } = {},
): Promise<void> {
  const systemRoot = options.systemRoot ?? process.env.SystemRoot;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot) || /[\u0000\r\n]/u.test(systemRoot)) {
    throw new Error('Windows SystemRoot must be an absolute path');
  }
  const result = await (options.run ?? runCommand)(
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PROJECTION_ACL_SCRIPT, 'utf16le').toString('base64')],
    JSON.stringify({ path: directory }),
  );
  if (result.exitCode !== 0) throw new Error('Pi projection ACL query failed');
  let acl: unknown;
  try { acl = JSON.parse(result.stdout); }
  catch { throw new Error('pi_projection_acl_invalid_json'); }
  const recordObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!recordObject(acl) || Object.keys(acl).sort().join(',') !== 'currentUser,owner,protected,reparsePoint,rules'
    || typeof acl.owner !== 'string' || !/^S-1-[0-9-]+$/u.test(acl.owner)
    || typeof acl.currentUser !== 'string' || !/^S-1-[0-9-]+$/u.test(acl.currentUser)
    || typeof acl.protected !== 'boolean' || typeof acl.reparsePoint !== 'boolean' || !Array.isArray(acl.rules)) {
    throw new Error('pi_projection_acl_invalid_shape');
  }
  if (acl.reparsePoint) throw new Error('pi_projection_reparse_point: Pi projection path must be a non-symlink directory');
  if (acl.owner !== acl.currentUser) throw new Error('pi_projection_owner_mismatch: Pi projection directory must be owned by the current user');
  if (!acl.protected) throw new Error('pi_projection_acl_unprotected');
  const principals = new Set([acl.owner, 'S-1-5-18', 'S-1-5-32-544']);
  let ownerControl = false;
  for (const rule of acl.rules) {
    if (!recordObject(rule) || Object.keys(rule).sort().join(',') !== 'allow,fullControl,inherits,sid'
      || typeof rule.sid !== 'string' || !/^S-1-[0-9-]+$/u.test(rule.sid)
      || typeof rule.allow !== 'boolean' || typeof rule.fullControl !== 'boolean' || typeof rule.inherits !== 'boolean') {
      throw new Error('pi_projection_acl_invalid_ace');
    }
    if (!principals.has(rule.sid) || !rule.allow) throw new Error('pi_projection_acl_unauthorized_ace');
    if (rule.sid === acl.owner && rule.fullControl && rule.inherits) ownerControl = true;
  }
  if (!ownerControl) throw new Error('pi_projection_acl_owner_access_missing');
}

/** Validate the client-owned empty directory before any credential access. */
export async function assertPiProjectionDirectory(projectionDir: string): Promise<void> {
  if (!path.isAbsolute(projectionDir) || path.normalize(projectionDir) !== projectionDir) {
    throw new Error('pi_projection_path_not_normal: Pi projection directory must be an absolute normalized path');
  }
  const stat = await fs.lstat(projectionDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('pi_projection_not_directory_or_symlink: Pi projection path must be a non-symlink directory');
  if (await fs.realpath(projectionDir) !== projectionDir) throw new Error('pi_projection_path_not_canonical: Pi projection directory parents must be canonical, without symlinks');
  if (process.platform === 'win32') {
    await assertWindowsPiProjectionAcl(projectionDir);
  } else {
    if (stat.uid !== process.getuid!()) throw new Error('pi_projection_owner_mismatch: Pi projection directory must be owned by the current uid');
    if ((stat.mode & 0o7777) !== 0o700) throw new Error('pi_projection_mode_mismatch: Pi projection directory must have mode 0700');
  }
  if ((await fs.readdir(projectionDir)).length !== 0) throw new Error('pi_projection_not_empty: Pi projection directory must be empty');
}

export interface PiProviderLaunchDependencies {
  ambient: NodeJS.ProcessEnv;
  createSecretStore: () => SecretStore;
  /** The profile store the profile was read from; its custody lock guards the key read. */
  profiles: ProviderProfileStore;
  spawn?: (command: string, args: string[], options: {
    cwd: string; env: Record<string, string>; stdio: 'inherit' | ['inherit', 'inherit', 'inherit', 'ipc']; serialization?: 'json';
  }) => ChildProcess;
}

/** Owns the credential-to-spawn sequence; the client retains directory ownership. */
export async function startPiProvider(
  profile: ModelProviderProfile,
  options: PiProviderLauncherOptions,
  dependencies: PiProviderLaunchDependencies,
): Promise<{ child: ChildProcess; cleanup: () => Promise<void> }> {
  const piCwd = options.piCwd;
  const projectionDir = options.piProjectionDir;
  if (options.validateOnly || piCwd === undefined || projectionDir === undefined || !/^[0-9a-f]{64}$/u.test(options.piConfigDigest ?? '')) {
    throw new Error('Pi launch requires an explicit cwd, projection directory and config digest');
  }
  if (options.runtimeEntry === 'pi-durable' && process.platform === 'win32') throw new Error('durable Pi is unavailable on Windows until parent-death Job Object recovery is validated');
  const runtimeEntry = options.runtimeEntry;
  const durable = runtimeEntry === 'pi-durable';
  const configDigest = options.piConfigDigest!;
  const projection = buildPiProviderProjection(profile, runtimeEntry);
  // The ONE place the two child grammars diverge. Everything after it —
  // projection write, layout assertion, secret resolution and the spawn
  // itself — is shared, because custody does not depend on which entry
  // consumes the projected provider.
  const delegated = (runtimeEntry === 'pi-prepared' || durable)
    ? buildPiPreparedArgs(options.piArgs)
    : buildPiProviderArgs(profile, options.piArgs);
  const env = buildPiProviderChildEnvironment({
    ambient: dependencies.ambient, projectionDir, sessionDir: options.sessionDir, secret: undefined,
  });
  // Reject an invalid layout before opening custody.
  await assertPiProjectionDirectory(projectionDir);
  await ensurePiSessionDirectory(options.sessionDir);
  const modelsPath = path.join(projectionDir, 'models.json');
  let created = false;
  const cleanup = async (): Promise<void> => {
    if (created) {
      await fs.unlink(modelsPath);
      created = false;
    }
  };
  try {
    const file = await fs.open(modelsPath, 'wx', 0o600);
    created = true;
    try { await file.writeFile(`${JSON.stringify(projection)}\n`); }
    finally { await file.close(); }
    const secret = await readProviderCustodySnapshot({
      profiles: dependencies.profiles,
      profile,
      createSecretStore: dependencies.createSecretStore,
    });
    if (!durable && secret !== undefined) env[PI_PROJECTED_KEY_ENV] = secret;
    const childArgs = [...(options.piEntry === undefined ? [] : [options.piEntry]), ...options.piFixedArgs, `--config-digest=${configDigest}`, ...delegated];
    const spawnChild = dependencies.spawn ?? spawn;
    const child = spawnChild(options.piBin, childArgs, { env, cwd: piCwd,
      stdio: durable ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      ...(durable ? { serialization: 'json' as const } : {}),
    });
    if (durable) {
      // Private launcher->worker channel. stdio belongs exclusively to the blind daemon.
      child.once('message', message => {
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || Object.keys(message).length !== 2
          || (message as {type?: unknown}).type !== 'byok.pi.durable.credential-request'
          || (message as {configDigest?: unknown}).configDigest !== configDigest
          || !child.send || !child.connected) { child.kill(); return; }
        child.send({ type: 'byok.pi.durable.credential', configDigest, secret: secret ?? null }, error => { if (error) child.kill(); });
      });
    }
    return { child, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
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

/** What a host supplies to {@link runPiProviderLauncher}. */
export interface PiProviderLauncherHost {
  /**
   * Builds the credential store that holds the selected profile's key. The
   * launcher calls it only for a profile that requires a credential, and only
   * under the profile store's configuration lock. A host that stores keys with
   * its own options (for example a `MacOsKeychainSecretStore` `storagePrefix`
   * or `account`) builds that store here. The parsed launcher options carry
   * `secretServicePrefix` and `macosKeychainPath` for the host to apply.
   */
  createSecretStore: () => SecretStore;
}

/**
 * The credential-custody launcher, as one call: the same checks and the same
 * launch as the bundled `byok-pi-provider-launcher` executable, with a
 * host-built credential store.
 *
 * It opens the profile database read-only, requires the exact configured
 * profile and model, checks the exact binding when the options carry one,
 * refuses a profile the runtime entry cannot serve, and builds the projection.
 * A validation-only call then checks custody without reading a key. A launch
 * reads the key through the custody snapshot, spawns Pi, forwards SIGINT and
 * SIGTERM to the child while it runs, and resolves with the child's exit code.
 * The projection file is removed on every exit path.
 */
export async function runPiProviderLauncher(
  options: PiProviderLauncherOptions,
  host: PiProviderLauncherHost,
): Promise<number> {
  const profiles = new SqliteProviderProfileStore({
    path: options.profileDbPath,
    readOnly: true,
  });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const profile = await profiles.get(options.profileRef);
    if (profile === undefined) {
      throw new Error(`provider profile ${options.profileRef} is not configured`);
    }
    if (profile.model !== options.modelId) {
      throw new Error(
        `selected model ${options.modelId} does not match configured provider model ${profile.model}`,
      );
    }
    if (options.expectedBinding !== undefined) {
      assertExactProviderProfileBinding(profile, options.expectedBinding);
    }
    if (options.runtimeEntry === 'pi-prepared') assertPiPreparedProviderProfile(profile);
    buildPiProviderProjection(profile, options.runtimeEntry);
    if (options.validateOnly) {
      await assertProviderCustodyIdle({ profiles, profile });
      return 0;
    }
    const launched = await startPiProvider(profile, options, {
      ambient: process.env,
      profiles,
      createSecretStore: host.createSecretStore,
    });
    cleanup = launched.cleanup;
    const child = launched.child;

    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          resolve(code ?? (signal ? 1 : 0));
        });
      });
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  } finally {
    await profiles.close();
    await cleanup?.();
  }
}
