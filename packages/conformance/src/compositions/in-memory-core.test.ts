/**
 * The in-memory composition running the complete conformance suite.
 *
 * This file is the entire integration between the reference implementation and
 * the suite: a factory, and nothing else. When Postgres + R2 arrives it adds a
 * sibling file of the same size — if it ever needs more than that, the port
 * contract is what needs fixing.
 */
import { createInMemoryCoreStores, createMutableClock } from '@byok-sdk/core';
import { runCoreConformance, type CoreCompositionFactory } from '../core/harness';

const inMemoryFactory: CoreCompositionFactory = {
  create() {
    const clock = createMutableClock();
    const { stores } = createInMemoryCoreStores({ clock });
    return {
      stores,
      now: () => clock.now().toISOString(),
      advanceTime: (ms: number) => {
        clock.advance(ms);
      },
    };
  },
};

runCoreConformance('in-memory', inMemoryFactory);
