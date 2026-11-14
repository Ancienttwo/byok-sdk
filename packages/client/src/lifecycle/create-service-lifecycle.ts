import { createLaunchdLifecycle, type LaunchdDeps } from './launchd.js';
import { createSystemdLifecycle, type SystemdDeps } from './systemd.js';
import { createWindowsUserLifecycle, type WindowsUserDeps } from './windows-user.js';
import { createWinswLifecycle, type WinswDeps } from './winsw.js';
import type { ManagedServiceLifecycle } from './managed-lifecycle.js';
import type { ServiceDefinition, ServiceLifecycle } from './service-types.js';

export class UnsupportedServicePlatformError extends Error {
  constructor(platform: string) {
    super(`no OS service lifecycle for platform "${platform}" — supported: darwin (launchd), linux (systemd --user), win32 (WinSW, or the Startup folder for scope 'user')`);
    this.name = 'UnsupportedServicePlatformError';
  }
}

export interface CreateServiceLifecycleOptions {
  /**
   * Overrides `process.platform` — test-only seam for exercising a
   * specific platform's generator/install logic from any host (combine
   * with a mocked `deps.run`/`deps.fs`, since the real launchctl/systemctl/
   * WinSW binaries obviously aren't present on the "wrong" OS).
   */
  platform?: NodeJS.Platform;
  /** Platform-specific DI seams (mocked exec, mocked fs, mocked homedir/uid) — only the fields matching the resolved platform are ever read. */
  deps?: LaunchdDeps & SystemdDeps & WinswDeps & WindowsUserDeps;
  /**
   * An isolated root for the `service-lifecycle` gate that install, repair,
   * uninstall and `owned` hold, for tests and parallel consumers. Omitted,
   * the gate uses `/tmp/byok-pm-<uid>`. Lifecycles exclude each other only
   * when they use the same root. Only this lifecycle's gate moves:
   * `claimServiceLifecycleOwner`, `releaseServiceLifecycleOwner` and
   * `localStateRelocation` still lock the default root, so a lifecycle on a
   * `gateRoot` no longer excludes them. It must be an absolute path and gets
   * the default root's check. An absent root is created with mode 0700.
   * A gateRoot owned by the process user is set to 0700; a symlink,
   * non-directory or foreign-owned path is refused. The refusal's `code` is
   * `private_dir_symlink`, `private_dir_not_directory` or
   * `private_dir_foreign_owner`, and `private_dir_mode` when the root cannot
   * be set to 0700. The check covers the root itself, not a
   * swap of its parent, so choose a root whose parent directory other users
   * cannot write. The option takes effect on macOS only: Linux and Windows
   * ignore it, a relative path included, because their gates have no
   * filesystem root.
   */
  gateRoot?: string;
}

/**
 * Platform-dispatched entry point for M3-4's lifecycle API: manages the
 * daemon as a background OS service via the platform's own idiomatic
 * mechanism —
 *
 *  - **macOS**: a launchd LaunchAgent (`launchd.ts`).
 *  - **Linux**: a systemd user unit (`systemd.ts`).
 *  - **Windows**: a WinSW-wrapped Windows Service (`winsw.ts`) — Node has no
 *    native SCM control-handler support in core, so a wrapper is used
 *    rather than hand-rolling the SCM protocol; see `winsw.ts`'s own doc
 *    comment for why WinSW specifically. With `windows.scope: 'user'`, a
 *    logon autostart from the user's Startup folder instead, with no SCM
 *    and no administrator (`windows-user.ts`, #1337).
 *
 * Every implementation delegates crash-restart entirely to the OS
 * supervisor (`KeepAlive`/`Restart=on-failure`/`<onfailure>`) — none of them
 * runs an in-process supervisor loop.
 *
 * Deliberately does NOT try to auto-resolve `ServiceDefinition.program`'s
 * `command`/`agentBin` from `import.meta.resolve`/`import.meta.url`-style
 * introspection the way `adapters/pi/resolve-bin.ts` does for pi's required
 * package. That pattern is a genuinely hazardous fit here: a
 * relative path from THIS source file to `bin/byok-agent.ts` (`../bin/...`,
 * since `lifecycle/` and `bin/` are sibling directories under `src/`) does
 * NOT survive tsup's bundling unchanged — `src/index.ts` and
 * `src/bin/byok-agent.ts` are two SEPARATE, independently-bundled tsup
 * entries (see `tsup.config.ts`), so any code from `lifecycle/` ends up
 * inlined into `dist/index.js` itself, whose OWN directory is `dist/`, not
 * `dist/lifecycle/` — a path relative to "wherever this bundled code
 * actually runs from" would need to be `./bin/byok-agent.js` there, the
 * OPPOSITE of the `../bin/...` that's correct in unbundled `src/`. Guessing
 * across that bundle boundary is exactly the class of hazard
 * `templates/packaging/sea/README.md` had to empirically work around for
 * pi's own resolution path. Rather than add a second such hazard, this
 * module requires the caller to supply an explicit, already-resolved
 * `program.command`/args (see `service-types.ts`'s `nodeAgentProgram` —
 * still just a formatting convenience, not a resolution mechanism) — the
 * `install`/`uninstall`/`service-*` CLI subcommands (`bin/commands/service.ts`)
 * default `agentBin` to `process.argv[1]` instead, which Node always
 * populates correctly with the actual script path being run regardless of
 * how it was invoked, bundled or not.
 */
export function createServiceLifecycle(def: ServiceDefinition, opts: CreateServiceLifecycleOptions = {}): ServiceLifecycle {
  return createManagedServiceLifecycle(def, opts);
}

/** @internal `createServiceLifecycle` with the owner gate a service installation runs its steps behind. */
export function createManagedServiceLifecycle(def: ServiceDefinition, opts: CreateServiceLifecycleOptions = {}): ManagedServiceLifecycle {
  const platform = opts.platform ?? process.platform;
  switch (platform) {
    case 'darwin':
      return createLaunchdLifecycle(def, opts.deps, opts.gateRoot);
    case 'linux':
      return createSystemdLifecycle(def, opts.deps, opts.gateRoot);
    case 'win32':
      return def.windows?.scope === 'user' ? createWindowsUserLifecycle(def, opts.deps, opts.gateRoot) : createWinswLifecycle(def, opts.deps, opts.gateRoot);
    default:
      throw new UnsupportedServicePlatformError(platform);
  }
}
