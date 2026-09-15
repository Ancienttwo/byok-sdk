import { randomBytes } from 'node:crypto';
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
   * Absolute path to a Node executable used to run this package's
   * `bin/byok-launch-cwd.mjs` for the runtimes whose MCP configuration cannot
   * express a per-server cwd (claude, codex).
   *
   * There is no default when this process is not itself plain Node. A daemon
   * embedded in a `bun --compile` product executable (Salesko's compiled
   * `salesko-agent` is one) must NOT run the launcher on `process.execPath`:
   * Bun would read `$cwd/bunfig.toml` and run its `preload` before the
   * launcher's own first statement, which is the exact vector this boundary
   * closes. Such a deployment has to attest a real Node binary here, or those
   * runtimes are refused a toolset rather than served an unprotected one.
   */
  readonly launcherInterpreter?: string;
}

/**
 * Why one candidate directory failed, independent of where the candidate came
 * from. `is_writable` is the one that matters most: it means the write probe
 * SUCCEEDED, so this uid can create files there and the directory isolates
 * nobody the agent is not already running as.
 */
export type LaunchCwdRejection = 'not_absolute' | 'unreadable' | 'is_a_symlink' | 'not_a_directory' | 'is_writable';

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

/** Seam for the tests that must run the uid-0 and filesystem branches without being root. */
export interface TrustedLaunchCwdEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly getuid?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
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

async function checkCandidate(dir: string, prefix: CheckPrefix): Promise<TrustedLaunchCwd> {
  if (!path.isAbsolute(dir)) return unavailable(`${prefix}_not_absolute`);
  let stats;
  try {
    stats = await fs.lstat(dir);
  } catch {
    return unavailable(`${prefix}_unreadable`);
  }
  // `lstat`, not `stat`: a symlink is rejected rather than followed. Whoever
  // can repoint the link chooses the cwd, which is the authority this module
  // exists to take away from them.
  if (stats.isSymbolicLink()) return unavailable(`${prefix}_is_a_symlink`);
  if (!stats.isDirectory()) return unavailable(`${prefix}_not_a_directory`);
  if (!(await provesNonWritable(dir))) return unavailable(`${prefix}_is_writable`);
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
  if (getuid !== undefined && getuid.call(process) === 0) {
    return unavailable('root_cannot_prove_write_boundary');
  }
  if (config?.dir !== undefined) return checkCandidate(config.dir, 'configured_dir');
  const fallback = platformDefault(environment);
  if (fallback === undefined) return unavailable('no_platform_default_directory');
  return checkCandidate(fallback, 'platform_default');
}

// ---------------------------------------------------------------------------
// The launcher, for runtimes whose MCP configuration has no cwd field
// ---------------------------------------------------------------------------

export type McpLaunchCwdLauncherUnavailableReason = 'launch_cwd_launcher_interpreter_unconfigured';

export type McpLaunchCwdLauncher =
  | { readonly kind: 'resolved'; readonly interpreter: string; readonly script: string }
  | { readonly kind: 'unavailable'; readonly reason: McpLaunchCwdLauncherUnavailableReason };

/**
 * `process.execPath`, but only when this process is provably a plain Node
 * that runs the script it is handed.
 *
 * Bun is excluded because a compiled Bun binary executes `$cwd/bunfig.toml`
 * `preload` before user code — using it to run the launcher would reintroduce
 * the vector inside the mitigation. A single-executable-application Node is
 * excluded because it ignores a script argument entirely and runs its own
 * embedded entrypoint. Deno likewise is not this launcher's host.
 */
function defaultLauncherInterpreter(): string | undefined {
  const versions = process.versions as Record<string, string | undefined>;
  if (typeof versions.bun === 'string') return undefined;
  if (typeof versions.deno === 'string') return undefined;
  if (typeof versions.node !== 'string') return undefined;
  // `process.execPath` of a single-executable-application build is the product
  // binary, which ignores a script argument and runs its own embedded entry.
  try {
    const sea = createRequire(import.meta.url)('node:sea') as { isSea?: () => boolean };
    if (sea.isSea?.() === true) return undefined;
  } catch {
    // No `node:sea` on this runtime means no SEA on this runtime.
  }
  return process.execPath;
}

/** The shipped launcher script, resolved from this package's own root so it works from `dist/` and from source. */
export function launchCwdScriptPath(): string {
  return path.join(clientPackageRoot(), 'bin', 'byok-launch-cwd.mjs');
}

export function resolveMcpLaunchCwdLauncher(config?: McpLaunchCwdConfig): McpLaunchCwdLauncher {
  const configured = config?.launcherInterpreter;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured) || /[\u0000\r\n]/u.test(configured)) {
      throw new Error('McpLaunchCwdConfig.launcherInterpreter must be an absolute executable path');
    }
    return Object.freeze({ kind: 'resolved' as const, interpreter: configured, script: launchCwdScriptPath() });
  }
  const fallback = defaultLauncherInterpreter();
  if (fallback === undefined) {
    return Object.freeze({
      kind: 'unavailable' as const,
      reason: 'launch_cwd_launcher_interpreter_unconfigured' as const,
    });
  }
  return Object.freeze({ kind: 'resolved' as const, interpreter: fallback, script: launchCwdScriptPath() });
}

/** What the daemon resolved once per offer and every adapter of that offer launches through. */
export interface McpLaunchBinding {
  /** The proven non-writable directory every MCP toolset server child starts in. */
  readonly cwd: string;
  /** Present only for adapters whose MCP configuration cannot carry a cwd. */
  readonly launcher?: { readonly interpreter: string; readonly script: string };
}

/**
 * Rewrite one server's `command`/`args` so the child reaches its real
 * executable already chdir'd into the trusted directory.
 *
 * argv is passed through structurally — no shell, no quoting, no
 * concatenation — so a server argument containing a space, a quote, `$(...)`,
 * a semicolon or a newline arrives byte-identical.
 *
 * `env` is carried through untouched: it is the server's own task-scoped
 * authority and the launcher is not a place to edit it.
 */
export function wrapMcpServerWithLaunchCwd(
  server: Readonly<McpStdioServerConfig>,
  binding: McpLaunchBinding & { readonly launcher: { readonly interpreter: string; readonly script: string } },
): McpStdioServerConfig {
  return Object.freeze({
    command: binding.launcher.interpreter,
    args: Object.freeze([
      binding.launcher.script,
      binding.cwd,
      server.command,
      ...(server.args ?? []),
    ]),
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
 */
export interface McpLaunchAttestation {
  readonly launchCwd: string;
  readonly launcher: { readonly interpreter: string; readonly script: string } | null;
}

export function mcpLaunchAttestation(binding: McpLaunchBinding): McpLaunchAttestation {
  return Object.freeze({
    launchCwd: binding.cwd,
    launcher: binding.launcher === undefined
      ? null
      : Object.freeze({ interpreter: binding.launcher.interpreter, script: binding.launcher.script }),
  });
}
