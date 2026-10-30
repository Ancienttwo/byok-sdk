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
 *   shell, the base is {@link WINDOWS_SESSION_NAMES} from the live session
 *   environment.
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
 * baseline plus the names Windows itself sets for a logon session.
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
 * `NO_PROXY`/`no_proxy` this module writes.
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

/** The login-shell capture failed, so no `login-shell` runtime environment exists in this process. */
export class RuntimeEnvironmentUnavailableError extends Error {
  readonly code = 'runtime_environment_unavailable' as const;
  constructor(readonly reason: ServiceEnvironmentUnavailableCode) {
    super(`runtime environment unavailable: the login-shell capture failed (${reason})`);
    this.name = 'RuntimeEnvironmentUnavailableError';
  }
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
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined || !admitted(name)) continue;
      if (matchesAny(name, HARD_DENY_PATTERNS, caseInsensitive)) denied.add(name);
      else result[name] = value;
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
    base = admit(live, (name) => matchesAny(name, WINDOWS_SESSION_NAMES, caseInsensitive));
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
  for (const [name, value] of Object.entries(base)) {
    if (matchesAny(name, removed, caseInsensitive)) conflicted.add(name);
    else env[name] = value;
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
 * its report, from this process's login-shell snapshot (captured on first
 * use) and the live `process.env`. Throws
 * {@link RuntimeEnvironmentUnavailableError} when `login-shell` has no
 * snapshot to build from.
 */
export async function buildRuntimeEnvironment(policy: RuntimeEnvironmentPolicy, conflicts?: RuntimeEnvironmentConflictRule): Promise<RuntimeEnvironment> {
  const snapshot = policy.base === 'allowlist' || process.platform === 'win32' ? undefined : await loginShellSnapshot();
  return composeRuntimeEnvironment({ policy, live: process.env, ...(snapshot === undefined ? {} : { snapshot }), ...(conflicts === undefined ? {} : { conflicts }) });
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
