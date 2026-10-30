import { SERVICE_FLAG } from './service-environment';
import type { ServiceLogReport } from './service-log';
import type { ServiceRepairResult, ServiceUnitInspection } from './service-unit';

/**
 * What the stable launcher executes (#1097). The unit never names it: on
 * macOS and Linux the unit runs `<storeDir>/service/<name>.launcher.sh`,
 * which execs this program; on Windows the SCM runs the installed WinSW
 * executable, whose descriptor names it. Changing the program rewrites the
 * launcher, never the unit's own path or arguments.
 *
 * `command` should be absolute: a bare name resolves against the service
 * manager's minimal PATH, which rarely includes nvm/volta/homebrew Node.
 */
export interface ServiceProgram {
  command: string;
  /**
   * Args passed verbatim to `command` — e.g. `[agentBinPath, 'start',
   * '--config', configPath]` for a plain node + script run (see
   * {@link nodeAgentProgram}), or `['start', '--config', configPath]` alone
   * if `command` is already a self-contained bundled binary (see
   * `templates/packaging/`). Every platform generator passes these through
   * untouched — `winsw.ts` emits one `<argument>` element per entry rather
   * than a single shell-quoted string specifically so a path containing
   * spaces never needs manual escaping (see that file's doc comment).
   *
   * The lifecycles never add or change an argument: a Host's own binary
   * gets exactly these. Issues #392/#394: `byok-agent install` builds its
   * program with {@link NodeAgentProgramOptions.service} on every platform.
   */
  args: string[];
  /** Working directory for the running service process; the launcher `cd`s into it. Default: the user's home (macOS, Linux), the WinSW install directory (Windows). */
  cwd?: string;
}

export interface NodeAgentProgramOptions {
  /** Absolute path to the `byok-agent` entry script to run. No auto-detection — see `create-service-lifecycle.ts`'s doc comment. */
  agentBin: string;
  /** Absolute path to the JSON config file `byok-agent start` should load — resolve this to an absolute path BEFORE calling, since the service will run with the OS service manager's own cwd, not the caller's. */
  configPath: string;
  /** Node executable to invoke `agentBin` with. Defaults to `process.execPath` (the currently running node) — always an absolute, real path, unlike a bare `node` on PATH. */
  nodeBin?: string;
  cwd?: string;
  /**
   * Append {@link SERVICE_FLAG}: `byok-agent start` then replaces the service
   * manager's minimal environment with the user's login-shell environment
   * (issue #392, `service-environment.ts`; win32 has none) and exits 0 on a
   * halt, so the supervisor does not restart it (issue #394). For a program
   * a service manager will run; `byok-agent install` sets it on every
   * platform.
   */
  service?: boolean;
}

/**
 * Convenience builder for the common case: run `node <agentBin> start
 * --config <configPath>` as the service's program. Still requires the
 * caller to supply an absolute `agentBin` — this helper is a formatting
 * convenience only, not a resolution mechanism.
 */
export function nodeAgentProgram(opts: NodeAgentProgramOptions): ServiceProgram {
  const program: ServiceProgram = {
    command: opts.nodeBin ?? process.execPath,
    args: [opts.agentBin, 'start', '--config', opts.configPath, ...(opts.service === true ? [SERVICE_FLAG] : [])],
  };
  if (opts.cwd !== undefined) program.cwd = opts.cwd;
  return program;
}

export interface ServiceDefinition {
  /** Stable service identifier — becomes the launchd `Label`, the systemd unit's basename, and the WinSW `<id>` (sanitized per-platform via {@link sanitizeServiceName}). Typically `DaemonConfig.productId`. */
  name: string;
  /** Human-readable display name — systemd `Description=`, WinSW `<name>`/`<description>`. Defaults to `name` if omitted. */
  displayName?: string;
  /** What the launcher runs — see {@link ServiceProgram}. */
  program: ServiceProgram;
  /** The product's SDK store (`DaemonConfig.storeDir` or its default). Holds the launcher and the lifecycle owner record under `<storeDir>/service`. */
  storeDir: string;
  /** `resolveHostLayout(...).logDir`: the daemon log and the service manager's redirect files (created if missing). On Windows also the default WinSW install directory — see `windows.installDir`. */
  logDir: string;
  /**
   * The lifecycle owner, e.g. `cli` or `app` (1-32 of `a-z`, `0-9`, `-`).
   * One owner per product store sets autostart; another owner's `install`,
   * `repair` and `uninstall` throw `ServiceUnitError` `lifecycle_owner_conflict`.
   */
  owner: string;
  /**
   * Windows/WinSW-only inputs. Required when actually constructing a
   * lifecycle on `win32` (`create-service-lifecycle.ts` throws a clear
   * error otherwise); ignored on macOS/Linux.
   */
  windows?: {
    /**
     * Absolute path to the product-bundled WinSW executable. Decision-6
     * boundary: this SDK never bundles or downloads this binary itself —
     * see `templates/service/winsw/README.md`. The lifecycle copies it
     * into `installDir` under this service's own name (WinSW's own
     * convention: the exe and its XML config must share a basename).
     */
    winswBin: string;
    /** Directory the renamed WinSW exe + generated XML are installed into. Defaults to `logDir`. */
    installDir?: string;
  };
}

/** Options for {@link ServiceLifecycle.install}. */
export interface ServiceInstallOptions {
  /** Replace a `foreign` unit (one without the SDK marker) at the unit path. Explicit operator intent only; never a default. */
  replaceUnmarked?: boolean;
}

export interface ServiceStatusResult {
  /** Whether the platform's own service manager has this service registered at all (a plist/unit/WinSW-config file present — checked directly, not inferred from `running`). */
  installed: boolean;
  /** Whether it's currently running, per the platform's own authoritative query (`launchctl print`, `systemctl --user is-active`, `sc.exe query`) — never a locally-cached guess. `false` here means "confirmed not running" ONLY when `determinate` is also `true` — see that field's own doc comment. */
  running: boolean;
  /**
   * Finding P1 #2 (residual, round 3): whether `running`/`installed` above
   * were actually CONFIRMED by a clean query, as opposed to a fallback
   * because the platform's own service-manager tool could not be asked at
   * all. `run()` (`exec-runner.ts`'s `Runner`) resolves an ordinary
   * non-throwing `RunResult` for a bus-connect failure, an unreachable
   * launchd GUI domain, or a permission-denied query — the SAME shape a
   * genuine "not running" query returns — so without this field, a caller
   * receiving `running: false` could not tell "the manager confirms it's
   * not running" apart from "the manager could not even be asked" (both
   * silently collapsed into the same boolean). Concretely:
   *
   * - `true`: either an authoritative "running"/"active" match, or a query
   *   that resolved with a KNOWN clean "not running"/"not loaded"/"not
   *   found" result.
   * - `false`: the query itself could not be answered — a
   *   connectivity/permission/manager-unreachable failure (each platform
   *   classifies this with the SAME `neverAbsence`-style pattern list its
   *   `uninstall()`/`stop()` already use for the identical reason — see
   *   `systemd.ts`/`launchd.ts`/`winsw.ts`'s own
   *   `*_CONNECTIVITY_OR_PERMISSION_FAILURE` constants). `running: false`
   *   in this case is a FALLBACK, not a confirmed fact.
   *
   * Callers that must not fail open on an unreachable manager (see
   * `bin/commands/unpair.ts`'s `checkServiceState`) must treat
   * `determinate: false` exactly the same as a thrown `status()` call.
   */
  determinate: boolean;
  /** Raw human-readable output from the underlying platform tool, for the `service-status` CLI subcommand and debugging. Never parsed further than the booleans above. */
  detail: string;
  /** How the installed unit compares with this definition's (#1097). */
  unit: ServiceUnitInspection;
  /** Location and size of the daemon log and the redirect files. */
  logs: ServiceLogReport;
}

/**
 * The lifecycle API M3-4 asks for: `install(opts) / uninstall() / start() /
 * stop() / status()`. Every method but `install` is deliberately
 * parameterless — the service's identity/program/logDir are already fixed
 * at `createServiceLifecycle(definition, ...)` construction time (mirrors
 * `createDaemon(config)`'s own "5-line launcher" shape), so `uninstall`/
 * `start`/`stop`/`status` always act on that one already-known service.
 *
 * Crash-restart is ALWAYS delegated to the OS supervisor (launchd
 * `KeepAlive`, systemd `Restart=always` + `RestartPreventExitStatus=0`,
 * WinSW `<onfailure>`) under the exit-code contract in `exit-codes.ts` — no
 * implementation of this interface runs an in-process supervisor loop of
 * its own.
 *
 * Idempotency convention shared by every platform implementation: `install`
 * and `start` hard-fail (throw) if the final "make it actually running"
 * step fails, since silently doing nothing there would misreport success.
 * `stop` is best-effort/tolerant ONLY of a KNOWN idempotent "already
 * stopped"/"not loaded"/"not installed" result (mirrors `Daemon.unpair()`'s
 * own "safe to call at any point in the lifecycle" convention in
 * `daemon/create-daemon.ts` for that idempotent case) — a genuine failure
 * (permission denied, manager unreachable, the exe locked/busy) is thrown
 * instead of being misreported as "stopped", using the same precise
 * classifier `uninstall` uses (cross-model-review P1 #7, round 2, second
 * half: silently swallowing a real `stop()` failure undermines the operator's
 * ability to trust "stopped" at all). `uninstall` is tolerant ONLY of a
 * KNOWN idempotent "not loaded"/"does not exist"/"already absent" result
 * from its stop+unregister step (see `exec-runner.ts`'s
 * `isIdempotentAbsence`) — a genuine failure (permission denied, service
 * busy, manager error, manager UNREACHABLE — e.g. no reachable systemd
 * `--user` D-Bus session or launchd GUI domain for this uid, textually
 * indistinguishable from "already absent" unless explicitly excluded, see
 * `exec-runner.ts`'s `IdempotentAbsence.neverAbsence`) is thrown instead,
 * and the plist/unit/winsw exe+xml are deliberately left in place, so a
 * still-running service never loses its control files and becomes an
 * orphan nobody can stop/uninstall (cross-model-review P1 #7).
 */
export interface ServiceLifecycle {
  /**
   * Writes the unit and launcher, claims the lifecycle owner record and
   * registers + starts the service. Safe to call again: rewrites both and
   * reloads. Throws `ServiceUnitError` `service_unit_unmarked` for a
   * `foreign` unit unless `replaceUnmarked` is set.
   */
  install(opts?: ServiceInstallOptions): Promise<void>;
  /** Rewrites and reloads a `repairable` unit; `exact` and `absent` are `not-needed`. Throws `service_unit_unmarked` for a `foreign` unit, which it never changes. */
  repair(): Promise<ServiceRepairResult>;
  /** Classifies the installed unit: absent / exact / repairable / foreign. Read-only. */
  inspect(): Promise<ServiceUnitInspection>;
  /** Stops (if running) and fully removes the service registration, unit, launcher and owner record. Safe to call when not installed; refuses a `foreign` unit. Throws — and leaves the control file in place — if the underlying service manager reports a genuine failure rather than success/"not installed"; see this interface's own doc comment. */
  uninstall(): Promise<void>;
  /** Starts an already-installed service. Throws a clear error if it isn't installed. */
  start(): Promise<void>;
  /** Stops a running service without uninstalling it. Safe to call when already stopped (or not installed/not loaded). Throws if the underlying service manager reports a genuine failure instead (e.g. permission denied, manager unreachable) rather than silently reporting success; see this interface's own doc comment. */
  stop(): Promise<void>;
  /** Current installed/running state, queried fresh from the platform's own service manager. */
  status(): Promise<ServiceStatusResult>;
}

/**
 * Sanitizes a free-form product/service identifier into something safe to
 * embed in a launchd `Label`, a systemd unit filename, and a WinSW `<id>`
 * (which doubles as a Windows service name AND a generated filename) — the
 * intersection of all three platforms' safe-identifier rules is
 * "letters, digits, `.`, `-`, `_`". Anything outside that set collapses to
 * `-`. A LEADING `-` is then stripped even though `-` is itself an allowed
 * character: `systemctl`'s argument parser (and, generally, any
 * getopt-style CLI) mistakes a bare positional argument starting with `-`
 * for an option rather than the service/unit name — e.g. `systemctl --user
 * enable --now -foo.service` — which would otherwise misparse every one of
 * `launchd.ts`/`systemd.ts`/`winsw.ts`'s own `run()` calls that pass this
 * sanitized name straight through as a CLI argument (cross-model-review P1
 * #8). Called independently by each platform module (not once centrally) so
 * every one of `launchd.ts`/`systemd.ts`/`winsw.ts` stays correct even when
 * used directly, without going through `createServiceLifecycle`'s
 * dispatcher.
 */
export function sanitizeServiceName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  const safe = cleaned.replace(/^-+/, '');
  if (!safe) {
    throw new Error(`service name "${name}" has no valid characters left after sanitizing (allowed: letters, digits, ".", "-", "_"; cannot consist only of leading "-")`);
  }
  return safe;
}
