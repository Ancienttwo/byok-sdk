/**
 * The composition contract: the full set of store ports, plus the clock seam.
 *
 * Every method on every port in this package obeys two rules, and
 * `src/__tests__/constraints.test.ts` enumerates them method by method to prove
 * it (sprint I7):
 *
 * 1. **Async.** Every method returns a `Promise`. A synchronous port would
 *    silently exclude SQL and object-store compositions from the contract.
 * 2. **Tenant-first.** Every method's first parameter is a required
 *    {@link TenantId}. There is no bare `deviceId`/`taskId` lookup anywhere —
 *    §12.6.2 layer 3 forbids the index such a lookup would need, and layer 5
 *    requires the tenant to be part of the lookup key rather than a second
 *    comparison step that can be forgotten.
 *
 * No port method can change the tenant of an existing row. That is not an
 * omission: "move this to another tenant" is the one operation that would make
 * every cross-tenant assertion in the conformance suite unfalsifiable.
 */
import type { ActivityStore, PresenceStore } from './presence';
import type { BoardStore } from './board';
import type { MailboxStore } from './mailbox';
import type { ObjectStore } from './blob';
import type { QuotaStore } from './quota';
import type { TenantId } from './tenant';
import type { TruthStore } from './truth';

/**
 * Injected time.
 *
 * TTL semantics (presence expiry, activity expiry, reservation expiry) are
 * behavior the conformance suite has to assert deterministically, which is
 * impossible against a wall clock. Compositions inject one; nothing in core
 * calls `Date.now()` directly.
 */
export interface Clock {
  now(): Date;
}

/** A clock pinned to a fixed instant, advanced explicitly. Used by tests and the in-memory reference. */
export interface MutableClock extends Clock {
  advance(ms: number): void;
  set(instant: Date): void;
}

/** Every port a composition must supply. */
export interface CoreStores {
  readonly mailbox: MailboxStore;
  readonly board: BoardStore;
  readonly truth: TruthStore;
  readonly presence: PresenceStore;
  readonly activity: ActivityStore;
  readonly objects: ObjectStore;
  readonly quota: QuotaStore;
}

/** Names of the ports in {@link CoreStores}, in contract order. */
export const CORE_STORE_NAMES = [
  'mailbox',
  'board',
  'truth',
  'presence',
  'activity',
  'objects',
  'quota',
] as const;

export type CoreStoreName = (typeof CORE_STORE_NAMES)[number];

// Layer 2 of §12.6.2 — the tenant-closed facade a handler actually receives —
// is deliberately not here. It is shaped by how handlers are written, and the
// first handlers land in `@byok/cloud` (S3). Defining it now would mean
// guessing that shape and freezing the guess into the contract package that
// every later sprint depends on. The tenant-first ports below are what make
// that facade a thin binding rather than a new authority.
