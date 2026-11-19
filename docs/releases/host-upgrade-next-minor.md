# Host upgrade to the next MINOR

This checklist starts after the published 0.44.1 release. Hosts on an earlier release first follow the
[0.44.0 checklist](host-upgrade-0.44.0.md) and its predecessors.

## Provider store credential namespace

1. Precheck the existing database with the candidate's
   `inspectProviderProfileStore(path)`. If it reports `new-path-repair` with
   `PROVIDER_STORE_SCHEMA_STALE`, preserve the original files, create a store
   on another path, configure its providers and ask users to re-enter keys.
   The new database starts with its own provisioning receipts. Re-submit
   unfinished sealed requests once the new configurations are ready.
2. Upgrade the Host and its installed or embedded Pi launcher together. Give
   both the same profile DB path and original base credential backend, service
   prefix, account scope and Keychain options. The SDK adds the DB namespace.
   A custom `ProviderProfileStore` generates and persists a unique `ps_` ID
   with 32 lowercase hexadecimal digits when created and exposes it as
   `credentialNamespaceId`. When reading or writing keys manually, apply
   `base.scope(store.credentialNamespaceId)` first.
3. Report cleanup of older shared-scope credentials as incomplete and leave
   those entries in place unless the user verifies ownership and retirement.
   For recognized namespaced stores, retire every copy of the identity first,
   obtain user authorization, then call
   `removeRetiredProviderCredentials(retiredPath, originalBaseSecretStore)`.
   Preserve the original DB and credential configuration for rollback. If
   credentials have been removed, users will need to re-enter them.
