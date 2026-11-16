# Host upgrade to the next MINOR

Use this checklist in order: [before](#before-upgrading), [during](#during-the-upgrade),
[after](#after-the-upgrade), then [known residuals](#known-residuals).
It covers changes after 0.43.0. Earlier Hosts first apply the
[previous checklist](host-upgrade-0.43.0.md) and its predecessors.

**This is release preparation.** Main is the source for current changes.
Sections marked **随 wire v7 合入 (with the wire v7 merge)** are staged outside
main. Wire notes use `integration/wire-v7@dc42f346a` and
`batch/wire-v7-1@a680fd500`; F1 notes use `feat/wire-v7-f1-impl@74d9f160a`.
Reconcile these pinned sources with the final integration merge before release.

Sources below name PRs and entry ids in
[`upgrade-manifest.json`](../../packages/client/upgrade-manifest.json).
Wire/F1 ids refer to their branch manifests until merge. Where no dedicated
entry exists, that gap is stated instead of inventing an id.

## Before upgrading

1. Stop accepting new work and drain inbound delivery on **every device**.
   Finish or explicitly abandon open turns, delegations, routines, and topology
   switches. Sources: [#2261], [#2309]; entries `bot-inbound-conversation-kind`,
   `host-ledger-format-table`, `reject-hosted-store-version-2`.
2. Export required history **with the old build**, then stop its writers.
   Prepare separate cloud, K4/K8 ledger, and refused provider-store paths.
   Old-format data is typed-refused: no content read, delete, migration, or
   automatic rebuild. Keep the old stores for history. Sources: [#2290],
   [#2309]; entries `reject-older-provider-kind-store`, `host-ledger-format-table`.
3. Adapt Host calls/config below before deployment. Plan one cloud/daemon/CLI
   upgrade window, cloud first. AiphaBee Local Agent and byok-host ship together.
   Sources: [#2277], [#2303], [AiphaBee #1384]; entries `wire-v7`,
   `wire-v7-client-negotiation-halt`, `runtime-status-side-arrays-refused`.

### Retired compatibility paths

Sources: [#2290]. Manifest entries: `retire-compatibility-apis`, `reject-hosted-old-entity-constraint`, `reject-older-provider-kind-store`, `reject-local-old-would-do`, `reject-hosted-frame-would-do`, `reject-hosted-old-would-do-row`.

Remove the following calls/imports. Preserve refused stores and configure a
separate current store; no automatic conversion or archive runs.

| Removed | Host action |
| --- | --- |
| `migrateProviderProfileStore`, `ProviderProfileStoreMigration` | Configure a supported provider store. Old provider-kind schemas are `PROVIDER_STORE_SCHEMA_STALE`. |
| `migrateWouldDo`, `WouldDoMigration` | Remove the migration path. Local rows without `turnId`, hosted old frames, and hosted rows without `turnId` are `would_do_unsupported_old`. |
| `importForSwitch`, `commitImport`, `discardImport` | Finish switches before upgrading. Local switch export remains; local import is gone. |
| `scopeSecretStore` | Use `SecretStore.scope(secretScopeId(scope))`. |
| `listPiCatalogModels` | Read choices from `modelRouteView`. |
| `sealedRoutineInstruction` | Construct the instruction at the member endpoint. |
| `TruthStoreProviderProfileStore`, its options, `PROVIDER_PROFILE_TRUTH_RECORD_KEY` | Configure a supported profile store; remove `PROVIDER_TRUTH_INVALID` handling. |
| `MacOsKeychainSecretStoreOptions.allowUnprefixedRead` | Remove the option; see [credentials](#credentials-and-provider-keys). |

An old hosted `entity_kind_check` is `hosted_schema_unsupported_old` before DDL.

### Removed unused client APIs

#### Task terminal evidence

Sources: [#2256]. Manifest entries: `remove-task-terminal-read`.

Remove `AgentSessionHandoffStore.getTaskTerminal()`. Failure handling still
awaits `recordTaskTerminal()` before `task.fail`; use that write receipt.
There is no public read replacement.

#### Team workspaces

Sources: [#2256]. Manifest entries: `remove-unused-team-workspace-methods`.

Remove `getWorkspace()`, `updateWorkspace()`, `validateMemberLease()`, and
`UpdateTeamWorkspaceInput` from `LocalTeamWorkspace` / `LocalTeamWorkspaceService`.
Use `listWorkspaces()` for definitions. `postMessage()`, `readMessages()`, and
`ackMessages()` validate their own leases. Create a separately named workspace
to change membership or limits.

#### Egress drop receipts

Sources: [#2256]. Manifest entries: `remove-egress-drop-receipts`.

Remove `dropReceipts()` and `AgentEgressDropReceipt`. Pass only the reason to
`noteTransportDrop(reason)`. Read lane counters and `lastDropReason` from
`status()`; collect per-drop history at your own transport boundary if needed.

#### Standalone daemon log writer

Sources: [#2256]. Manifest entries: `remove-standalone-daemon-log`.

Remove `openDaemonLog()` and `DaemonLog`; own your line sink and rotation.
`DaemonLogOptions` remains for the internal process-output router, which is
not an exported standalone line writer.

#### Service exit disposition

Sources: [#2256]. Manifest entries: `remove-service-exit-disposition`.

Remove `serviceExitDisposition()` and `ServiceExitDisposition`. Use
`EXIT_CODE_CONTRACT` / `ExitCode`; configure your supervisor to stop on exit 0
and restart on failure. SDK-generated units already do so.

#### Pi RPC close wait

Sources: [#2256]. Manifest entries: `remove-pi-rpc-close-wait`.

Remove `PiRpcClient.waitClosed()`. An injected `spawnFn` observes its own
child's `close` event. RPC consumers drain `events` and inspect `terminalError`
/ `processExited`. `dispose()` initiates process-tree cleanup and waits for it.

#### Aliases and convenience factories

Sources: [#2288]. Manifest entries: `remove-unused-client-aliases`.

`AGENT_CONTENT_READ_CAPABILITY_WORKSPACE`, `AGENT_CONTENT_READ_CAPABILITY_TRANSCRIPT`
and `AGENT_CONTENT_READ_CAPABILITY_ARTIFACT` are removed; read the same names from
`AGENT_CONTENT_READ_CAPABILITIES.workspace`, `.transcript` and `.artifact`.
`TOOL_AUTHORIZATION_MODES` and `TOOL_FILE_ACCESS` are removed; the
`ToolAuthorizationMode` and `ToolFileAccess` types remain. `DaemonEventKind` is
removed; use `DaemonEvent['kind']`.

`createAgentHomeProjection()` and `AgentHomeProjectionFunction` are removed. Pass
the projection object itself: `agentHome.projection: { prepare: async ({ agentRef, cwd }) => { ... } }`.

#### Installed skill-pack listing

Sources: [#2288]. Manifest entries: `remove-list-installed-skill-packs`.

`listInstalledSkillPacks()` is removed. `installSkillPacks()` returns what it
installed and kept, and `projectSkillPack()` copies one installed pack by name;
a Host that needs an inventory keeps the names it installed.

#### Truth memory client

Sources: [#2288]. Manifest entries: `remove-truth-memory-client`.

Remove `TruthMemoryClient`, `TruthMemoryClientError` and their option, input,
and result types. Call cloud truth routes with a device proof from
`createStoredDeviceProofSigner()`, which remains available.

### In-memory blob factory

Sources: [#2256]. Manifest entries: `remove-create-in-memory-blobs`.

`@byok-sdk/cloud` removes `createInMemoryBlobs(objects, bytes)`. It only
returned `bytes.bind(objects)`. Call `bind(objects)` on the `InMemoryBlobBytes`
from `createInMemoryBlobBytes()` instead; it returns the same `InMemoryBlobs`.

### DaemonConfig rejects unknown fields

Sources: [#2288]. Manifest entries: `daemon-config-unknown-fields-fail-closed`, `daemon-config-unknown-field-rejected`.

Run the **candidate build's** `byok-agent config check` against each config.
Delete every unknown field, including formerly removed `workspaceRoot`,
`gitWorkspace`, `strictAgentOnly`, and `hostedJournal`. Embedded construction
refuses them too: `DaemonConfigInvalidError`, `unknown_field`.

Remove `--strict`, `DaemonConfigFieldRemovedError`, `removed_field`,
`DaemonConfigIssue.severity` / `.migration`, and `DaemonEffectiveConfig.warnings`
(including status config warnings). Every issue is an error. The published
JSON schema closes every object. A rollback also needs config accepted by the
older build.

### Removed cloud and data-plane APIs

**随 wire v7 合入 (with the wire v7 merge).**

Sources: [#2297]. Manifest entries: `cloud-unused-exports-removed`, `cloud-host-facade-methods-removed`, `cloud-approval-identity-required`, `cloud-approval-unnamed-observation-refused`, `cloud-agentless-archive-input-removed`, `cloud-error-agent-ref-missing-removed`, `dataplane-unused-exports-removed`, `dataplane-retention-policy-store-removed`, `dataplane-mailbox-row-tenant-validated`.

These names had no caller in the SDK or its known Hosts. Remove the import and
use the replacement named here.

#### `@byok-sdk/cloud`

- **Board feed client.** `BoardFeedClient`, `BoardFeedRetryableError`,
  `BoardFeedStoppedError` and the `BoardFeed*` types are removed. Read the
  board through the device routes or `TenantStores.board`.
- **Host facade methods.** `ByokCloud` no longer has these methods:
  - `completeAgentHomeProjection` and `completeInputPreparation`. The device
    completion routes still complete both.
  - `listBoardItems` and `acceptBoardItem`. Use the tenant board store
    (`list`, `updateStatus`).
  - `enqueueSealedAgentOffer` and `enqueueSealedAgentEgressOffer`, with
    `SealedAgentDispatchInput` and `SealedAgentEgressDispatchInput`.
    `submitSealedAgentExecution` is the hosted sealed lane. The plaintext
    resume lanes still refuse `sealing` and `sealed` with
    `coordination_input_invalid`.
  - `enqueueProviderProvisioningNotice`, with
    `ProviderProvisioningNoticeInput`.
- **Constants and aliases.** These are removed:
  - `CLOUD_PORT_INTERFACES`; `CLOUD_PORT_METHODS` stays.
  - `TRUTH_RECORD_CAPABILITY` and `TRUTH_INLINE_CONTENT_TYPE`. Use
    `CLOUD_CAPABILITIES.truthRecords`.
  - `CapabilitiesResponseSchema` and `CapabilitiesResponse`. Use
    `CapabilityDeclarationSchema` and `CapabilityDeclaration` from
    `@byok-sdk/core`.
  - `receiptRetentionClass`.
- **In-memory projection adapters.** `InMemoryAgentMemoryProjectionStore`
  and `InMemoryAgentMemoryProjectionAuthorizer` are no longer exported. A
  hosted composition supplies its own projection ports.
- **Approval identity.** Every approval observation names its `approvalId`:
  `approval_requested`, a local `approval_resolved`, and a host approve or
  reject. `ApprovalObservationSchema`, `ApprovalTimelineEventSchema` and
  `PendingApproval` now require the field. A stored timeline that holds an
  observation without one is refused when read; no id is synthesized.
  Wire v7 starts on new stores, so a v7 store never holds one.
- **Archive input.** `taskArchiveInput` requires `agentRef`.
- **Error code.** `task_attempt_agent_ref_missing` is removed from
  `CLOUD_ERROR_CODES`. Migration 0039 makes the Agent columns `NOT NULL`, so
  the read that raised it cannot fail.

#### `@byok-sdk/cloud-dataplane`

- **Resident Postgres wakes.** `createPostgresMailboxWake`,
  `createPostgresTaskEventsWake`, `MailboxWakeProbeMissedError`,
  `TaskEventsWakeProbeMissedError` and their types are removed. Use the
  cloud's in-process wake with its bounded `fallbackMs` reread. The SQL
  triggers stay.
- **Composition factories.** These are removed; construct the class instead:
  - `createPostgresCloudMaintenance` and `PostgresCloudMaintenanceOptions`:
    use `PostgresCloudCleanup`.
  - `createPostgresTenantErasure` and
    `PostgresTenantErasureCompositionOptions`: use `PostgresTenantErasure`.
  - `createPostgresTaskRedactionStore`: use `PostgresTaskRedactionStore`.
  - `createPostgresAgentMemoryProjectionStore`: use
    `PostgresAgentMemoryProjectionStore`.
- **Retention policy store.** `PostgresRetentionPolicyStore`,
  `TenantRetentionPolicy` and `TenantRetentionPolicyInput` are removed. The
  `tenant_retention_policy` table and `runMaintenance` are unchanged: the
  Host writes and reads the policy with SQL and passes it to maintenance.
- **Mailbox rows.** Every outbox read validates the row's tenant with
  `tenantId()`, so a row with an invalid `tenant_id` fails the read with
  `ByokCoreError` `tenant_id_invalid`. Rows the SDK wrote are unaffected.
- **Agentless retirement.** `retireAgentlessTasks` and its option and result
  types are removed. It moved pre-0039 rows that had no Agent identity, and
  wire v7 starts on a new database. The retired-id fence stays: a task id in
  `task_agentless_retired` still refuses a new offer with
  `agent_task_already_exists`.
### Undici in the Host dependency tree

Keep a Host override to **8.12.4**. Pi's exact dependency can still install a
separate older copy. The owner chose Host overrides; there is no SDK Pi fork.
Merge the setting into the Host root `package.json`, reinstall, and check:

| Manager | Setting | Verification |
| --- | --- | --- |
| npm | `"overrides": { "undici": "8.12.4" }` | `npm ls undici --all` |
| Bun | `"overrides": { "undici": "8.12.4" }` | `bun pm why undici` |
| pnpm | `"pnpm": { "overrides": { "undici": "8.12.4" } }` | `pnpm why -r undici` |

Every listed undici version should be 8.12.4. This does not update Node's
built-in undici or another package's bundled copy. Sources: [#2098] (owner
policy), [#2095] (SDK fix). No new manifest entry: this carries forward the
[previous override advice](host-upgrade-0.43.0.md#undici-in-the-host-dependency-tree-2081).

## During the upgrade

1. Keep old writers stopped. With wire v7, run migrations on a **new Postgres
   database**, then write storage entitlements and retention policy. Use the
   same role, database, and `search_path` for migration and cloud startup.
   Embedded Hosts point `storage.path` at a new SQLite file. Sources: [#2283],
   [#2291]; entries `wire-v7-server-sqlite-store`,
   `wire-v7-dataplane-postgres-new-database`, `wire-v7-dataplane-store-epoch`.
2. Deploy cloud first, then daemons and CLI from the **same candidate release**.
   A v6 daemon cannot work with v7; plan downtime during the gap. Never run
   v6 and v7 cloud processes on one database. Sources: [#2277], [#2291], [#2303];
   entries `wire-v7`, `wire-v7-dataplane-store-epoch`, `wire-v7-client-negotiation-halt`.
3. Create a new K4/K8 ledger at a **new path** with `botLedgerOptions`, and a
   separate hosted collaboration schema/database. Sources: [#2309]; entries
   `host-ledger-format-table`, `host-ledger-format-api`, `reject-hosted-store-version-2`.
4. Re-pair every device and configure providers again. Follow the credential
   rules below. Sources: [#2290], [#2287]; entries `retire-compatibility-apis`,
   `keys-store-refuse-before-write`, `wire-v7-v6-enrollment-entry-deleted`.

### SQLite stores decide their format before any write (#2286)

Sources: [#2295], [#2309]. Manifest entries: `core-sqlite-node-entry`, `sqlite-stores-refuse-before-write`, `client-journal-exact-format`.

A store that refuses an older file now refuses it before it opens the file for
writing, sets a pragma such as `journal_mode = WAL` or `auto_vacuum`, or runs
DDL. The refused file keeps its bytes, and no `-wal`, `-shm` or `-journal` file
appears next to it.

The new entry `@byok-sdk/core/sqlite-node` exports
`readSqliteFileUnchanged(path, readMetadata)`. It opens an existing, non-empty
file read-only and immutable, runs `readMetadata` on the main file and closes
it; it returns `undefined` for `:memory:`, a missing path or a zero-length
file. A copy-and-own Host store can call it with its own format check before
its writable open. The core root does not export it. Its functions need Node:
they load `node:sqlite` and `node:fs` only when called, so a Worker bundle that
reaches `HostLedger` through `@byok-sdk/bot-collaboration/host-kit` still
resolves the entry.

`@byok-sdk/client`:

- The local task journal has no version row. It is current when its tables and
  columns are exactly this build's. Any other journal, including one that still
  holds the retired `local_artifact_ref`, `local_cleanup_candidate` or
  `local_storage_usage` table, is refused with `JournalUnavailableError` and
  stays in place; startup no longer drops those tables, and a format refusal is
  no longer moved to `quarantine/`. A file that SQLite cannot read is still
  quarantined.
- A journal that the read-only check cannot open is refused with
  `JournalUnavailableError` and stays in place; it is not quarantined. Other
  stores that call `readSqliteFileUnchanged` get `SqliteReadOnlyOpenError` in
  the same case. On Windows the check opens a path past `MAX_PATH` in the
  same `\\?\` extended-length form as the writable open: both name the file
  through `sqliteOpenPath` / `sqliteFileUri` from `@byok-sdk/core/sqlite-node`.
- A durable replica written in another pi-durable schema version than the
  pinned one is refused instead of migrated forward.
- A replica lock path that holds another database, such as the replica of a
  task whose id ends in `.sqlite.lock`, is refused instead of written.

Every released journal and replica is already current. Preserve or export a
refused store and resolve it before starting this build.

The copy-and-own examples follow the same order: the Desktop example
`HostStore`, the basic example's Clarification and goal/btw stores and the MCP
example `BetaLedger`. The basic example's two stores now record their format in
a `host_format` table, one row per store, so they can share one Host database.
A Host database with their tables but without `host_format` predates it and is
refused; preserve it and configure a new store at a separate path.

See [WAL-only format metadata](#wal-only-format-metadata) for the accepted exception to byte preservation.

### Host ledgers record their format (#2286)

Sources: [#2309]. Manifest entries: `host-ledger-format-table`, `host-ledger-format-api`, `keys-store-refuse-before-write`, `reject-hosted-store-version-2`.

`@byok-sdk/server/execution-core` `HostLedger` records the ledger's format in a
`host_store_format(owner, version)` table, one row per layer: `k4` for the ledger
itself and `k8` for a Bot collaboration ledger. It is the only format authority;
the ledger body and the Bot collaboration state no longer carry a `version`. An
existing ledger is decided on its unchanged main file, before the writable
open, pragmas or DDL, and is refused with `HostStoreFormatError` (code
`host_store_format_unsupported`) when a row's version differs, an expected layer
is missing, an unknown layer is present, or it has tables but no
`host_store_format`. A refused file is not migrated, repaired or deleted.

Every ledger written by 0.42 or 0.43 (and earlier releases) has no `host_store_format` and is
refused. Before you upgrade, finish or abandon in-flight Bot collaboration work
(open turns, delegations, routines and any topology switch). After the upgrade,
open a new ledger file at a new path; keep the old file if you need its history,
since this build does not read it.

- `HostLedgerOptions.expectedFormats` names each layer's row besides `k4`;
  `ledger.formats` exposes the rows.
- `@byok-sdk/bot-collaboration` exports `botLedgerOptions` (the compact veto and
  the `k8` format). Open every Bot ledger with it, for example
  `new HostLedger(file, tenant, { ...botLedgerOptions, projectionOutboxLimits })`.
  `BotCollaboration` refuses a ledger opened without it, and `inspectLedger`
  reports an older ledger as `rejected`.
- `LedgerState.version`, `CollaborationState.version`, and `OldCollaborationStateError` are removed. Drop old collaboration `new-path-repair` handling too.
  `LedgerDump` and `SWITCH_EXPORT_VERSION` are now 2, so a switch dump or switch
  export written by an earlier release is refused; complete a topology switch
  before upgrading.

The hosted bot-collaboration example (Postgres) follows the same decision: its
`STORE_VERSION` is now 3, and a scope written by version 2 is refused when it is
opened with `HostedStoreVersionError`, under the scope lock and before any
write; the schedulers skip it. Finish or abandon its in-flight collaboration
work before upgrading, then provision a new hosted store (a new schema or
database).

`@byok-sdk/keys` `SqliteProviderProfileStore` decides an existing store's format
the same way, before `journal_mode` or DDL. A store with `provider_profile` but
without one of its custody tables is refused with `PROVIDER_STORE_SCHEMA_STALE`
instead of having the table created; a store the read-only check cannot open is
refused with `PROVIDER_STORE_UNAVAILABLE`. Every released keys store is still
accepted. Its configuration lock file is opened through `sqliteOpenPath` like
the store.

`sqliteOpenPath` from `@byok-sdk/core/sqlite-node` now returns `:memory:`
unchanged on Windows too.

### Credentials and provider keys

A provider secret and a device enrollment are different records:

- An **unprefixed provider Keychain secret** is refused with
  `KEYCHAIN_SECRET_DECODE_FAILED`. It is not read as a raw secret. There is no
  `KEYCHAIN_LEGACY` code. Explicit provider reconfiguration may replace that
  same-name legacy entry. Keep the existing decode-error UI.
- A **keys store missing custody tables** is `PROVIDER_STORE_SCHEMA_STALE`
  before WAL/DDL. The SDK does not create those tables. Preserve the old store
  and configure a separate current store and providers. A read-only open failure
  is `PROVIDER_STORE_UNAVAILABLE`; current released keys fixtures still open.
- A **v6 device enrollment — 随 wire v7 合入** is recognized by format without
  decoding its key. Start deletes it and reports re-pair required. Pair deletes
  it and pairs as a first pairing; clear deletes it. A plain status read only
  reports it. This explicit enrollment deletion does not delete old databases.

Sources: [#2290], [#2309], [#2287],
[AiphaBee correction](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6918385300).
Entries `retire-compatibility-apis` (removed Keychain option; no dedicated
unprefixed-secret entry), `reject-older-provider-kind-store`,
`keys-store-refuse-before-write`, `wire-v7-v6-enrollment-entry-deleted`.

### Wire v7

**随 wire v7 合入 (with the wire v7 merge).**

Sources: [#2277], [#2285], [#2283], [#2291], [#2293], [#2302], [#2303], [#2305]. Manifest entries: `wire-v7`, `wire-v7-execution-target`, `wire-v7-steer-refused`, `wire-v7-no-server-capabilities`, `wire-v7-decline-codes`, `wire-v7-retired-flags-and-bounds`, `wire-v7-decline-reason-bound`, `wire-v7-server-execution-target`, `wire-v7-server-steer-refused`, `wire-v7-server-sqlite-store`, `wire-v7-cloud-executor`, `wire-v7-cloud-steer-refusal-reads`, `wire-v7-cloud-terminal-executor`, `wire-v7-cloud-unclaimed-task-reports`, `wire-v7-cloud-steer-text-bound`, `wire-v7-dataplane-postgres-new-database`, `wire-v7-dataplane-store-epoch`, `wire-v7-dataplane-stores`, `wire-v7-client-negotiation-halt`, `wire-v7-client-execution-target`, `wire-v7-client-decline-reason-detail`, `wire-v7-client-selection-before-native-sessions`, `claim-accepted-before-runtime-start`.

`PROTOCOL_VERSION` is 7. There is no v6 reader: a v6 peer and a v7 peer
cannot talk to each other.

#### New store

v7 starts on a new store. Retained v6 records (terminal receipts, task
history, attempts) are not migrated, and a store a v6 build wrote is not
supported:

- Export the history you need before you upgrade.
- Devices pair again; a v6 device credential does not carry over.
- The Host's K4 frozen work and outbox snapshots rotate: start them fresh on
  the v7 store.
- The SQLite startup check refuses a pending row of another major
  (`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`). The hosted data plane checks the
  database's wire epoch instead; see "Cloud data plane" below.

#### What a v6 daemon sees

- **Not paired again:** expected to stop at authentication with
  `device_revoked`. To be verified in phase 1 against the pinned v6 daemon;
  it must halt, not reconnect forever.
- **Paired again into the v7 store:** its lone `conn.hello` gets
  `rejected` with `protocol_version_unsupported`. It reads that as a refused
  handshake and halts with `handshake_rejected`.

A v7 daemon that reaches a v6 cloud gets HTTP 400 on its hello and halts with
`ProtocolNegotiationError` (`code: 'protocol_negotiation_failed'`,
`localVersion`, `httpStatus`; `peerVersion` only when the peer stated it).
Upgrade both sides to resolve it.

In `@byok-sdk/client` this is the halt reason `protocol_negotiation_failed`
(new in `DAEMON_HALT_REASONS`). The daemon takes it when its lone hello gets a
`rejected` outcome with `protocol_version_unsupported` (`httpStatus` 200) or a
4xx other than 401, 403, 409, 413 and 429. `DaemonLifecycle`'s `halted` phase
carries `httpStatus` for it, `byok-agent start`, diagnostics and the support
bundle print it, and `whenOpen()` rejects with a `DaemonHaltError` whose `cause`
is the `ProtocolNegotiationError`. A 404 usually means a wrong server base URL
or a Host that does not mount the messages route. Add the reason wherever a
Host switches on halt reasons.

#### Offer `target` and claim `executor`

- `task.offer` takes one required `target` in place of `runtime`,
  `harnessId` and `dispatchSelection`. Lanes: `auto`, `runtime`,
  `subscription` (no `providerId`), `byok`, `byok-profile`, `harness`. The
  three model lanes still need the device flag `dispatch-selection`.
- `nativeSessions` needs an explicit Pi target (lane `runtime`, `byok` or
  `byok-profile` with `runtimeId: 'pi'`).
  Without one the offer declines with `native_sessions_selection_invalid`.
  `native_sessions_unsupported` no longer hides a selection violation: a
  device checks the selection rules first.
- `task.claim` takes one required `executor`
  (`{ kind: 'runtime', runtimeId }` or `{ kind: 'harness', harnessId }`) in
  place of `runtime`, `harnessId` and `agentId`. `task.complete` requires it;
  `task.fail` and `task.cancelled` carry it after a claim.
- `@byok-sdk/client`: `RuntimeTaskInput` takes `target`, and
  `RuntimeOperationManifest.modelTarget` (the model-lane target) replaces
  `dispatchSelection`; a custom adapter reads the model selection from
  `manifest.modelTarget`. `taskRuntimeTarget(descriptor)` returns
  `{ lane: 'runtime', runtimeId }` or `{ lane: 'harness', harnessId }`: pass it
  as the offer `target`.
- Cloud `TaskAttempt.claimedExecutor` replaces `claimedRuntime` and
  `claimedHarnessId`. Host offer and task APIs take `target` too.

#### `task.steer_refused`

A device reports a steer it received and did not deliver with
`task.steer_refused { steerMessageId, reason }`. Reasons: `input_too_large`,
`steer_unsupported`, `task_not_active`; the list is open. The first reason
wins. The report is plaintext on sealed tasks too.

The task event feed ends at its terminal. Read late refusals with
`tasks.readSteerRefusal(taskId, messageId)` or
`tasks.listSteerRefusals(taskId, { afterRevision, limit })`.
Save the `{ messageId }` from `TaskHandle.steer`; enqueueing is not a delivery
receipt. The cloud APIs and cursor change are listed below.

#### Removed fields and flags

- `capabilities` on the `GET /byok/events` and `POST /byok/messages`
  responses: the server advertises nothing.
- `limits.maxTokens` on `task.offer`.
- The offer selection rules `runtime_selection_mismatch` and
  `harness_selection_conflict`.
- The device flags `steer` and `provider-profile-binding`.
- `WireAddition.kind`, `.rule` and `.advertisedBy`.

#### Decline codes

`DECLINE_CODES` lists every known `task.decline` code: Agent home, sealed
input, selection rules, offer admission (for example
`offer_capability_missing`, `file_scope_unsupported`), prepared offers
(`PREPARED_OFFER_DECLINE_CODES`) and the input-preparation rejections. `code`
stays optional and open: read it with `readDeclineCode`, and expect
`unknown` with `reportedCode`. Codes stay plaintext on sealed tasks.
`task.decline.reason` is now bounded and redacted like `task.fail.reason`.
A v7 device puts the code only in `code`: `reason` is the detail and no longer
starts with `<code>: ` (for example `offer_capability_missing` and the offer
selection rules). A Host that parsed a code out of `reason` reads `code`.
See [Decline codes in the staged protocol](https://github.com/Ancienttwo/byok-sdk/blob/a680fd5008ab6b4110d43b3ec770281661cc559e/docs/protocol.md#decline-codes).

#### Steer text bound

A plaintext `task.steer` text is at most 65,536 UTF-8 bytes
(`TASK_STEER_TEXT_MAX_BYTES`); the sender refuses a longer one before it
enqueues. A sealed steer is not checked on the device. `conn.hello` carries
at most 64 capability flags.

#### Cloud (`@byok-sdk/cloud`)

- **Claim and terminal executor.** The cloud records the winning claim's
  `executor` as `TaskAttempt.claimedExecutor`. A replayed claim must name the
  same executor. A claim's executor must be one the offer's target allows:
  any under `auto`, otherwise exactly the named runtime or harness. After a
  claim, every terminal must echo exactly that executor. Before a claim, a
  cancel carries none, and a `task.complete` is rejected. An unclaimed
  `daemon_interrupted` recovery may name the executor its device admitted
  before a claim that never reached the cloud; it must be one the offer's
  target allows, and it records no claim or owner. `TerminalResult.executor`
  (and the third argument of `projectTerminalResult`) is the claimed
  executor, so a task that was never claimed has none.
- **Renamed inbound refusal reasons** (`INBOUND_REFUSAL_REASONS`, as an
  observer reports them; the wire codes are unchanged). Rename these strings
  if your observer matches them:
  - `claim_harness_mismatch` is now `claim_executor_mismatch`;
  - `terminal_harness_mismatch` is now `terminal_executor_mismatch`;
  - `claim_harness_and_runtime_conflict` is removed: a claim can no longer
    express it.
  - New: `steer_refusal_id_mismatch` (wire `payload_invalid`),
    `steer_refusal_unknown_steer` (wire `not_permitted`) and
    `task_not_claimed` (wire `not_permitted`).
- **Reports before a claim** (#2289). Before a task is claimed, the cloud
  takes only `task.claim`, `task.decline`, `task.cancelled` and a
  `task.fail` with `recovery` from the offered device. Every other task
  report is rejected with `task_not_claimed` (wire `not_permitted`) and
  changes nothing: `task.started`, `task.progress`, `task.artifact`,
  `task.await_approval`, `task.approval_resolved`, `task.steer_refused`,
  `task.complete`, and a `task.fail` without `recovery`. The previous
  release took them, so an unclaimed task could become running, awaiting
  approval or terminal with no owner. Reports from any other device were already rejected
  (`task_not_found_for_device`). A device that claims before it reports
  sees no change.
- **Renamed fields.** `SteerRejectedError.executor` replaces `.runtime`, and
  `TerminalResult.executor` replaces `.harnessId`.
- **Steer refusals.** Read them with
  `ByokCloud.readSteerRefusal(tenant, taskId, steerMessageId)`, using the id
  of the envelope `steerTask` returned. Or page them with
  `ByokCloud.listSteerRefusals(tenant, { taskId, afterRevision, limit })`.
  The cloud records a refusal only for a `task.steer` it sent that device for
  that task. It takes the refusal in every task state and never changes the
  task's state. Task archive and redaction keep refusal rows, as they keep
  the terminal receipt; a row carries no content.
- **Steer text bound.** `steerTask` rejects a plaintext text over 65,536 UTF-8
  bytes with `coordination_input_invalid`, before any mailbox row exists.
- **`POST /byok/messages`** answers an entry of another wire major with
  `rejected` and `protocol_version_unsupported`, and an unknown type with
  `rejected` and `type_unsupported`, each with HTTP 200. The handshake answer
  carries `ingress` and no `capabilities`.

#### Cloud data plane (`@byok-sdk/cloud-dataplane`)

- **New database.** Run the migrations on a new Postgres database, then write
  the storage entitlements and retention policy. `0040_wire_v7.sql` stops
  before any change when any table already holds a row, Host configuration
  included, with an error that names the table. Otherwise it records wire
  epoch 7 in `byok_wire_epoch`.
- **Startup check.** `createPostgresCloudStores` rejects a database whose
  epoch is not 7, or that has none, with `PostgresStoreEpochUnsupportedError`
  (`code: 'POSTGRES_STORE_EPOCH_UNSUPPORTED'`, `requiredEpoch`, `foundEpoch`
  when present) and changes nothing. It replaces the pending-mailbox check:
  `PostgresMailboxProtocolUnsupportedError` and
  `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` are removed. Match the new code
  where you matched the old one.
- **New store.** `PostgresTaskSteerRefusalStore` is the `steerRefusals` port
  (table `task_steer_refusal`); `createPostgresCloudStores` includes it.
  Archive, redaction, retention and device retirement keep its rows; tenant
  erasure deletes them (`TENANT_ERASURE_TABLES`).
- **Claims.** A claimed task stores exactly one executor, in
  `claimed_runtime` or `claimed_harness_id` (a new CHECK).
- **One schema.** The migrations and the preflight act on the first schema of
  the connecting role's `search_path` in that database. Run the migrations and
  the cloud with the same role, database and `search_path`; changing the
  `search_path` between them points the cloud at another schema.
- **Cut over at once.** Per-task locks (steer refusals, approval timeline) use
  new keys, which a v6 process does not take. Do not run v6 and v7 cloud
  processes against one database; v7 starts on a new one.

#### Embedded server (`@byok-sdk/server`)

- **SQLite store.** The schema is version 10 and no older file is upgraded in
  place. Opening a file from a v6 build (schema 6 to 9) fails with
  `SqliteSchemaError` `SQLITE_SCHEMA_UNSUPPORTED`, and `inspectSqliteStore`
  reports `new-path-repair`. Point `storage.path` at a new file and pair again. Export required history
  with the old build before the cutover. `new-path-repair` is the pinned
  branch's inspection label, not automatic repair; align it with #2286 part C.
- **Dispatch.** `DispatchInput` takes one required `target` in place of
  `runtime`, `harnessId` and `dispatchSelection`. Pass `{ lane: 'auto' }` to
  keep the device's own runtime choice. An execution-core intent names a
  concrete target; `auto` is refused there.
- **Claimed executor.** `TaskSnapshot.claimedExecutor` and the `task.state`
  server event's `claimedExecutor` replace `claimedRuntime` and
  `claimedHarnessId`; `SteerRejectedError.executor` replaces `runtime`.
- **Steer.** `TaskHandle.steer` resolves `{ messageId }`. Text over 65,536
  UTF-8 bytes is refused with `ByokCloudError` `coordination_input_invalid`
  before anything is enqueued.
- **Steer refusals.** A task's event feed yields
  `{ kind: 'steer_refused', messageId, reason, at }` for each refusal
  recorded before its terminal; add the arm to exhaustive switches over
  `ServerTaskEvent`. `tasks.readSteerRefusal(taskId, messageId)` and
  `tasks.listSteerRefusals(taskId, { afterRevision, limit })` read every
  refusal, including one recorded after the feed ended. A refusal is kept for
  the life of the store, archived task included.
- **Event cursors.** `tasks.events` cursors start with `te2.`; a `te1.`
  cursor is refused with `cursor_unknown`. Start a new read.

#### Daemon (`@byok-sdk/client`)

- **Start after an accepted claim** (#2294). The daemon starts the runtime and
  sends `task.started` only after the cloud accepts its `task.claim`. A refused
  claim ends the attempt with one non-retryable `task.decline` whose `reason`
  is `claim refused: <refusal reason>`, with no `code`. A claim still unsettled
  at the offer's startup deadline fails with `runtime startup deadline exceeded`
  (retryable). A Host that saw `task.started` refused after a lost claim now
  sees that decline instead.

#### Cancel runs ahead of a hung steer (#2304)

A cancel runs immediately instead of waiting behind an unanswered steer of
its task. Later controls still wait for the cancel. If teardown rejects the
pending steer, the daemon reports `task_not_active`; if the steer resolves
after cancel, it sends no refusal. Neither sends another terminal. Use the
late-refusal reads above if the task feed already ended.

Source: [#2311] for [#2304]. No dedicated entry exists in the referenced
batch; the refusal surfaces are `wire-v7-steer-refused` and
`wire-v7-server-steer-refused`. Do not wait on `steer()` before sending cancel.
Wait for `task.started`, not a sent claim, before steering a running task.

The accepted-claim wait costs one round trip. `accepted` and a replayed
`duplicate` start the runtime; cancel/shutdown/deadline use the existing
claimed-before-start terminal path. The existing startup deadline (default
30 seconds) also bounds reconnects. Source: [#2305] for [#2294]; entry
`claim-accepted-before-runtime-start`.

Custom stores implement `TaskSteerRefusalStore` and
`MailboxStore.readMessage(tenant, { deviceId, messageId })` (exact retained-row
lookup, no ack). Sources: [#2277], [#2285]; entries `wire-v7-steer-refused`,
`wire-v7-cloud-steer-refusal-reads`. The client settles `type_unsupported`
permanently and advances the cursor; it no longer retries that envelope.
Source: [#2303]; entry `wire-v7-client-execution-target`.

### Pairing registration fence (#2045)

**随 wire v7 合入 (with the wire v7 merge).** F1 is separately staged; it is
not in the pinned integration/batch heads above.

Sources: [#2282], [#2287]. Manifest entries: `wire-v7-pair-fencing`, `wire-v7-pair-field-bounds`, `wire-v7-tenant-id-text`, `wire-v7-pairing-enrollment-port`, `wire-v7-pairing-product-id-bound`, `wire-v7-pairing-product-id-refused`, `wire-v7-client-pairing-errors`, `wire-v7-device-credential-attempt`, `wire-v7-auth-manager-pair`, `wire-v7-pair-gate-split`, `wire-v7-pair-new-code-fresh-key`, `wire-v7-v6-enrollment-entry-deleted`, `wire-v7-auth-errors-without-server-text`, `wire-v7-access-token-in-memory`.

`POST /byok/pair` fences machine supersession with a compare-and-set on the
machine's current device. See [#2282] and [#2287] for the staged contract.

- `PairRequest` requires `expectedDeviceDigest` (`null` or a
  `pairDeviceDigest`). A v6 client gets `400`.
- `401` carries `code: 'pairing_code_invalid'`. The new `409`
  `pairing_superseded` carries only `currentDeviceDigest`, and its code stays
  redeemable.
- Custom cloud stores: `DeviceRegistration` and `PairingEnrollmentInput`
  require `expectedDeviceDigest`. `DeviceDirectory.register` returns
  `DeviceRegistrationResult` (`registered` or `conflict`), and
  `PairingEnrollment.redeemAndRegister` returns `PairingEnrollmentResult`
  (`registered`, `conflict` or `code_invalid` in place of `undefined`).
  With `machineId`, the fence check, the supersession and the insert form
  one atomic section per machine; a conflict writes nothing and consumes no
  code. The cloud conformance suite has a case for each rule.
- `createPairingCode` refuses a `productId` longer than 64 characters
  (`PAIRING_CODE_PRODUCT_ID_MAX_LENGTH`) with `ByokCloudError` code
  `pairing_product_id_invalid`, and mints nothing. Hosts with longer product
  ids shorten them before upgrading.
- The in-memory, SQLite and Postgres reference stores implement the fence.
  Postgres serializes registrations of one machine with
  `pg_advisory_xact_lock`; no schema change.

#### Client pairing

- `Daemon.pair()` and `byok-agent pair` reject with three new errors:
  `PairingSupersededError` (another pairing of this `productId` replaced this
  one while its request was in flight; nothing was written), `PairingBusyError`
  (`retryable: true`; two pairings of the same machine ran at once; retry with
  the same code) and `PairingCodeRejectedError` (the code is unknown, expired
  or used; pair with a new code).
- `FirstPairingAttemptRefusedError` is renamed `PairingAttemptRefusedError`
  and has no `code`: its only cause is another store's staged attempt.
- `pairing_attempt_unattributed` and
  `clearDeviceEnrollment({ clearUnattributedAttempt })` are removed: a v7
  attempt always names its store. Hosts that handled them (AiphaBee:
  aiphabee#1384) drop that path.
- An injected `DeviceCredentialBackend` implements `readPairingAttempt` and
  `savePairingAttempt` in place of `readFirstPairingAttempt` and
  `saveFirstPairingAttempt`; the attempt type is `PairingAttempt`.
- Every pairing stages an attempt, including a re-pair. A retry with the same
  code resumes it; a new code stages a fresh key, except a re-pair of the
  store's own enrollment, which keeps its key.
- Pairing no longer holds the `productId` lock across its request or across
  its E2EE member custody. Re-pairing a running daemon shuts it down outside
  the lock; the member entries are written only while the new enrollment
  still holds.
- A pairing or renewal error carries only the HTTP status, never the server's
  response text. A malformed `2xx` body is `AuthResponseInvalidError` with no
  `cause`.
- **Wire bounds.** `PairRequest.deviceName` and `PairResponse.deviceId` are
  1 to 64 UTF-16 code units (`PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH`,
  `PAIR_RESPONSE_DEVICE_ID_MAX_LENGTH`) and a tenant id 1 to 200, of
  well-formed text without control characters. Code units, not code points:
  an astral character such as an emoji counts as two. One check,
  `isPairingText(value, maxUnits)`, owns both length and text at every
  boundary. The core tenant id mint (`tenantId`, `isTenantId`) now refuses any
  control character or unpaired surrogate, not only NUL; a Host that mints
  tenant ids with such characters changes them before upgrading. A client
  refuses a longer `deviceId` as `AuthResponseInvalidError` and writes
  nothing. These bounds are the wire contract, under which the largest OS
  credential entry measures 2,106 bytes; the client guarantees the 2,400-byte
  fit by checking the encoded entry before every write, and a pairing
  validates everything it writes before it writes `device.json`. A Host whose
  hostnames exceed 64 code units sets `deviceName`: `config check` reports it, and
  pairing throws `PairingInputInvalidError` (`field: 'deviceName'`). A
  `machineId` resolver must return a lowercase hex SHA-256, or pairing throws
  `PairingInputInvalidError` (`field: 'machineId'`).
- **The access token is no longer persisted.** `DeviceRecord` (and
  `DeviceCredentialBackend.read` and `replace`) carries no `accessToken` or
  `expiresAt`. The daemon exchanges a token with the device key on its first
  request after start and after a `401`, and keeps it in memory: a start costs
  the `/byok/challenge` and `/byok/token` round trips once. Renewal writes
  nothing. An injected `DeviceCredentialBackend` drops those two fields, and
  its `replace` always discards a staged attempt.
- **v6 OS entry.** The client reads the OS entry's format version and never
  decodes a v6 entry. `start` deletes it and reports re-pair required, pairing
  deletes it and pairs as a first pairing, and a clear deletes it. Re-pair
  every device after the cloud upgrade, as the operator order above says.

## After the upgrade

Run config check, `status`, and `doctor` with the daemon's own release. Verify
fresh pairing/provider setup, one task reaching `task.started` and a terminal,
and steer/cancel handling before restoring traffic. Package installation alone
does not establish these Host paths. The observations below describe what changes.

### Bot collaboration inbound conversation identity (#2250)

Sources: [#2261]. Manifest entries: `bot-inbound-conversation-kind`.

`inboundKey(message)` now includes channel, conversation kind, conversation id,
and platform message id. Direct/group conversations with the same id stay
separate. Every inbound key changes; drain delivery before upgrading to avoid
one-time readmission. Persist/compare the new keys; there is no old-key lookup.

### Bot collaboration round inbound disposition (#2255)

Sources: [#2261]. Manifest entries: `bot-round-inbound-disposition`.

An existing root Turn stays authoritative. Without a root, any succeeded or
delivered seat means `answered`; otherwise a failed/cancelled seat means
`failed`; otherwise `coalesced`. Seat-only cancellation no longer means root
`cancelled`. Update consumers; existing rows use this precedence without migration.

### Device retirement keeps assertion replay entries (#2264)

Sources: [#2266]. Manifest entries: `dataplane-revoke-keeps-assertion-replay`.

Keep replay entries through revoke/supersession until the assertion expires
(at most five minutes after issue). Postgres now matches in-memory and SQLite.
Custom directories must do the same. Pass `deviceAssertionReplay` to
`createByokCloud` and schedule `runMaintenance()` to collect expired rows;
without the authority that step is `not-configured` and rows accumulate.

### Grok tasks no longer run the Grok updater (#2269)

Sources: [#2276]. Manifest entries: `grok-task-autoupdate-off`.

Every Grok task gets `GROK_DISABLE_AUTOUPDATER=1`, overriding the task environment.
If you relied on tasks to update Grok, update it outside tasks (the user's Grok
or installer). Tasks no longer write the updater's `agent` link into the install.

### Pi tasks and extension runs (#2299)

Sources: [#2301], [#2307], [#2313]. Manifest entries: `pi-turn-own-run`.

The first Pi prompt uses `streamingBehavior: 'followUp'` to join an active
extension run. Its turn ends with that run and includes its remaining output.
Unrelated runs outside the turn no longer settle it or report their progress,
usage, or tool frames as the task's. Extension errors remain visible. A prompt
handled without a run ends the turn immediately.

For output free of user extension runs, use `agentUserContext: 'excluded'` and
only Host-owned `agentExtensionPaths`. Inherit loads user extensions too.
An extension's settlement/compaction hook can still drop the first prompt;
keep the Host startup deadline wired to cancellation. Startup waits now stop
on abort (#2307), including durable startup (#2313). Those abort fixes have
no separate manifest entry.

### OAR 0.110.0 (#2235, #2296)

#### Unconfirmed models fail non-retryable (Codex, agy)

Sources: [#2242], [#2298]. Manifest entries: `model-confirmation-non-retryable`.

A requested model that the runtime does not confirm now fails start with
`ModelConfirmationError`: `task.fail.retryable: false`, `failure.class: 'unknown'`.
A direct adapter throws a start `RuntimeExecutionFailure` with non-retryable retry.
Change the requested model or its access before sending a new task. Do not
retry the same mismatch as transient. dsh, Grok, and OpenCode are unchanged.

#### agy model mismatches wait up to the request deadline

Sources: [#2242], [#2298]. Manifest entries: `agy-model-confirmation-deadline`.

A conflicting model notification is only an observation. A later notification
with the requested model can still confirm it. A persistent mismatch fails at
agy's 30-second request deadline. Allow that deadline in Host startup timeouts.
A successful confirmation after an earlier conflict is valid.

#### agy runs with `--gemini-dir`

The ACP argv now includes `--gemini-dir <owned home>/.gemini`. Allow the flag
in wrappers and argv allowlists; the device's agy must support it. Sources:
[#2242], [#2298]. No dedicated manifest entry (no public type/config change).

#### Claude queued follow-up write failures

Sources: [#2242], [#2298]. Manifest entries: `claude-queued-write-failure`.

Direct `ClaudeAdapter` embeddings treat resolved `followUp()` as queued, not
written. A later stdin failure reaches the `events` iteration as a retryable
run failure. Resend the undelivered input on a new session. Daemon Hosts do
not call this API and need no change.

### Blocked Turn projection ids (#2245)

Sources: [#2263]. Manifest entries: `bot-blocked-projection-id`.

Match the `blocked:` prefix and read `turnId` / `code` from the value.
The id is now `blocked:<turnId>:<code>:<fingerprint>`, with
`{ owner, turnId, code, reason }`. Codes are `unavailable_model`,
`schema_over_budget`, and `current_request_too_large`. Changed reasons add
rows; a repeated reason reuses the same id. Deduplicate by id.

### Pi Agent skills from DaemonConfig (#2169)

Sources: [#2271]. Manifest entries: `pi-agent-skill-paths-config`.

Set `runtimes.pi.agentSkillPaths` to authorized absolute skill files/directories
instead of constructing an adapter for them. Unset stays `[]`. Relative,
duplicate, NUL-containing paths, or a non-empty list with `durableLane`, are
invalid config. Missing/unreadable skills fail start non-retryable before spawn.
Under file scope, `read` refuses skills outside granted roots (`outside_scope`);
`/skill:<name>` still expands them. Symlinks are followed; ownership is not checked.

### Device retirement clears device-scoped state (#2237)

`DeviceDirectory.revoke()` and machine supersession in `register()` (also
reached through `pairing.redeemAndRegister()`) now delete the retired device's
presence hint, challenge nonces and inbound dedup ledgers in every SDK
composition: in-memory, the embedded SQLite server and Postgres. Before, only
Postgres deleted them; in memory and on SQLite a revoked device's presence hint
stayed until its TTL, and its nonces and dedup ledgers stayed until expiry or
restart. Device-assertion replay entries are still kept until they expire
(#2264).

#### Store ports gain deleteDevice

Sources: [#2268]. Manifest entries: `device-state-delete-ports`.

Custom `PresenceStore`, `NonceStore`, and `InboundDedupStore` implementations
add `deleteDevice(tenant, deviceId): Promise<void>`. Delete every presence hint,
nonce, and device/Agent dedup ledger for the device.

#### In-memory composition wiring

Sources: [#2268]. Manifest entries: `in-memory-directory-device-state`.

Pass `core.presence` after `core.mailbox` to `createInMemoryCloudStores`.
Give `InMemoryDeviceDirectory(tasks, mailbox, state)` its third argument
`{ presence, nonces, dedup }` from the composition's stores.

#### Retirement contract for a custom DeviceDirectory

Sources: [#2268]. Manifest entries: `device-retirement-clears-state`.

On revoke and machine supersession, call the stores' `deleteDevice` once the
registration change is durable (in its transaction, if shared). On every revoke,
clean up even without a device row, so retry recovers failed cleanup. Do not
delete assertion replay entries. A retired device disappears from presence.

If your Host reuses a `deviceId`, a resent old envelope can be processed again
after dedup deletion. Own that idempotency if needed. Standard pairing mints
a new id.

#### Postgres stores

Sources: [#2268]. Manifest entries: `postgres-device-state-delete`.

`PostgresPresenceStore`, `PostgresNonceStore`, and `PostgresInboundDedupStore`
implement `deleteDevice`. Repeated revoke clears state without a device row.
No schema change.

### E2EE member state on retirement (#2267)

Retirement now clears E2EE member state in every opted-in composition. Follow
the shared-store wiring and custom-directory rules below.

#### E2EE member store moves into CloudStores

Sources: [#2278]. Manifest entries: `e2ee-member-store-in-cloud-stores`.

Remove `ByokCloudOptions.e2eeMemberStore`. Enable `e2eeMember: true` in the
Postgres or in-memory composition and pass its stores as `cloud`. Custom
compositions give routes and the directory the **same** `CloudStores.e2eeMember`
instance; no runtime check detects two instances.

#### Capability ports read cloud.e2eeMember

Sources: [#2278]. Manifest entries: `e2ee-capability-port-in-cloud-stores`.

Replace `CapabilityPorts.e2eeMemberStore` with `cloud: stores` in
`capabilityDeclarationForPorts`. Keep the `e2ee.member` declaration and store
paired; mismatches fail construction.

#### InMemoryE2eeMemberStore is no longer exported

Sources: [#2278]. Manifest entries: `remove-in-memory-e2ee-member-store`.

Use the composition opt-in's `stores.e2eeMember` instead of a standalone store.

#### E2eeMemberStore gains deleteDevice

Sources: [#2278]. Manifest entries: `e2ee-member-store-delete-device`.

Custom stores add `deleteDevice(tenant, deviceId)`. Delete the member's addressed
scope-key packages, registration, and both pairing MACs. Keep chain, epochs,
key ids, shred records, KEM floor, and proof requests. A device with no state
is a no-op.

#### Retirement deletes E2EE member state

Sources: [#2278]. Manifest entries: `device-retirement-clears-e2ee-member-state`.

Custom directories call that method on both durable retirement paths and every
revoke, even without a device row. Retired packages disappear and the member id
can be registered again; its KEM floor remains. A package written after retirement
is not cleaned through a registration that is already gone.

#### E2EE composition opt-ins

Sources: [#2278]. Manifest entries: `e2ee-composition-opt-ins`.

`CloudStores.e2eeMember`, `DeviceScopedStores.e2eeMember`, the composition
`e2eeMember: true` opt-ins, and `PostgresE2eeMemberStore.deleteDevice` are additive.

### Service uninstall stops before it removes `current` (#2274)

Sources: [#2275], [#2280]. Manifest entries: `service-uninstall-stops-before-pointers`.

Exercise uninstall/reinstall on supported service platforms. The order is
stop/unregister while `current` exists, remove `current`, remove unit/launcher,
then remove payloads, snapshots, and receipt.

A failed/refused/timed-out stop removes nothing; the service can still start.
A later unit-removal failure leaves no `current`, so it starts no payload.
Retry `uninstall()` after fixing the cause. Windows user-scope retry does not
run a missing stop program when no launcher runs. Failed first-install cleanup
uses the same order. This fixes the previous Windows uninstall regression.

### Runtime status carries every observation field inline

Sources: [#2288]. Manifest entries: `runtime-status-inline`, `runtime-status-side-arrays-refused`.

`@byok-sdk/client` control `status` (`byok-agent status`, `doctor`) now returns
each runtime's `versionVerdict`, `versionChange`, `executablePath` and
`executableSource` inside `runtimes[]`, like `Daemon.status()`. The
`runtimeVersionVerdicts`, `runtimeVersionChanges` and `runtimeExecutables` side
arrays are gone. A status from an earlier daemon that still sends them is
refused (`ControlStatusShapeUnsupportedError`): `status` reports the live status
unavailable, and `doctor` reports the daemon status request failed and probes
runtimes locally. Run `status` and `doctor` from the same release as the daemon.
Audit records and the support bundle still carry neither the verdict, the
restart comparison nor the executable path.

### Version verdict is the one runtime version warning

Sources: [#2288]. Manifest entries: `runtime-version-verdict-only`.

`RuntimeDetectResult.advisory` and the `RuntimeDetectionAdvisory` type are
removed. An unqualified runtime version is reported only as
`versionVerdict: { state: 'warn', qualifiedVersion }`, and
`RuntimeObservation.qualifiedVersion` is that warning's projection. A custom
runtime adapter whose `detect()` still returns `advisory` is refused by
`validateRuntimeDetectResult()`; return `versionVerdict` instead (or
`runtimeVersionDetectionFields()` output). A Host that read
`availability.advisory.qualifiedVersion` reads
`availability.versionVerdict?.state === 'warn' ? availability.versionVerdict.qualifiedVersion : undefined`.

### Agent memory outbox version 2 is refused

Sources: [#2288]. Manifest entries: `agent-memory-outbox-version-error`, `agent-memory-outbox-v2-rejected`.

An Agent home whose `.byok/agent-memory-redacted-outbox-v2.json` still holds the
0.32.0 version 2 state is no longer upgraded in memory. Memory projection for
that home fails with `AgentMemoryOutboxVersionUnsupportedError`
(`stateVersion: 2`); the file is neither read further, rewritten nor deleted, and
a higher writer epoch does not replace it. Remove or archive the file to resume
projection. Its pending memory mutations, if any, are not published.

### Todo extension reads one config location

Sources: [#2288]. Manifest entries: `todo-config-legacy-location-refused`.

The bundled Pi todo extension reads its settings only from
`$XDG_CONFIG_HOME/rpiv-todo/config.json` (`~/.config/rpiv-todo/config.json`
when `XDG_CONFIG_HOME` is unset). It no longer falls back to
`~/.config/rpiv-todo/config.json` when `XDG_CONFIG_HOME` points elsewhere:
if the `XDG_CONFIG_HOME` file is absent and the old one exists, loading the
extension's config throws `TodoConfigLegacyLocationError` naming both paths.
Only the old file's existence is checked; its content is never read. With a
todo config at the old location, Pi reports this error when it loads the todo
extension; moving the file fixes it.

### MCP frame ceiling has one authority

Sources: [#2288]. Manifest entries: `mcp-frame-ceiling-single-authority`.

`@byok-sdk/client/mcp-server` `MCP_SERVER_MAX_FRAME_BYTES` is unchanged at
1 MiB. It is now a re-export of the same constant the SDK MCP client's read
buffer and the HTTP server's `maxOutboundFrameBytes` default use, so the three
can no longer drift apart. No Host change.

### Other manifest entries

These entries linked to separate docs/issues; include them in the Host review too.

| Change | Host action | Source / manifest entry |
| --- | --- | --- |
| K4 settlement hint | `HostOptions.onSettled` is an optional coalesced synchronous hint. K8 advances on K4 settlement; extra terminal-only drains can be removed if they existed solely to advance Turns. | [#2265], `k4-settlement-notice` |
| Delivery supersession | Delivery adapters can use `supersededDeliveryIds` to exclude manual-resend predecessors from active work and retention protection. | [#2262], `bot-delivery-supersession` |
| Grok user context | `inherit` stays the default. With `excluded`, use a sealed Agent home; user instructions/sessions stay out. Switching a Bot from inherit cannot resume its old user-store sessions. Isolation refusal is non-retryable. See [Grok isolation](../adapter-capabilities.md#agentusercontext-grok). | [#2258], `grok-agent-user-context` |
| Grok retention | Add `grok-session-store` to exhaustive switches. Default TTL is 31 days or session-ledger TTL + one day, whichever is longer; explicit TTL must meet the latter floor. Live sessions/running homes are protected; the search index is untouched. | [#2258], `grok-session-store` |
| Codex on Windows | `excluded` without symlink privilege refuses detection with `agent_user_context_unavailable`; offers decline retryable before claim. Enable Developer Mode, use an administrator daemon, or choose `inherit`. Accept unknown unavailable causes through the protocol reader. | [#2259], `agent-user-context-unavailable-cause` |

### AiphaBee same-release checklist

[AiphaBee #1384] and its comments are the adoption authority. Paths identify
call sites, not stable line numbers. Adoption still needs the candidate and
owner's MINOR approval through the advisor.

| Same-release action | Source / SDK entries |
| --- | --- |
| Ship Local Agent and byok-host together; new cloud store, re-pair, configure providers. | [AiphaBee #1384], [#2277], [#2287]; `wire-v7`, `wire-v7-v6-enrollment-entry-deleted` |
| Drop `pairing_attempt_unattributed` / `clearUnattributedAttempt` in `apps/local-agent/src/user-installer.ts`. Drop `migrateProviderProfileStore` there and in `packages/byok-host/src/coordinator.ts`. | [AiphaBee #1384], [#2287], [#2290]; `wire-v7-device-credential-attempt`, `retire-compatibility-apis` |
| Remove `migrateWouldDo` and `WouldDoMigration` in `toolset-migration.ts` and byok-host's bot-collaboration re-exports; rework/delete the migration. | [Type comment](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6913636275), [#2290]; `retire-compatibility-apis` |
| Replace `availability.advisory.qualifiedVersion` in `packages/agent-runtime/src/local-runtime-capabilities.ts` and its/byok-host runtime tests with `versionVerdict`. | [Status comment](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6913353618), [#2288]; `runtime-version-verdict-only` |
| Remove `PROVIDER_TRUTH_INVALID` copy in all three locales in `apps/local-agent/src/settings-copy.ts`. Keep `KEYCHAIN_SECRET_DECODE_FAILED` copy; do not add `KEYCHAIN_LEGACY`. | [Copy comment](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6914910257), [Correction](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6918385300), [#2290]; `retire-compatibility-apis` |
| In `research-pass-host.ts`, replace `execution-core-k8.sqlite` with a new path and use `botLedgerOptions`. Retarget `migrateLegacyBotChatStore` in `local-bot-chat-store.ts`. Drop `collaboration.version`, `OldCollaborationStateError`, and new-path-repair uses; use switch export 2. Respect keys custody refusal and core's default `sqlite-node` entry. | [Part B update](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6924493982), [#2309]; `host-ledger-format-table`, `host-ledger-format-api`, `keys-store-refuse-before-write`, `core-sqlite-node-entry` |
| Check win-ci and every other paired device for in-flight/must-keep ledger work. The two checked Mac ledgers do not establish other devices' state. | [Device comment](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6921118095), [#2309]; `host-ledger-format-table` |
| Current tenant/name sources needed no change in the coordinator's audit. If the cloud display name is later passed as SDK `deviceName`, tighten its 80-character validator to the SDK's 64-unit/text rule first. | [Name comment](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6916985327), [#2287]; `wire-v7-pair-field-bounds` |
| Run typecheck/tests without removed compatibility calls; run #1016 win-ci install → reinstall with switched receipt → uninstall to baseline; test a staging LA build with re-pair. These gate the production LA hold and #1377/#1016/#983. | [AiphaBee #1384], [Uninstall update](https://github.com/Ancienttwo/aiphabee/issues/1384#issuecomment-6913995844), [#2275], [#2280]; `service-uninstall-stops-before-pointers` |

## Known residuals

### WAL-only format metadata

Sources: [#2295], [#2309], [#2283]. Manifest entries: `sqlite-stores-refuse-before-write`, `client-journal-exact-format`, `host-ledger-format-table`, `keys-store-refuse-before-write`, `wire-v7-server-sqlite-store`.

Not handled: the format is read from the main file. A store created by an older
version that crashed before its first checkpoint holds its schema only in its
WAL; its format is decided on a writable connection, and when that connection
closes after the refusal SQLite checkpoints the WAL into the main file and
removes the `-wal` and `-shm` files. The refused store keeps its logical content,
but its file bytes change. This applies to every store above, the Host ledger and
the keys store below. Such a store holds almost no data. New stores checkpoint
right after creating their schema, which keeps that window short.

This accepted exception also covers the staged v7 server. Preserve the main
file **and sidecars together** before trying the new build if an untouched
artifact is required. Do not claim unconditional byte preservation.

### Grok login preserved during excluded tasks

If Grok replaces its auth link with a login file, the SDK leaves that file in
execution scratch, reports a cleanup `RuntimeDisposalFailure`, skips retention
for that execution, and blocks later Grok starts. The user moves the file back
to their Grok home or deletes it and logs in again. The SDK never restores or
deletes it. Source: [#2258]; entry `grok-agent-user-context`.

### Integration and adoption evidence

Phase 2, part C/C2/P, F1, final manifest alignment, and pinned-v6 halt checks
belong to the integration/release gate. This documentation does not establish
those results. AiphaBee's Windows and staging acceptance stays under
[AiphaBee #1384].

[#2095]: https://github.com/Ancienttwo/byok-sdk/pull/2095
[#2098]: https://github.com/Ancienttwo/byok-sdk/issues/2098
[#2242]: https://github.com/Ancienttwo/byok-sdk/pull/2242
[#2256]: https://github.com/Ancienttwo/byok-sdk/pull/2256
[#2258]: https://github.com/Ancienttwo/byok-sdk/pull/2258
[#2259]: https://github.com/Ancienttwo/byok-sdk/pull/2259
[#2261]: https://github.com/Ancienttwo/byok-sdk/pull/2261
[#2262]: https://github.com/Ancienttwo/byok-sdk/pull/2262
[#2263]: https://github.com/Ancienttwo/byok-sdk/pull/2263
[#2265]: https://github.com/Ancienttwo/byok-sdk/pull/2265
[#2266]: https://github.com/Ancienttwo/byok-sdk/pull/2266
[#2268]: https://github.com/Ancienttwo/byok-sdk/pull/2268
[#2271]: https://github.com/Ancienttwo/byok-sdk/pull/2271
[#2275]: https://github.com/Ancienttwo/byok-sdk/pull/2275
[#2276]: https://github.com/Ancienttwo/byok-sdk/pull/2276
[#2277]: https://github.com/Ancienttwo/byok-sdk/pull/2277
[#2278]: https://github.com/Ancienttwo/byok-sdk/pull/2278
[#2280]: https://github.com/Ancienttwo/byok-sdk/pull/2280
[#2282]: https://github.com/Ancienttwo/byok-sdk/pull/2282
[#2283]: https://github.com/Ancienttwo/byok-sdk/pull/2283
[#2285]: https://github.com/Ancienttwo/byok-sdk/pull/2285
[#2287]: https://github.com/Ancienttwo/byok-sdk/pull/2287
[#2288]: https://github.com/Ancienttwo/byok-sdk/pull/2288
[#2290]: https://github.com/Ancienttwo/byok-sdk/pull/2290
[#2291]: https://github.com/Ancienttwo/byok-sdk/pull/2291
[#2293]: https://github.com/Ancienttwo/byok-sdk/pull/2293
[#2294]: https://github.com/Ancienttwo/byok-sdk/issues/2294
[#2295]: https://github.com/Ancienttwo/byok-sdk/pull/2295
[#2297]: https://github.com/Ancienttwo/byok-sdk/pull/2297
[#2298]: https://github.com/Ancienttwo/byok-sdk/pull/2298
[#2301]: https://github.com/Ancienttwo/byok-sdk/pull/2301
[#2302]: https://github.com/Ancienttwo/byok-sdk/pull/2302
[#2303]: https://github.com/Ancienttwo/byok-sdk/pull/2303
[#2304]: https://github.com/Ancienttwo/byok-sdk/issues/2304
[#2305]: https://github.com/Ancienttwo/byok-sdk/pull/2305
[#2307]: https://github.com/Ancienttwo/byok-sdk/pull/2307
[#2309]: https://github.com/Ancienttwo/byok-sdk/pull/2309
[#2311]: https://github.com/Ancienttwo/byok-sdk/pull/2311
[#2313]: https://github.com/Ancienttwo/byok-sdk/pull/2313
[AiphaBee #1384]: https://github.com/Ancienttwo/aiphabee/issues/1384
