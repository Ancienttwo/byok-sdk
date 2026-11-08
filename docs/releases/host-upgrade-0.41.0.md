# Host upgrade to 0.41.0

Use this checklist for a Host moving from 0.40.0 to 0.41.0. Earlier Hosts must first apply the [0.40.0 checklist](host-upgrade-0.40.0.md) and its predecessors. 0.41.0 is not released yet; this checklist grows with the release train.

## Stores

`migrateProviderProfileStore(path)` from `@byok-sdk/keys` migrates a keys SQLite profile store written by an earlier version whose `provider_kind` CHECK set is narrower than this version's. Opening such a store throws `PROVIDER_STORE_SCHEMA_STALE`, and opening never migrates. A Host that keeps a profile store calls the migration in this order on every upgrade:

1. Stop every process that has the store open, including the Pi provider launcher.
2. In the single process that starts first, call `migrateProviderProfileStore(path)` before any process opens the store. It returns `'migrated'` after a rebuild and `'unchanged'` for a current store or a missing file. The call takes the exclusive write lock even on a current store. It fails with `SQLITE_BUSY` only while another process is writing; an idle connection does not block it, which is why step 1 is required.
3. Open `SqliteProviderProfileStore` with this version.

`inspectProviderProfileStore(path)` reports such a store as `migration-required`. A Host that upgrades through `createServiceInstallation` lists the store in its precheck, which exits 0 for `migration-required` (2 only for `new-path-repair` or `rejected`), and supplies a `migrate(versionDir)` program that calls the candidate's `migrateProviderProfileStore(path)`. The installation runs it after the store snapshot and before the switch, then runs the precheck again; a failed migration restores the snapshot and restarts the old version (`store_migration_failed`). Without `migrate`, the upgrade stops with `store_migration_required` and the store is unchanged.

The migration runs in one SQLite transaction under the exclusive write lock. It copies every profile row verbatim, including the profile ref that names the provider key in the credential store, and the enabled state. Keys stay in the credential store and users do not re-enter them. Custody rows stay in place. The call fails in two ways, and both leave the store as it was:

- `PROVIDER_STORE_SCHEMA_STALE`: the store has another schema difference, or the copied rows did not verify. It cannot be migrated; keep it, provision a separate current-schema store and re-enter keys.
- Any other error, such as `SQLITE_BUSY` or an I/O error, is operational. The transaction rolled back; close the other processes that use the store and call the migration again. Do not provision a new store for it.
