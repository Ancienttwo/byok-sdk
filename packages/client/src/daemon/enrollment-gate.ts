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
  return acquirePathMutationGate({ scope: `device-enrollment:${productId}` }, { waitMs: ENROLLMENT_GATE_WAIT_MS });
}
