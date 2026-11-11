import { InMemoryStorageLedger } from './storage-ledger.js';
import type { InMemoryObjectBytes } from './blob.js';
/**
 * The in-memory reference composition.
 *
 * This exists to be the first thing that passes the conformance suite, and to
 * stay the cheapest way to run it. It is a reference, not a production store:
 * everything lives in process memory and nothing survives a restart. What it
 * *does* guarantee is that the behavior the suite asserts is achievable without
 * a database, which is what makes the same assertions meaningful when a
 * Postgres + R2 composition runs them later.
 */
import { InMemoryPresenceStore } from './presence.js';
import { InMemoryBoardStore } from './board.js';
import { InMemoryMailboxStore } from './mailbox.js';
import { InMemoryObjectStore } from './blob.js';
import { InMemoryQuotaStore } from './quota.js';
import { InMemorySkillPackStore } from './skill-pack.js';
import { InMemoryTruthStore } from './truth.js';
import { createMutableClock } from './clock.js';
import type { Clock, CoreStores, MutableClock } from '../stores.js';

export { createMutableClock, IN_MEMORY_CLOCK_EPOCH } from './clock.js';
export { InMemoryMailboxStore } from './mailbox.js';
export { InMemoryBoardStore } from './board.js';
export { InMemoryTruthStore } from './truth.js';
export { InMemoryPresenceStore } from './presence.js';
export { InMemoryObjectStore } from './blob.js';
export { InMemoryQuotaStore } from './quota.js';
export { InMemorySkillPackStore } from './skill-pack.js';
export { InMemoryDeviceAssertionReplayAuthority } from './device-assertion-replay.js';

export interface InMemoryCoreOptions {
  readonly objectBytes: InMemoryObjectBytes;
  /** Defaults to a fresh {@link createMutableClock}, so TTL behavior is deterministic. */
  readonly clock?: Clock;
}

export interface InMemoryCoreComposition {
  readonly stores: CoreStores;
  /** The clock the stores read. Mutable only when the caller did not inject its own. */
  readonly clock: Clock;
}

export function createInMemoryCoreStores(
  options: InMemoryCoreOptions,
): InMemoryCoreComposition {
  const clock: Clock = options.clock ?? createMutableClock();
  const ledger = new InMemoryStorageLedger(clock);
  const objects = new InMemoryObjectStore(clock, { ledger, bytes: options.objectBytes });
  const quota = new InMemoryQuotaStore(clock, objects, ledger);
  const stores: CoreStores = {
    mailbox: new InMemoryMailboxStore(clock, quota),
    board: new InMemoryBoardStore(clock),
    truth: new InMemoryTruthStore(clock),
    presence: new InMemoryPresenceStore(clock),
    objects,
    quota,
    skillPacks: new InMemorySkillPackStore(),
  };
  return { stores, clock };
}

/** Convenience for tests that need to move time: returns the composition and its mutable clock. */
export function createInMemoryCoreCompositionWithClock(objectBytes: InMemoryObjectBytes): {
  readonly stores: CoreStores;
  readonly clock: MutableClock;
} {
  const clock = createMutableClock();
  return { stores: createInMemoryCoreStores({ clock, objectBytes }).stores, clock };
}

export { InMemoryStorageLedger } from './storage-ledger.js';
export type { InMemoryObjectBytes } from './blob.js';
