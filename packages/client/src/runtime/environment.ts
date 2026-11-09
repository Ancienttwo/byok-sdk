import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loginShellSnapshot, type LoginShellSnapshot, type ServiceEnvironmentUnavailableCode } from '../login-shell-environment';

/**
 * The environment of every child process of a task: the runtime CLI and the
 * MCP servers the daemon probes for it (#1095).
 *
 * {@link buildRuntimeEnvironment} builds it from a
 * {@link RuntimeEnvironmentPolicy}, which each runtime adapter owns:
 *
 * - `login-shell` (default): the user's login-shell snapshot
 *   (`../login-shell-environment.ts`), never the daemon's live
 *   environment, so a variable an embedding Host puts into `process.env` does
 *   not reach the runtime. A failed capture fails closed with
 *   {@link RuntimeEnvironmentUnavailableError}. On win32, which has no login
 *   shell, the base is {@link WINDOWS_SESSION_NAMES}: `PATH` and `PATHEXT`
 *   as logon builds them from the registry (see {@link WindowsLogonRegistry}),
 *   the other names from the live session environment.
 * - `allowlist`: the platform baseline plus `allow`, from the live
 *   environment; it needs no snapshot.
 *
 * Then, in order: the adapter's conflict rule removes names from the base;
 * `pass` copies the named variables from the live environment at every build;
 * the hard deny removes `CLAUDECODE` (Claude Code sets it inside its own
 * sessions; a child agent starts as its own top-level session) and `BYOK_*`
 * (this SDK's control-plane variables), whatever listed them; `NO_PROXY` and
 * `no_proxy` gain `127.0.0.1` and `localhost`, so a user's proxy never takes
 * the traffic to the daemon's loopback gate and MCP servers.
 *
 * {@link buildAllowlistedEnv} is the narrow form over a given environment. It
 * is used by the durable Pi tool shell, the prepared Pi lane on the Pi auth
 * store, and Hermes launcher or custody paths.
 *
 * Every name in every list may be an exact match or a `*`-suffixed prefix
 * (e.g. `'LC_*'` matches `LC_ALL`, `LC_CTYPE`, ...).
 *
 * The same pass that builds the environment builds its
 * {@link RuntimeEnvironmentReport}: every name with its source, and the names
 * the hard deny or the conflict rule removed. Never a value. `byok-agent
 * doctor` reads it from the running daemon (`runtimes.environment`).
 */

/** Inputs to {@link buildAllowlistedEnv}. */
export interface BuildAllowlistedEnvOptions {
  /**
   * The ambient environment (normally `process.env`). Never mutated — every
   * returned variable is copied into a fresh object.
   */
  ambient: Readonly<Record<string, string | undefined>>;
  /** Names admitted beyond the platform baseline, still subject to the hard deny. */
  allow?: readonly string[];
  /**
   * Test seam: which platform's extra base vars to include
   * ({@link WINDOWS_BASE_ALLOWLIST} vs none) — defaults to `process.platform`
   * so callers never have to think about it, while still letting a test
   * exercise the win32 branch deterministically on any host OS.
   */
  platform?: NodeJS.Platform;
}

/**
 * Always included regardless of runtime or platform — the bare minimum any
 * CLI needs to resolve its own binary/libraries, find a home/temp
 * directory, and behave sanely in a non-interactive shell. `XDG_*` matters
 * specifically: a user with `XDG_CONFIG_HOME` set relies on it for
 * claude/codex's own login-state discovery — omitting it would silently
 * break auth detection for those users, not just cosmetic config lookup.
 *
 * F3: the four standard proxy variables are included here deliberately, in
 * both `SCREAMING_CASE` (what curl and most CLIs check first) and lowercase
 * `snake_case` (the conventional form on Unix — some tools check only one
 * spelling, some check both), not gated behind a caller's own `allow`
 * list: an agent CLI spawned behind a corporate proxy
 * with none of these forwarded silently loses all outbound network access —
 * a materially worse default than forwarding a proxy URL. See
 * docs/security.md's "Proxy variables pass through" paragraph for the accepted
 * trade-off this implies (a proxy URL may itself embed proxy credentials).
 */
const BASE_PLATFORM_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  // macOS credential-store discovery used by subscription-authenticated
  // agent CLIs depends on the login account name as well as HOME. Omitting
  // USER makes `claude auth status` report logged out under the filtered
  // child environment even when the host CLI is logged in.
  'USER',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'TZ',
  'TERM',
  'SHELL',
  'LC_*',
  'XDG_*',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

/** Additional always-included names on win32 only — see {@link BuildAllowlistedEnvOptions.platform}. */
const WINDOWS_BASE_ALLOWLIST: readonly string[] = [
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'windir',
  'SYSTEMDRIVE',
  'PROGRAMFILES',
  'APPDATA',
  'LOCALAPPDATA',
];

/**
 * The win32 runtime environment base under `login-shell`: the platform
 * baseline plus the names Windows itself sets for a logon session. `PATH` and
 * `PATHEXT` are the logon registry values ({@link WINDOWS_LOGON_NAMES}), so a
 * directory a shell profile adds to the session `PATH` is not in the base;
 * every other name is the live session value.
 */
const WINDOWS_SESSION_NAMES: readonly string[] = [
  ...BASE_PLATFORM_ALLOWLIST,
  ...WINDOWS_BASE_ALLOWLIST,
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
  // The runtimes' own config homes a user may set on win32, kept as the
  // macOS/Linux login-shell snapshot keeps them (#1595).
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
];

/**
 * Hard deny. It wins over every allow entry and applies to both builders. It
 * is checked LAST in the per-variable decision, so no allow match can skip
 * it.
 */
const HARD_DENY_PATTERNS: readonly string[] = [
  'CLAUDECODE',
  'BYOK_*',
];

/**
 * F1: `caseInsensitive` is `true` only on win32.
 * Windows environment variable names are case-insensitive at the OS level
 * but NOT case-normalized by Node — `process.env` hands back whatever
 * casing the variable actually has there (`Path`, `ComSpec`,
 * `SystemDrive`, `ProgramFiles`, ...), which routinely does not match this
 * module's own SCREAMING_CASE pattern spelling byte-for-byte. Uppercasing
 * both sides before comparing (rather than, say, only uppercasing `name`)
 * keeps this symmetric and correct regardless of which side happens to be
 * mixed-case. Non-win32 platforms never set `caseInsensitive`, so this stays
 * byte-exact there — unchanged from before F1.
 */
function matchesPattern(name: string, pattern: string, caseInsensitive: boolean): boolean {
  const candidateName = caseInsensitive ? name.toUpperCase() : name;
  const candidatePattern = caseInsensitive ? pattern.toUpperCase() : pattern;
  return candidatePattern.endsWith('*')
    ? candidateName.startsWith(candidatePattern.slice(0, -1))
    : candidateName === candidatePattern;
}

function matchesAny(name: string, patterns: readonly string[], caseInsensitive: boolean): boolean {
  return patterns.some((pattern) => matchesPattern(name, pattern, caseInsensitive));
}

function copyAdmitted(
  ambient: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  admitted: (name: string, caseInsensitive: boolean) => boolean,
): Record<string, string> {
  // F1: win32 only — see `matchesPattern`'s own doc comment for why OS-cased
  // keys make case-sensitive matching silently wrong there specifically.
  // A mixed-case `Byok_Secret` is denied there exactly as `BYOK_SECRET` is.
  const caseInsensitive = platform === 'win32';
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (admitted(name, caseInsensitive) && !matchesAny(name, HARD_DENY_PATTERNS, caseInsensitive)) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Which environment a runtime adapter gives its children (see this module's
 * doc comment). `pass` names variables taken from the live `process.env` at
 * every build, for a Host that sets them after it starts. Names never match
 * `CLAUDECODE` or `BYOK_*`.
 */
export type RuntimeEnvironmentPolicy =
  | { readonly base?: 'login-shell'; readonly pass?: readonly string[] }
  | { readonly base: 'allowlist'; readonly allow?: readonly string[]; readonly pass?: readonly string[] };

/**
 * An adapter's conflict rule: given the names `pass` actually supplied, the
 * names (or `*` prefixes) to remove from the base. On win32 the supplied
 * names arrive in upper case and the removed names match case-insensitively.
 */
export type RuntimeEnvironmentConflictRule = (passed: ReadonlySet<string>) => readonly string[];

/**
 * Where a runtime environment name came from: the base (`login-shell`,
 * `windows-session` or `allowlist`), the policy's `pass`, or `sdk` for the
 * `NO_PROXY`/`no_proxy` this module writes and the `PI_PACKAGE_DIR` the Pi
 * adapter writes from `packageDir`.
 */
export type RuntimeEnvironmentSource = 'login-shell' | 'windows-session' | 'allowlist' | 'pass' | 'sdk';

/** The rule that kept a name out: the hard deny (`CLAUDECODE`, `BYOK_*`) or the adapter's conflict rule. */
export type RuntimeEnvironmentRemovalRule = 'deny' | 'conflict';

/**
 * The names of one runtime environment, sorted, never their values. `removed`
 * lists the names a base or `pass` admitted and a rule then kept out, so a
 * name is in exactly one of the two lists.
 */
export interface RuntimeEnvironmentReport {
  readonly names: readonly { readonly name: string; readonly source: RuntimeEnvironmentSource }[];
  readonly removed: readonly { readonly name: string; readonly rule: RuntimeEnvironmentRemovalRule }[];
}

/** One build: the environment and its {@link RuntimeEnvironmentReport}. `env` is a fresh object. */
export interface RuntimeEnvironment {
  readonly env: Record<string, string>;
  readonly report: RuntimeEnvironmentReport;
}

/**
 * The base capture failed — the login-shell snapshot, or on win32 the logon
 * registry read (`logon-registry-unavailable`) — so no `login-shell` runtime
 * environment exists in this process.
 */
export class RuntimeEnvironmentUnavailableError extends Error {
  readonly code = 'runtime_environment_unavailable' as const;
  constructor(readonly reason: ServiceEnvironmentUnavailableCode) {
    super(`runtime environment unavailable: the base capture failed (${reason})`);
    this.name = 'RuntimeEnvironmentUnavailableError';
  }
}

/*
 * win32 logon registry (#1317). `PATH` and `PATHEXT` of the base are built
 * the way Windows builds them at logon, measured with `CreateEnvironmentBlock`
 * on windows-latest and windows-2022:
 * https://github.com/Ancienttwo/byok-sdk/pull/1395#issuecomment-6599686570 and
 * https://github.com/Ancienttwo/byok-sdk/pull/1395#issuecomment-6599840085
 *
 * - Read with `reg export` (UTF-16LE), not `reg query`, whose output follows
 *   the console code page.
 * - Within each key, every REG_SZ first, then every REG_EXPAND_SZ in key
 *   order, expanded with what is defined so far; an undefined `%NAME%` stays.
 * - Predefined names come in two stages: a few before the machine key, the
 *   profile names before the user key. Volatile Environment names
 *   (`HOMEDRIVE`, `LOGONSERVER`, ...) are set after logon and never expand.
 * - REG_DWORD and other non-string values are ignored.
 * - `PATH` is the machine value, then the user value's entries with every
 *   empty entry and every entry byte-for-byte equal to a machine entry
 *   removed, so a user `%PATH%` (expanded to the machine value) adds nothing
 *   twice.
 * - `PATHEXT` and every other name: the user value replaces the machine value.
 */

/** The win32 base names logon builds from the registry, upper case. */
const WINDOWS_LOGON_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT']);

/** The keys logon reads, machine first. */
export const WINDOWS_MACHINE_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
export const WINDOWS_USER_ENVIRONMENT_KEY = 'HKCU\\Environment';

/** A REG_SZ (`expand: false`) or REG_EXPAND_SZ (`expand: true`) registry value. */
export interface WindowsRegistryString {
  readonly expand: boolean;
  readonly value: string;
}

/**
 * Reads the REG_SZ and REG_EXPAND_SZ values of one registry key, keyed by the
 * upper-case value name. Rejects when the key cannot be read or parsed.
 *
 * @internal
 */
export type WindowsRegistryReader = (key: string) => Promise<ReadonlyMap<string, WindowsRegistryString>>;

/**
 * The machine and user Environment keys of this process's logon, read once
 * per process like the login-shell snapshot, or the failed read.
 *
 * @internal
 */
export type WindowsLogonRegistry =
  | { readonly source: 'registry'; readonly machine: ReadonlyMap<string, WindowsRegistryString>; readonly user: ReadonlyMap<string, WindowsRegistryString> }
  | { readonly source: 'unavailable' };

/**
 * Reads both logon keys with `reader`, machine then user, one export at a
 * time: concurrent `reg export` runs interfere (#1395 E1g: an exit code 1, or
 * a file holding another key). Any failure is `unavailable`, which the build
 * fails closed on.
 *
 * @internal
 */
export async function readWindowsLogonRegistry(reader: WindowsRegistryReader): Promise<WindowsLogonRegistry> {
  try {
    const machine = await reader(WINDOWS_MACHINE_ENVIRONMENT_KEY);
    const user = await reader(WINDOWS_USER_ENVIRONMENT_KEY);
    return { source: 'registry', machine, user };
  } catch {
    return { source: 'unavailable' };
  }
}

const defaultWindowsLogonSource = (): Promise<WindowsLogonRegistry> => readWindowsLogonRegistry(readWindowsRegistryKey);
let windowsLogonSource = defaultWindowsLogonSource;
let windowsLogon: Promise<WindowsLogonRegistry> | undefined;

/** This process's logon registry values, read on the first call. Never rejects. */
function windowsLogonRegistry(): Promise<WindowsLogonRegistry> {
  windowsLogon ??= windowsLogonSource();
  return windowsLogon;
}

/**
 * Test seam: replaces how {@link buildRuntimeEnvironment} reads the logon
 * registry on win32 and forgets an earlier read; `undefined` restores the
 * real read.
 *
 * @internal
 */
export function setWindowsLogonRegistrySource(source: (() => Promise<WindowsLogonRegistry>) | undefined): void {
  windowsLogonSource = source ?? defaultWindowsLogonSource;
  windowsLogon = undefined;
}

/**
 * The names logon sets before it reads the machine Environment key, so a
 * machine REG_EXPAND_SZ can name them (#1317 E1e, `CreateEnvironmentBlock` on
 * windows-latest and windows-2022). Their values are taken from the live
 * session, which logon gave them.
 */
const WINDOWS_LOGON_MACHINE_PREDEFINED_NAMES: readonly string[] = ['ALLUSERSPROFILE', 'ProgramData', 'PUBLIC', 'SystemDrive', 'SystemRoot'];

/**
 * The names logon sets from the user profile after the machine key and before
 * the user key, so only a user REG_EXPAND_SZ can name them (#1317 E1e). The
 * names a Host can set freely (`TMPDIR`, `LANG`, `HOME`, proxies, ...) are in
 * neither list, so a Host value never reaches `PATH` through `%NAME%`.
 */
const WINDOWS_LOGON_USER_PREDEFINED_NAMES: readonly string[] = [
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'COMPUTERNAME',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
];

/** `%NAME%` replaced by its value in `scope` (upper-case names); an undefined name stays as written. */
function expandWindowsNames(value: string, scope: ReadonlyMap<string, string>): string {
  return value.replace(/%([^%]+)%/gu, (reference, name: string) => scope.get(name.toUpperCase()) ?? reference);
}

/**
 * Adds one Environment key to `scope` as logon does (#1317 E1d/E1e): every
 * REG_SZ first, then every REG_EXPAND_SZ in key order, each expanded with
 * `scope` as it stands, so an expandable value sees every plain value and the
 * expandable values before it. `path` turns the key's `PATH` into the value
 * the scope holds.
 */
function addWindowsEnvironmentKey(values: ReadonlyMap<string, WindowsRegistryString>, scope: Map<string, string>, path: (value: string) => string = (value) => value): void {
  for (const expand of [false, true]) {
    for (const [name, entry] of values) {
      if (entry.expand !== expand) continue;
      const value = expand ? expandWindowsNames(entry.value, scope) : entry.value;
      scope.set(name, name === 'PATH' ? path(value) : value);
    }
  }
}

/**
 * `PATH` and `PATHEXT` as logon builds them from the registry (#1317 E1):
 * the machine predefined names, the machine key, the user predefined names,
 * then the user key. `PATH` is the machine value, then the user value's
 * entries that are not empty and not byte-for-byte an entry of the machine
 * value, joined by `;`; so a user `%PATH%` adds nothing twice. A user value
 * expanded after the user `PATH` sees the joined one. `PATHEXT` and every
 * other name take the user value over the machine value. Registry names
 * other than these two only feed the expansion.
 */
function windowsLogonBase(logon: Extract<WindowsLogonRegistry, { source: 'registry' }>, live: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const session = new Map<string, string>();
  for (const [name, value] of Object.entries(live)) if (value !== undefined) session.set(name.toUpperCase(), value);
  const scope = new Map<string, string>();
  const predefine = (names: readonly string[]): void => {
    for (const name of names) {
      const value = session.get(name.toUpperCase());
      if (value !== undefined) scope.set(name.toUpperCase(), value);
    }
  };
  predefine(WINDOWS_LOGON_MACHINE_PREDEFINED_NAMES);
  addWindowsEnvironmentKey(logon.machine, scope);
  const machinePath = scope.get('PATH');
  const machineEntries = new Set(machinePath?.split(';'));
  predefine(WINDOWS_LOGON_USER_PREDEFINED_NAMES);
  // When nothing of the user value is left, Windows still appends a `;`
  // (#1395 E1 B11); this join deliberately leaves no empty entry.
  addWindowsEnvironmentKey(logon.user, scope, (value) => [machinePath, ...value.split(';').filter((entry) => entry.length > 0 && !machineEntries.has(entry))]
    .filter((part) => part !== undefined && part.length > 0).join(';'));
  const pathValue = scope.get('PATH');
  const pathext = scope.get('PATHEXT');
  return {
    ...(pathValue === undefined || pathValue.length === 0 ? {} : { PATH: pathValue }),
    ...(pathext === undefined ? {} : { PATHEXT: pathext }),
  };
}

const REG_EXPORT_TIMEOUT_MS = 10_000;

/**
 * The real {@link WindowsRegistryReader}: `%SystemRoot%\\System32\\reg.exe`
 * exports `key` to a UTF-16LE file in a private temp directory, removed once
 * read. `reg query` is not used: its stdout follows the console code page,
 * which loses non-ASCII directories (#1317 E1). The file may hold secrets a
 * user keeps in environment variables, so no error carries its content.
 *
 * @internal
 */
export async function readWindowsRegistryKey(key: string): Promise<ReadonlyMap<string, WindowsRegistryString>> {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot) || /[\u0000\r\n]/u.test(systemRoot)) throw new Error('SystemRoot is not an absolute path');
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
  // Loaded on the first read, so only a win32 build pulls it into this module's graph.
  const { createPrivateSystemTempDir } = await import('../util/secure-dir');
  const directory = await createPrivateSystemTempDir('byok-reg-');
  try {
    const file = path.join(directory, 'key.reg');
    // Concurrent `reg export` runs that share TEMP/TMP mix up their output
    // (an exit code 1, or a file holding another key); each run gets this
    // read's private directory as both (#1395 E1g/E1h:
    // https://github.com/Ancienttwo/byok-sdk/pull/1395#issuecomment-6604292991,
    // https://github.com/Ancienttwo/byok-sdk/pull/1395#issuecomment-6604394309).
    const env = { ...process.env, TEMP: directory, TMP: directory };
    await new Promise<void>((resolve, reject) => {
      execFile(reg, ['export', key, file, '/y'], { env, timeout: REG_EXPORT_TIMEOUT_MS, windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    return parseWindowsRegistryExport(await fs.readFile(file), key);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const REGISTRY_ROOTS: Readonly<Record<string, string>> = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER' };

/**
 * The REG_SZ and REG_EXPAND_SZ values of `key` in a `reg export` file: a
 * UTF-16LE BOM, the version 5 header, then `[<key>]` and one value per line —
 * `"name"="text"` with `\\` and `\"` escaped, or `"name"=hex(2):..` with the
 * UTF-16LE bytes of an expandable string, continued over lines ending in `\\`.
 * Other value types are skipped; a subkey section ends the key. Anything else
 * is a parse failure.
 *
 * @internal
 */
export function parseWindowsRegistryExport(bytes: Uint8Array, key: string): Map<string, WindowsRegistryString> {
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error('reg export output has no UTF-16LE byte order mark');
  const lines = Buffer.from(bytes.subarray(2)).toString('utf16le').split('\r\n');
  const [root, ...rest] = key.split('\\');
  const hive = REGISTRY_ROOTS[root!];
  if (hive === undefined) throw new Error('registry key is not under HKLM or HKCU');
  if (lines[0] !== 'Windows Registry Editor Version 5.00') throw new Error('reg export output has no version 5 header');
  if (lines[1] !== '' || lines[2]?.toUpperCase() !== `[${[hive, ...rest].join('\\')}]`.toUpperCase()) throw new Error('reg export output does not start with the key');
  const values = new Map<string, WindowsRegistryString>();
  for (let index = 3; index < lines.length; index += 1) {
    let line = lines[index]!;
    if (line === '') continue;
    if (line.startsWith('[')) break;
    while (line.endsWith('\\') && /^(?:@|"(?:[^"\\]|\\.)*")=hex/u.test(line) && index + 1 < lines.length) line = line.slice(0, -1) + lines[(index += 1)]!.trimStart();
    const entry = /^(?:@|"((?:[^"\\]|\\.)*)")=(.*)$/u.exec(line);
    if (entry === null) throw new Error('reg export output has an unparsable value line');
    const value = registryString(entry[2]!);
    if (entry[1] !== undefined && value !== undefined) values.set(unescapeRegistry(entry[1]).toUpperCase(), value);
  }
  return values;
}

function unescapeRegistry(text: string): string {
  return text.replace(/\\(.)/gu, '$1');
}

/** One exported value: a string, an expandable string, `undefined` for another type, or a parse failure. */
function registryString(data: string): WindowsRegistryString | undefined {
  const text = /^"((?:[^"\\]|\\.)*)"$/u.exec(data);
  if (text !== null) return { expand: false, value: unescapeRegistry(text[1]!) };
  const hex = /^hex\(([0-9a-f]+)\):((?:[0-9a-f]{2}(?:,[0-9a-f]{2})*)?)$/u.exec(data);
  if (hex === null) {
    if (/^(?:dword:[0-9a-f]{8}|hex:(?:[0-9a-f]{2}(?:,[0-9a-f]{2})*)?)$/u.test(data)) return undefined;
    throw new Error('reg export output has an unparsable value');
  }
  if (hex[1] !== '2') return undefined;
  const octets = hex[2] === '' ? [] : hex[2]!.split(',').map((octet) => Number.parseInt(octet, 16));
  if (octets.length % 2 !== 0) throw new Error('reg export output has an odd-length expandable string');
  return { expand: true, value: Buffer.from(octets).toString('utf16le').replace(/\0+$/u, '') };
}

const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost'];

function assertNames(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of variable names`);
  for (const name of value) {
    if (typeof name !== 'string' || name.length === 0 || /[=\0]/.test(name) || name.slice(0, -1).includes('*') || name === '*') {
      throw new TypeError(`${label} entries must be variable names or *-suffixed prefixes`);
    }
    if (matchesAny(name, HARD_DENY_PATTERNS, true)) throw new TypeError(`${label} must not name CLAUDECODE or BYOK_*`);
  }
  return Object.freeze([...value as string[]]);
}

/** Validates a policy at the adapter or daemon boundary and returns a frozen copy. */
export function assertRuntimeEnvironmentPolicy(value: unknown, label: string): RuntimeEnvironmentPolicy {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const policy = value as Record<string, unknown>;
  const base = policy.base ?? 'login-shell';
  if (base !== 'login-shell' && base !== 'allowlist') throw new TypeError(`${label}.base must be login-shell or allowlist`);
  const known = base === 'allowlist' ? ['base', 'allow', 'pass'] : ['base', 'pass'];
  const unknown = Object.keys(policy).find((key) => !known.includes(key));
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is not a ${base} policy field`);
  const pass = policy.pass === undefined ? undefined : assertNames(policy.pass, `${label}.pass`);
  if (base === 'allowlist') {
    const allow = policy.allow === undefined ? undefined : assertNames(policy.allow, `${label}.allow`);
    return Object.freeze({ base, ...(allow === undefined ? {} : { allow }), ...(pass === undefined ? {} : { pass }) });
  }
  return Object.freeze({ ...(policy.base === undefined ? {} : { base }), ...(pass === undefined ? {} : { pass }) });
}

/** Inputs to {@link composeRuntimeEnvironment}. */
export interface ComposeRuntimeEnvironmentInput {
  policy: RuntimeEnvironmentPolicy;
  /** Required for `login-shell` off win32. */
  snapshot?: LoginShellSnapshot;
  /** Required for `login-shell` on win32: the source of `PATH` and `PATHEXT`. */
  windowsLogon?: WindowsLogonRegistry;
  /** The live environment (normally `process.env`). Never mutated. */
  live: Readonly<Record<string, string | undefined>>;
  conflicts?: RuntimeEnvironmentConflictRule;
  platform?: NodeJS.Platform;
}

/**
 * The synchronous core of {@link buildRuntimeEnvironment}: a fresh
 * environment and its report from the given snapshot and live environment.
 *
 * @internal
 */
export function composeRuntimeEnvironment(input: ComposeRuntimeEnvironmentInput): RuntimeEnvironment {
  const platform = input.platform ?? process.platform;
  const caseInsensitive = platform === 'win32';
  const { policy, live } = input;
  const denied = new Set<string>();
  const admit = (source: Readonly<Record<string, string | undefined>>, admitted: (name: string) => boolean): Record<string, string> => {
    const result: Record<string, string> = {};
    const names = Object.keys(source);
    // Node sends the lexicographically first spelling of a win32 name to a child.
    if (caseInsensitive) names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      const value = source[name];
      if (value === undefined || !admitted(name)) continue;
      if (matchesAny(name, HARD_DENY_PATTERNS, caseInsensitive)) denied.add(name);
      else {
        // Use the session list's spelling for SDK reads as well as child lookups.
        // Prefix entries (LC_*, XDG_*) canonicalize the whole name to upper case.
        const pattern = caseInsensitive ? WINDOWS_SESSION_NAMES.find((pattern) => matchesPattern(name, pattern, true)) : undefined;
        let canonical = name;
        if (pattern !== undefined) canonical = pattern.endsWith('*') ? name.toUpperCase() : pattern;
        if (!Object.hasOwn(result, canonical)) result[canonical] = value;
      }
    }
    return result;
  };
  let base: Record<string, string>;
  let baseSource: RuntimeEnvironmentSource;
  if (policy.base === 'allowlist') {
    const patterns = allowlistPatterns(platform, policy.allow ?? []);
    base = admit(live, (name) => matchesAny(name, patterns, caseInsensitive));
    baseSource = 'allowlist';
  } else if (platform === 'win32') {
    const logon = input.windowsLogon;
    if (logon?.source === 'unavailable') throw new RuntimeEnvironmentUnavailableError('logon-registry-unavailable');
    if (logon?.source !== 'registry') throw new TypeError('a win32 login-shell runtime environment requires the logon registry values');
    base = {
      ...admit(live, (name) => !WINDOWS_LOGON_NAMES.has(name.toUpperCase()) && matchesAny(name, WINDOWS_SESSION_NAMES, caseInsensitive)),
      ...windowsLogonBase(logon, live),
    };
    baseSource = 'windows-session';
  } else {
    const status = input.snapshot?.status;
    if (status?.source === 'unavailable') throw new RuntimeEnvironmentUnavailableError(status.code);
    if (status?.source !== 'login-shell' || input.snapshot?.env === undefined) throw new TypeError('a login-shell runtime environment requires a captured snapshot');
    base = admit(input.snapshot.env, () => true);
    baseSource = 'login-shell';
  }
  const passPatterns = policy.pass ?? [];
  const passed = admit(live, (name) => matchesAny(name, passPatterns, caseInsensitive));
  // win32 names are case-insensitive, so a rule sees them in upper case and its exact-name triggers match any spelling.
  const removed = input.conflicts?.(new Set(Object.keys(passed).map((name) => caseInsensitive ? name.toUpperCase() : name))) ?? [];
  const env: Record<string, string> = {};
  const conflicted = new Set<string>();
  // win32 names are case-insensitive: a passed `PATH` replaces the base `Path`, never sits beside it.
  const passedNames = new Set(Object.keys(passed).map((name) => caseInsensitive ? name.toUpperCase() : name));
  for (const [name, value] of Object.entries(base)) {
    if (matchesAny(name, removed, caseInsensitive)) conflicted.add(name);
    else if (!passedNames.has(caseInsensitive ? name.toUpperCase() : name)) env[name] = value;
  }
  Object.assign(env, passed);
  const written = withLoopbackNoProxy(env, caseInsensitive);
  const sources = new Map<string, RuntimeEnvironmentSource>();
  for (const name of Object.keys(env)) sources.set(name, written.includes(name) ? 'sdk' : Object.hasOwn(passed, name) ? 'pass' : baseSource);
  const removals = new Map<string, RuntimeEnvironmentRemovalRule>();
  for (const name of conflicted) removals.set(name, 'conflict');
  for (const name of denied) removals.set(name, 'deny');
  const byName = (a: { name: string }, b: { name: string }): number => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return {
    env,
    report: {
      names: [...sources].map(([name, source]) => ({ name, source })).sort(byName),
      removed: [...removals].filter(([name]) => !Object.hasOwn(env, name)).map(([name, rule]) => ({ name, rule })).sort(byName),
    },
  };
}

/**
 * Merges every `NO_PROXY`/`no_proxy` entry plus the loopback names into
 * both spellings, in place, and returns the names it wrote. win32 names are
 * case-insensitive, so it gets one `NO_PROXY`.
 */
function withLoopbackNoProxy(env: Record<string, string>, caseInsensitive: boolean): string[] {
  const keys = Object.keys(env).filter((name) => caseInsensitive ? name.toUpperCase() === 'NO_PROXY' : name === 'NO_PROXY' || name === 'no_proxy');
  const entries: string[] = [];
  for (const key of keys) {
    for (const entry of env[key]!.split(',').map((part) => part.trim())) {
      if (entry.length > 0 && !entries.includes(entry)) entries.push(entry);
    }
    delete env[key];
  }
  for (const entry of LOOPBACK_NO_PROXY) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  const value = entries.join(',');
  env.NO_PROXY = value;
  if (caseInsensitive) return ['NO_PROXY'];
  env.no_proxy = value;
  return ['NO_PROXY', 'no_proxy'];
}

/**
 * The environment every child process of a task receives under `policy`, and
 * its report, from this process's login-shell snapshot or, on win32, its
 * logon registry values (each read on first use) and the live `process.env`.
 * Throws {@link RuntimeEnvironmentUnavailableError} when `login-shell` has
 * nothing to build from.
 */
export async function buildRuntimeEnvironment(policy: RuntimeEnvironmentPolicy, conflicts?: RuntimeEnvironmentConflictRule): Promise<RuntimeEnvironment> {
  const shell = policy.base !== 'allowlist';
  const snapshot = shell && process.platform !== 'win32' ? await loginShellSnapshot() : undefined;
  const windowsLogon = shell && process.platform === 'win32' ? await windowsLogonRegistry() : undefined;
  return composeRuntimeEnvironment({
    policy,
    live: process.env,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(windowsLogon === undefined ? {} : { windowsLogon }),
    ...(conflicts === undefined ? {} : { conflicts }),
  });
}

function allowlistPatterns(platform: NodeJS.Platform, allow: readonly string[]): readonly string[] {
  return [...BASE_PLATFORM_ALLOWLIST, ...(platform === 'win32' ? WINDOWS_BASE_ALLOWLIST : []), ...allow];
}

/**
 * The platform baseline plus `options.allow`, minus the hard deny (see this
 * module's own doc comment for its callers).
 */
export function buildAllowlistedEnv(options: BuildAllowlistedEnvOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const allowPatterns = allowlistPatterns(platform, options.allow ?? []);
  return copyAdmitted(options.ambient, platform, (name, caseInsensitive) => matchesAny(name, allowPatterns, caseInsensitive));
}
