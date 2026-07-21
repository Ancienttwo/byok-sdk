import { createLaunchdLifecycle, type LaunchdDeps } from './launchd';
import { createSystemdLifecycle, type SystemdDeps } from './systemd';
import { createWinswLifecycle, type WinswDeps } from './winsw';
import type { ServiceDefinition, ServiceLifecycle } from './service-types';

export class UnsupportedServicePlatformError extends Error {
  constructor(platform: string) {
    super(`no OS service lifecycle for platform "${platform}" — supported: darwin (launchd), linux (systemd --user), win32 (WinSW)`);
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
  /** Platform-specific DI seams (mocked exec, mocked fs, mocked homedir/getuid) — only the fields matching the resolved platform are ever read. */
  deps?: LaunchdDeps & SystemdDeps & WinswDeps;
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
 *    comment for why WinSW specifically.
 *
 * Every implementation delegates crash-restart entirely to the OS
 * supervisor (`KeepAlive`/`Restart=on-failure`/`<onfailure>`) — none of them
 * runs an in-process supervisor loop.
 *
 * Deliberately does NOT try to auto-resolve `ServiceDefinition.program`'s
 * `command`/`agentBin` from `import.meta.resolve`/`import.meta.url`-style
 * introspection the way `adapters/pi/resolve-bin.ts` does for pi's
 * optionalDependency. That pattern is a genuinely hazardous fit here: a
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
  const platform = opts.platform ?? process.platform;
  switch (platform) {
    case 'darwin':
      return createLaunchdLifecycle(def, opts.deps);
    case 'linux':
      return createSystemdLifecycle(def, opts.deps);
    case 'win32':
      return createWinswLifecycle(def, opts.deps);
    default:
      throw new UnsupportedServicePlatformError(platform);
  }
}
