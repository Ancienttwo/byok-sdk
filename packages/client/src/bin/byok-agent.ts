#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { PI_TEAM_OPERATOR_TOKEN } from './team-pi-operator-entry';
import { runTeamPiRelayCommand } from './commands/team-pi-relay';
import { runTeamRelayCommand } from './commands/team-relay';
import { createDaemon, createServiceLifecycle, readServiceInstallationRecord, type ServiceLifecycle } from '../index';
import { argValue, ConfigError, hasFlag, loadConfig, positionalArgs, resolveStoreDir } from './config';
import { formatHaltRemedy } from '../diagnostics/format';
import { applyLoginShellEnvironment, SERVICE_FLAG } from '../lifecycle/service-environment';
import { runApprovalsCommand } from './commands/approvals';
import { runApproveCommand, runRejectCommand } from './commands/approve-reject';
import { readPairInput, runPairCommand } from './commands/pair';
import { runDoctorCommand } from './commands/doctor';
import { runConfigCheckCommand } from './commands/config-check';
import { runRuntimesCommand } from './commands/runtimes';
import {
  cliServiceDefinition,
  cliServiceInstallation,
  runInstallCommand,
  runServiceStartCommand,
  runServiceStatusCommand,
  runServiceStopCommand,
  runUninstallCommand,
} from './commands/service';
import { formatStartErrorReason, runStartCommand, type StartOutcome } from './commands/start';
import { daemonExitCode, EXIT_FAILURE } from '../lifecycle/exit-codes';
import { boundServiceRedirectLogs, routeProcessOutputToDaemonLog } from '../lifecycle/service-log';
import { serviceLogDir } from '../daemon/host-layout';
import { runStatusCommand } from './commands/status';
import { runSupportBundleCommand } from './commands/support-bundle';
import { runTasksFollowCommand, runTasksListCommand } from './commands/tasks';
import { runToolsetsReloadCommand } from './commands/toolsets';
import { runTeamCreateCommand, runTeamJoinCommand, runTeamListCommand, runTeamOpenCommand, runTeamWatchCommand } from './commands/team';
import { runUnpairCommand } from './commands/unpair';
import { runUpgradeInstallationCommand, runUpgradeStatusCommand, runUpgradeStoreCheckCommand, UPGRADE_INSTALLATION_ACTIONS, type UpgradeInstallationAction } from './commands/upgrade';
import { runVersionCommand } from './version';

/**
 * `byok-agent`: a PLAIN structured CLI (subcommands + line-oriented stdout +
 * a tail-able JSONL log) — deliberately NOT a TUI. No ink/blessed/React
 * reconciler, no full-screen TTY control codes. Every subcommand must work
 * headless (piped stdout, no TTY, running as a background service) and
 * cross-platform; see `diagnostics/format.ts` for the plain-text-only rendering
 * this relies on.
 *
 * ## The read model — persisted state, a live probe, and (M4 Phase 2) a live control socket
 *
 * `start` is a long-lived foreground process (or an installed background
 * service running the same command). `status`/`runtimes`/`tasks`/
 * `toolsets reload`/`tasks --follow`/`unpair`/`approve`/`reject` are all
 * separate, short-lived
 * invocations. As of M4 Phase 2 there IS a local IPC channel between them —
 * a Unix domain socket / Windows named pipe (`daemon/control-server.ts`,
 * `daemon/control-client.ts`), mutually authenticated by an HMAC handshake over
 * a token that never crosses the wire — but it's only reachable while a
 * `start` (foreground or service) is actually running, so every
 * short-lived command still has an honest, historical/persisted-state
 * fallback for when it isn't:
 *
 * - `status`/`tasks` (no `--follow`) read PERSISTED STATE first, always:
 *   `<storeDir>/device.json` (via `DeviceStore`, for paired/deviceId — a
 *   freshly-constructed `Daemon` that never called `start()`/`pair()` in
 *   THIS process would otherwise always report `paired: false`, which would
 *   be actively wrong for an already-paired device) and
 *   `<storeDir>/audit.jsonl` (the content-free `DaemonRecord`s `start`
 *   appends — and prints to stdout as the same JSON lines — see
 *   `daemon/audit-log.ts`, reduced into a task list / last-known lifecycle via
 *   `diagnostics/tasks-view.ts`). `status`
 *   additionally tries the control socket afterward: if reachable, a
 *   clearly-marked `live-*` section (pid/uptime/transport/active tasks) is
 *   appended; if not, one line says so and the persisted view above stands
 *   on its own, never faked as "live".
 * - `runtimes` is an explicit fresh local probe. `status` reads the daemon's
 *   cached startup observations over control when online and timestamped audit
 *   observations when offline. It never executes a local runtime probe.
 *   Online doctor/support bundles also use daemon observations; offline
 *   diagnostics label their explicit probes `local-shell`. Older daemons with
 *   missing observation fields are reported as unknown.
 * - `tasks --follow` requires the authenticated control socket's
 *   `tasks.subscribe` feed, preserving full content in the live view.
 *   Offline task snapshots reduce content-free DaemonRecords; there is no
 *   audit-to-event reconstruction or audit follow fallback. Run
 *   `byok-agent start` (or the service) for a live subscription.
 *
 * `pair`/`start` are the only commands that construct or run a daemon in THIS
 * process. `toolsets reload` mutates only an already-running daemon over the
 * authenticated control socket.
 */

/** `pair --e2ee`: the input is `<pairing code>.<verification secret>` (#654 §7.2, owner §50c). */
const E2EE_PAIR_FLAG = '--e2ee';
const REPLACE_OTHER_STORE_FLAG = '--replace-other-store';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  byok-agent --version',
      '  byok-agent pair <code> --server <url> [--e2ee] [--replace-other-store] [--config <path>]   (--e2ee: <code> is the <pairing code>.<verification secret> the web client shows; --replace-other-store: replace an enrollment another storeDir of this productId paired)',
      '  byok-agent start [--config <path>] [--service]            (or BYOK_CONFIG env var; launchd/systemd pass --service)',
      '  byok-agent status [--config <path>]',
      '  byok-agent config check [--strict] [--json] [--config <path>]   (validate a config file and print its effective values; --strict fails on warnings)',
      '  byok-agent doctor [--json] [--fix --yes] [--config <path>]',
      '  byok-agent doctor --repair restore-enrollment-metadata --expected-device-id <id> --expected-tenant-id <id> --yes [--json] [--config <path>]',
      '  byok-agent doctor --repair reset-cursor --yes [--json] [--config <path>]   (after a cursor_unreadable halt: replay from 0)',
      '  byok-agent support-bundle --output <path> [--config <path>]',
      '  byok-agent runtimes [--config <path>]',
      '  byok-agent tasks [--follow] [--config <path>]',
      '  byok-agent toolsets reload --config <path>',
      '  byok-agent team list --config <path>',
      '  byok-agent team create <workspace> --members <id,id> --config <path>',
      '  byok-agent team join <workspace> --member <id> --config <path>   (prints MCP config)',
      '  Private __byok_pi_team_operator dispatch is operator-only, non-attested; not a daemon/helper command.',
      '  byok-agent team pi-relay <workspace> --bindings <private-absolute.json> --codex-bin <absolute> --max-notifications <1..100> --config <path>',
      '  byok-agent team relay <workspace> --bindings <private-absolute.json> --codex-bin <absolute> --max-notifications <1..100> --config <path>',
      '  byok-agent team watch <workspace> --config <path>',
      '  byok-agent team open <workspace> --tmux-bin <absolute> [--session <name>] --config <path>',
      '  byok-agent unpair [--yes] [--force] [--config <path>]',
      '  byok-agent upgrade check --store [--json] [--config <path>]   (read-only; exit 2 when a store would be refused)',
      '  byok-agent upgrade apply <payload-dir> | rollback | recover | status [--json] --config <path>   (an install --payload installation)',
      '  byok-agent approvals [--config <path>]                    (list pending approvalIds — see approve/reject below)',
      '  byok-agent approve <approvalId> [--config <path>]',
      '  byok-agent reject <approvalId> [--reason <text>] [--config <path>]',
      '',
      '  Background OS service (launchd/systemd/WinSW) — see templates/service/**:',
      '  byok-agent install [--config <path>] [--name <svc>] [--agent-bin <path>] [--node-bin <path>] [--winsw-bin <path>] [--winsw-install-dir <path>] [--replace-unmarked]',
      '  byok-agent install --payload <dir> --install-root <dir> [--config <path>] [--name <svc>] [--node-bin <path>] [--winsw-bin <path>] [--replace-unmarked]',
      '  byok-agent uninstall [--config <path>] [--name <svc>]',
      '  byok-agent service-start [--config <path>] [--name <svc>]',
      '  byok-agent service-stop [--config <path>] [--name <svc>]',
      '  byok-agent service-status [--config <path>] [--name <svc>]',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * A configuration that cannot load is the `config_invalid` halt: restarting
 * with it fails the same way. Under `--service` everything the process
 * writes to stdout/stderr goes to its own rotated log (#1097,
 * `lifecycle/service-log.ts`); the service manager's redirect keeps only
 * output from before it opens, such as a config error.
 */
async function startOutcome(rest: string[], service: boolean): Promise<StartOutcome> {
  const configPath = configPathFrom(rest);
  let config: ReturnType<typeof loadConfig>;
  try {
    if (!configPath) throw new ConfigError('start requires --config <path> or a BYOK_CONFIG env var');
    config = loadConfig(configPath);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(formatStartErrorReason(err));
    console.error(`daemon halted: reason=config_invalid — ${formatHaltRemedy('config_invalid')}`);
    return { kind: 'halted', reason: 'config_invalid' };
  }
  const controller = abortOnSignal();
  if (!service) return runStartCommand(config, { signal: controller.signal });
  const logDir = serviceLogDir(resolveStoreDir(config));
  boundServiceRedirectLogs(logDir);
  const daemonLog = routeProcessOutputToDaemonLog({ logDir });
  try {
    return await runStartCommand(config, { signal: controller.signal });
  } finally {
    daemonLog.close();
  }
}

function configPathFrom(args: string[]): string | undefined {
  return argValue(args, '--config') ?? process.env.BYOK_CONFIG;
}

/** Wires an `AbortController` to SIGINT/SIGTERM for a long-running subcommand (`start`, `tasks --follow`). */
function abortOnSignal(): AbortController {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  return controller;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (command === PI_TEAM_OPERATOR_TOKEN) {
    // #700: Node's own undici loads before Pi's npm copy (see `loadNodeUndici` in `sdk-reserved-helper-command.ts`).
    Reflect.get(globalThis, 'Headers');
    await (await import('#byok-pi-runtime-host')).runPiTeamOperatorHost(rest);
    return;
  }

  if (command === '--version') {
    runVersionCommand();
    return;
  }

  if (command === 'pair') {
    const [input] = positionalArgs(rest, ['--server', '--config']).filter((arg) => arg !== E2EE_PAIR_FLAG && arg !== REPLACE_OTHER_STORE_FLAG);
    const server = argValue(rest, '--server');
    if (!input || !server) usage();
    const config = loadConfig(argValue(rest, '--config'), { serverUrl: server });
    const { code, verificationSecret } = readPairInput(input, hasFlag(rest, E2EE_PAIR_FLAG));
    return runPairCommand(config, code, {}, verificationSecret, hasFlag(rest, REPLACE_OTHER_STORE_FLAG));
  }

  if (command === 'start') {
    const service = hasFlag(rest, SERVICE_FLAG);
    // Issue #392: under a service manager, adopt the user's login-shell
    // environment BEFORE anything reads process.env (BYOK_CONFIG, the config
    // file, adapter resolution). This process's own BYOK_* values survive.
    try {
      if (service) await applyLoginShellEnvironment();
      // exitCode, not exit(): a piped stdout/stderr (a service log) drains the
      // final lines, the halt remedy included, before the process ends.
      process.exitCode = daemonExitCode(await startOutcome(rest, service), service);
    } catch (error) {
      console.error(formatStartErrorReason(error));
      process.exitCode = EXIT_FAILURE;
    }
    return;
  }

  if (command === 'config') {
    const [action, ...extra] = positionalArgs(rest, ['--config']).filter((arg) => arg !== '--strict' && arg !== '--json');
    if (action !== 'check' || extra.length > 0) usage();
    const configPath = configPathFrom(rest);
    if (!configPath) throw new ConfigError('config check requires --config <path> or a BYOK_CONFIG env var');
    process.exitCode = runConfigCheckCommand(configPath, { strict: hasFlag(rest, '--strict'), json: hasFlag(rest, '--json') });
    return;
  }

  if (command === 'status') {
    const config = loadConfig(configPathFrom(rest));
    return runStatusCommand(config);
  }

  if (command === 'doctor') {
    const config = loadConfig(configPathFrom(rest));
    return runDoctorCommand(config, {
      json: hasFlag(rest, '--json'),
      fix: hasFlag(rest, '--fix'),
      repair: hasFlag(rest, '--repair') ? (argValue(rest, '--repair') ?? '') : undefined,
      expectedDeviceId: hasFlag(rest, '--expected-device-id') ? (argValue(rest, '--expected-device-id') ?? '') : undefined,
      expectedTenantId: hasFlag(rest, '--expected-tenant-id') ? (argValue(rest, '--expected-tenant-id') ?? '') : undefined,
      confirmed: hasFlag(rest, '--yes'),
    });
  }

  if (command === 'support-bundle') {
    const outputPath = argValue(rest, '--output');
    if (!outputPath) usage();
    const config = loadConfig(configPathFrom(rest));
    return runSupportBundleCommand(config, { outputPath });
  }

  if (command === 'runtimes') {
    const config = loadConfig(configPathFrom(rest));
    return runRuntimesCommand(config);
  }

  if (command === 'tasks') {
    const config = loadConfig(configPathFrom(rest));
    if (hasFlag(rest, '--follow')) {
      const controller = abortOnSignal();
      return runTasksFollowCommand(config, { signal: controller.signal });
    }
    return runTasksListCommand(config);
  }

  if (command === 'toolsets') {
    const [action, ...extra] = positionalArgs(rest, ['--config']);
    if (action !== 'reload' || extra.length > 0) usage();
    const configPath = configPathFrom(rest);
    if (!configPath) {
      console.error('toolsets reload requires --config <path> or a BYOK_CONFIG env var');
      process.exit(1);
    }
    return runToolsetsReloadCommand(loadConfig(configPath));
  }

  if (command === 'team') {
    const [action, workspaceId, ...extra] = positionalArgs(rest, ['--members', '--member', '--tmux-bin', '--session', '--config', '--bindings', '--codex-bin', '--max-notifications']);
    if (extra.length > 0) usage();
    const configPath = configPathFrom(rest);
    if (!configPath) { console.error('team commands require --config <path> or a BYOK_CONFIG env var'); process.exit(1); }
    const config = loadConfig(configPath);
    if (action === 'list' && workspaceId === undefined) return runTeamListCommand(config);
    if (!workspaceId) usage();
    if (action === 'create') {
      const members = argValue(rest, '--members')?.split(',').filter(Boolean);
      if (!members?.length) usage();
      return runTeamCreateCommand(config, workspaceId, members);
    }
    if (action === 'join') {
      const memberId = argValue(rest, '--member'); if (!memberId) usage();
      return runTeamJoinCommand(config, workspaceId, memberId);
    }
    if (action === 'relay' || action === 'pi-relay') {
      const bindingsFile = argValue(rest, '--bindings');
      const codexBin = argValue(rest, '--codex-bin');
      const budget = argValue(rest, '--max-notifications');
      if (!bindingsFile || !codexBin || !budget || !/^[1-9][0-9]*$/u.test(budget)) usage();
      const controller = abortOnSignal();
      const relayInput = { config, workspaceId, bindingsFile, codexBin, maxNotifications: Number(budget), signal: controller.signal };
      return action === 'pi-relay'
        ? runTeamPiRelayCommand({ ...relayInput, operatorInvocation: { command: process.execPath, args: [fileURLToPath(import.meta.url), PI_TEAM_OPERATOR_TOKEN] } })
        : runTeamRelayCommand(relayInput);
    }
    if (action === 'watch') { const controller = abortOnSignal(); return runTeamWatchCommand(config, workspaceId, controller.signal); }
    if (action === 'open') {
      const tmuxBin = argValue(rest, '--tmux-bin'); if (!tmuxBin) usage();
      return runTeamOpenCommand({ config, configPath, workspaceId, tmuxBin, sessionName: argValue(rest, '--session') });
    }
    usage();
  }

  if (command === 'unpair') {
    const configPath = configPathFrom(rest);
    const config = loadConfig(configPath);
    const daemon = createDaemon(config);
    // Finding P1 #2: best-effort — reuses the exact same
    // ServiceDefinition/lifecycle `service.ts`'s own commands build, so
    // "is a service installed/running" is answered from the SAME identity
    // `install`/`service-status` would use, not a second guess. Construction
    // itself throws on an unsupported platform, or on win32 without
    // `--winsw-bin` (see `lifecycle/winsw.ts`) — in either case there is no
    // way to query a service's state at all, so `lifecycle` stays
    // `undefined` and `runUnpairCommand` treats that the same as any other
    // "cannot confirm no daemon is running" state (finding P1 #2 residual):
    // refused by default, bypassable with `--force`.
    let lifecycle: ServiceLifecycle | undefined;
    if (configPath) {
      try {
        lifecycle = createServiceLifecycle(cliServiceDefinition(config, configPath, rest));
      } catch {
        lifecycle = undefined;
      }
    }
    return runUnpairCommand(daemon, {
      confirmed: hasFlag(rest, '--yes'),
      lifecycle,
      force: hasFlag(rest, '--force'),
      storeDir: resolveStoreDir(config),
      productId: config.productId,
    });
  }

  if (command === 'upgrade') {
    const [action, ...operands] = positionalArgs(rest, ['--config', '--name', '--node-bin', '--winsw-bin', '--winsw-install-dir']);
    if (action === 'check') {
      if (!operands.includes('--store') || operands.some((flag) => flag !== '--store' && flag !== '--json')) usage();
      const config = loadConfig(configPathFrom(rest));
      process.exitCode = await runUpgradeStoreCheckCommand({ storeDir: resolveStoreDir(config), json: hasFlag(rest, '--json') });
      return;
    }
    const args = operands.filter((operand) => operand !== '--json');
    if (!UPGRADE_INSTALLATION_ACTIONS.includes(action as UpgradeInstallationAction) || args.length !== (action === 'apply' ? 1 : 0)) usage();
    const configPath = configPathFrom(rest);
    if (!configPath) {
      console.error(`upgrade ${action} requires --config <path> or a BYOK_CONFIG env var`);
      process.exit(1);
    }
    const config = loadConfig(configPath);
    const noInstallation = (): never => {
      console.error('upgrade: no payload installation is recorded for this store (install it with byok-agent install --payload)');
      process.exit(1);
    };
    if (action === 'status') {
      // A status read takes only the recorded install root, never the service definition.
      const record = (await readServiceInstallationRecord(resolveStoreDir(config))) ?? noInstallation();
      return runUpgradeStatusCommand(record.installRoot, { json: hasFlag(rest, '--json') });
    }
    const installation = (await cliServiceInstallation(config, configPath, rest, {})) ?? noInstallation();
    return runUpgradeInstallationCommand(installation, {
      action: action as Exclude<UpgradeInstallationAction, 'status'>, ...(action === 'apply' ? { payload: args[0] } : {}), json: hasFlag(rest, '--json'),
    });
  }

  if (command === 'approvals') {
    const config = loadConfig(configPathFrom(rest));
    const storeDir = resolveStoreDir(config);
    return runApprovalsCommand(storeDir, config.productId);
  }

  if (command === 'approve' || command === 'reject') {
    const [approvalId] = positionalArgs(rest, ['--reason', '--config']);
    if (!approvalId) usage();
    const config = loadConfig(configPathFrom(rest));
    const storeDir = resolveStoreDir(config);
    if (command === 'approve') return runApproveCommand(storeDir, config.productId, approvalId);
    return runRejectCommand(storeDir, config.productId, approvalId, argValue(rest, '--reason'));
  }

  if (
    command === 'install' ||
    command === 'uninstall' ||
    command === 'service-start' ||
    command === 'service-stop' ||
    command === 'service-status'
  ) {
    const configPath = configPathFrom(rest);
    if (!configPath) {
      console.error(`${command} requires --config <path> or a BYOK_CONFIG env var`);
      process.exit(1);
    }
    const config = loadConfig(configPath);
    if (command === 'install') return runInstallCommand(config, configPath, rest);
    if (command === 'uninstall') return runUninstallCommand(config, configPath, rest);
    if (command === 'service-start') return runServiceStartCommand(config, configPath, rest);
    if (command === 'service-stop') return runServiceStopCommand(config, configPath, rest);
    return runServiceStatusCommand(config, configPath, rest);
  }

  usage();
}

// Every throw is a crash: exit 1, which every supervisor restarts.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
