# Host upgrade to 0.41.0

Use this checklist for a Host moving from 0.40.0 to 0.41.0. Earlier Hosts must first apply the [0.40.0 checklist](host-upgrade-0.40.0.md) and its predecessors. 0.41.0 is not released yet; this checklist grows with the release train.

## Stores

`migrateProviderProfileStore(path)` from `@byok-sdk/keys` migrates a keys SQLite profile store written by an earlier version whose `provider_kind` CHECK set is narrower than this version's. Opening such a store throws `PROVIDER_STORE_SCHEMA_STALE`, and opening never migrates. A Host that keeps a profile store calls the migration in this order on every upgrade:

1. Stop every process that has the store open, including the Pi provider launcher.
2. Call `migrateProviderProfileStore(path)`. It returns `'migrated'` after a rebuild and `'unchanged'` for a current store or a missing file, so it is safe to call on every start before the first open.
3. Open `SqliteProviderProfileStore` with this version.

The migration runs in one SQLite transaction under the exclusive write lock. It copies every profile row verbatim, including the profile ref that names the provider key in the credential store, and the enabled state. Keys stay in the credential store and users do not re-enter them. Custody rows stay in place. Any other schema difference, or any failure, rolls back and throws `PROVIDER_STORE_SCHEMA_STALE`; the store is left as it was. Such a store still needs a separate current-schema store and re-entered keys.
