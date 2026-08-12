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
 * Ports that are NOT (yet) members of the composition contract.
 *
 * `CORE_STORE_NAMES` answers "what must every composition supply", and the
 * conformance suite reads it to assert exactly that. This list answers a
 * different question — "what is a core port, and therefore bound by the
 * tenant-first/async rules the source scan enforces" — and the two are not the
 * same set while a port is being introduced across more than one merge unit.
 *
 * `skillPacks` is here because its Postgres implementation is Phase 2 of the
 * `skill-pack-delivery-channel` plan. Adding it to `CoreStores` in Phase 1
 * would have obliged every existing composition to implement it in the same
 * slice — the alternative shapes were an optional port member (a compatibility
 * fallback, forbidden) or a port outside the contract table entirely (which
 * would exempt it from the tenant-first scan, the one rule most worth having).
 * Phase 2 moves it into `CORE_STORE_NAMES` and this list goes back to empty.
 */
export const CORE_NON_COMPOSITION_PORT_NAMES = ['skillPacks'] as const;

/** Every port name in this package: the composition contract plus the list above. */
export const CORE_PORT_NAMES = [
  ...CORE_STORE_NAMES,
  ...CORE_NON_COMPOSITION_PORT_NAMES,
] as const;

export type CorePortName = CoreStoreName | (typeof CORE_NON_COMPOSITION_PORT_NAMES)[number];

export const CORE_PORT_METHODS: Readonly<Record<CorePortName, readonly string[]>> = {
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
export const CORE_PORT_INTERFACES: Readonly<Record<CorePortName, string>> = {
  mailbox: 'MailboxStore',
  board: 'BoardStore',
  truth: 'TruthStore',
  presence: 'PresenceStore',
  activity: 'ActivityStore',
  objects: 'ObjectStore',
  quota: 'QuotaStore',
  skillPacks: 'SkillPackStore',
};
