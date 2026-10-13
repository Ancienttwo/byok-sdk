import type { ConnectionManager } from '../../daemon/connection-manager';
import type { DaemonStatus } from '../../daemon/create-daemon';
import type { DaemonLifecycle } from '../../daemon/daemon-lifecycle';

/**
 * Test barriers for issue #391: `ConnectionManager.start()` and
 * `daemon.start()` no longer wait for the server, so a test that needs an
 * accepted session waits here instead. Both reject on a halt rather than
 * waiting out the deadline.
 */

export const OPEN_LIFECYCLE: DaemonLifecycle = { phase: 'running', connection: 'open' };

async function poll(check: () => boolean, halted: () => string | undefined, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    const reason = halted();
    if (reason !== undefined) throw new Error(`${what} halted: ${reason}`);
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} to open`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Resolves once the server has accepted this session's `conn.hello`. */
export function waitForOpen(connection: ConnectionManager, timeoutMs = 10_000): Promise<void> {
  return poll(() => connection.isOpen(), () => connection.getHaltReason(), timeoutMs, 'the connection');
}

/** Resolves once `status().lifecycle` is `running` + `open`. */
export function waitForDaemonOpen(daemon: { status(): Pick<DaemonStatus, 'lifecycle'> }, timeoutMs = 10_000): Promise<void> {
  return poll(
    () => {
      const lifecycle = daemon.status().lifecycle;
      return lifecycle.phase === 'running' && lifecycle.connection === 'open';
    },
    () => {
      const lifecycle = daemon.status().lifecycle;
      return lifecycle.phase === 'halted' ? lifecycle.reason : undefined;
    },
    timeoutMs,
    'the daemon',
  );
}
