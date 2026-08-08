/**
 * The in-memory composition running the complete cloud-local conformance suite.
 *
 * This file is the entire integration between the reference implementation and
 * the suite: a factory, and nothing else. Its Postgres sibling is the same size
 * — if either ever needs more than that, the port contract is what needs
 * fixing.
 */
import { createMutableClock } from '@byok/core';
import { createInMemoryCloudStores, createWebCrypto } from '@byok/cloud';
import { runCloudConformance, type CloudCompositionFactory } from '../cloud/harness';

const inMemoryFactory: CloudCompositionFactory = {
  create() {
    const clock = createMutableClock();
    const { stores } = createInMemoryCloudStores(clock, createWebCrypto());
    return {
      // Exactly the certified ports, in `CLOUD_CONFORMANCE_PORTS` order: the
      // suite asserts the key set, so a composition cannot quietly hand over
      // extra surface the other compositions do not owe.
      stores: {
        devices: stores.devices,
        pairingCodes: stores.pairingCodes,
        nonces: stores.nonces,
        dedup: stores.dedup,
        tasks: stores.tasks,
        receipts: stores.receipts,
        sequence: stores.sequence,
        rateLimiter: stores.rateLimiter,
      },
      now: () => clock.now().toISOString(),
      advanceTime: (ms: number) => {
        clock.advance(ms);
      },
    };
  },
};

runCloudConformance('in-memory', inMemoryFactory);
