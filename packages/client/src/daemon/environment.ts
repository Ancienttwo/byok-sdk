/**
 * M5: per-runtime environment allowlist for spawned agent child processes.
 *
 * Before this module existed, `task-runner.ts` built every task's
 * `TaskContext.env` as `process.env` verbatim — the daemon's OWN full
 * environment, unfiltered, handed to whichever runtime CLI (`pi`/`claude`/
 * `codex`) `pickAdapter` selected. Any credential-shaped variable sitting in
 * the daemon's own environment for a completely unrelated reason (an
 * `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, `GITHUB_TOKEN` set for the
 * daemon's OWN deployment, nothing to do with any coding-agent runtime) was
 * therefore inherited by every single spawned agent process — a
 * credential-leak gap, not a deliberate design choice.
 *
 * {@link buildRuntimeEnv} replaces that blanket passthrough with an explicit
 * allowlist, built fresh per task from three layers:
 *
 * 1. A small, always-included platform baseline ({@link BASE_PLATFORM_ALLOWLIST}
 *    / {@link WINDOWS_BASE_ALLOWLIST}) — the bare minimum any CLI needs to
 *    resolve its own binaries/libraries, find a home/temp directory, and
 *    behave sanely in a non-interactive shell.
 * 2. Whatever ADDITIONAL names the *specific* runtime adapter about to be
 *    spawned declares it actually needs
 *    (`RuntimeAdapter.environmentRequirements()` — see `../types.ts`). An
 *    adapter that declares nothing at all (doesn't implement the optional
 *    method) gets the platform baseline ONLY — fail-closed by construction,
 *    not by an extra check here.
 * 3. A per-device, per-runtime operator override (`DaemonConfig
 *    .runtimeEnvironment` — see `create-daemon.ts`) — a local escape hatch
 *    for a product/operator that knows it needs one more variable forwarded
 *    to one specific runtime on this one device.
 *
 * One hard, unconditional deny always wins over all three layers above,
 * including the operator's own override: `BYOK_*`, this SDK's own
 * control-plane variables, must never reach a spawned agent process — see
 * {@link HARD_DENY_PATTERNS}.
 *
 * Every name in every list may be an exact match or a `*`-suffixed prefix
 * (e.g. `'LC_*'` matches `LC_ALL`, `LC_CTYPE`, ...).
 */

/**
 * What one runtime adapter declares it needs beyond the always-included
 * platform baseline. Returned from the optional
 * `RuntimeAdapter.environmentRequirements()` method (`../types.ts`).
 */
export interface RuntimeEnvironmentRequirements {
  /**
   * Extra non-secret, config-discovery-shaped variable names this runtime's
   * own CLI reads (e.g. a `<RUNTIME>_CONFIG_DIR`-style override) — anything
   * that isn't itself a credential. Optional: most adapters need nothing
   * beyond the platform baseline.
   */
  baseNames?: readonly string[];
  /**
   * Credential/auth variable names this runtime's own CLI reads to
   * authenticate (e.g. a provider API key). Kept as its own field (distinct
   * from `baseNames`) so a product's own security review can reason about
   * "what credential-shaped names does this runtime get" as a single,
   * explicit list per adapter — see e.g. the pi adapter's
   * `KNOWN_PROVIDER_ENV_VARS`.
   */
  credentialNames?: readonly string[];
}

/** Inputs to {@link buildRuntimeEnv}. */
export interface BuildRuntimeEnvOptions {
  /**
   * The daemon's own ambient environment (normally `process.env`). Never
   * mutated — every returned variable is copied into a fresh object.
   */
  ambient: NodeJS.ProcessEnv;
  /**
   * The selected runtime adapter's own declared requirements —
   * `undefined` (no `environmentRequirements()` implementation on that
   * adapter) means "platform baseline only," fail-closed.
   */
  requirements?: RuntimeEnvironmentRequirements;
  /**
   * This device's own operator-configured escape hatch for this one runtime
   * (`DaemonConfig.runtimeEnvironment?.[adapterId]?.allow`) — merged in like
   * any other allowlist entry, still subject to the hard deny below.
   */
  locallyAllowedNames?: readonly string[];
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
 * spelling, some check both), not gated behind any adapter's own
 * `environmentRequirements()`: an agent CLI spawned behind a corporate proxy
 * with none of these forwarded silently loses all outbound network access —
 * a materially worse default than forwarding a proxy URL. See
 * docs/security.md's environment-allowlist section for the accepted
 * trade-off this implies (a proxy URL may itself embed proxy credentials).
 */
const BASE_PLATFORM_ALLOWLIST: readonly string[] = [
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

/** Additional always-included names on win32 only — see {@link BuildRuntimeEnvOptions.platform}. */
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
 * Hard deny — wins unconditionally over every allowlist layer above (the
 * platform baseline, an adapter's own declared requirements, AND the
 * operator's own local override): this SDK's own control-plane variables
 * must never reach a spawned agent process, full stop. A product embedding
 * this SDK cannot accidentally (or deliberately, via
 * `runtimeEnvironment.<id>.allow`) punch a hole in this. Checked LAST in
 * {@link buildRuntimeEnv}'s per-variable decision, deliberately: it must be
 * the final word on every single variable, never short-circuited past by an
 * earlier allow match.
 */
const HARD_DENY_PATTERNS: readonly string[] = ['BYOK_*'];

/**
 * F1: `caseInsensitive` is `true` only on win32 (see {@link buildRuntimeEnv}).
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

/**
 * Build the environment one specific runtime's spawned child process should
 * actually receive — a fresh object, never `options.ambient` itself and
 * never mutated in place. See this module's own doc comment for the full
 * allow/deny model.
 */
export function buildRuntimeEnv(options: BuildRuntimeEnvOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  // F1: win32 only — see `matchesPattern`'s own doc comment for why OS-cased
  // keys make case-sensitive matching silently wrong there specifically.
  // Every other platform keeps exact case-sensitive matching, unchanged.
  const caseInsensitive = platform === 'win32';
  const allowPatterns: readonly string[] = [
    ...BASE_PLATFORM_ALLOWLIST,
    ...(platform === 'win32' ? WINDOWS_BASE_ALLOWLIST : []),
    ...(options.requirements?.baseNames ?? []),
    ...(options.requirements?.credentialNames ?? []),
    ...(options.locallyAllowedNames ?? []),
  ];

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.ambient)) {
    if (value === undefined) continue;
    // Deny checked LAST, deliberately (see HARD_DENY_PATTERNS's own doc
    // comment) — this must be the final word on every single variable. Also
    // case-insensitive on win32 (F1): a mixed-case `Byok_Secret` must be
    // denied there exactly as `BYOK_SECRET` is denied everywhere else — the
    // operator's own local override must not be able to punch a hole in the
    // hard deny just because win32 happened to hand back different casing.
    if (matchesAny(name, allowPatterns, caseInsensitive) && !matchesAny(name, HARD_DENY_PATTERNS, caseInsensitive)) {
      result[name] = value;
    }
  }
  return result;
}
