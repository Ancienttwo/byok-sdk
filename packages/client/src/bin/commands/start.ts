import { createDaemon, type Daemon, type DaemonConfig } from '../../index';
import { createAuditAppender } from '../audit-log';
import { resolveStoreDir } from '../config';
import { formatDaemonEventLine } from '../format';

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
 * Runs the daemon in the foreground until `deps.signal` aborts. Every
 * `DaemonEvent` it observes is (a) appended to `<storeDir>/audit.jsonl` —
 * the only channel a separate `status`/`tasks`/`runtimes` invocation has
 * into this process' state, see `byok-agent.ts`'s header comment — and (b)
 * printed as one line to stdout via the SAME formatter `tasks --follow`
 * uses when tailing that log, so watching `start`'s own stdout and tailing
 * the audit log show identical text.
 */
export async function runStartCommand(config: DaemonConfig, deps: StartDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const storeDir = resolveStoreDir(config);
  const daemon = deps.daemon ?? createDaemon(config);

  const appendToAudit = createAuditAppender(storeDir, (err) =>
    error(`audit log append failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  // Subscribe BEFORE start() so the earliest events (runtimes-detected,
  // connection) are captured too — mirrors daemon-observer.test.ts's own
  // "subscribe before pair()/start()" convention.
  const unsubscribe = daemon.subscribe((event) => {
    appendToAudit(event);
    log(formatDaemonEventLine(event));
  });

  try {
    await daemon.start();
    // Exact "daemon started: ..." prefix preserved from the pre-M3-2b bin —
    // examples/basic/README.md tells a human operator to watch stdout for
    // this literal text.
    const label = config.branding?.displayName ?? config.productName;
    log(`daemon started: product=${label} (${config.productId}) server=${config.serverUrl}`);
    deps.onReady?.();

    if (!deps.signal.aborted) {
      await new Promise<void>((resolve) => {
        deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    unsubscribe();
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
