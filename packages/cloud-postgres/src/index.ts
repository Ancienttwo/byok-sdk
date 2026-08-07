/**
 * `@byok/cloud-postgres` — the durable data plane.
 *
 * `cloud-postgres → core + cloud + pg`, and never the reverse. The two
 * platform-neutral packages stay loadable on Workers precisely because the
 * database driver lives here (design §4): `@byok/cloud` is a stateless handler
 * package, and a `hono` user must not be made to install `pg` to use it.
 *
 * The naming family is `@byok/cloud-<transaction authority>`; a future optional
 * D1 adapter would be `@byok/cloud-d1`.
 */

// The pool factory (int8 parsing configured per-pool, never globally)
export { createByokPool } from './pool';
export type { ByokPoolOptions } from './pool';

// The forward-only migration runner
export { MigrationChecksumMismatchError, MigrationFilenameError, migrate, readMigrationFiles } from './migrate';
export type { MigrationFile, MigrationResult } from './migrate';

// The cloud-local port implementations, and the composition that bundles them
export {
  PostgresDeviceDirectory,
  PostgresDeviceSequenceStore,
  PostgresInboundDedupStore,
  PostgresNonceStore,
  PostgresPairingCodeStore,
  PostgresRequestReceiptStore,
  PostgresTaskAttemptStore,
  createPostgresCloudStores,
} from './stores/index';
export type { PostgresCloudStoreOptions, PostgresCloudStores } from './stores/index';
