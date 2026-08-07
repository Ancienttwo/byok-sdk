/**
 * The declared method inventory of every port (sprint I7).
 *
 * This table is enforced from two directions, which is why it is a shared
 * constant rather than a literal inside one test:
 *
 * - `constraints.test.ts` scans the *source interfaces* and asserts each listed
 *   method exists, is async, and takes a required `TenantId` first.
 * - This module asserts every *composition under test* implements exactly these
 *   methods — no missing method, and no extra one that the contract has not
 *   pinned down and that therefore no other composition would implement.
 *
 * Adding a port method means editing this table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import { describe, expect, it } from 'vitest';
import type { CoreStoreName } from '../../stores';
import { CORE_STORE_NAMES } from '../../stores';
import { withComposition, type CoreCompositionFactory } from './harness';

export const CORE_PORT_METHODS: Readonly<Record<CoreStoreName, readonly string[]>> = {
  mailbox: ['append', 'readAfter', 'advanceCursor', 'readCursor', 'collectRetired'],
  board: ['create', 'get', 'list', 'claim', 'unclaim', 'updateStatus'],
  truth: ['writeTerminal', 'writeSnapshot', 'getRecord', 'listManifest'],
  presence: ['publish', 'read', 'list'],
  activity: ['append', 'read'],
  objects: [
    'putManifest',
    'commit',
    'get',
    'list',
    'addReference',
    'removeReference',
    'markDeletePending',
    'markDeleted',
  ],
  quota: [
    'readEntitlement',
    'writeEntitlement',
    'readUsage',
    'readStatus',
    'reserve',
    'finalizeReservation',
    'abortReservation',
    'expireReservations',
    'applyMailboxDelta',
  ],
};

/** The interface each port name is declared as, for the source-side scan. */
export const CORE_PORT_INTERFACES: Readonly<Record<CoreStoreName, string>> = {
  mailbox: 'MailboxStore',
  board: 'BoardStore',
  truth: 'TruthStore',
  presence: 'PresenceStore',
  activity: 'ActivityStore',
  objects: 'ObjectStore',
  quota: 'QuotaStore',
};

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
