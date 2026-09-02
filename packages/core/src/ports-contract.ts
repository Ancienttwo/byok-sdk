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
import { CORE_STORE_NAMES, type CoreStoreName } from './stores';

/**
 * Ports that are core ports but NOT members of the composition contract.
 *
 * Now empty, and that is the whole point of Phase 2. Phase 1 of
 * `skill-pack-delivery-channel` held `skillPacks` here as a self-declared
 * temporary bridge: adding it to `CoreStores` before its Postgres
 * implementation existed would have obliged every composition to implement it
 * in the same slice, and the alternatives — an optional port member (a
 * compatibility fallback, forbidden) or a port outside the contract table
 * entirely (exempt from the tenant-first scan, the one rule most worth having)
 * — were both worse. Phase 2 delivered that implementation and moved
 * `skillPacks` into `CORE_STORE_NAMES`, so this list goes back to empty exactly
 * as the Phase 1 note promised. The empty set stays named rather than deleted:
 * it is the testable statement "every core port is a composition member", which
 * `CORE_STORE_NAMES` alone cannot make.
 */
export const CORE_NON_COMPOSITION_PORT_NAMES = [] as const;

export const CORE_PORT_METHODS: Readonly<Record<CoreStoreName, readonly string[]>> = {
  mailbox: ['append', 'readAfter', 'recordDelivery', 'advanceCursor', 'readCursor', 'collectRetired'],
  board: ['create', 'get', 'list', 'claim', 'unclaim', 'updateStatus'],
  truth: ['writeTerminal', 'writeSnapshot', 'getRecord', 'listManifest'],
  presence: ['publish', 'read', 'list'],
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
    'readReservation',
    'reserve',
    'finalizeReservation',
    'abortReservation',
    'expireReservations',
    'applyMailboxDelta',
  ],
  skillPacks: ['publish', 'get', 'list', 'readFile'],
};

/** The interface each port name is declared as, for the source-side scan. */
export const CORE_PORT_INTERFACES: Readonly<Record<CoreStoreName, string>> = {
  mailbox: 'MailboxStore',
  board: 'BoardStore',
  truth: 'TruthStore',
  presence: 'PresenceStore',
  objects: 'ObjectStore',
  quota: 'QuotaStore',
  skillPacks: 'SkillPackStore',
};
