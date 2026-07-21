#!/usr/bin/env node
import { createDaemon, DeviceRevokedError } from '../index';
import { argValue, hasFlag, loadConfig, positionalArgs } from './config';
import { runApproveCommand, runRejectCommand } from './commands/approve-reject';
import { runPairCommand } from './commands/pair';
import { runRuntimesCommand } from './commands/runtimes';
import {
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

/**
 * `byok-agent`: a PLAIN structured CLI (subcommands + line-oriented stdout +
 * a tail-able JSONL log) — deliberately NOT a TUI. No ink/blessed/React
 * reconciler, no full-screen TTY control codes. Every subcommand must work
 * headless (piped stdout, no TTY, running as a background service) and
 * cross-platform; see `bin/format.ts` for the plain-text-only rendering
 * this relies on.
 *
 * ## The read model — why `status`/`tasks`/`runtimes` don't talk to a running `start`
 *
 * `start` is a long-lived foreground process. `status`/`runtimes`/`tasks`/
 * `tasks --follow`/`approve`/`reject`/`unpair` are all separate, short-lived
 * invocations — there is no IPC control socket between them (that's likely
 * M4; deliberately not built here). Each subcommand's data source follows
 * from that constraint, not from convenience:
 *
 * - `status`/`tasks` (no `--follow`) read PERSISTED STATE ONLY:
 *   `<storeDir>/device.json` (via `DeviceStore`, for paired/deviceId — a
 *   freshly-constructed `Daemon` that never called `start()`/`pair()` in
 *   THIS process would otherwise always report `paired: false`, which would
 *   be actively wrong for an already-paired device) and
 *   `<storeDir>/audit.jsonl` (the audit log `start` appends every
 *   `DaemonEvent` to — see `bin/audit-log.ts` — replayed into a task list /
 *   last-known-connection-state via `bin/tasks-view.ts`). This is honestly
 *   a historical snapshot: if no `start` has ever run, or a lot has happened
 *   since the last one exited, that's exactly what gets reported (never
 *   faked as "live").
 * - `runtimes` (and the compact runtime summary inside `status`) is a FRESH
 *   STANDALONE PROBE instead: it constructs the same bundled pi/claude/codex
 *   adapter set `createDaemon` would (see `bin/runtime-probe.ts`) and calls
 *   `detect()`/`capabilities()` directly, independent of whether any daemon
 *   is running. "What's on this machine right now" is more useful live than
 *   stale, and detection is cheap/side-effect-free, so there's no reason to
 *   read a historical snapshot here instead.
 * - `tasks --follow` tails `audit.jsonl` from its CURRENT end forward (like
 *   `tail -f`) rather than subscribing to a live process — see
 *   `bin/audit-log.ts`'s `followAuditLog`. Run plain `tasks` first for
 *   history.
 * - `unpair` constructs a fresh (never-started) `Daemon` and calls
 *   `.unpair()` directly — that's genuinely safe standalone, since clearing
 *   the on-disk device record doesn't require a live in-process daemon (see
 *   `create-daemon.ts`'s own doc comment on `unpair()`). It does NOT stop a
 *   separately running `start` process; it only affects that process' (or
 *   any future process') NEXT `start()`.
 * - `approve`/`reject` are the one case that genuinely CAN'T work this way:
 *   `Daemon.approve`/`reject` require a live `TaskRunner` in the SAME
 *   process (`create-daemon.ts` throws "daemon is not started" otherwise),
 *   and there is no IPC to reach one running in a different process. They're
 *   still wired here (constructing a fresh `Daemon` and calling the method
 *   directly) because that's the correct shape for the day cross-process
 *   IPC exists — today, invoking them prints an honest note explaining why
 *   they're ready-but-unexercised (see `commands/approve-reject.ts`) rather
 *   than silently faking success.
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
      '  byok-agent approve <taskId> [--config <path>]',
      '  byok-agent reject <taskId> [reason...] [--config <path>]',
      '  byok-agent unpair [--yes] [--config <path>]',
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

  if (command === 'approve' || command === 'reject') {
    const positionals = positionalArgs(rest, ['--config']);
    const taskId = positionals[0];
    if (!taskId) usage();
    const config = loadConfig(configPathFrom(rest));
    const daemon = createDaemon(config);
    if (command === 'approve') return runApproveCommand(daemon, taskId);
    const reason = positionals.slice(1).join(' ') || undefined;
    return runRejectCommand(daemon, taskId, reason);
  }

  if (command === 'unpair') {
    const config = loadConfig(configPathFrom(rest));
    const daemon = createDaemon(config);
    return runUnpairCommand(daemon, { confirmed: hasFlag(rest, '--yes') });
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
