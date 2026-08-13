/**
 * The Postgres composition of the eight `@byok-sdk/core` ports.
 *
 * All eight, or none: `runCoreConformance`'s port-inventory dimension asserts a
 * composition supplies exactly `CORE_STORE_NAMES` and exactly the methods
 * `CORE_PORT_METHODS` declares, so there is no such thing as a partial core
 * composition to certify. The original seven landed in one slice (design §11);
 * `skillPacks` is the eighth, added in Phase 2 of `skill-pack-delivery-channel`
 * when it graduated from a bridge port to a mandatory `CoreStores` member. This
 * function returns a full `CoreStores` where the cloud-local sibling returns a
 * named subset.
 *
 * Everything that reads time reads the injected clock. Nothing calls SQL
 * `now()` — presence expiry, activity expiry and reservation expiry are all
 * contract behavior the suite asserts by moving a test clock, and a store that
 * asked the database for the time would make every one of those assertions
 * either a sleep or a flake.
 */
import type { Clock, CoreStores } from '@byok-sdk/core';
import type { Pool } from 'pg';
import { PostgresActivityStore, PostgresPresenceStore } from './presence';
import { PostgresBoardStore } from './board';
import { PostgresMailboxStore } from './mailbox';
import { PostgresObjectStore } from './objects';
import { PostgresQuotaStore } from './quota';
import { PostgresSkillPackStore } from './skill-pack';
import { PostgresTruthStore } from './truth';

export { PostgresMailboxStore } from './mailbox';
export { PostgresBoardStore } from './board';
export { PostgresTruthStore } from './truth';
export { PostgresPresenceStore, PostgresActivityStore } from './presence';
export { PostgresObjectStore } from './objects';
export { PostgresQuotaStore } from './quota';
export { PostgresSkillPackStore } from './skill-pack';

export interface PostgresCoreStoreOptions {
  readonly pool: Pool;
  /**
   * The clock every TTL and timestamp in this composition reads. Injected, not
   * the database's `now()`: expiry has to be assertable under a test clock, and
   * a store that asks the server for the time cannot be.
   */
  readonly clock: Clock;
}

export function createPostgresCoreStores(options: PostgresCoreStoreOptions): CoreStores {
  const { pool, clock } = options;
  return {
    mailbox: new PostgresMailboxStore(pool, clock),
    board: new PostgresBoardStore(pool, clock),
    truth: new PostgresTruthStore(pool, clock),
    presence: new PostgresPresenceStore(pool, clock),
    activity: new PostgresActivityStore(pool, clock),
    objects: new PostgresObjectStore(pool, clock),
    quota: new PostgresQuotaStore(pool, clock),
    // No clock: a skill-pack manifest carries no timestamp, so this store reads
    // none — the same shape as the cloud-local `devices` directory.
    skillPacks: new PostgresSkillPackStore(pool),
  };
}
