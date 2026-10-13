import { createDaemon, type Daemon, type DaemonConfig } from '../../index';
import { serviceEnvironmentStatus, type ServiceEnvironmentStatus } from '../../lifecycle/service-environment';
import { appendEnvironmentRecord, createAuditAppender } from '../audit-log';
import { resolveStoreDir } from '../config';
import { formatServiceEnvironment, StartStdoutProjector } from '../format';

export interface StartDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** DI for tests: drive a pre-built (e.g. stub-adapter-backed) `Daemon` instead of the real `createDaemon(config)`. */
  daemon?: Daemon;
  /** Test hook: fires once `daemon.start()` has resolved and the banner line has been logged — lets a test abort deterministically instead of racing real timing. Unused by the real CLI entry. */
  onReady?: () => void;
  /** Required: there is no sane default "never stop" signal. The real CLI entry (`byok-agent.ts`) wires this to SIGINT/SIGTERM; tests wire their own `AbortController`. */
  signal: AbortSignal;
  /** Issue #392: where this process's environment came from. Defaults to {@link serviceEnvironmentStatus} (`byok-agent.ts` applied it for `--service`). */
  environment?: ServiceEnvironmentStatus;
}

/**
 * Runs the daemon in the foreground until `deps.signal` aborts. Every
 * `DaemonEvent` it observes is (a) appended to `<storeDir>/audit.jsonl` —
 * the only channel a separate `status`/`tasks`/`runtimes` invocation has
 * into this process' state, see `byok-agent.ts`'s header comment — and (b)
 * projected to stdout by `StartStdoutProjector` (`bin/format.ts`): the
 * one-line formatter `tasks --follow` uses, with free-form text redacted and
 * each turn's progress folded into at most one sizes-and-counts line,
 * because this stdout is a service log (issue #395).
 */
export async function runStartCommand(config: DaemonConfig, deps: StartDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const storeDir = resolveStoreDir(config);
  const daemon = deps.daemon ?? createDaemon(config);
  const stdout = new StartStdoutProjector();

  // Issue #392: where this process's environment came from. Printed first
  // (the service log shows it even when start fails), and recorded for
  // `status` only once start() succeeded — i.e. by the process that owns the
  // store — so a rejected second `start` never overwrites what the running
  // daemon sees.
  const environment = deps.environment ?? serviceEnvironmentStatus();
  log(`environment: ${formatServiceEnvironment(environment)}`);

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
  let notifyControlShutdown: (() => void) | undefined;
  // Subscribe BEFORE start() so the earliest events (runtimes-detected,
  // connection) are captured too — mirrors daemon-observer.test.ts's own
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
    for (const line of stdout.accept(event)) log(line);
    if (event.kind === 'shutdown-complete') {
      controlShutdownComplete = true;
      notifyControlShutdown?.();
    }
  });

  try {
    await daemon.start();
    await appendEnvironmentRecord(storeDir, { status: environment, ts: new Date().toISOString() }).catch((err: unknown) => {
      error(`audit log append failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Exact "daemon started: ..." prefix preserved from the pre-M3-2b bin —
    // examples/basic/README.md tells a human operator to watch stdout for
    // this literal text.
    const label = config.branding?.displayName ?? config.productName;
    log(`daemon started: product=${label} (${config.productId}) server=${config.serverUrl}`);
    deps.onReady?.();

    if (!deps.signal.aborted && !controlShutdownComplete) {
      await new Promise<void>((resolve) => {
        notifyControlShutdown = resolve;
        deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    unsubscribe();
    for (const line of stdout.flush(new Date().toISOString())) log(line);
    await daemon.stop();
    log('daemon stopped');
  } catch (err) {
    unsubscribe();
    await daemon.stop().catch((cleanupErr: unknown) => {
      error(`cleanup failed during shutdown: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    });
    throw err;
  }
}
