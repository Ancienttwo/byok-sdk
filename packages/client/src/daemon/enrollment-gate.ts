import os from 'node:os';
import { acquirePathMutationGate, type PathMutationGate } from '../util/path-mutation-gate.js';

/** Bounded wait for the other store's clear or pairing credential writes. */
const ENROLLMENT_GATE_WAIT_MS = 30_000;

/**
 * The productId-wide lock on the OS credential entry (#1964). Lock order: the
 * store owner lease first, then this gate. An enrollment clear holds it from
 * its validation through its deletion; a pairing holds it across its
 * credential writes. The OS entry is per user, and so is the gate.
 */
export function acquireEnrollmentGate(productId: string): Promise<PathMutationGate> {
  // The darwin and linux gates are per uid already; a win32 named pipe is
  // machine-wide, so the user name keeps two users' enrollments apart.
  const user = process.platform === 'win32' ? `${os.userInfo().username}:` : '';
  return acquirePathMutationGate({ scope: `device-enrollment:${user}${productId}` }, { waitMs: ENROLLMENT_GATE_WAIT_MS });
}
