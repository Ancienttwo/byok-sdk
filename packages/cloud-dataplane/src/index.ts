/**
 * `@byok-sdk/cloud-dataplane` — the durable data plane.
 *
 * `cloud-dataplane → core + cloud + protocol + pg`, and never the reverse. The two
 * platform-neutral packages stay loadable on Workers precisely because the
 * database driver lives here (design §4): `@byok-sdk/cloud` is a stateless handler
 * package, and a `hono` user must not be made to install `pg` to use it.
 *
 * The package name follows its hosted role rather than leaking one storage
 * technology into the public identity. Postgres remains the transaction
 * authority and R2/S3-compatible storage remains the byte plane; a future
 * alternative composition must use a distinct package name rather than making
 * this authority conditional at runtime.
 *
 * Two entries, one online surface:
 *
 * - `.` (this file) is the superset: the online request path plus the Node-only
 *   operations — the migration runner, the migrations directory, and the
 *   cleanup/maintenance composition — that a resident Node/VPS service runs
 *   in-process.
 * - `./runtime` is the Worker-loadable online surface alone, and is the single
 *   authority for the online export list: this file re-exports it wholesale
 *   rather than duplicating it, so the two entries cannot drift.
 *
 * The invariant that makes the split real: the `./runtime` subgraph must never
 * reach a node builtin. It is enforced at build time by the neutral-platform
 * tsup pass over `src/runtime.ts`, and pinned by the runtime-entry test.
 */

// The online surface — pool, stores, truth — owned by `./runtime`.
export * from './runtime';

// The forward-only migration runner, and the migration files it applies. The
// SQL is authored in the repository's `deploy/sql/` and copied into this
// package at build time, so an installed copy can migrate a database without a
// source checkout in reach.
export { MigrationChecksumMismatchError, MigrationFilenameError, migrate, readMigrationFiles } from './migrate';
export type { MigrationFile, MigrationResult } from './migrate';
export { migrationsDir } from './migrations-dir';

// Host-owned retention/dead-letter/R2 GC and reconciliation. This is separate
// from CoreStores because it coordinates one concrete SQL authority with one
// concrete byte store; it is not a domain port every composition must fake.
export {
  CLOUD_CLEANUP_ERROR_CODES,
  CloudCleanupError,
  PostgresCloudCleanup,
  createPostgresCloudMaintenance,
} from './cleanup';

export type {
  CleanupJobState,
  CloudCleanupErrorCode,
  CloudCleanupResult,
  DeadLetterPage,
  DeadLetterQuery,
  DeadLetterRef,
  DeadLetterReplayInput,
  ObjectUsageRebuildResult,
  PostgresCloudCleanupOptions,
  PostgresCloudMaintenanceOptions,
  TenantRetentionPolicy,
  TenantRetentionPolicyInput,
} from './cleanup';

// Package-owned destructive maintenance. This is intentionally Node-only: an
// operator passes a direct-DSN pool, while the Worker `./runtime` surface never
// gains a destructive tenant-data capability.
export {
  TENANT_ERASURE_ERROR_CODES,
  TENANT_ERASURE_TABLES,
  PostgresTenantErasure,
  TenantErasureError,
  createPostgresTenantErasure,
} from './tenant-erasure';
export type {
  PostgresTenantErasureCompositionOptions,
  PostgresTenantErasureOptions,
  TenantErasureConflict,
  TenantErasureErrorCode,
  TenantErasureReadback,
  TenantErasureResult,
  TenantErasureStatus,
} from './tenant-erasure';
