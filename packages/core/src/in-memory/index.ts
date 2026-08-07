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
import { InMemoryActivityStore, InMemoryPresenceStore } from './presence';
import { InMemoryBoardStore } from './board';
import { InMemoryMailboxStore } from './mailbox';
import { InMemoryObjectStore } from './blob';
import { InMemoryQuotaStore } from './quota';
import { InMemoryTruthStore } from './truth';
import { createMutableClock } from './clock';
import type { Clock, CoreStores, MutableClock } from '../stores';

export { createMutableClock, IN_MEMORY_CLOCK_EPOCH } from './clock';
export { InMemoryMailboxStore } from './mailbox';
export { InMemoryBoardStore } from './board';
export { InMemoryTruthStore } from './truth';
export { InMemoryPresenceStore, InMemoryActivityStore } from './presence';
export { InMemoryObjectStore } from './blob';
export { InMemoryQuotaStore } from './quota';

export interface InMemoryCoreOptions {
  /** Defaults to a fresh {@link createMutableClock}, so TTL behavior is deterministic. */
  readonly clock?: Clock;
}

export interface InMemoryCoreComposition {
  readonly stores: CoreStores;
  /** The clock the stores read. Mutable only when the caller did not inject its own. */
  readonly clock: Clock;
}

export function createInMemoryCoreStores(
  options: InMemoryCoreOptions = {},
): InMemoryCoreComposition {
  const clock: Clock = options.clock ?? createMutableClock();
  const stores: CoreStores = {
    mailbox: new InMemoryMailboxStore(clock),
    board: new InMemoryBoardStore(clock),
    truth: new InMemoryTruthStore(clock),
    presence: new InMemoryPresenceStore(clock),
    activity: new InMemoryActivityStore(clock),
    objects: new InMemoryObjectStore(clock),
    quota: new InMemoryQuotaStore(clock),
  };
  return { stores, clock };
}

/** Convenience for tests that need to move time: returns the composition and its mutable clock. */
export function createInMemoryCoreCompositionWithClock(): {
  readonly stores: CoreStores;
  readonly clock: MutableClock;
} {
  const clock = createMutableClock();
  return { stores: createInMemoryCoreStores({ clock }).stores, clock };
}
