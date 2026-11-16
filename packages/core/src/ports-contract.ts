/**
 * The declared method inventory of every core port (sprint I7).
 *
 * This table is contract data, not test data — it says what a port IS, and it
 * is enforced from two directions that must read the same table:
 *
 * - `__tests__/constraints.test.ts` scans the *source interfaces* in this
 *   package and asserts each listed method exists, is async, and takes a
 *   required `TenantId` first.
 * - `@byok-sdk/conformance`'s port-inventory dimension asserts every *composition
 *   under test* implements exactly these methods — no missing method, and no
 *   extra one that the contract has not pinned down and that therefore no
 *   other composition would implement.
 *
 * It lives in shipped source rather than under `__tests__/` because the second
 * enforcer is now a separate package (S4A story O-005): a `core → conformance`
 * devDependency for a table `core` itself asserts against would be a cycle,
 * and the direction that has to hold is `conformance → core`.
 *
 * Adding a port method means editing this table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import { CORE_STORE_NAMES, type CoreStoreName } from './stores.js';

export const CORE_PORT_METHODS: Readonly<Record<CoreStoreName, readonly string[]>> = {
  mailbox: [
    'append',
    'readUsage',
    'readAfter',
    'readMessage',
    'recordDelivery',
    'advanceCursor',
    'readCursor',
    'collectExpired',
    'expirePending',
    'closeStream',
    'reopenStream',
  ],
  board: ['create', 'get', 'list', 'claim', 'unclaim', 'updateStatus', 'remove'],
  truth: ['writeTerminal', 'writeSnapshot', 'getRecord', 'listManifest'],
  presence: ['publish', 'read', 'list', 'collectExpired', 'deleteDevice'],
  objects: [
    'putManifest',
    'commit',
    'get',
    'list',
    'addReference',
    'removeReference',
    'markDeletePending',
    'markDeleted',
    'collectExpired',
  ],
  quota: [
    'readEntitlement',
    'writeEntitlement',
    'readUsage',
    'readStatus',
    'readReservation',
    'reserve',
    'finalizeReservation',
    'abortReservation',
    'collectExpired',
  ],
  skillPacks: ['publish', 'get', 'list', 'readFile'],
};
