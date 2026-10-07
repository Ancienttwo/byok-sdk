import { LOADER_ENV_DENY_PATTERNS } from '@byok-sdk/implementation-identity';
export { LOADER_ENV_DENY_PATTERNS, loaderEnvInjections } from '@byok-sdk/implementation-identity';

/**
 * The environment of every child process of a task: the runtime CLI and the
 * MCP servers the daemon probes for it.
 *
 * {@link buildRuntimeEnv} inherits the daemon's full environment, as OAR
 * does. The user's own agent reads its own configuration and credentials from
 * it. Only three groups of names are removed:
 *
 * - `CLAUDECODE`: Claude Code sets it inside its own sessions. OAR removes
 *   it so that a child agent starts as its own top-level session.
 * - `BYOK_*`: this SDK's own control-plane variables (key custody).
 * - Loader injection names ({@link LOADER_ENV_DENY_PATTERNS}). The trusted
 *   MCP launch directory depends on them being absent.
 *
 * {@link buildAllowlistedEnv} is the narrow form. Only the Pi custody lanes
 * use it: the durable Pi tool shell, the prepared Pi lane and the
 * external-CLI custody baseline.
 *
 * Every name in every list may be an exact match or a `*`-suffixed prefix
 * (e.g. `'LC_*'` matches `LC_ALL`, `LC_CTYPE`, ...).
 */

/** Inputs to {@link buildAllowlistedEnv}. */
export interface BuildAllowlistedEnvOptions {
  /**
   * The ambient environment (normally `process.env`). Never mutated — every
   * returned variable is copied into a fresh object.
   */
  ambient: NodeJS.ProcessEnv;
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
 * docs/security.md's environment-allowlist section for the accepted
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
 * Hard deny. It wins over every allow entry and applies to both builders. It
 * is checked LAST in the per-variable decision, so no allow match can skip
 * it.
 */
const HARD_DENY_PATTERNS: readonly string[] = [
  'CLAUDECODE',
  'BYOK_*',
  // Loader injection. These change how an interpreter LOADS code, before the
  // first statement of whatever it was asked to run — including this SDK's own
  // `bin/byok-launch-cwd.mjs`, whose entire job is to establish a trusted cwd
  // before a server binary starts. See `./trusted-launch-cwd.ts`.
  ...LOADER_ENV_DENY_PATTERNS,
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
  ambient: NodeJS.ProcessEnv,
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
 * The environment every child process of a task receives: the full ambient
 * environment minus the hard deny. A fresh object; `ambient` is never
 * mutated.
 */
export function buildRuntimeEnv(
  options: { ambient: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Record<string, string> {
  return copyAdmitted(options.ambient, options.platform ?? process.platform, () => true);
}

/**
 * The platform baseline plus `options.allow`, minus the hard deny. Only the
 * Pi custody lanes use it (see this module's own doc comment).
 */
export function buildAllowlistedEnv(options: BuildAllowlistedEnvOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const allowPatterns: readonly string[] = [
    ...BASE_PLATFORM_ALLOWLIST,
    ...(platform === 'win32' ? WINDOWS_BASE_ALLOWLIST : []),
    ...(options.allow ?? []),
  ];
  return copyAdmitted(options.ambient, platform, (name, caseInsensitive) => matchesAny(name, allowPatterns, caseInsensitive));
}
