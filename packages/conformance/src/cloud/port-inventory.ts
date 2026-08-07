/**
 * The composition side of the cloud-local port method inventory.
 *
 * The table itself is contract data and lives in `@byok/cloud`'s shipped source
 * (`CLOUD_PORT_METHODS`). This module asserts every composition under test
 * implements exactly those methods for every port the suite certifies — no
 * missing method, and no extra one that the contract has not pinned down and
 * that therefore no other composition would implement.
 *
 * The suite's scope (`CLOUD_CONFORMANCE_PORTS`) is uniform across compositions;
 * see `harness.ts` for why `blobs` waits for S4A-c and why `rateLimiter` is
 * satisfied without a table.
 */
import { describe, expect, it } from 'vitest';
import { CLOUD_PORT_METHODS } from '@byok/cloud';
import {
  CLOUD_CONFORMANCE_PORTS,
  withCloudComposition,
  type CloudCompositionFactory,
} from './harness';

function methodNames(store: object): string[] {
  const names = new Set<string>();
  let current: object | null = store;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor') continue;
      const value = (store as Record<string, unknown>)[name];
      if (typeof value === 'function') names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names].sort();
}

export function runCloudPortInventoryConformance(factory: CloudCompositionFactory): void {
  describe('port inventory', () => {
    it('supplies every certified port', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(Object.keys(stores).sort()).toEqual([...CLOUD_CONFORMANCE_PORTS].sort());
      });
    });

    for (const name of CLOUD_CONFORMANCE_PORTS) {
      it(`implements exactly the declared ${name} methods`, async () => {
        await withCloudComposition(factory, async ({ stores }) => {
          const store = stores[name] as unknown as object;
          expect(methodNames(store)).toEqual([...CLOUD_PORT_METHODS[name]].sort());
        });
      });
    }
  });
}
