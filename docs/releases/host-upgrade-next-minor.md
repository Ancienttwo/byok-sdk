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

## Model discovery connection fields

Update calls to `discoverProviderModels` to pass `auth_mode` and `base_url`.
Remove `providerKind` from the connection object and keep `adapter`. The same
three fields can be taken directly from a provider profile.

```ts
const models = await discoverProviderModels({ adapter, auth_mode, base_url }, secret);
```

## dsh and agy provider keys

Supply an async `resolveKey` on `DshAdapterOptions`, `AgyAdapterOptions`,
`runtimes.dsh` or `runtimes.agy`. Read the key in that callback from the
Host's credential store for the daemon's account. Remove `model.keyEnv`
from dsh configuration and remove the old provider-key entries from
`runtimeEnvironment.pass` or `allow`. The Host can stop copying keys into
its process environment. Both adapters now omit `authPresent` during
installation detection. Use the Host's credential store to decide whether
the account has a saved key.

**Known limitation.** Plain JSON configuration cannot start dsh or agy.
Use an embedded Host to provide the per-spawn callback. See [#2408](https://github.com/Ancienttwo/byok-sdk/issues/2408).

## Agent memory preflight and helper path

Use `checkAgentMemoryHome(home, { scope: 'resident' })` from
`@byok-sdk/client/agent-memory` to validate `MEMORY.md` during device sync
without starting a helper. The same entry exports
`resolveAgentMemoryFilesystemHelper(assetRoot?)` to resolve a verified helper
path before opening a filesystem. See [#2410](https://github.com/Ancienttwo/byok-sdk/issues/2410).

## Codex task MCP allowlists

List every tool a task should use in the local server's `approveTools`. Codex now
exposes only those exact names. Omitted and empty grants both expose zero
tools. A tool previously available through `readOnlyHint` or an ad hoc approval
now needs an explicit grant. Upgrade to Codex CLI 0.48.0 or later for tasks with
required toolsets. If `codex_mcp_server_name_collision` names a server, rename the
injected or user-configured server before retrying, including under
`agentUserMcpServers: 'inherit'`. See [#2414](https://github.com/Ancienttwo/byok-sdk/issues/2414).
