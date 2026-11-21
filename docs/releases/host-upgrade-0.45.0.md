# Host upgrade to 0.45.0

This checklist covers the 0.44.1 → 0.45.0 upgrade to wire v8. Hosts on an
earlier release first follow the [0.44.1 notes](v0.44.1.md) and the
[0.44.0 checklist](host-upgrade-0.44.0.md) where applicable.

Plan the [wire and store cutover](#wire-v8-and-the-provider-store-cutover)
together with the [provider store migration](#provider-store-credential-namespace).
Review the [known issues](v0.45.0.md#known-issues) before switching traffic.

## Wire v8 and the provider store cutover

1. Pause new task offers and provisioning intents while the old Host and devices
   are still running. Resolve or cancel open intents, finish in-flight tasks,
   and let the devices flush their outboxes and terminal receipts.
2. Stop the old server and daemons. Keep their stores for rollback and provision
   fresh storage for the v8 server. For embedded SQLite, use a new database
   with schema 11. For hosted PostgreSQL, apply migrations through
   [0041_wire_v8.sql](../../deploy/sql/0041_wire_v8.sql) on a new database.
   Initialize fresh local daemon journals, outboxes, and K4/K8 ledgers.
   Follow the provider store steps below in the same window.
3. Upgrade the Host, server, and daemons together and pair the devices against
   the new server. Pairing from a fresh `storeDir` with the same `productId`
   fails with `DeviceStoreBindingMismatchError` (`device_store_not_bound`)
   while the old enrollment occupies that product's OS credential slot.
   Explicitly replace the enrollment with `replaceOtherStore: true`, or
   unpair the old enrollment or clear its credential entry first. Use a
   distinct `productId` to keep the old OS credential entry intact.
   Wait for each device to publish its harness inventory before submitting
   explicit offers. Wire v7 and v8 peers refuse each other.
4. Use `{ lane: 'auto' }` to let a device choose an advertised executor that
   supports device defaults. For explicit routing, pass `lane: 'harness'`, the
   advertised `harnessId`, and a supported `selection`. Use `device-default`
   to keep the executor's defaults or `subscription` with a `modelId` to pin
   the model under the vendor's own CLI login. Subscription admission
   requires Claude.ai for Claude or a ChatGPT account for Codex. For a Host credential, use
   `byok` with the advertised pi-ai catalog `providerId`. For `byok`,
   `adapter-model`, and `byok-profile`, omit `modelId` only if the device advertises that selection
   mode in `capabilities.defaultModelModes`. DSH can use a configured default
   or an explicit model within the configured route. OpenCode without a
   configured model list requires `adapter-model` with an explicit ID.
   Preserve the original executable offer when replaying an undelivered task
   ID. A different offer body returns `coordination_input_invalid`. A
   different target device or Agent identity returns `agent_ref_mismatch`.
   Resubmitting a delivered task ID for the same device and Agent returns
   `agent_task_already_exists`.
5. Verify pairing, task start and terminal delivery before restoring traffic.
   Replacing the OS credential entry leaves the preserved 0.44.1 store
   unbound. To roll back, restore the matching 0.44.1 binaries,
   configuration, and stores. If you replaced or cleared the old entry,
   restore the preserved OS credential entry or re-pair the device against
   the restored 0.44.1 server.

### Harness model selection

`task.decline.code` includes `invalid_request` for missing required model IDs
and `model_unavailable` for a rejected model before claim. A native runtime
model refusal after claim is reported through `task.fail.failure.class`.

#### Pi provider selection

Ordinary Pi supports `device-default` with the device's Pi auth store. For
`adapter-model`, pass an exact `provider/id` from `PiAdapter.listModels()`.
A prepared task must use the same provider and model as its frozen record.
Ordinary Pi uses credentials from its own store and configuration.
The pinned Pi 1.5.2 exposes session token and cost totals through
`get_session_stats`. Pi does not report account usage or quotas through the SDK.

Replace Pi offers that used `byok` with `byok-profile`. Durable Pi requires
`byok-profile`. Read the persisted
local profile and derive the exact binding with
`exactProviderProfileBinding(profile)` from `@byok-sdk/keys`. Use the binding
from the store assigned to the target device, and refresh it after changing
the profile.

```ts
const target = {
  lane: 'harness',
  harnessId: 'pi',
  selection: {
    mode: 'byok-profile',
    providerProfile: exactProviderProfileBinding(profile),
    modelId: 'provider/model',
  },
} satisfies ExecutionTarget;
```

Omit `selection.modelId` to use `profile.model`. An override reuses the same
credential, provider endpoint, `api`, and `pi_model` settings. Pi projects
image input for an override only when the pinned catalog confirms support
for that provider and API. An override without verified image support is
declined before claim if `requiredCapabilities` includes `image-input`.
A prepared task
must count and execute the same model. A runtime refusal for an unavailable
model after claim reports `task.fail.failure.class = 'model_unavailable'`.

AiphaBee can use the same persisted binding for bots that select different
models. Read the saved default from the profile or provisioning status. The
exact binding's hash still includes the saved default.

## Managed runtime upgrades

Set `DaemonConfig.runtimeInstallRoot` to the absolute SDK install root and pass
that same root to `upgradeRuntime({ installRoot, runtimeId })`. The Host calls
this operation explicitly. It stages Claude, Codex, DSH, or OpenCode v2 at the
SDK's exact qualified version with npm install scripts disabled. The daemon
prefers the resulting managed executable. The active copy switches only after
the staged CLI passes its version and liveness probes.

AGY and Grok return vendor commands and reasons. Pi ships with the SDK. Read
local status or doctor for the installed source and upgrade guidance. Stop
sessions using a managed copy before calling `uninstallManagedRuntime` with
the Host-configured install root. The SDK resolves that root and rejects
symbolic links at the `runtimes` directory or the selected runtime directory.
Keep the resolved install root stable during removal. A process with write access to the path can still
replace a directory between the path check and the recursive delete.

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

The qualified combinations use the ordinary lane and the Node distribution helper on macOS arm64.

- SDK-built dsh `0.2.2-rc.1` uses `sandbox: 'danger-full-access'` and SDK authorization mode `all`. Set `BYOK_DSH_BIN` to the absolute path of the qualified executable.
- SDK-built Pi `1.5.2` uses the default SDK launcher, bundled Pi entry and `agentUserContext: 'inherit'`, with SDK authorization mode `auto` or `all`. In `auto`, if a high-risk hub call arrives while the runtime is still starting, the SDK denies that invocation because approval is unavailable.

Prepared input preparation and execution require `direct`. Use `direct` also for native-sessions, durable Pi, and custom adapters. [Runtime qualification](../researches/2026-11-19-mcp-search-runtime-qualification.md)

If a selected server already uses `byoktools`, keep that task direct-only or rename the server before selecting any search toolset. Update the Host's exact selectors and any native rules or hooks that mention the old name. Check whether a saved runtime session can resume with the changed tool names before reusing it.

Claude stays closed to search in this release. When qualifying a future Claude combination, its native deny rules and `PreToolUse` hooks see the hub call, such as `mcp__byoktools__call_tool`, with the inner identity in `server` and `tool` and its parameters in `arguments`. Review any native filters that rely on a direct tool name before opting in. SDK authorization selectors continue to match the inner tool name, server, and arguments.

## dsh and agy provider keys

Supply an async `resolveKey` on `DshAdapterOptions`, `AgyAdapterOptions`,
`runtimes.dsh` or `runtimes.agy`. Read the key in that callback from the
Host's credential store for the daemon's account. Remove `model.keyEnv`
from dsh configuration and remove the old provider-key entries from
`runtimeEnvironment.pass` or `allow`. The Host can stop copying keys into
its process environment. Both adapters now omit `authPresent` during
installation detection. Use the Host's credential store to decide whether
the account has a saved key.

Provider keys supplied through `resolveKey` or Claude's `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` environment variables must contain at least 20
characters and cannot contain leading or trailing whitespace, NUL, or line
breaks. Give local OpenAI-compatible endpoints a placeholder of at least 20
characters even when they do not require authentication.

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

## Undici in the Host dependency tree

Pi 1.5.2 pins undici 8.12.3. Override it to 8.12.4 in the Host root, verify
every resolved copy and rebuild. The existing npm dependency-chain and
lockfile cleanup steps still apply.
[Override and verification steps](host-upgrade-0.44.0.md#undici-in-the-host-dependency-tree) ·
[Refs #2098](https://github.com/Ancienttwo/byok-sdk/issues/2098)
