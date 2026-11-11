import os from 'node:os';
import path from 'node:path';
import { promises as fs, type Dirent } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { runCommand, type CommandRunner } from './command-runner';
import { configurationPendingError, withConfigurationLock } from './custody';
import { ByokKeysError } from './errors';
import { PI_PREPARED_COMPAT_KEYS } from './pi-model-config';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import {
  PI_LAUNCHER_RUNTIME_ENTRIES, PI_PROJECTED_KEY_ENV, assertPiLaunchArgs, buildPiPreparedArgs, buildPiProviderArgs,
  buildPiProviderProjection, piProjectionProviderId, type PiLauncherRuntimeEntry,
} from './pi-provider-projection';
import type { ProviderProfileStore } from './profile-store';
import {
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  type ModelProviderProfile,
  type ProviderProfileRef,
} from './provider-profile';
import {
  assertExactProviderProfileBinding,
  exactProviderProfileBinding,
  type ExactProviderProfileBinding,
} from './provider-profile-binding';
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
 * A declared `pi_model.api: 'openai-responses'` is refused for the same
 * reason. So are `pi_model.providerId`, `pi_model.inputLimits` and any compat key outside
 * {@link PI_PREPARED_COMPAT_KEYS}: the frozen prepared model wire does not
 * carry them, and the prepared host refuses a projected entry that declares one.
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
  if (profile.pi_model?.api === 'openai-responses') {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      `${profile.profile_ref} declares Pi api openai-responses; the prepared runtime entry compiles openai-completions only`,
    );
  }
  const uncarried = profile.pi_model === undefined ? [] : [
    ...(profile.pi_model.providerId === undefined ? [] : ['providerId']),
    ...(profile.pi_model.inputLimits === undefined ? [] : ['inputLimits']),
    ...Object.keys(profile.pi_model.compat).filter(key => !PI_PREPARED_COMPAT_KEYS.includes(key)).map(key => `compat.${key}`),
  ];
  if (uncarried.length > 0) {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      `${profile.profile_ref} declares Pi ${uncarried.join(', ')}; the prepared model wire does not carry these fields`,
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
 * the two Pi directories this launch owns, then the projected key when one is
 * given. Only a prepared host is given one; the rpc and durable entries take
 * theirs over IPC. No ambient agent or session directory survives.
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

/**
 * The closed causes of a failed Windows ACL query. Tool exit codes are Win32
 * error codes (#1381 E2): 2 and 3 are a missing path, 5 is access denied.
 * stderr is never read, so no path or host detail reaches the error.
 */
const WINDOWS_TOOL_EXIT_CAUSES: Readonly<Record<number, string>> = Object.freeze({
  2: 'path_not_found',
  3: 'path_not_found',
  5: 'access_denied',
});
const WINDOWS_READDIR_CAUSES: Readonly<Record<string, string>> = Object.freeze({
  ENOENT: 'path_not_found',
  EPERM: 'access_denied',
  EACCES: 'access_denied',
});

function aclQueryFailure(step: string, cause: string, exit?: number): Error {
  return new Error(`pi_projection_acl_query_failed: Pi projection ACL query failed (cause=${cause}, step=${step}${exit === undefined ? '' : `, exit=${exit}`})`);
}

/** A fixed tool from the system directory, never from `PATH`. */
function windowsSystemTool(systemRoot: string | undefined, name: 'icacls.exe' | 'whoami.exe'): string {
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot) || /[\u0000\r\n]/u.test(systemRoot)) {
    throw new Error('Windows SystemRoot must be an absolute path');
  }
  return path.win32.join(systemRoot, 'System32', name);
}

async function runWindowsTool(run: CommandRunner, executable: string, step: 'icacls' | 'whoami', args: string[]): Promise<string> {
  const result = await run(executable, args);
  if (result.exitCode === 0) return result.stdout;
  const cause = result.exitCode === 127 ? `${step}_unavailable` : WINDOWS_TOOL_EXIT_CAUSES[result.exitCode] ?? 'unexpected';
  throw aclQueryFailure(step, cause, result.exitCode);
}

const SDDL_SIDS: Readonly<Record<string, string>> = Object.freeze({ OW: 'S-1-3-4', SY: 'S-1-5-18', BA: 'S-1-5-32-544' });
const SDDL_RIGHTS: Readonly<Record<string, number>> = Object.freeze({
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
});
const SDDL_ACE_FLAGS = new Set(['OI', 'CI', 'NP', 'IO', 'ID']);
const FULL_CONTROL = 0x1f01ff;
const READ_CONTROL = 0x20000;
const SYNCHRONIZE = 0x100000;

interface ProjectionAce { allow: boolean; flags: ReadonlySet<string>; mask: number; sid: string }

/**
 * The DACL of an `icacls /save` SDDL line. Anything outside the known grammar
 * (another component, an unknown control flag, ACE type, ACE flag, right or
 * SID alias, an object or conditional ACE) is refused, never skipped. The
 * current user's SID is matched by the exact form icacls renders it in.
 */
function parseProjectionDacl(sddl: string, user: { sid: string; token: string }): ProjectionAce[] {
  const dacl = /^D:((?:P|AI|AR)*)((?:\([^()]*\))*)$/u.exec(sddl);
  if (!dacl) throw new Error('pi_projection_acl_invalid_sddl');
  // Inherited ACEs carry aliases such as AU or CO, so judge protection first.
  if (!dacl[1]!.includes('P')) throw new Error('pi_projection_acl_unprotected');
  const aces: ProjectionAce[] = [];
  for (const [, body] of dacl[2]!.matchAll(/\(([^()]*)\)/gu)) {
    const fields = body!.split(';');
    if (fields.length !== 6) throw new Error('pi_projection_acl_invalid_ace');
    const [type, flagText, rightText, objectGuid, inheritGuid, sidText] = fields as [string, string, string, string, string, string];
    if ((type !== 'A' && type !== 'D') || objectGuid !== '' || inheritGuid !== '') throw new Error('pi_projection_acl_invalid_ace');
    const flags = flagText.match(/../gu) ?? [];
    if (flags.join('') !== flagText || flags.some(flag => !SDDL_ACE_FLAGS.has(flag))) throw new Error('pi_projection_acl_invalid_ace');
    let mask = 0;
    if (/^0x[0-9a-f]+$/iu.test(rightText)) mask = Number.parseInt(rightText, 16);
    else {
      const rights = rightText.match(/../gu) ?? [];
      if (rights.length === 0 || rights.join('') !== rightText || rights.some(right => SDDL_RIGHTS[right] === undefined)) {
        throw new Error('pi_projection_acl_invalid_ace');
      }
      for (const right of rights) mask = (mask | SDDL_RIGHTS[right]!) >>> 0;
    }
    const sid = sidText === user.token ? user.sid : SDDL_SIDS[sidText] ?? (/^S-1-[0-9]+(?:-[0-9]+)+$/u.test(sidText) ? sidText : undefined);
    if (sid === undefined) throw new Error('pi_projection_acl_invalid_ace');
    aces.push({ allow: type === 'A', flags: new Set(flags), mask, sid });
  }
  return aces;
}

/** The SDDL of one `icacls /save` record, whose first line must be the target's leaf name. */
async function saveSddl(run: CommandRunner, icacls: string, target: string, file: string): Promise<string> {
  await runWindowsTool(run, icacls, 'icacls', [target, '/save', file]);
  const lines = (await fs.readFile(file)).toString('utf16le').replace(/^\uFEFF/u, '').replace(/\r\n$/u, '').split('\r\n');
  if (lines.length !== 2 || lines[0] !== path.basename(target)) throw new Error('pi_projection_acl_invalid_output');
  return lines[1]!;
}

/**
 * Version of the Windows Pi projection ACL agreement between the client, which
 * creates the directory (`createProjectionDir` with `ensurePiProjectionDir`),
 * and this launcher, which checks it. 1 was the PowerShell query with the owner
 * check; 2 requires the OWNER RIGHTS READ_CONTROL ACE and reads no owner
 * (#1373). A client and a launcher of different versions refuse each other,
 * so bump it with any change to that ACL.
 */
export const PI_PROJECTION_ACL_PROTOCOL = 2;

/**
 * Read-only Windows equivalent of uid + 0700; never repairs host ACLs.
 *
 * It does not read the owner. The client creates the projection leaf with one
 * exclusive mkdir (`createProjectionDir` -> `createPrivateTempDir`, no reuse of
 * an existing name) and then grants OWNER RIGHTS (S-1-3-4) only READ_CONTROL,
 * which takes away the owner's implicit WRITE_DAC. OWNER RIGHTS limits only
 * handles opened after it is in place, and nobody else can hold an older
 * handle to a leaf this launch's client created exclusively. So whoever owns
 * the directory can change its DACL only through an explicit ACE, and the
 * rules below admit explicit ACEs only for the current user, SYSTEM and
 * Administrators (#1373).
 */
export async function assertWindowsPiProjectionAcl(
  directory: string,
  options: { systemRoot?: string; run?: CommandRunner } = {},
): Promise<void> {
  const systemRoot = options.systemRoot ?? process.env.SystemRoot;
  const icacls = windowsSystemTool(systemRoot, 'icacls.exe');
  const whoami = windowsSystemTool(systemRoot, 'whoami.exe');
  const run = options.run ?? runCommand;

  // libuv marks every entry that carries a reparse attribute as a link, for
  // any reparse tag (#1381 E5), and lists it without opening it.
  let entries: Dirent[];
  try { entries = await fs.readdir(path.dirname(directory), { withFileTypes: true }); }
  catch (error) {
    throw aclQueryFailure('readdir', WINDOWS_READDIR_CAUSES[(error as NodeJS.ErrnoException).code ?? ''] ?? 'unexpected');
  }
  const entry = entries.find(candidate => candidate.name === path.basename(directory));
  if (entry === undefined) throw aclQueryFailure('readdir', 'path_not_found');
  if (entry.isSymbolicLink()) throw new Error('pi_projection_reparse_point: Pi projection path must be a non-symlink directory');
  if (!entry.isDirectory()) throw new Error('pi_projection_not_directory_or_symlink: Pi projection path must be a non-symlink directory');

  const user = /^"[^\r\n]*","(S-1-[0-9]+(?:-[0-9]+)+)"$/u.exec((await runWindowsTool(run, whoami, 'whoami', ['/user', '/fo', 'csv', '/nh'])).trim());
  if (!user) throw new Error('pi_projection_acl_invalid_output');
  const currentUser = user[1]!;

  const saveDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'byok-acl-'));
  let userToken: string;
  let sddl: string;
  try {
    // icacls writes some SIDs as aliases: the built-in local Administrator
    // (RID 500) is `LA`. Render the current user's SID once, alone in the DACL
    // of an empty file, and match exactly that form (#1373). The ACE is full
    // control so the file can be deleted under a parent that grants Modify only.
    const reference = path.join(saveDir, 'user');
    await fs.writeFile(reference, '');
    await runWindowsTool(run, icacls, 'icacls', [reference, '/inheritance:r', '/grant:r', `*${currentUser}:(F)`]);
    const rendered = /^D:[A-Z]*\(A;;[^;()]*;;;([^;()]+)\)$/u.exec(await saveSddl(run, icacls, reference, path.join(saveDir, 'user.acl')));
    if (!rendered) throw new Error('pi_projection_acl_invalid_output');
    userToken = rendered[1]!;
    const known = SDDL_SIDS[userToken] ?? (/^S-1-/u.test(userToken) ? userToken : undefined);
    if (known !== undefined && known !== currentUser) throw new Error('pi_projection_acl_invalid_output');
    sddl = await saveSddl(run, icacls, directory, path.join(saveDir, 'acl'));
  } finally {
    await fs.rm(saveDir, { recursive: true, force: true });
  }
  const aces = parseProjectionDacl(sddl, { sid: currentUser, token: userToken });

  const ownerRights = aces.filter(ace => ace.sid === 'S-1-3-4');
  if (ownerRights.length !== 1 || !ownerRights[0]!.allow || ownerRights[0]!.flags.size !== 0
    || (ownerRights[0]!.mask !== READ_CONTROL && ownerRights[0]!.mask !== (READ_CONTROL | SYNCHRONIZE))) {
    throw new Error('pi_projection_acl_owner_rights_missing: Pi projection directory must grant OWNER RIGHTS only READ_CONTROL');
  }
  const principals = new Set([currentUser, 'S-1-3-4', 'S-1-5-18', 'S-1-5-32-544']);
  let userControl = false;
  for (const ace of aces) {
    if (!ace.allow || !principals.has(ace.sid)) throw new Error('pi_projection_acl_unauthorized_ace');
    if (ace.sid === currentUser && (ace.mask & FULL_CONTROL) === FULL_CONTROL
      && ace.flags.has('OI') && ace.flags.has('CI') && !ace.flags.has('IO') && !ace.flags.has('NP')) userControl = true;
  }
  if (!userControl) throw new Error('pi_projection_acl_owner_access_missing');
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
  // The rpc host and the durable worker run model-callable tools that inherit
  // their process environment, so their key travels over a private IPC
  // channel. Only the prepared host, which runs no native tool, takes it from
  // its environment.
  const ipcLane = runtimeEntry === 'pi-prepared' ? undefined : durable ? 'durable' : 'rpc';
  const configDigest = options.piConfigDigest!;
  const projection = buildPiProviderProjection(profile, runtimeEntry);
  // The ONE place the child grammars diverge. Everything after it —
  // projection write, layout assertion, secret resolution and the spawn
  // itself — is shared; only the key's delivery channel (`ipcLane`) depends
  // on which entry consumes the projected provider.
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
    if (ipcLane === undefined && secret !== undefined) env[PI_PROJECTED_KEY_ENV] = secret;
    const childArgs = [...(options.piEntry === undefined ? [] : [options.piEntry]), ...options.piFixedArgs, `--config-digest=${configDigest}`, ...delegated];
    const spawnChild = dependencies.spawn ?? spawn;
    const child = spawnChild(options.piBin, childArgs, { env, cwd: piCwd,
      stdio: ipcLane === undefined ? 'inherit' : ['inherit', 'inherit', 'inherit', 'ipc'],
      ...(ipcLane === undefined ? {} : { serialization: 'json' as const }),
    });
    if (ipcLane !== undefined) {
      // Private launcher->host channel. stdio belongs exclusively to the blind daemon.
      child.once('message', message => {
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || Object.keys(message).length !== 2
          || (message as {type?: unknown}).type !== `byok.pi.${ipcLane}.credential-request`
          || (message as {configDigest?: unknown}).configDigest !== configDigest
          || !child.send || !child.connected) { child.kill(); return; }
        child.send({ type: `byok.pi.${ipcLane}.credential`, configDigest, secret: secret ?? null,
          ...(durable ? { profileRef: profile.profile_ref, providerId: piProjectionProviderId(profile) } : {}),
        }, error => { if (error) child.kill(); });
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
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
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
    if (options.runtimeEntry === 'pi-rpc') assertPiLaunchArgs(profile);
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
