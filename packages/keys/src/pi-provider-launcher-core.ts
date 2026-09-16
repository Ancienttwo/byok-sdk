import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  assertImplementationSpawnBinding, parseImplementationSpawnBinding, projectKeysPiInheritedEnvironment,
  type ImplementationSpawnBindingV1,
} from '@byok-sdk/implementation-identity';

import { runCommand, type CommandRunner } from './command-runner';
import { ByokKeysError } from './errors';
import { PI_PROJECTED_KEY_ENV, buildPiProviderArgs, buildPiProviderProjection } from './pi-provider-projection';
import {
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  type ExactProviderProfileBinding,
  type ModelProviderProfile,
  type ProviderProfileRef,
} from './provider-profile';
import { type SecretStore, modelProviderSecretName } from './secret-store';

export interface PiProviderLauncherOptions {
  piBin: string;
  /** Explicit script entry for the selected interpreter; never inferred from a filename. */
  piEntry?: string;
  launchBinding?: ImplementationSpawnBindingV1;
  piCwd?: string;
  piFixedArgs?: readonly string[];
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
    '--pi-entry',
    '--launch-binding',
    '--pi-cwd',
    '--pi-fixed-args',
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
  const piEntry = values.get('--pi-entry');
  if (piEntry !== undefined && (!path.isAbsolute(piEntry) || /[\u0000\r\n]/u.test(piEntry))) {
    throw new Error('--pi-entry requires an absolute single-line path');
  }
  let launchBinding: ImplementationSpawnBindingV1 | undefined;
  let piCwd: string | undefined;
  let piFixedArgs: readonly string[] | undefined;
  if (!validateOnly || ['--launch-binding', '--pi-cwd', '--pi-fixed-args'].some((flag) => values.has(flag))) {
    let rawBinding: unknown;
    let rawFixedArgs: unknown;
    try { rawBinding = JSON.parse(required('--launch-binding')); }
    catch { throw new Error('--launch-binding requires a valid JSON binding'); }
    launchBinding = parseImplementationSpawnBinding(rawBinding);
    if (launchBinding === undefined) throw new Error('invalid implementation spawn binding');
    piCwd = required('--pi-cwd');
    try { rawFixedArgs = JSON.parse(required('--pi-fixed-args')); }
    catch { throw new Error('--pi-fixed-args requires a JSON array'); }
    if (!Array.isArray(rawFixedArgs) || rawFixedArgs.some((arg) => typeof arg !== 'string')) {
      throw new Error('--pi-fixed-args requires a JSON array of strings');
    }
    piFixedArgs = rawFixedArgs as string[];
    if (launchBinding.command !== required('--pi-bin') || launchBinding.entry !== piEntry
      || launchBinding.cwd !== piCwd || JSON.stringify(launchBinding.fixedArgv) !== JSON.stringify(piFixedArgs)) {
      throw new Error('launcher arguments differ from implementation spawn binding');
    }
    if (launchBinding.envCommitments.PI_CODING_AGENT_SESSION_DIR !== sessionDir
      || launchBinding.envCommitments.PI_CODING_AGENT_DIR === undefined) {
      throw new Error('launcher session/projection directories must match binding commitments');
    }
  }
  return {
    ...(piEntry === undefined ? {} : { piEntry }),
    piBin: required('--pi-bin'),
    ...(launchBinding === undefined ? {} : { launchBinding, piCwd, piFixedArgs }),
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

/** The inherited inventory is shared with admission; controlled values come only from the binding. */
export function buildPiProviderChildEnvironment(options: {
  ambient: NodeJS.ProcessEnv;
  binding: ImplementationSpawnBindingV1;
  sessionDir: string;
  secret: string | undefined;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const binding = parseImplementationSpawnBinding(options.binding);
  if (binding === undefined) throw new Error('invalid implementation spawn binding');
  if (binding.envCommitments.PI_CODING_AGENT_SESSION_DIR !== options.sessionDir
    || binding.envCommitments.PI_CODING_AGENT_DIR === undefined) {
    throw new Error('launcher session/projection directories must match binding commitments');
  }
  const result = {
    ...projectKeysPiInheritedEnvironment(options.ambient, options.platform),
    ...binding.envCommitments,
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
    [ordered]@{
      sid = $_.IdentityReference.Translate($sidType).Value
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
export async function assertPiProjectionDirectory(projectionDir: string, expectedDir: string): Promise<void> {
  if (projectionDir !== expectedDir || !path.isAbsolute(projectionDir) || path.normalize(projectionDir) !== projectionDir) {
    throw new Error('pi_projection_path_mismatch: Pi projection directory differs from committed path');
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
  spawn?: (command: string, args: string[], options: {
    cwd: string; env: Record<string, string>; stdio: 'inherit';
  }) => ChildProcess;
}

/** Owns the credential-to-spawn sequence; the client retains directory ownership. */
export async function startPiProvider(
  profile: ModelProviderProfile,
  options: PiProviderLauncherOptions,
  dependencies: PiProviderLaunchDependencies,
): Promise<{ child: ChildProcess; cleanup: () => Promise<void> }> {
  const binding = options.launchBinding;
  if (options.validateOnly || binding === undefined || options.piCwd === undefined || options.piFixedArgs === undefined) {
    throw new Error('Pi launch requires an explicit spawn binding, cwd and fixed args');
  }
  const projection = buildPiProviderProjection(profile);
  const delegated = buildPiProviderArgs(profile, options.piArgs);
  const env = buildPiProviderChildEnvironment({
    ambient: dependencies.ambient, binding, sessionDir: options.sessionDir, secret: undefined,
  });
  const actual = { command: options.piBin, entry: options.piEntry, fixedArgv: [...options.piFixedArgs], cwd: options.piCwd, env };
  // Reject drift and invalid layout before opening custody. A second assertion
  // below remeasures the actual credential-bearing env at the final boundary.
  await assertImplementationSpawnBinding(binding, actual);
  const projectionDir = env.PI_CODING_AGENT_DIR!;
  await assertPiProjectionDirectory(projectionDir, binding.envCommitments.PI_CODING_AGENT_DIR!);
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
    const secret = await resolvePiProviderSecret(profile, dependencies.createSecretStore);
    if (secret !== undefined) env[PI_PROJECTED_KEY_ENV] = secret;
    const childArgs = [...(actual.entry === undefined ? [] : [actual.entry]), ...actual.fixedArgv, ...delegated];
    const spawnChild = dependencies.spawn ?? spawn;
    await assertImplementationSpawnBinding(binding, actual);
    const child = spawnChild(actual.command, childArgs, { env, cwd: actual.cwd, stdio: 'inherit' });
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
