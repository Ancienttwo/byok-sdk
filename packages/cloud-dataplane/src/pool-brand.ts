import type { Pool } from 'pg';

/**
 * Marks a pool built by `createByokPool`. A registry symbol, because the
 * package's two entries each bundle their own copy of this module, and a host
 * may build the pool from one entry and pass it to stores from the other.
 */
export const BYOK_POOL = Symbol.for('@byok-sdk/cloud-dataplane.pool');

/** Refuses, at composition, a pool that `createByokPool` did not build. */
export function assertByokPool(pool: Pool, owner: string): void {
  if ((pool as Pool & Record<symbol, unknown>)[BYOK_POOL] === true) return;
  throw new TypeError(
    `${owner} needs a pool from createByokPool: a bare pg.Pool reads bigint columns as strings and lets an idle-client reset crash the process.`,
  );
}
