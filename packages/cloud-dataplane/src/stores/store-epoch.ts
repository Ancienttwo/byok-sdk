/**
 * The store's wire epoch: the one startup fence of the hosted composition.
 *
 * Each wire major starts on a new database. The current migration refuses a
 * database that holds rows and records epoch 8 in `byok_wire_epoch`. A
 * composition reads this row before serving requests and requires its own
 * protocol version.
 */
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import type { Pool } from 'pg';

export const POSTGRES_STORE_EPOCH_UNSUPPORTED = 'POSTGRES_STORE_EPOCH_UNSUPPORTED' as const;

/**
 * The database was not created for this build's wire major. Thrown by
 * `createPostgresCloudStores` before any store is returned; the database is
 * left exactly as it was. Run the migrations on a new database.
 */
export class PostgresStoreEpochUnsupportedError extends Error {
  readonly code = POSTGRES_STORE_EPOCH_UNSUPPORTED;
  /** The epoch this build serves (`PROTOCOL_VERSION`). */
  readonly requiredEpoch: number;
  /** The database's recorded epoch; absent when it has none (a store created before wire v7, or not migrated). */
  readonly foundEpoch?: number;

  constructor(foundEpoch: number | undefined) {
    super(
      `The database's wire epoch is ${foundEpoch === undefined ? 'absent' : String(foundEpoch)}, not ${PROTOCOL_VERSION}; ` +
        `wire v${PROTOCOL_VERSION} starts on a new database: run the migrations on a new database and pair the devices again`,
    );
    this.name = 'PostgresStoreEpochUnsupportedError';
    this.requiredEpoch = PROTOCOL_VERSION;
    if (foundEpoch !== undefined) this.foundEpoch = foundEpoch;
  }
}

/** Refuse with {@link PostgresStoreEpochUnsupportedError} unless the database's epoch is `PROTOCOL_VERSION`. */
export async function assertStoreEpoch(pool: Pool): Promise<void> {
  // A statement naming a missing table fails to parse, so presence is its own read.
  const present = await pool.query<{ readonly present: boolean }>(`SELECT to_regclass('byok_wire_epoch') IS NOT NULL AS present`);
  const epoch = present.rows[0]?.present === true
    ? (await pool.query<{ readonly epoch: number }>('SELECT epoch FROM byok_wire_epoch')).rows[0]?.epoch
    : undefined;
  if (epoch !== PROTOCOL_VERSION) throw new PostgresStoreEpochUnsupportedError(epoch);
}
