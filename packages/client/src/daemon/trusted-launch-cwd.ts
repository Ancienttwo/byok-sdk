import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { clientPackageRoot } from '../adapters/pi/client-manifest';
import type { McpStdioServerConfig } from '../types';

/**
 * The working directory an MCP toolset SERVER child is launched in, and why it
 * is not the Agent home.
 *
 * A `bun --compile` single-file binary reads `$cwd/bunfig.toml` and runs its
 * `preload` entries BEFORE any of the program's own code — verified on
 * Bun 1.4.2, and `--config=/dev/null` does not suppress it for a compiled
 * binary (it suppresses it only for the bare interpreter, because the flag
 * reaches the program's argv rather than the runtime). The only control point
 * is therefore the child's cwd.
 *
 * Until this module existed, every MCP toolset server child inherited the
 * canonical Agent home as its cwd — a directory the agent's own tools write to
 * by design. Any compiled server binary (Salesko's `salesko-agent mcp serve`
 * is one) could be handed arbitrary preload code by the agent it is supposed
 * to be serving.
 *
 * The RUNTIME process (the pi/claude/codex CLI itself) keeps the manifest cwd:
 * session resume and relative-path resolution depend on it, and it is not the
 * thing this boundary is about.
 *
 * Non-writability is PROVEN, never assumed from a mode bit: `resolve` attempts
 * to create a file in the candidate and requires the attempt to fail with
 * `EACCES`/`EPERM`/`EROFS`. A candidate that accepts the write is rejected
 * (and the probe file removed) even if its permissions looked right — mode
 * bits do not account for ACLs, for the effective uid, or for a filesystem
 * that was remounted read-write.
 *
 * The probe alone is not the boundary, because both of its premises are things
 * this uid can change:
 *
 * - A directory OWNED by this uid answers the probe with `EACCES` while its
 *   owner remains free to `chmod` it writable first. Ownership by another uid
 *   (root, for the intended immutable versioned release directory) is therefore
 *   required, not just a cleared write bit.
 * - `rename(2)` replaces a directory using write permission on its PARENT.
 *   A root-owned 0555 directory sitting inside a directory this uid can write
 *   is a directory this uid can swap out wholesale. So every ancestor up to the
 *   volume root is put through the identical check.
 *
 * WHAT DOES THE CHDIR, on each platform:
 *
 * - POSIX (darwin, linux): the trusted system `/bin/sh`, run as
 *   `sh -c 'cd -- "$0" && exec "$@"' <dir> <command> [...args]`. The shell is
 *   already on the machine, is root-owned and not group/other-writable (both
 *   proven here, not assumed), reads no rc file for `-c`, and `exec`s so the
 *   runtime CLI's child IS the server. No Node host is required, which is the
 *   point: a daemon embedded in a `bun --compile` product executable has a
 *   trusted launcher without attesting anything.
 * - win32: this package's `bin/byok-launch-cwd.mjs`, which needs a real Node
 *   host. A host that is not plain Node (Bun, Deno, a single-executable
 *   application) and attests no interpreter is REFUSED, fail-closed. There is
 *   deliberately no Windows shell path: `cmd.exe` has no `exec`, and its
 *   quoting rules are not something a boundary should be built on.
 *
 * A launch-cwd PASS asserts WHERE the server starts. It does not assert that
 * the launcher or the executor is the binary it claims to be — that is the
 * separate attested-install work.
 */

/** Operator-supplied inputs to {@link resolveTrustedLaunchCwd}. Both fields are optional and both are validated. */
export interface McpLaunchCwdConfig {
  /**
   * An absolute directory to launch MCP toolset servers in, in preference to
   * the platform default. It must still pass every check below — a configured
   * directory is a preference, never an exemption.
   *
   * The intended value is an immutable, root-owned versioned release
   * directory. `os.tmpdir()` and anything else this daemon's own uid can write
   * is rejected by the write probe: the agent runs at that same uid in the
   * common deployment, so such a directory isolates other users and nothing
   * else.
   */
  readonly dir?: string;
  /**
   * ESCAPE HATCH, not a supported path. An absolute path to a Node executable
   * used to run this package's `bin/byok-launch-cwd.mjs` for the runtimes whose
   * MCP configuration cannot express a per-server cwd (claude, codex).
   *
   * The supported launchers need no configuration: POSIX bootstraps through the
   * trusted system `/bin/sh`, and win32 runs the shipped launcher script on a
   * real Node host. This field exists for the deployment that has neither and
   * can attest a Node binary of its own. A host that sets it takes on proving
   * the binary it names is one the agent's uid cannot replace — nothing here
   * can prove that for an arbitrary path.
   */
  readonly launcherInterpreter?: string;
}

/**
 * Why one candidate directory failed, independent of where the candidate came
 * from. `is_writable` is the one that matters most: it means the write probe
 * SUCCEEDED, so this uid can create files there and the directory isolates
 * nobody the agent is not already running as.
 */
export type LaunchCwdRejection =
  | 'not_absolute'
  | 'unreadable'
  | 'is_a_symlink'
  | 'not_a_directory'
  | 'is_writable'
  /**
   * The candidate is owned by the uid this daemon runs as. A mode bit is not a
   * boundary against its own owner: the agent, running at that same uid, can
   * `chmod` the directory writable and then plant `bunfig.toml` in it. Only an
   * owner OUTSIDE this uid (root, in the intended immutable-release shape) puts
   * the directory beyond the agent's reach.
   */
  | 'owned_by_current_uid'
  /**
   * An ancestor could not be inspected, is a symlink, is not a directory, is
   * owned by this uid, or accepted the write probe. Any of those lets this uid
   * `rename` the candidate out of the way and put its own directory at the same
   * path — the leaf's own mode never comes into it.
   */
  | 'ancestor_unreadable'
  | 'ancestor_is_a_symlink'
  | 'ancestor_not_a_directory'
  | 'ancestor_owned_by_current_uid'
  | 'ancestor_writable';

/**
 * `root_cannot_prove_write_boundary` is uid 0: no directory on the machine is
 * unwritable by this process, so the boundary cannot be proven at all. The
 * rest name which candidate was tried and how it failed.
 */
export type TrustedLaunchCwdUnavailableReason = 'root_cannot_prove_write_boundary'
| 'no_platform_default_directory' | `configured_dir_${LaunchCwdRejection}` | `platform_default_${LaunchCwdRejection}`;

export type TrustedLaunchCwd =
  | { readonly kind: 'resolved'; readonly dir: string }
  | { readonly kind: 'unavailable'; readonly reason: TrustedLaunchCwdUnavailableReason };

/** The three facts the POSIX launcher check reads off one path. */
export interface LaunchCwdShellStatEntry {
  readonly uid: number;
  /** The permission bits, as `st_mode` carries them. */
  readonly mode: number;
  readonly isFile: boolean;
}

/**
 * The `node:fs` calls {@link resolveMcpLaunchCwdLauncher} makes on the system
 * shell, as one injectable triple. Each call throws exactly as `fs` does when
 * the path cannot be inspected.
 */
export interface LaunchCwdShellStat {
  readonly lstat: (target: string) => LaunchCwdShellStatEntry;
  readonly stat: (target: string) => LaunchCwdShellStatEntry;
  readonly realpath: (target: string) => string;
}

function toShellStatEntry(stats: Stats): LaunchCwdShellStatEntry {
  return { uid: stats.uid, mode: stats.mode, isFile: stats.isFile() };
}

const realShellStat: LaunchCwdShellStat = Object.freeze({
  lstat: (target: string) => toShellStatEntry(lstatSync(target)),
  stat: (target: string) => toShellStatEntry(statSync(target)),
  realpath: (target: string) => realpathSync(target),
});

/** Seam for the tests that must run the uid-0 and filesystem branches without being root. */
export interface TrustedLaunchCwdEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly getuid?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The system shell the POSIX launcher bootstraps through. Defaults to
   * `/bin/sh` and is overridden only by tests, which point it at a shell built
   * to fail one specific trust check.
   */
  readonly systemShell?: string;
  /**
   * How the shell's ownership and mode are read. Defaults to real `node:fs`.
   * Injected by the tests that must exercise a root-owned-but-group-writable
   * shell, which a non-root test process cannot create on disk.
   */
  readonly shellStat?: LaunchCwdShellStat;
}

type CheckPrefix = 'configured_dir' | 'platform_default';

function unavailable(reason: TrustedLaunchCwdUnavailableReason): TrustedLaunchCwd {
  return Object.freeze({ kind: 'unavailable' as const, reason });
}

/**
 * Prove the current process cannot create a file in `dir`.
 *
 * `wx` is `O_WRONLY|O_CREAT|O_EXCL`, so this never truncates an existing file
 * and never collides with a concurrent probe. A probe that SUCCEEDS is the
 * failing case: the file is removed and the directory rejected.
 */
async function provesNonWritable(dir: string): Promise<boolean> {
  const probePath = path.join(dir, `.byok-launch-cwd-probe-${randomBytes(12).toString('hex')}`);
  let handle;
  try {
    handle = await fs.open(probePath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
  }
  await handle.close();
  await fs.unlink(probePath).catch(() => {});
  return false;
}

/**
 * Every ancestor of `dir` up to and including the volume root, nearest first.
 *
 * The leaf's own mode is only half the boundary: `rename(2)` needs write
 * permission on the PARENT, not on the directory being replaced, so a
 * 0555 root-owned leaf inside a directory this uid can write is a directory
 * this uid can swap for one of its own. The same argument applies one level up
 * for the parent, so the walk continues to the root.
 */
function ancestorsOf(dir: string): string[] {
  const ancestors: string[] = [];
  let current = path.dirname(dir);
  for (;;) {
    ancestors.push(current);
    const next = path.dirname(current);
    if (next === current) return ancestors;
    current = next;
  }
}

/**
 * The three facts every directory on the path has to satisfy: it is a real
 * directory (not a symlink whoever owns it can repoint), it is not owned by the
 * uid this daemon runs as, and this process cannot create a file in it.
 *
 * `currentUid` is `undefined` only where the platform has no uid at all
 * (Windows); the ownership half of the check is then skipped and the write
 * probe carries the boundary on its own.
 */
type PathComponentRejection = 'unreadable' | 'is_a_symlink' | 'not_a_directory' | 'owned_by_current_uid' | 'is_writable';

async function checkOnePathComponent(
  target: string,
  currentUid: number | undefined,
): Promise<PathComponentRejection | undefined> {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return 'unreadable';
  }
  // `lstat`, not `stat`: a symlink is rejected rather than followed. Whoever
  // can repoint the link chooses the cwd, which is the authority this module
  // exists to take away from them.
  if (stats.isSymbolicLink()) return 'is_a_symlink';
  if (!stats.isDirectory()) return 'not_a_directory';
  if (currentUid !== undefined && stats.uid === currentUid) return 'owned_by_current_uid';
  if (!(await provesNonWritable(target))) return 'is_writable';
  return undefined;
}

const ANCESTOR_REJECTION = Object.freeze({
  unreadable: 'ancestor_unreadable',
  is_a_symlink: 'ancestor_is_a_symlink',
  not_a_directory: 'ancestor_not_a_directory',
  owned_by_current_uid: 'ancestor_owned_by_current_uid',
  is_writable: 'ancestor_writable',
} as const satisfies Record<PathComponentRejection, LaunchCwdRejection>);

async function checkCandidate(
  dir: string,
  prefix: CheckPrefix,
  currentUid: number | undefined,
): Promise<TrustedLaunchCwd> {
  if (!path.isAbsolute(dir)) return unavailable(`${prefix}_not_absolute`);
  const leaf = await checkOnePathComponent(dir, currentUid);
  if (leaf !== undefined) return unavailable(`${prefix}_${leaf}`);
  for (const ancestor of ancestorsOf(dir)) {
    const rejection = await checkOnePathComponent(ancestor, currentUid);
    if (rejection === undefined) continue;
    // `not_absolute` cannot reach here — every ancestor of an absolute path is
    // absolute — so the map is total over what this loop can produce.
    return unavailable(`${prefix}_${ANCESTOR_REJECTION[rejection]}`);
  }
  return Object.freeze({ kind: 'resolved' as const, dir });
}

/**
 * The per-platform fallback when no directory is configured.
 *
 * POSIX: `/` — present on every POSIX system, owned by root, and mode 0755, so
 * no non-root uid can write it. Windows: `%SystemRoot%`, the same shape of
 * claim, still put through the same write probe rather than trusted for being
 * a system path.
 */
function platformDefault(environment: TrustedLaunchCwdEnvironment): string | undefined {
  const platform = environment.platform ?? process.platform;
  if (platform !== 'win32') return '/';
  const env = environment.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  return systemRoot === undefined || systemRoot.length === 0 ? undefined : systemRoot;
}

/**
 * Resolve the directory every MCP toolset server child of this daemon is
 * launched in, or state why no such directory could be proven.
 *
 * Not memoized: the whole result is one `lstat` plus one failed `open`, and a
 * cached "resolved" would keep asserting a boundary after the directory it
 * names was remounted, replaced, or chmodded.
 */
export async function resolveTrustedLaunchCwd(
  config?: McpLaunchCwdConfig,
  environment: TrustedLaunchCwdEnvironment = {},
): Promise<TrustedLaunchCwd> {
  // uid 0 first, before any candidate: root can write every directory on the
  // machine, so the probe below would reject each one in turn and report the
  // last candidate's shape instead of the real reason. This is a documented
  // limitation of running the daemon as root, not a default to be papered
  // over — the fix is the immutable-install work (§26), not a directory.
  const getuid = environment.getuid ?? process.getuid;
  const currentUid = getuid === undefined ? undefined : getuid.call(process);
  if (currentUid === 0) {
    return unavailable('root_cannot_prove_write_boundary');
  }
  if (config?.dir !== undefined) return checkCandidate(config.dir, 'configured_dir', currentUid);
  const fallback = platformDefault(environment);
  if (fallback === undefined) return unavailable('no_platform_default_directory');
  return checkCandidate(fallback, 'platform_default', currentUid);
}

// ---------------------------------------------------------------------------
// The launcher, for runtimes whose MCP configuration has no cwd field
// ---------------------------------------------------------------------------

/**
 * The POSIX bootstrap program, run as `sh -c <SCRIPT> <trustedCwd> <command>
 * [...args]`.
 *
 * `sh -c` assigns the first word after the program text to `$0` and the rest
 * to `$1...`, so `$0` is the trusted directory and `"$@"` is the target's argv
 * with no shell word splitting, no globbing and no quoting round trip: an
 * argument containing a space, a tab, a newline, a quote, `$(...)`, a backtick,
 * `*`, `;`, `&&`, `~` or non-ASCII bytes arrives byte-identical.
 *
 * `cd --` (rather than a bare `cd`) is what keeps a directory named `-L` or
 * `-P` from being read as an option. The target is reached through `exec`, so
 * the shell replaces itself and the runtime CLI's child IS the server: one
 * pid, signals and exit status pass through with nothing in between.
 *
 * `exec -- "$@"` is NOT used, and must not be: dash rejects it outright
 * (`exec: --: not found`, exit 127). The form below is the one verified on
 * dash 0.5.12, bash 5.2.37 invoked as `sh`, busybox ash, and macOS `/bin/sh`.
 *
 * `cd` is given an ABSOLUTE realpath by {@link wrapMcpServerWithLaunchCwd},
 * because a relative argument to `cd` is resolved through `CDPATH` — which is
 * why `CDPATH` (along with `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS` and
 * `PS4`) is in the loader deny list `daemon/environment.ts` enforces.
 */
export const MCP_LAUNCH_CWD_SHELL_SCRIPT = 'cd -- "$0" && exec "$@"';

/** The system shell, and the only shell this module will bootstrap through. */
const SYSTEM_SHELL_PATH = '/bin/sh';

/**
 * Why no trusted launcher could be produced for this host. Every one of these
 * refuses the offer: there is no fallback launcher, because every fallback
 * available here is one the agent's own uid could have written.
 */
export type McpLaunchCwdLauncherUnavailableReason =
  /**
   * win32 only: this process is not a plain Node that would run the launcher
   * script it is handed (Bun, Deno, or a single-executable application), and
   * the operator attested no interpreter. A compiled Bun host is the case that
   * matters — it would read `$cwd/bunfig.toml` and run its `preload` before the
   * launcher's own first statement, which is the exact vector this boundary
   * closes.
   */
  | 'launch_cwd_launcher_unavailable'
  /** POSIX: `/bin/sh` could not be inspected at all. */
  | 'launch_cwd_shell_unreadable'
  /** POSIX: `/bin/sh` resolves to something that is not a regular file. */
  | 'launch_cwd_shell_not_a_regular_file'
  /**
   * POSIX: `/bin/sh`, or the symlink standing at that path, is not owned by
   * root. A shell this uid owns is a shell the agent can replace, and the
   * bootstrap would then be running the agent's own program.
   */
  | 'launch_cwd_shell_not_root_owned'
  /** POSIX: `/bin/sh` is group- or world-writable, so its owner is not the only writer. */
  | 'launch_cwd_shell_writable';

/** A launcher that was resolved: which mechanism, what runs it, and what it runs. */
export type ResolvedMcpLaunchCwdLauncher =
  /** POSIX: `interpreter` is the realpath of the system shell, `script` is {@link MCP_LAUNCH_CWD_SHELL_SCRIPT}. */
  | { readonly kind: 'shell'; readonly interpreter: string; readonly script: string }
  /** win32: `interpreter` is a plain-Node executable, `script` is this package's `bin/byok-launch-cwd.mjs`. */
  | { readonly kind: 'node'; readonly interpreter: string; readonly script: string };

export type McpLaunchCwdLauncher =
  | ResolvedMcpLaunchCwdLauncher
  | { readonly kind: 'unavailable'; readonly reason: McpLaunchCwdLauncherUnavailableReason };

/** The shipped launcher script, resolved from this package's own root so it works from `dist/` and from source. */
export function launchCwdScriptPath(): string {
  return path.join(clientPackageRoot(), 'bin', 'byok-launch-cwd.mjs');
}

/**
 * `process.execPath`, but only when this process is provably a plain Node that
 * runs the script it is handed. win32 only — POSIX bootstraps through the
 * system shell and never needs a Node host at all.
 *
 * Bun is excluded because a compiled Bun binary executes `$cwd/bunfig.toml`
 * `preload` before user code. A single-executable-application Node is excluded
 * because it ignores a script argument entirely and runs its own embedded
 * entrypoint. Deno likewise is not this launcher's host.
 */
function plainNodeInterpreter(): string | undefined {
  const versions = process.versions as Record<string, string | undefined>;
  if (typeof versions.bun === 'string') return undefined;
  if (typeof versions.deno === 'string') return undefined;
  if (typeof versions.node !== 'string') return undefined;
  try {
    const sea = createRequire(import.meta.url)('node:sea') as { isSea?: () => boolean };
    if (sea.isSea?.() === true) return undefined;
  } catch {
    // No `node:sea` on this runtime means no SEA on this runtime.
  }
  return process.execPath;
}

function launcherUnavailable(reason: McpLaunchCwdLauncherUnavailableReason): McpLaunchCwdLauncher {
  return Object.freeze({ kind: 'unavailable' as const, reason });
}

/**
 * Prove the shell at `shellPath` is one only root can have written.
 *
 * `/bin/sh` is a symlink on most Linux distributions (dash, or busybox), so the
 * checks run on the realpath — and the symlink standing at the path is checked
 * for root ownership too, because whoever owns the link chooses the target.
 *
 * Deliberately NOT checked: the darwin `SF_RESTRICTED` (SIP) flag. `/bin/sh` on
 * this platform does carry it (`ls -lO` reports `restricted`), but Node's
 * `fs.Stats` has no `st_flags` field at all — `'flags' in fs.statSync('/bin/sh')`
 * is `false` on darwin — so there is nothing to read without a native addon.
 * Asserting a flag this process cannot observe would be a check that always
 * passed, which is worse than no check; the root-ownership and write-bit proofs
 * here are what carry the boundary on darwin.
 */
function checkSystemShell(
  shellPath: string,
  stat: LaunchCwdShellStat,
): McpLaunchCwdLauncherUnavailableReason | { readonly realpath: string } {
  let link;
  let realpath: string;
  let target;
  try {
    link = stat.lstat(shellPath);
    realpath = stat.realpath(shellPath);
    target = stat.stat(realpath);
  } catch {
    return 'launch_cwd_shell_unreadable';
  }
  if (link.uid !== 0) return 'launch_cwd_shell_not_root_owned';
  if (!target.isFile) return 'launch_cwd_shell_not_a_regular_file';
  if (target.uid !== 0) return 'launch_cwd_shell_not_root_owned';
  // Group/other write. The owner's own write bit is not a finding: the owner is
  // root, which is the trust anchor this check establishes in the first place.
  if ((target.mode & 0o022) !== 0) return 'launch_cwd_shell_writable';
  return { realpath };
}

export function resolveMcpLaunchCwdLauncher(
  config?: McpLaunchCwdConfig,
  environment: TrustedLaunchCwdEnvironment = {},
): McpLaunchCwdLauncher {
  const platform = environment.platform ?? process.platform;
  const configured = config?.launcherInterpreter;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured) || /[\u0000\r\n]/u.test(configured)) {
      throw new Error('McpLaunchCwdConfig.launcherInterpreter must be an absolute executable path');
    }
    // The operator's escape hatch, and the one input this module does not
    // second-guess: an attested interpreter runs the shipped launcher script on
    // both platforms. It is not the supported path and the documentation does
    // not present it as one.
    return Object.freeze({ kind: 'node' as const, interpreter: configured, script: launchCwdScriptPath() });
  }
  if (platform === 'win32') {
    const interpreter = plainNodeInterpreter();
    if (interpreter === undefined) return launcherUnavailable('launch_cwd_launcher_unavailable');
    return Object.freeze({ kind: 'node' as const, interpreter, script: launchCwdScriptPath() });
  }
  const shellPath = environment.systemShell ?? SYSTEM_SHELL_PATH;
  const checked = checkSystemShell(shellPath, environment.shellStat ?? realShellStat);
  if (typeof checked === 'string') return launcherUnavailable(checked);
  return Object.freeze({
    kind: 'shell' as const,
    interpreter: checked.realpath,
    script: MCP_LAUNCH_CWD_SHELL_SCRIPT,
  });
}

/** What the daemon resolved once per offer and every adapter of that offer launches through. */
export interface McpLaunchBinding {
  /** The proven non-writable directory every MCP toolset server child starts in. */
  readonly cwd: string;
  /** Present only for adapters whose MCP configuration cannot carry a cwd. */
  readonly launcher?: ResolvedMcpLaunchCwdLauncher;
}

/**
 * Rewrite one server's `command`/`args` so the child reaches its real
 * executable already chdir'd into the trusted directory.
 *
 * argv is passed through structurally — no shell word splitting, no quoting,
 * no concatenation — so a server argument containing a space, a quote,
 * `$(...)`, a semicolon or a newline arrives byte-identical. The `shell`
 * launcher runs a fixed program text that never interpolates an argument into
 * itself; the arguments reach it as positional parameters.
 *
 * `env` is carried through untouched: it is the server's own task-scoped
 * authority and the launcher is not a place to edit it.
 *
 * Three refusals, all fail-closed, all specific to the fact that a shell now
 * stands between the runtime and the server:
 *
 * - A relative `cwd` would be resolved by `cd` through `CDPATH`, so the
 *   directory the boundary names must be absolute.
 * - A `command` starting with `-` would be read by `exec` as one of ITS own
 *   options rather than as the program to run.
 * - A relative `command` is a PATH lookup performed after the chdir, which is
 *   not the identity the binding attested. It is not resolved here — this
 *   module does not own a PATH lookup and is not the place to invent one — so
 *   it is refused.
 *
 * The last two are this wrapper's OWN boundary assertion, standing behind the
 * registry rule rather than substituting for it: `./toolset-registry.ts` already
 * refuses a non-absolute or option-like `command` at load, so an operator's
 * configuration can never reach here carrying one. These stay because this
 * function also wraps commands the registry never saw — the SDK's reserved
 * helpers — and because a wrapper that quietly launched whatever it was handed
 * would make the earlier rule the only thing holding the boundary up.
 */
export function wrapMcpServerWithLaunchCwd(
  server: Readonly<McpStdioServerConfig>,
  binding: McpLaunchBinding & { readonly launcher: ResolvedMcpLaunchCwdLauncher },
): McpStdioServerConfig {
  if (!path.isAbsolute(binding.cwd)) {
    throw new Error(`launch_cwd_binding_cwd_not_absolute: ${JSON.stringify(binding.cwd)}`);
  }
  if (server.command.startsWith('-')) {
    throw new Error(`launch_cwd_target_command_option_like: ${JSON.stringify(server.command)}`);
  }
  if (!path.isAbsolute(server.command)) {
    throw new Error(`launch_cwd_target_command_not_absolute: ${JSON.stringify(server.command)}`);
  }
  const args = binding.launcher.kind === 'shell'
    ? ['-c', binding.launcher.script, binding.cwd, server.command, ...(server.args ?? [])]
    : [binding.launcher.script, binding.cwd, server.command, ...(server.args ?? [])];
  return Object.freeze({
    command: binding.launcher.interpreter,
    args: Object.freeze(args),
    ...(server.env === undefined ? {} : { env: Object.freeze({ ...server.env }) }),
  });
}

/**
 * The identity of the launch path, as a value a fingerprint can bind.
 *
 * Deliberately NOT folded into the toolset's `definitionRevision`
 * (`./toolset-registry.ts`): that digest is the operator's configured intent —
 * the `command`/`args` they wrote and the read/mutation classification they
 * declared. An SDK launcher upgrade is not a change to their configuration,
 * and making it one would churn every stored revision on every SDK release.
 * It is drift of a different fact, so it is bound as a different fact.
 *
 * `kind` is part of the bound value: a shell bootstrap and a Node launcher are
 * different launch mechanisms and must never fingerprint equal, even in the
 * degenerate case where they were handed the same two strings.
 */
export interface McpLaunchAttestation {
  readonly launchCwd: string;
  readonly launcher: ResolvedMcpLaunchCwdLauncher | null;
}

export function mcpLaunchAttestation(binding: McpLaunchBinding): McpLaunchAttestation {
  const launcher = binding.launcher;
  return Object.freeze({
    launchCwd: binding.cwd,
    launcher: launcher === undefined
      ? null
      : Object.freeze({ ...launcher }),
  });
}
