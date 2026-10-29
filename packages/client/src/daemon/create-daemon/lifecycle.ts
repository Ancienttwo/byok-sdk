import { startControlServer, AnotherControlServerRunningError } from '../control-server';
import { type DaemonLifecycle, type DaemonHaltReason, DaemonHaltError } from '../daemon-lifecycle';
import { InsecureServerUrlError } from '../url';
import { DeviceRecordRePairRequiredError } from '../store';
import { DeviceStoreBindingMismatchError } from '../daemon-errors';
import { CursorUnreadableError } from '../cursor-store';
import { AuthRequestAbortedError, DeviceRevokedError } from '../auth-manager';
import { SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS } from './support';
import type { DaemonScope } from './scope';

/** The daemon lifecycle: the serialized mutation slot, lifecycle phases, start and stop (#926). */

export async function runLifecycleMutation<T>(daemonScope: DaemonScope, operation: () => Promise<T>): Promise<T> {
  const { daemonState } = daemonScope;
  const predecessor = daemonState.lifecycleMutationTail;
  let release!: () => void;
  daemonState.lifecycleMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Serves the full or the enrollment-only method table. A running endpoint
 * switches tables in place on its same listener and token: closing it would
 * publish "gone" (`isControlDaemonGone`) while this daemon still holds its
 * store lease, and a contender would then find the live mutex. Only a daemon
 * without an endpoint binds one.
 */
export async function replaceControlServer(daemonScope: DaemonScope, required: boolean, enrollmentOnly = false): Promise<void> {
  const { daemonState, controlMethods, storeDir, config } = daemonScope;
  const methods = enrollmentOnly
    ? {
        unary: {
          status: controlMethods.unary.status!,
          'enrollment.pair': controlMethods.unary['enrollment.pair']!,
          shutdown: controlMethods.unary.shutdown!,
        },
        stream: {},
      }
    : controlMethods;
  if (daemonState.controlServerHandle) {
    daemonState.controlServerHandle.setMethods(methods);
    return;
  }
  try {
    daemonState.controlServerHandle = await startControlServer({ storeDir, productId: config.productId, methods });
  } catch (err) {
    if (required || err instanceof AnotherControlServerRunningError) throw err;
    console.warn(
      `[byok/client] control socket failed to start (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
    );
    daemonState.controlServerHandle = undefined;
  }
}

/** One report path per lifecycle fact: `status().lifecycle` and the `lifecycle` event change together. */
export function setLifecycle(daemonScope: DaemonScope, next: DaemonLifecycle): void {
  const { daemonState, observer } = daemonScope;
  if (JSON.stringify(next) === JSON.stringify(daemonState.lifecycle)) return;
  daemonState.lifecycle = next;
  observer.noteLifecycle(next);
}

export function halted(daemonScope: DaemonScope, reason: DaemonHaltReason): void {
  const { setLifecycle } = daemonScope;
  setLifecycle({ phase: 'halted', reason, at: new Date().toISOString() });
  endActiveTasks(daemonScope, `halted: ${reason}`);
}

/**
 * #394's crash path for a run that already started: the connection has
 * stopped itself; record the `lifecycle` health failure and report the
 * crash. Like a halt, the daemon stays up for its owner to stop.
 */
export function crashed(daemonScope: DaemonScope): void {
  const { setLifecycle, operationalHealth } = daemonScope;
  setLifecycle({ phase: 'crashed', at: new Date().toISOString() });
  endActiveTasks(daemonScope, 'crashed');
  void operationalHealth.recordFailure('lifecycle').catch((err: unknown) => {
    console.warn(`[byok/client] failed to persist operational health: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * #1119: a run that ended (halted or crashed) takes no more offers and ends
 * its active tasks now, whether or not its owner ever calls `stop()`, so an
 * embedded Host and `byok-agent` behave the same. Each `task.fail` is
 * journaled (the connection has ended) and reported by the next `start()`.
 * Each soft interrupt is capped at the shutdown grace, so every task reaches
 * close and its fail is journaled within it even when a runtime never answers.
 * The pass is a late mutation barrier: `stop()` waits for it, bounded by the
 * shutdown grace, before its own pass and before releasing ownership.
 */
function endActiveTasks(daemonScope: DaemonScope, reason: string): void {
  const { daemonState, pendingLateMutationBarriers, config } = daemonScope;
  const runner = daemonState.runner;
  if (runner === undefined) return;
  runner.stopAcceptingOffers();
  const graceMs = config.shutdownGraceMs ?? SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS;
  const teardown = runner.shutdownActiveTasks(reason, graceMs).catch((err: unknown) => {
    console.warn(`[byok/client] ending active tasks after the run ${reason} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  pendingLateMutationBarriers.add(teardown);
  void teardown.finally(() => pendingLateMutationBarriers.delete(teardown));
}

export async function start(daemonScope: DaemonScope): Promise<void> {
  const { checkServerUrl, startUnderLease } = daemonScope;
  try {
    checkServerUrl();
  } catch (err) {
    if (err instanceof InsecureServerUrlError) throw new DaemonHaltError('config_invalid', { cause: err });
    throw err;
  }
  await runAuthOperation(daemonScope, startUnderLease);
}

/**
 * Resume only in the operation's lifecycle slot: an earlier shutdown must
 * finish before auth is re-armed. A later stop invalidates the queued request
 * synchronously, so entering its slot cannot undo that cancellation.
 * `cancellationEpoch` is the epoch the request was made in; an operation that
 * continues an earlier request (service enrollment's start) passes that one.
 */
export async function runAuthOperation<T>(
  daemonScope: DaemonScope,
  operation: (cancellationEpoch: number) => Promise<T>,
  cancellationEpoch = daemonScope.daemonState.authCancellationEpoch,
): Promise<T> {
  const { daemonState } = daemonScope;
  daemonState.pendingAuthOperations += 1;
  try {
    return await daemonScope.runLifecycleMutation(async () => {
      if (cancellationEpoch !== daemonState.authCancellationEpoch) throw new AuthRequestAbortedError('stopped');
      daemonState.auth.resume();
      return operation(cancellationEpoch);
    });
  } finally {
    daemonState.pendingAuthOperations -= 1;
  }
}

/**
 * The halts a start can find locally. Anything else thrown from startup is
 * a crash. `store_owned` is found before this process owns the store, so it
 * is thrown only (see {@link DaemonHaltError}).
 */
export function startupHaltReason(daemonScope: DaemonScope, err: unknown): DaemonHaltReason | undefined {
  if (err instanceof DaemonHaltError) return err.reason;
  if (err instanceof AnotherControlServerRunningError) return 'store_owned';
  if (err instanceof DeviceRecordRePairRequiredError) return 're_pair_required';
  if (err instanceof DeviceStoreBindingMismatchError) return 'store_not_bound';
  if (err instanceof DeviceRevokedError) return 'device_revoked';
  if (err instanceof CursorUnreadableError) return 'cursor_unreadable';
  return undefined;
}

/** `requestEpoch` is the `authCancellationEpoch` the start was requested in. */
export async function startUnderLease(daemonScope: DaemonScope, requestEpoch: number): Promise<void> {
  const { daemonState, runStartUnderLease } = daemonScope;
  daemonState.startInProgress = true;
  try {
    await runStartUnderLease(requestEpoch);
  } finally {
    daemonState.startInProgress = false;
  }
}

/**
 * Public `Daemon.stop()` (also `unpair()`'s own teardown, below) — see
 * `runShutdownSequence`'s own doc comment for the sequence this now runs.
 * `opts` is an internal-only extension of the public `stop(): Promise<void>`
 * interface (this file already has the analogous `performControlShutdown`
 * convention of calling this closure directly with extra options a plain
 * `Daemon.stop()` caller never needs to pass): `performControlShutdown`
 * below supplies its own `reason` instead of this default.
 */
export async function stop(daemonScope: DaemonScope, opts: { drainTimeoutMs?: number; reason?: string } = {}): Promise<void> {
  const { daemonState, requestShutdown } = daemonScope;
  // Plan `device-assertion-broker` (codex round-2 F1): arm the minting latch
  // the INSTANT `stop()` is called, before `requestShutdown` enqueues the
  // teardown behind any in-progress lifecycle mutation. `runShutdownSequence`
  // sets it too, but that runs only AFTER `runLifecycleMutation` awaits its
  // predecessor — so a `stop()` queued behind an in-progress `start()`/
  // `pair()` would otherwise leave the control socket minting with
  // `shuttingDown === false` for the whole duration of that predecessor.
  // Setting it here, synchronously, before the first await, closes that gap.
  daemonState.shuttingDown = true;
  cancelAuthOperations(daemonScope);
  await requestShutdown(opts.reason ?? 'operator', { drainTimeoutMs: opts.drainTimeoutMs });
}

/**
 * Cancels every start and pair requested before now, the queued and the
 * running. Call it synchronously when a stop is requested (`stop()`, the
 * control `shutdown` RPC), before any await.
 */
export function cancelAuthOperations(daemonScope: DaemonScope): void {
  const { daemonState } = daemonScope;
  daemonState.authCancellationEpoch += 1;
  // A start or pair may be blocked in an OS credential call (a locked
  // keychain) and the teardown queues behind it. Signal first: the auth
  // manager's stop is the one cancellation for those calls; then await the
  // operation settling.
  if (daemonState.pendingAuthOperations > 0) void daemonState.auth.stop().catch(() => undefined);
}

export function requestShutdown(daemonScope: DaemonScope, reason: string, opts: { drainTimeoutMs?: number } = {}): Promise<void> {
  const { daemonState, runLifecycleMutation, runShutdownSequence } = daemonScope;
  if (daemonState.shutdownPromise) return daemonState.shutdownPromise;
  const current = runLifecycleMutation(() => runShutdownSequence(reason, opts));
  daemonState.shutdownPromise = current;
  void current.finally(() => {
    if (daemonState.shutdownPromise === current) daemonState.shutdownPromise = undefined;
  }).catch(() => undefined);
  return current;
}
