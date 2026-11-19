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

## MCP toolset search

The configuration accepts `exposure: 'search'` on a local `DaemonConfig.mcpToolsets.<id>` entry. The Host selects the ID with `requiredToolsets` as usual. In a qualified ordinary Attempt, one task-scoped `byoktools` server provides `tool_search` and `call_tool` for all selected search toolsets.

The initial combination is SDK-built dsh `0.2.2-rc.1` on macOS arm64, in the ordinary lane with `sandbox: 'danger-full-access'` and the Node distribution helper. Set the daemon environment variable `BYOK_DSH_BIN` to the absolute path of the qualified dsh executable. This combination uses SDK authorization mode `all`. Other combinations stay closed. Prepared input preparation and execution require `direct`. Use `direct` also for native-sessions, durable Pi, and custom adapters. [Runtime qualification](../researches/2026-11-19-mcp-search-runtime-qualification.md)

If a selected server already uses `byoktools`, keep that task direct-only or rename the server before selecting any search toolset. Update the Host's exact selectors and any native rules or hooks that mention the old name. Check whether a saved runtime session can resume with the changed tool names before reusing it.

Claude stays closed to search in this release. When qualifying a future Claude combination, its native deny rules and `PreToolUse` hooks see the hub call, such as `mcp__byoktools__call_tool`, with the inner identity in `server` and `tool` and its parameters in `arguments`. Review any native filters that rely on a direct tool name before opting in. SDK authorization selectors continue to match the inner tool name, server, and arguments.
