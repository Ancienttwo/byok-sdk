import type { ConnectionHalt, ConnectionManager, ConnectionState } from '../../daemon/connection-manager';
import type { Daemon } from '../../daemon/create-daemon';
import type { DaemonLifecycle } from '../../daemon/daemon-lifecycle';

/**
 * Test barriers for issue #391: `ConnectionManager.start()` and
 * `daemon.start()` no longer wait for the server, so a test that needs an
 * accepted session waits here instead. Both reject on a halt rather than
 * waiting out the deadline.
 */

export const OPEN_LIFECYCLE: DaemonLifecycle = { phase: 'running', connection: 'open' };

export interface OpenBarrier {
  readonly onStateChange: (state: ConnectionState) => void;
  readonly onHalted: (halt: ConnectionHalt) => void;
  /** Resolves once the server has accepted this session's `conn.hello`. */
  waitForOpen(connection: Pick<ConnectionManager, 'isOpen' | 'getHaltReason'>, timeoutMs?: number): Promise<void>;
}

/**
 * Pass `onStateChange` and `onHalted` to the `ConnectionManager` it waits on.
 * Event-driven because an outage session is open for only 1-2 ms, which a
 * poll can miss every time (#2354).
 */
export function openBarrier(): OpenBarrier {
  const waiters = new Set<(failure: Error | undefined) => void>();
  const wake = (failure: Error | undefined): void => {
    for (const waiter of [...waiters]) waiter(failure);
  };
  return {
    onStateChange: (state) => {
      if (state === 'open') wake(undefined);
    },
    onHalted: (halt) => wake(new Error(`the connection halted: ${halt.reason}`)),
    waitForOpen: (connection, timeoutMs = 10_000) => {
      if (connection.isOpen()) return Promise.resolve();
      const reason = connection.getHaltReason();
      if (reason !== undefined) return Promise.reject(new Error(`the connection halted: ${reason}`));
      return new Promise<void>((resolve, reject) => {
        const waiter = (failure: Error | undefined): void => {
          clearTimeout(timer);
          waiters.delete(waiter);
          if (failure === undefined) resolve();
          else reject(failure);
        };
        const timer = setTimeout(() => waiter(new Error(`timed out after ${timeoutMs}ms waiting for the connection to open`)), timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

/**
 * Resolves once the lifecycle is `running` + `open`; a halt rejects with
 * `DaemonHaltError`. Event-driven on `whenOpen()` because an outage session
 * is open for only 1-2 ms, which a poll can miss every time (#2354).
 */
export async function waitForDaemonOpen(daemon: Pick<Daemon, 'whenOpen'>, timeoutMs = 10_000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await daemon.whenOpen({ signal });
  } catch (error) {
    if (signal.aborted && error === signal.reason) throw new Error(`timed out after ${timeoutMs}ms waiting for the daemon to open`);
    throw error;
  }
}
