import { R2ObjectMaintenanceStore, type R2ObjectMaintenanceOptions } from '../r2-blobs.js';
/**
 * The Postgres composition of the seven `@byok-sdk/core` ports.
 *
 * All seven, or none: `runCoreConformance`'s port-inventory dimension asserts a
 * composition supplies exactly `CORE_STORE_NAMES` and exactly the methods
 * `CORE_PORT_METHODS` declares, so there is no such thing as a partial core
 * composition to certify. The original seven landed in one slice (design §11);
 * `skillPacks` joined in Phase 2 of `skill-pack-delivery-channel`
 * when it graduated from a bridge port to a mandatory `CoreStores` member. This
 * function returns a full `CoreStores` where the cloud-local sibling returns a
 * named subset.
 *
 * Everything that reads time reads the injected clock. Nothing calls SQL
 * `now()` — presence expiry and reservation expiry are both
 * contract behavior the suite asserts by moving a test clock, and a store that
 * asked the database for the time would make every one of those assertions
 * either a sleep or a flake.
 */
import type { Clock, CoreStores } from '@byok-sdk/core';
import type { ByokPool } from '../../pool.js';
import { assertByokPool } from '../../pool-brand.js';
import { PostgresPresenceStore } from './presence.js';
import { PostgresBoardStore } from './board.js';
import { PostgresMailboxStore } from './mailbox.js';
import { PostgresObjectStore } from './objects.js';
import { PostgresQuotaStore } from './quota.js';
import { PostgresSkillPackStore } from './skill-pack.js';
import { PostgresTruthStore } from './truth.js';

export { PostgresMailboxStore } from './mailbox.js';
export { PostgresBoardStore } from './board.js';
export { PostgresTruthStore } from './truth.js';
export { PostgresPresenceStore } from './presence.js';
export { PostgresObjectStore } from './objects.js';
export { PostgresQuotaStore } from './quota.js';
export { PostgresSkillPackStore } from './skill-pack.js';

export interface PostgresCoreStoreOptions {
  readonly objectStorage: R2ObjectMaintenanceOptions;
  readonly pool: ByokPool;
  /**
   * The clock every TTL and timestamp in this composition reads. Injected, not
   * the database's `now()`: expiry has to be assertable under a test clock, and
   * a store that asks the server for the time cannot be.
   */
  readonly clock: Clock;
}

export function createPostgresCoreStores(options: PostgresCoreStoreOptions): CoreStores {
  const { pool, clock } = options;
  assertByokPool(pool, 'createPostgresCoreStores');
  return {
    mailbox: new PostgresMailboxStore(pool, clock),
    board: new PostgresBoardStore(pool, clock),
    truth: new PostgresTruthStore(pool, clock),
    presence: new PostgresPresenceStore(pool, clock),
    objects: new PostgresObjectStore(pool, clock, new R2ObjectMaintenanceStore(options.objectStorage)),
    quota: new PostgresQuotaStore(pool, clock),
    // No clock: a skill-pack manifest carries no timestamp, so this store reads
    // none — the same shape as the cloud-local `devices` directory.
    skillPacks: new PostgresSkillPackStore(pool),
  };
}
