import { createServiceLifecycle, type DaemonConfig, type ServiceDefinition, type ServiceLifecycle } from '../../index';
import { agentServiceDefinition } from '../../lifecycle/agent-service';
import { readLastLifecycleRecord } from '../audit-log';
import { argValue, hasFlag, resolveStoreDir } from '../config';
import { formatLifecycle, formatLifecycleRemedy } from '../format';

export interface ServiceCommandDeps {
  log?: (line: string) => void;
  /** DI for tests: drive a pre-built lifecycle instead of the real platform-dispatched `createServiceLifecycle`. */
  lifecycle?: ServiceLifecycle;
}

/** The lifecycle owner `byok-agent install` records (#1097). An App of the same product records its own. */
export const CLI_SERVICE_OWNER = 'cli';

/** `install --replace-unmarked`: replace a unit this SDK did not generate (a 0.31 unit, or a hand-written one). */
export const REPLACE_UNMARKED_FLAG = '--replace-unmarked';

/**
 * The CLI's arguments for {@link agentServiceDefinition}, the library
 * implementation an embedded Host calls too. `--name`/`--agent-bin`/
 * `--node-bin`/`--winsw-bin`/`--winsw-install-dir` override its defaults.
 * `agentBin` defaults to `process.argv[1]`, the script Node is running —
 * see `lifecycle/create-service-lifecycle.ts`'s doc comment for why this
 * module family never resolves it itself.
 */
export function cliServiceDefinition(config: DaemonConfig, configPath: string, rest: string[]): ServiceDefinition {
  const winswBin = argValue(rest, '--winsw-bin');
  const installDir = argValue(rest, '--winsw-install-dir');
  return agentServiceDefinition({
    config,
    configPath,
    agentBin: argValue(rest, '--agent-bin') ?? process.argv[1] ?? 'byok-agent',
    nodeBin: argValue(rest, '--node-bin') ?? process.execPath,
    owner: CLI_SERVICE_OWNER,
    ...(argValue(rest, '--name') === undefined ? {} : { name: argValue(rest, '--name') }),
    ...(winswBin ? { windows: installDir ? { winswBin, installDir } : { winswBin } } : {}),
  });
}

function buildLifecycle(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps): ServiceLifecycle {
  return deps.lifecycle ?? createServiceLifecycle(cliServiceDefinition(config, configPath, rest));
}

function serviceNameFor(config: DaemonConfig, rest: string[]): string {
  return argValue(rest, '--name') ?? config.productId;
}

/**
 * Writes the unit and its stable launcher, registers them with the OS
 * service manager, and starts the service — see
 * `lifecycle/create-service-lifecycle.ts` for the per-platform mechanics.
 * Refuses a unit this SDK did not generate unless `--replace-unmarked`.
 * On Windows, `--winsw-bin <path>` is required (the product-bundled WinSW
 * executable — Decision-6: this SDK never bundles/downloads it itself; see
 * `templates/service/winsw/README.md`).
 */
export async function runInstallCommand(config: DaemonConfig, configPath: string, rest: string[], deps: ServiceCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lifecycle = buildLifecycle(config, configPath, rest, deps);
  await lifecycle.install(hasFlag(rest, REPLACE_UNMARKED_FLAG) ? { replaceUnmarked: true } : {});
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
  // #1097: how the installed unit compares with the one install writes.
  log(`unit: ${status.unit.state} path=${status.unit.unitPath}${status.unit.owner === undefined ? '' : ` owner=${status.unit.owner}`}`);
  log(`launcher: ${status.unit.launcherPath}`);
  log(`logs: ${status.logs.dir} ${status.logs.status} totalBytes=${status.logs.totalBytes}`);
  for (const file of status.logs.files) log(`log-file: ${file.name} kind=${file.kind} bytes=${file.sizeBytes}`);
  // Issue #394: a halted service exits 0 and stays stopped; its last
  // lifecycle event says why and what to do.
  const last = await readLastLifecycleRecord(resolveStoreDir(config));
  log(last ? `lifecycle: last-known ${formatLifecycle(last.lifecycle)} at=${last.ts}` : 'lifecycle: unknown (no lifecycle event yet)');
  const remedy = last ? formatLifecycleRemedy(last.lifecycle) : undefined;
  if (remedy !== undefined) log(`lifecycle-remedy: ${remedy}`);
}
