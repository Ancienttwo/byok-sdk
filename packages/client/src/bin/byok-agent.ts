#!/usr/bin/env node
import { createDaemon, createServiceLifecycle, DeviceRevokedError, type ServiceLifecycle } from '../index';
import { argValue, hasFlag, loadConfig, positionalArgs, resolveStoreDir } from './config';
import { runApprovalsCommand } from './commands/approvals';
import { runApproveCommand, runRejectCommand } from './commands/approve-reject';
import { runPairCommand } from './commands/pair';
import { runRuntimesCommand } from './commands/runtimes';
import {
  buildServiceDefinition,
  runInstallCommand,
  runServiceStartCommand,
  runServiceStatusCommand,
  runServiceStopCommand,
  runUninstallCommand,
} from './commands/service';
import { runStartCommand } from './commands/start';
import { runStatusCommand } from './commands/status';
import { runTasksFollowCommand, runTasksListCommand } from './commands/tasks';
import { runUnpairCommand } from './commands/unpair';
import { runWorkspacesCommand } from './commands/workspaces';

/**
 * `byok-agent`: a PLAIN structured CLI (subcommands + line-oriented stdout +
 * a tail-able JSONL log) — deliberately NOT a TUI. No ink/blessed/React
 * reconciler, no full-screen TTY control codes. Every subcommand must work
 * headless (piped stdout, no TTY, running as a background service) and
 * cross-platform; see `bin/format.ts` for the plain-text-only rendering
 * this relies on.
 *
 * ## The read model — persisted state, a live probe, and (M4 Phase 2) a live control socket
 *
 * `start` is a long-lived foreground process (or an installed background
 * service running the same command). `status`/`runtimes`/`tasks`/
 * `tasks --follow`/`unpair`/`approve`/`reject` are all separate, short-lived
 * invocations. As of M4 Phase 2 there IS a local IPC channel between them —
 * a Unix domain socket / Windows named pipe (`daemon/control-server.ts`,
 * `bin/control-client.ts`), mutually authenticated by an HMAC handshake over
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
 *   `<storeDir>/audit.jsonl` (the audit log `start` appends every
 *   `DaemonEvent` to — see `bin/audit-log.ts` — replayed into a task list /
 *   last-known-connection-state via `bin/tasks-view.ts`). `status`
 *   additionally tries the control socket afterward: if reachable, a
 *   clearly-marked `live-*` section (pid/uptime/transport/active tasks) is
 *   appended; if not, one line says so and the persisted view above stands
 *   on its own, never faked as "live".
 * - `runtimes` (and the compact runtime summary inside `status`) is a FRESH
 *   STANDALONE PROBE instead: it constructs the same bundled pi/claude/codex
 *   adapter set `createDaemon` would (see `bin/runtime-probe.ts`) and calls
 *   `detect()`/`capabilities()` directly, independent of whether any daemon
 *   is running. "What's on this machine right now" is more useful live than
 *   stale, and detection is cheap/side-effect-free, so there's no reason to
 *   read a historical snapshot here instead. The control socket deliberately
 *   never duplicates this probe (see `control-protocol.ts`'s `status`
 *   method doc comment) — this CLI keeps owning it.
 * - `tasks --follow` prefers subscribing to the control socket's
 *   `tasks.subscribe` (a genuinely live feed, full fidelity, the same
 *   events `start`'s own stdout shows); falls back to tailing
 *   `audit.jsonl` from its CURRENT end forward (like `tail -f`) when the
 *   socket isn't reachable — see `bin/audit-log.ts`'s `followAuditLog`. Run
 *   plain `tasks` first for history either way.
 * - `unpair` tries the control socket first: if reachable, that's a
 *   DEFINITIVE "yes, a daemon is running against this store" (foreground or
 *   service, no distinction needed anymore) — it sends `shutdown
 *   {reason:'unpair'}` and waits for the daemon to actually exit. Finding F6:
 *   `device.json` is only cleared once that exit is CONFIRMED (or `--force`
 *   is passed, logged as an explicit WARNING) — an unconfirmed exit (the RPC
 *   failing, teardown hanging, or the exit-poll timing out) refuses instead,
 *   since the daemon may still be running and could silently re-write the
 *   credential (see `commands/unpair.ts`'s `UnpairExitUnconfirmedError`).
 *   Only when the socket isn't reachable does it fall back to
 *   the heuristic, OS-service-state-based flow this command has had since
 *   finding P1 #2: refusing outright when an installed background service
 *   is confirmed running, or when it cannot even confirm one ISN'T running
 *   (bypassable with `--force`) — see `commands/unpair.ts`'s own doc
 *   comment for the full history and residual gap that heuristic flow
 *   still has (a foreground process is invisible to it, which is exactly
 *   what the control-socket path above now fixes).
 * - `approve`/`reject` call the control socket's `approvals.resolve`
 *   directly — there's no persisted-state fallback for these (approving a
 *   task only ever means anything against a LIVE daemon); daemon
 *   unreachable is reported as a clear, specific error. Still honest about
 *   what these can resolve today: no bundled runtime adapter raises an
 *   approval yet, so a real daemon always answers `not_found` — see
 *   `commands/approve-reject.ts`'s own doc comment.
 * - `approvals` (finding F4: operators otherwise had no way to ever learn
 *   an `approvalId` to pass to `approve`/`reject`) calls the control
 *   socket's `approvals.list` and renders one line per pending approval
 *   (approvalId/taskId/age/summary excerpt) — same no-fallback rule as
 *   `approve`/`reject` above. See `commands/approvals.ts`'s own doc
 *   comment.
 *
 * `pair`/`start` are the only two commands that mutate/run a live daemon in
 * THIS process, unchanged in spirit from the pre-M3-2b bin.
 */

function usage(): never {
  console.error(
    [
      'Usage:',
      '  byok-agent pair <code> --server <url> [--config <path>]',
      '  byok-agent start [--config <path>]                        (or BYOK_CONFIG env var)',
      '  byok-agent status [--config <path>]',
      '  byok-agent runtimes [--config <path>]',
      '  byok-agent tasks [--follow] [--config <path>]',
      '  byok-agent workspaces [--show-paths] [--config <path>]',
      '  byok-agent unpair [--yes] [--force] [--config <path>]',
      '  byok-agent approvals [--config <path>]                    (list pending approvalIds — see approve/reject below)',
      '  byok-agent approve <approvalId> [--config <path>]',
      '  byok-agent reject <approvalId> [--reason <text>] [--config <path>]',
      '',
      '  Background OS service (launchd/systemd/WinSW) — see templates/service/**:',
      '  byok-agent install [--config <path>] [--name <svc>] [--agent-bin <path>] [--node-bin <path>] [--winsw-bin <path>] [--winsw-install-dir <path>]',
      '  byok-agent uninstall [--config <path>] [--name <svc>]',
      '  byok-agent service-start [--config <path>] [--name <svc>]',
      '  byok-agent service-stop [--config <path>] [--name <svc>]',
      '  byok-agent service-status [--config <path>] [--name <svc>]',
    ].join('\n'),
  );
  process.exit(1);
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

  if (command === 'pair') {
    const [code] = positionalArgs(rest, ['--server', '--config']);
    const server = argValue(rest, '--server');
    if (!code || !server) usage();
    const config = loadConfig(argValue(rest, '--config'), { serverUrl: server });
    return runPairCommand(config, code);
  }

  if (command === 'start') {
    const configPath = configPathFrom(rest);
    if (!configPath) {
      console.error('start requires --config <path> or a BYOK_CONFIG env var');
      process.exit(1);
    }
    const config = loadConfig(configPath);
    const controller = abortOnSignal();
    return runStartCommand(config, { signal: controller.signal });
  }

  if (command === 'status') {
    const config = loadConfig(configPathFrom(rest));
    return runStatusCommand(config);
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

  if (command === 'workspaces') {
    const config = loadConfig(configPathFrom(rest));
    return runWorkspacesCommand(config, { showPaths: hasFlag(rest, '--show-paths') });
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
        lifecycle = createServiceLifecycle(buildServiceDefinition(config, configPath, rest));
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

main().catch((err: unknown) => {
  if (err instanceof DeviceRevokedError) {
    // A cold `daemon.start()` against an already-revoked device fails fast
    // with this typed error (see ConnectionManager.waitForAck) instead of
    // hanging for the ack timeout — give the operator a clear, actionable
    // message instead of a generic one.
    console.error('device revoked — re-pair needed (run: byok-agent pair <code> --server <url>)');
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
