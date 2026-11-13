import os from 'node:os';
import { acquirePathMutationGate, type PathMutationGate } from '../util/path-mutation-gate.js';

/**
 * Bound on waiting for another store's clear, pairing or renewal; a timeout
 * is a busy gate (`PathMutationGateBusyError`), never revocation. 30 s is the
 * largest wait the path-mutation gate accepts. It covers the usual hold: two
 * to four OS credential commands of at most 15 s each, or a pairing's request
 * under its 15 s default deadline. A holder stuck past it fails the waiter as
 * busy instead of blocking it. A renewal waits only after its token exchange
 * and starts 60 s before expiry. A busy timeout writes nothing, and the next
 * call renews again, because the 30 s renewal floor counts only successful
 * renewals; if a slow exchange plus a full wait outlasts the 60 s margin, the
 * cached token expires first and the next request's 401 renews reactively.
 * The wait never delays shutdown: `stop()` aborts it at once through the
 * mutation signal.
 */
const ENROLLMENT_GATE_WAIT_MS = 30_000;

/**
 * The productId-wide lock on the OS credential entry (#1964, #2034). Lock
 * order: the store owner lease first, then this gate. An enrollment clear
 * holds it from its validation through its deletion and a renewal around
 * validating and persisting the new token; a renewal never holds it across
 * network I/O. A pairing holds it across its own request, because the
 * server's registration has no fencing (#2045 F1): a request that times out
 * releases the gate while the server may still register it, and only server
 * fencing closes that gap. The OS entry is per user, and so is the gate.
 * `signal` abandons the wait; a gate acquired after the abort is released.
 */
export async function acquireEnrollmentGate(productId: string, signal?: AbortSignal): Promise<PathMutationGate> {
  // Checked before the acquisition starts, so an aborted caller starts none.
  signal?.throwIfAborted();
  // The darwin and linux gates are per uid already; a win32 named pipe is
  // machine-wide, so the user name keeps two users' enrollments apart.
  const user = process.platform === 'win32' ? `${os.userInfo().username}:` : '';
  const acquiring = acquirePathMutationGate({ scope: `device-enrollment:${user}${productId}` }, { waitMs: ENROLLMENT_GATE_WAIT_MS });
  if (signal === undefined) return acquiring;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([acquiring, aborted]);
  } catch (error) {
    // The acquisition outlives an abort: release a gate it still obtains.
    if (signal.aborted) void acquiring.then((gate) => gate.release().catch(() => {}), () => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
