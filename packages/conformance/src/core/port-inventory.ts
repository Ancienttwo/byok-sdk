/**
 * The composition side of the port method inventory (sprint I7).
 *
 * The table itself is contract data and lives in `@byok-sdk/core`'s shipped source
 * (`CORE_PORT_METHODS`), because it is enforced from two directions that must
 * read the same list:
 *
 * - core's `constraints.test.ts` scans the *source interfaces* and asserts each
 *   listed method exists, is async, and takes a required `TenantId` first.
 * - this module asserts every *composition under test* implements exactly these
 *   methods — no missing method, and no extra one that the contract has not
 *   pinned down and that therefore no other composition would implement.
 *
 * Adding a port method means editing that table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import { describe, expect, it } from 'vitest';
import { CORE_PORT_METHODS, CORE_STORE_NAMES } from '@byok-sdk/core';
import { withComposition, type CoreCompositionFactory } from './harness';

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

export function runPortInventoryConformance(factory: CoreCompositionFactory): void {
  describe('port inventory', () => {
    it('supplies every declared port', async () => {
      await withComposition(factory, async ({ stores }) => {
        expect(Object.keys(stores).sort()).toEqual([...CORE_STORE_NAMES].sort());
      });
    });

    for (const name of CORE_STORE_NAMES) {
      it(`implements exactly the declared ${name} methods`, async () => {
        await withComposition(factory, async ({ stores }) => {
          const store = stores[name] as unknown as object;
          expect(methodNames(store)).toEqual([...CORE_PORT_METHODS[name]].sort());
        });
      });
    }
  });
}
