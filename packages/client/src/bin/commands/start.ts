import { createDaemon, type Daemon, type DaemonConfig } from '../../index';
import { DaemonHaltError, type DaemonHaltReason } from '../../daemon/daemon-lifecycle';
import { serviceEnvironmentStatus } from '../../lifecycle/service-environment';
import { createAuditAppender } from '../audit-log';
import { resolveStoreDir } from '../config';
import { formatHaltRemedy, formatServiceEnvironment, StartStdoutProjector } from '../format';

export interface StartDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** DI for tests: drive a pre-built (e.g. stub-adapter-backed) `Daemon` instead of the real `createDaemon(config)`. */
  daemon?: Daemon;
  /** Test hook: fires once `daemon.start()` has resolved and the banner line has been logged — lets a test abort deterministically instead of racing real timing. Unused by the real CLI entry. */
  onReady?: () => void;
  /** Required: there is no sane default "never stop" signal. The real CLI entry (`byok-agent.ts`) wires this to SIGINT/SIGTERM; tests wire their own `AbortController`. */
  signal: AbortSignal;
}

/**
 * How a `start` ended without crashing (issue #394). A crash is a throw.
 * `byok-agent.ts` maps these to exit codes: `stopped` 0, `halted` 78
 * (0 under `--service`), a throw 1.
 */
export type StartOutcome = { kind: 'stopped' } | { kind: 'halted'; reason: DaemonHaltReason };

/**
 * Issue #394, the `start` exit-code contract: 0 a normal stop, 78 a halt
 * (EX_CONFIG: a restart cannot fix it), 1 a crash (`main().catch`). Under
 * `--service` a halt exits 0 too: it is the one status launchd
 * (`SuccessfulExit`), systemd (`Restart=on-failure`) and WinSW (`onfailure`)
 * all leave stopped, while a crash still exits 1 and is restarted.
 */
export function startExitCode(outcome: StartOutcome, service: boolean): number {
  if (outcome.kind === 'stopped') return 0;
  return service ? 0 : 78;
}

/**
 * Runs the daemon in the foreground until `deps.signal` aborts, a control
 * `shutdown` completes, or the daemon halts (`lifecycle` `halted`). Every
 * `DaemonEvent` it observes is (a) appended to `<storeDir>/audit.jsonl` —
 * the only channel a separate `status`/`tasks`/`runtimes` invocation has
 * into this process' state, see `byok-agent.ts`'s header comment — and (b)
 * projected to stdout by `StartStdoutProjector` (`bin/format.ts`): the
 * one-line formatter `tasks --follow` uses, with free-form text redacted and
 * each turn's progress folded into at most one sizes-and-counts line,
 * because this stdout is a service log (issue #395).
 */
export async function runStartCommand(config: DaemonConfig, deps: StartDeps): Promise<StartOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const storeDir = resolveStoreDir(config);
  const daemon = deps.daemon ?? createDaemon(config);
  const stdout = new StartStdoutProjector();

  // Issue #392: where this process's environment came from
  // (`byok-agent.ts` applied the login shell for `--service`). Printed first,
  // so the service log shows it even when start fails. The record `status`
  // reads is the daemon's own `environment-resolved` event, which reaches the
  // audit log below like every other event — and only from a daemon that got
  // past the single-owner bind.
  log(`environment: ${formatServiceEnvironment(serviceEnvironmentStatus())}`);

  const appendToAudit = createAuditAppender(storeDir, (err) =>
    error(`audit log append failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  // M4 Phase 2: the daemon's control socket (`shutdown` RPC — see
  // `create-daemon.ts`'s `performControlShutdown`) can stop the daemon from
  // OUTSIDE this process (a separate `byok-agent unpair`/`service-stop`-like
  // invocation), with no OS signal involved at all. Without reacting to
  // that here, this function would hang forever awaiting `deps.signal`'s
  // abort, which would never come — see the wait below.
  //
  // Gatekeeper-confirmed regression (fixed here): this used to wait for
  // `shutdown-requested`, which fires SYNCHRONOUSLY at the very START of
  // `performControlShutdown` — before it has even called
  // `session.interrupt()` on an active task, let alone sent that task's
  // `task.fail`. Waking up that early let this function's own
  // `daemon.stop()` call below race ahead and close the connection
  // (`ConnectionManager.stopped = true`, synchronously) before the
  // still-in-flight `task.fail` send could reach the outbox drain,
  // silently dropping it. `shutdown-complete` fires only once
  // `performControlShutdown` has ALREADY finished its own internal
  // `stop()` — waiting for that instead means this function's `daemon.stop()`
  // below always runs strictly after the real teardown (interrupt -> send
  // task.fail -> finish -> stop) has completed, so it can never race ahead
  // of it; see `daemon-control-socket.test.ts`'s dedicated regression test.
  let controlShutdownComplete = false;
  let wake: (() => void) | undefined;
  // Issue #394: a halt the server causes (revocation, a rejected hello, a
  // lost replay cursor) ends this process too: nothing reconnects after it.
  let haltReason: DaemonHaltReason | undefined;
  // Stdout closes at shutdown (open turns are flushed first); the audit log
  // keeps recording through `daemon.stop()`, so it ends on the final
  // lifecycle the offline `status`/`doctor`/`service-status` read.
  let stdoutOpen = true;
  // Subscribe BEFORE start() so the earliest events (environment-resolved,
  // runtimes-detected, lifecycle) are captured too — mirrors daemon-observer.test.ts's own
  // "subscribe before pair()/start()" convention.
  const unsubscribe = daemon.subscribe((event) => {
    appendToAudit(event);
    // Finding F8 (cross-model adversarial review): this stdout stream is
    // captured verbatim by whatever's running `start` — a human's terminal,
    // but ALSO launchd/systemd/WinSW service logs when installed as a
    // background service. An `awaiting-approval` summary can carry the
    // exact tool-call text (a shell command, a file's contents) a
    // `confirm`-mode policy is gating; redact it here the same way
    // `appendToAudit` above already redacts it on disk. The full summary
    // stays available via the AUTHENTICATED control socket — the new
    // `approvals` CLI command, `approvals.list`, or `tasks --follow`'s own
    // `tasks.subscribe` path (`bin/commands/tasks.ts`, which does NOT set
    // this flag).
    //
    // Issue #395 (minimal): the same rule now covers model text. Each turn's
    // progress is folded into at most one sizes-and-counts line, and
    // completed/failed/cancelled text is redacted — see `StartStdoutProjector`.
    if (stdoutOpen) for (const line of stdout.accept(event)) log(line);
    if (event.kind === 'shutdown-complete') {
      controlShutdownComplete = true;
      wake?.();
    }
    if (event.kind === 'lifecycle' && event.lifecycle.phase === 'halted') {
      haltReason = event.lifecycle.reason;
      wake?.();
    }
  });

  const halted = async (reason: DaemonHaltReason): Promise<StartOutcome> => {
    error(`daemon halted: reason=${reason} — ${formatHaltRemedy(reason)}`);
    await appendToAudit.flush();
    return { kind: 'halted', reason };
  };

  try {
    try {
      await daemon.start();
    } catch (err) {
      if (!(err instanceof DaemonHaltError)) throw err;
      // start() has already torn its partial startup down; this stop() only
      // settles anything a caller-built daemon may still hold.
      await daemon.stop().catch((cleanupErr: unknown) => {
        error(`cleanup failed during shutdown: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      });
      unsubscribe();
      return await halted(err.reason);
    }
    // Exact "daemon started: ..." prefix preserved from the pre-M3-2b bin —
    // examples/basic/README.md tells a human operator to watch stdout for
    // this literal text.
    const label = config.branding?.displayName ?? config.productName;
    log(`daemon started: product=${label} (${config.productId}) server=${config.serverUrl}`);
    deps.onReady?.();

    if (!deps.signal.aborted && !controlShutdownComplete && haltReason === undefined) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    stdoutOpen = false;
    for (const line of stdout.flush(new Date().toISOString())) log(line);
    await daemon.stop();
    unsubscribe();
    log('daemon stopped');
    if (haltReason !== undefined) return await halted(haltReason);
    await appendToAudit.flush();
    return { kind: 'stopped' };
  } catch (err) {
    unsubscribe();
    await daemon.stop().catch((cleanupErr: unknown) => {
      error(`cleanup failed during shutdown: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    });
    throw err;
  }
}
