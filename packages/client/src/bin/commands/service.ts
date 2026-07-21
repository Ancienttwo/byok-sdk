import path from 'node:path';
import { createServiceLifecycle, nodeAgentProgram, type DaemonConfig, type ServiceDefinition, type ServiceLifecycle } from '../../index';
import { argValue, resolveStoreDir } from '../config';

export interface ServiceCommandDeps {
  log?: (line: string) => void;
  /** DI for tests: drive a pre-built lifecycle instead of the real platform-dispatched `createServiceLifecycle`. */
  lifecycle?: ServiceLifecycle;
}

/**
 * Builds the SAME `ServiceDefinition` every one of `install`/`uninstall`/
 * `service-start`/`service-stop`/`service-status` derives — critical so
 * `uninstall`/`service-stop`/`service-status` compute the exact same
 * service name (and, on Windows, install directory) `install` used,
 * without requiring the operator to re-supply identical ad hoc flags to
 * five separate invocations. `--name`/`--agent-bin`/`--node-bin`/
 * `--winsw-bin`/`--winsw-install-dir` are override escape hatches; every
 * default is derived deterministically from `config` alone (mirrors
 * `bin/config.ts`'s own doc comment: every subcommand loads config the same
 * way).
 *
 * `agentBin` defaults to `process.argv[1]` — the actual script path Node is
 * currently running, always correct regardless of how this CLI was
 * invoked (global install, `npx`, a product's own `node_modules/.bin`
 * symlink) — NOT an `import.meta`-based guess; see
 * `lifecycle/create-service-lifecycle.ts`'s doc comment for why this
 * module family never tries to resolve that path itself. A product
 * shipping a single compiled binary (`templates/packaging/`) instead of
 * `node + byok-agent.js` should pass `--agent-bin`/`--node-bin` explicitly,
 * or construct a `ServiceDefinition` directly via `createServiceLifecycle`
 * rather than this convenience CLI subcommand.
 *
 * `configPath` is resolved to an ABSOLUTE path before being baked into the
 * generated service's `--config <path>` argument: a service launched by
 * launchd/systemd/WinSW starts with the OS service manager's OWN minimal
 * environment and working directory, not the operator's interactive shell
 * — a relative path here would resolve against whatever cwd the service
 * manager happens to choose, not where the operator ran `install` from.
 */
export function buildServiceDefinition(config: DaemonConfig, configPath: string, rest: string[]): ServiceDefinition {
  const name = argValue(rest, '--name') ?? config.productId;
  const agentBin = argValue(rest, '--agent-bin') ?? process.argv[1] ?? 'byok-agent';
  const nodeBin = argValue(rest, '--node-bin') ?? process.execPath;
  const absoluteConfigPath = path.resolve(configPath);
  const logDir = path.join(resolveStoreDir(config), 'service-logs');

  const definition: ServiceDefinition = {
    name,
    displayName: config.branding?.displayName ?? config.productName,
    program: nodeAgentProgram({ agentBin, configPath: absoluteConfigPath, nodeBin }),
    logDir,
  };

  const winswBin = argValue(rest, '--winsw-bin');
  if (winswBin) {
    const installDir = argValue(rest, '--winsw-install-dir');
    definition.windows = installDir ? { winswBin, installDir } : { winswBin };
  }
  return definition;
}

function buildLifecycle(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps): ServiceLifecycle {
  return deps.lifecycle ?? createServiceLifecycle(buildServiceDefinition(config, configPath, rest));
}

function serviceNameFor(config: DaemonConfig, rest: string[]): string {
  return argValue(rest, '--name') ?? config.productId;
}

/**
 * Generates the platform service definition (plist/unit/WinSW xml),
 * registers it with the OS service manager, and starts it — see
 * `lifecycle/create-service-lifecycle.ts` for the per-platform mechanics.
 * On Windows, `--winsw-bin <path>` is required (the product-bundled WinSW
 * executable — Decision-6: this SDK never bundles/downloads it itself; see
 * `templates/service/winsw/README.md`).
 */
export async function runInstallCommand(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lifecycle = buildLifecycle(config, configPath, rest, deps);
  await lifecycle.install();
  log(`service installed and started: ${serviceNameFor(config, rest)}`);
}

/** Stops (if running) and fully removes the service registration + generated definition file. Safe to call when not installed. */
export async function runUninstallCommand(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lifecycle = buildLifecycle(config, configPath, rest, deps);
  await lifecycle.uninstall();
  log(`service uninstalled: ${serviceNameFor(config, rest)}`);
}

/** Starts an already-installed service (named so it never collides with the existing `start`, which runs the daemon in the foreground — see `byok-agent.ts`'s header comment). */
export async function runServiceStartCommand(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lifecycle = buildLifecycle(config, configPath, rest, deps);
  await lifecycle.start();
  log(`service started: ${serviceNameFor(config, rest)}`);
}

/** Stops a running service without uninstalling it. */
export async function runServiceStopCommand(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lifecycle = buildLifecycle(config, configPath, rest, deps);
  await lifecycle.stop();
  log(`service stopped: ${serviceNameFor(config, rest)}`);
}

/** Reports installed/running state straight from the platform's own service manager. */
export async function runServiceStatusCommand(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lifecycle = buildLifecycle(config, configPath, rest, deps);
  const status = await lifecycle.status();
  log(`installed: ${status.installed ? 'yes' : 'no'}`);
  // Finding P1 #2 (residual, round 3): a plain `running: no` would misreport
  // an INDETERMINATE query (manager unreachable/permission denied — see
  // `ServiceStatusResult.determinate`) as a confirmed "not running" result.
  // Said so explicitly instead; the raw `detail` line right after still
  // carries the underlying tool output for diagnosis.
  const runningLabel = status.running ? 'yes' : status.determinate ? 'no' : 'unknown (could not query the service manager)';
  log(`running: ${runningLabel}`);
  log(`detail: ${status.detail.trim() || '(none)'}`);
}
