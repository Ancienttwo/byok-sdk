import os from 'node:os';
import { acquirePathMutationGate, type PathMutationGate } from '../util/path-mutation-gate.js';

/**
 * Bound on waiting for another store's clear, pairing or renewal; a timeout
 * is a busy gate (`PathMutationGateBusyError`), never revocation. 30 s is the
 * largest wait the path-mutation gate accepts. It covers a holder's
 * validate-and-write, which is two to four OS credential commands of at most
 * 15 s each, in the usual case; a holder stuck past it fails the waiter as
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
 * order: the store owner lease first, then this gate. A holder only validates
 * and writes or deletes under it, and never holds it across network I/O: an
 * enrollment clear from its validation through its deletion, a pairing around
 * staging its attempt and around persisting the enrollment, a renewal around
 * persisting the new token. The OS entry is per user, and so is the gate.
 * `signal` abandons the wait; a gate acquired after the abort is released.
 */
export async function acquireEnrollmentGate(productId: string, signal?: AbortSignal): Promise<PathMutationGate> {
  // The darwin and linux gates are per uid already; a win32 named pipe is
  // machine-wide, so the user name keeps two users' enrollments apart.
  const user = process.platform === 'win32' ? `${os.userInfo().username}:` : '';
  const acquiring = acquirePathMutationGate({ scope: `device-enrollment:${user}${productId}` }, { waitMs: ENROLLMENT_GATE_WAIT_MS });
  if (signal === undefined) return acquiring;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([acquiring, aborted]);
  } catch (error) {
    if (signal.aborted) void acquiring.then((gate) => gate.release(), () => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
