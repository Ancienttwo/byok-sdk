/**
 * A deterministic clock for the in-memory reference and the conformance suite.
 *
 * TTL behavior (presence expiry, activity expiry, reservation expiry) is part
 * of the contract, and asserting it against a wall clock means either sleeping
 * or accepting flakes. A composition under test injects one of these and moves
 * time explicitly.
 */
import type { MutableClock } from '../stores';

/** Fixed start instant, so golden-ish assertions in the suite read the same on every run. */
export const IN_MEMORY_CLOCK_EPOCH = '2026-01-01T00:00:00.000Z';

export function createMutableClock(start: Date = new Date(IN_MEMORY_CLOCK_EPOCH)): MutableClock {
  let current = start.getTime();
  return {
    now(): Date {
      return new Date(current);
    },
    advance(ms: number): void {
      current += ms;
    },
    set(instant: Date): void {
      current = instant.getTime();
    },
  };
}
