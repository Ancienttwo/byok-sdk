import os from 'node:os';
import { acquirePathMutationGate, type PathMutationGate } from '../util/path-mutation-gate.js';
import type { AuthManager } from './auth-manager.js';

/**
 * Bound on waiting for another store's clear, pairing or renewal; a timeout
 * is a busy gate (`PathMutationGateBusyError`), never revocation. 30 s is the
 * largest wait the path-mutation gate accepts. It covers the usual hold: two
 * to four OS credential commands of at most 15 s each. There is no deadline
 * on the whole hold: each OS credential command has its own. A holder stuck
 * past 30 s fails the waiter
 * as busy instead of blocking it (#2045 F5). A renewal waits only after its token exchange
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
 * validating and persisting the new token. A pairing takes it around each
 * local step: staging its attempt, checking it still owns that attempt
 * before a resend, and persisting the enrollment. The server's registration
 * fence (#2045) is what keeps a pairing in flight from superseding a later
 * one. Member writes, of a running daemon and of a pairing's E2EE custody,
 * take it around each write and its binding reread (#2055). No holder keeps
 * it across network I/O. The OS entry is per user, and so is the gate.
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

type MemberWrites = <T>(auth: AuthManager, write: () => Promise<T>, signal: AbortSignal) => Promise<T>;
let memberWrites: MemberWrites | undefined;

/** `AuthManager`'s static block registers {@link writeUnderBinding} here, so the seam stays out of its public type. */
export function registerMemberWrites(writes: MemberWrites): void {
  memberWrites = writes;
}

/**
 * Package-internal daemon seam (#2055): runs `write` of the shared E2EE
 * member entries under this gate, after `auth` rereads that the OS entry and
 * `device.json` still hold its run's enrollment. Otherwise it writes nothing
 * and loses the binding as a renewal does. `signal` also ends the wait in
 * `auth`'s credential mutation queue, so a member run a re-pair aborts never
 * waits behind a renewal that waits for the re-pair's gate. Never hold it
 * across network I/O.
 */
export function writeUnderBinding<T>(auth: AuthManager, write: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return memberWrites!(auth, write, signal);
}
