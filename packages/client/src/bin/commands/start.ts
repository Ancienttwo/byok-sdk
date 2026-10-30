import { createDaemon, type Daemon, type DaemonConfig } from '../../index';
import { DaemonHaltError, type DaemonHaltReason } from '../../daemon/daemon-lifecycle';
import { createDaemonRecordProjector, type DaemonRecord } from '../../daemon/daemon-record';
import { serviceEnvironmentStatus, type ServiceEnvironmentStatus } from '../../login-shell-environment';
import { createAuditAppender } from '../audit-log';
import { ConfigError, resolveStoreDir } from '../config';
import { DaemonOwnerActiveError } from '../../daemon/daemon-owner';
import { isRuntimeDisposalFailure } from '../../runtime-failure';
import { formatHaltRemedy, formatServiceEnvironment } from '../format';

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
 * How a `start` ended without crashing (issue #394). A crash is a throw
 * (including {@link DaemonCrashedError} for a crash after start).
 * `byok-agent.ts` maps these to exit codes: `stopped` 0, `halted` 78
 * (0 under `--service`), a throw 1.
 */
export type StartOutcome = { kind: 'stopped' } | { kind: 'halted'; reason: DaemonHaltReason };

/** The run crashed after start (`lifecycle` `crashed`); the cause was logged when it happened. */
export class DaemonCrashedError extends Error {
  constructor() {
    super('daemon crashed after start; see the error logged above');
    this.name = 'DaemonCrashedError';
  }
}

/** @internal One content-free diagnostic for start's durable stderr sink. */
export function formatStartErrorReason(error: unknown): string {
  // These SDK classes contain only fixed templates and configured identifiers.
  // Config loading must never interpolate a parser/library error into them.
  if (error instanceof ConfigError || error instanceof DaemonOwnerActiveError
    || error instanceof DaemonHaltError || error instanceof DaemonCrashedError) {
    return `${error.name}: ${error.message}`;
  }
  if (isRuntimeDisposalFailure(error)) {
    return `RuntimeDisposalFailure stage=${error.stage} reasonBytes=${Buffer.byteLength(error.message, 'utf8')}`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  // Unknown names and codes can themselves contain runtime text.
  return `${error instanceof Error ? 'Error' : 'UnknownError'} reasonBytes=${Buffer.byteLength(reason, 'utf8')}`;
}

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
 * `shutdown` completes, or the daemon halts (`lifecycle` `halted`).
 *
 * Issue #395: every `DaemonEvent` it observes is projected to content-free
 * `DaemonRecord`s (`daemon/daemon-record.ts`), and each record is written to
 * BOTH durable sinks as one identical JSON line: `<storeDir>/audit.jsonl` —
 * the only channel a separate `status`/`tasks` invocation has into this
 * process, see `byok-agent.ts`'s header comment — and stdout, which is a
 * service log under launchd/systemd/WinSW. The process's own
 * `environment-resolved`, `daemon-started` and `daemon-stopped` records go
 * through the same path. Full content is only on the authenticated control
 * socket (`tasks --follow`). Errors go to stderr through the same content-free diagnostic formatter.
 */
export async function runStartCommand(config: DaemonConfig, deps: StartDeps): Promise<StartOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const storeDir = resolveStoreDir(config);
  const daemon = deps.daemon ?? createDaemon(config);
  const projector = createDaemonRecordProjector();
  const audit = createAuditAppender(storeDir, (err) =>
    error(`audit log append failed: ${formatStartErrorReason(err)}`),
  );
  const persist = (record: DaemonRecord): void => {
    log(audit.append(record));
  };

  // The daemon emits environment-resolved after acquiring ownership (#439).
  // Only startup failure diagnostics use this host-side snapshot.
  const environment = deps.environment ?? serviceEnvironmentStatus();

  // M4 Phase 2: the daemon's control socket (`shutdown` RPC — see
  // `create-daemon.ts`'s `performControlShutdown`) can stop the daemon from
  // OUTSIDE this process, with no OS signal involved at all. Without reacting
  // to that here, this function would hang forever awaiting `deps.signal`.
  //
  // It waits for `shutdown-complete`, not `shutdown-requested`: the latter
  // fires at the very START of `performControlShutdown`, and waking that early
  // let this function's own `daemon.stop()` close the connection before an
  // in-flight `task.fail` reached the outbox drain. `shutdown-complete` fires
  // once that teardown has finished; see `daemon-control-socket.test.ts`.
  let controlShutdownComplete = false;
  let wake: (() => void) | undefined;
  // Issue #394: a halt the server causes (revocation, a rejected hello, a
  // lost replay cursor) ends this process too: nothing reconnects after it.
  let haltReason: DaemonHaltReason | undefined;
  // A crash after start (`lifecycle` `crashed`) also ends this process, as a
  // crash: exit 1, so the supervisor restarts it.
  let crashed = false;
  // Subscribe BEFORE start() so the earliest events (runtimes-detected,
  // lifecycle) are captured too.
  const unsubscribe = daemon.subscribe((event) => {
    for (const record of projector.project(event)) persist(record);
    if (event.kind === 'shutdown-complete') {
      controlShutdownComplete = true;
      wake?.();
    }
    if (event.kind === 'lifecycle' && event.lifecycle.phase === 'halted') {
      haltReason = event.lifecycle.reason;
      wake?.();
    }
    if (event.kind === 'lifecycle' && event.lifecycle.phase === 'crashed') {
      crashed = true;
      wake?.();
    }
  });

  const halted = async (reason: DaemonHaltReason): Promise<StartOutcome> => {
    error(`daemon halted: reason=${reason} — ${formatHaltRemedy(reason)}`);
    await audit.flush();
    return { kind: 'halted', reason };
  };

  try {
    try {
      await daemon.start();
    } catch (err) {
      // No record carries the environment of a start that did not succeed;
      // the service's stderr log still shows it (closed values only, #392).
      error(`environment: ${formatServiceEnvironment(environment)}`);
      if (!(err instanceof DaemonHaltError)) throw err;
      // start() has already torn its partial startup down; this stop() only
      // settles anything a caller-built daemon may still hold.
      await daemon.stop().catch((cleanupErr: unknown) => {
        error(`cleanup failed during shutdown: ${formatStartErrorReason(cleanupErr)}`);
      });
      unsubscribe();
      return await halted(err.reason);
    }
    persist({ kind: 'daemon-started', ts: new Date().toISOString(), productId: config.productId });
    deps.onReady?.();

    if (!deps.signal.aborted && !controlShutdownComplete && haltReason === undefined && !crashed) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    await daemon.stop();
    unsubscribe();
    // Turns still open when the daemon stopped, then the stop itself.
    const stoppedAt = new Date().toISOString();
    for (const record of projector.flush(stoppedAt)) persist(record);
    persist({ kind: 'daemon-stopped', ts: stoppedAt });
    if (haltReason !== undefined) return await halted(haltReason);
    if (crashed) {
      await audit.flush();
      throw new DaemonCrashedError();
    }
    await audit.flush();
    return { kind: 'stopped' };
  } catch (err) {
    if (err instanceof DaemonCrashedError) throw err;
    unsubscribe();
    await daemon.stop().catch((cleanupErr: unknown) => {
      error(`cleanup failed during shutdown: ${formatStartErrorReason(cleanupErr)}`);
    });
    throw err;
  }
}
