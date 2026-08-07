/**
 * The composition-parameterized conformance harness.
 *
 * The whole point of this file is the signature: `runCoreConformance(name,
 * factory)`. Assertions are fixed and live here; a composition supplies a
 * factory and nothing else. When the Postgres + R2 composition arrives (S4A) it
 * must pass this suite *unmodified* — if any assertion needed a
 * composition-specific branch, that would be evidence the port contract is
 * wrong, not the test. Same for a self-hosted server composition, or the
 * optional D1 adapter.
 *
 * Time is injected rather than slept on: `advanceTime` is part of the factory
 * contract because TTL expiry (presence, activity, reservations) is contract
 * behavior, and asserting it against a wall clock is either slow or flaky.
 */
import { describe } from 'vitest';
import type { CoreStores } from '../../stores';
import { runMailboxConformance } from './mailbox';
import { runBoardConformance } from './board';
import { runTruthConformance } from './truth';
import { runPresenceConformance } from './presence';
import { runObjectConformance } from './objects';
import { runQuotaConformance } from './quota';
import { runTenantIsolationConformance } from './tenant-isolation';
import { runPortInventoryConformance } from './port-inventory';

/** One live composition under test. */
export interface CoreCompositionHandle {
  readonly stores: CoreStores;
  /**
   * The composition's current instant as an ISO string. Exposed so assertions
   * about absolute deadlines (a downgrade grace, a retention cutoff) can be
   * written relative to the composition's own clock instead of a hardcoded date
   * that would silently pin the suite to one implementation.
   */
  now(): string;
  /** Moves the composition's clock forward. Must affect every TTL the stores observe. */
  advanceTime(ms: number): void | Promise<void>;
  /** Optional teardown for compositions holding connections. */
  dispose?(): void | Promise<void>;
}

/**
 * How the suite obtains a composition. `create` is called once per test, so
 * every assertion starts from empty state and no test can depend on another's
 * writes.
 */
export interface CoreCompositionFactory {
  create(): CoreCompositionHandle | Promise<CoreCompositionHandle>;
}

/** Runs a test body against a fresh composition and disposes it afterwards. */
export async function withComposition(
  factory: CoreCompositionFactory,
  body: (handle: CoreCompositionHandle) => Promise<void>,
): Promise<void> {
  const handle = await factory.create();
  try {
    await body(handle);
  } finally {
    await handle.dispose?.();
  }
}

/**
 * The complete core conformance suite.
 *
 * @param name Composition label, used only for test output.
 * @param factory Supplies a fresh composition per test.
 */
export function runCoreConformance(name: string, factory: CoreCompositionFactory): void {
  describe(`core conformance [${name}]`, () => {
    runPortInventoryConformance(factory);
    runMailboxConformance(factory);
    runBoardConformance(factory);
    runTruthConformance(factory);
    runPresenceConformance(factory);
    runObjectConformance(factory);
    runQuotaConformance(factory);
    runTenantIsolationConformance(factory);
  });
}
