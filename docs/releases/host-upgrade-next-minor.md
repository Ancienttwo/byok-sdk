# Host upgrade to the next MINOR

Use this checklist in order: [before](#before-upgrading), [during](#during-the-upgrade),
[after](#after-the-upgrade), then [known residuals](#known-residuals).
It covers changes after 0.43.0. Earlier Hosts first apply the
[previous checklist](host-upgrade-0.43.0.md) and its predecessors.

Before upgrading, finish or explicitly abandon in-flight collaboration work.
Older ledgers are refused regardless of any earlier migration; the candidate
removes `migrateWouldDo`. See [Host ledgers](#host-ledgers-record-their-format-2286).

**This is release preparation.** Sections marked **With the wire v7 merge**
take effect with that merge. Check the final candidate's manifest before deployment.

Sources below name PRs and entry ids in
[`upgrade-manifest.json`](../../packages/client/upgrade-manifest.json).
Missing dedicated entries are stated explicitly.

## Before upgrading

1. Stop accepting new work and drain inbound delivery on **every device**.
   Finish or explicitly abandon open turns, delegations, routines, and topology
   switches. Sources: [#2261], [#2309]; entries `bot-inbound-conversation-kind`,
   `host-ledger-format-table`, `reject-hosted-store-version-2`.
2. Export required history **with the old build**, then stop its writers.
   Prepare separate cloud, K4/K8 ledger, and refused provider-store paths.
   Old-format **stores** are refused with typed errors, without reading their
   content, deleting, migrating or rebuilding them. Keep them for history.
   Two qualifications: [v6 enrollments are deleted](#credentials-and-provider-keys)
   with wire v7, and [WAL-only refusal can change store bytes](#wal-only-format-metadata).
   Sources: [#2290], [#2309], [#2287]; entries `reject-older-provider-kind-store`,
   `host-ledger-format-table`, `wire-v7-v6-enrollment-entry-deleted`.
3. Complete the Host code, store and configuration adaptations below before
   deployment. Plan one cloud/daemon/CLI window, cloud first. Sources: [#2277],
   [#2303]; entries `wire-v7`, `wire-v7-client-negotiation-halt`.
   AiphaBee's Local Agent and byok-host must ship together; its adoption checklist
   lives in [AiphaBee #1384].

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

Remove `AgentSessionHandoffStore.getTaskTerminal()`; use the
`recordTaskTerminal()` receipt awaited before `task.fail`. No public read replaces it.

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

Replace `openDaemonLog()` / `DaemonLog` with a Host line sink and rotation.
`DaemonLogOptions` remains for internal process output.

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

Remove `listInstalledSkillPacks()`; retain the names returned by
`installSkillPacks()`. `projectSkillPack()` copies an installed pack by name.

#### Truth memory client

Sources: [#2288]. Manifest entries: `remove-truth-memory-client`.

Remove `TruthMemoryClient`, `TruthMemoryClientError` and their option, input,
and result types. Call cloud truth routes with a device proof from
`createStoredDeviceProofSigner()`, which remains available.

### In-memory blob factory

Sources: [#2256]. Manifest entries: `remove-create-in-memory-blobs`.

Replace `@byok-sdk/cloud`'s `createInMemoryBlobs(objects, bytes)` with
`bytes.bind(objects)`, where `bytes` comes from `createInMemoryBlobBytes()`.
The result remains `InMemoryBlobs`.

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

**With the wire v7 merge.**

Sources: [#2297]. Manifest entries: `cloud-unused-exports-removed`, `cloud-host-facade-methods-removed`, `cloud-approval-identity-required`, `cloud-approval-unnamed-observation-refused`, `cloud-agentless-archive-input-removed`, `cloud-error-agent-ref-missing-removed`, `dataplane-unused-exports-removed`, `dataplane-retention-policy-store-removed`, `dataplane-mailbox-row-tenant-validated`.

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
- **Approval identity.** Supply `approvalId` on requested/resolved and Host
  approve/reject observations. `ApprovalObservationSchema`,
  `ApprovalTimelineEventSchema` and `PendingApproval` require it;
  reading stored observations without it fails without synthesizing an id.
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
- **Mailbox rows.** Invalid `tenant_id` in outbox reads raises
  `ByokCoreError` `tenant_id_invalid`; SDK-written rows are unaffected.
- **Agentless retirement.** Remove `retireAgentlessTasks` and its option/result
  types. The `task_agentless_retired` fence still rejects new offers for
  retired ids with `agent_task_already_exists`.

### Undici in the Host dependency tree

Keep a Host override to **8.12.4**. Pi's exact dependency can still install a
separate older copy. Merge the setting into the Host root `package.json`, reinstall, and check:

| Manager | Setting | Verification |
| --- | --- | --- |
| npm | `"overrides": { "undici": "8.12.4" }` | `npm ls undici --all` |
| Bun | `"overrides": { "undici": "8.12.4" }` | `bun pm why undici` |
| pnpm | `"pnpm": { "overrides": { "undici": "8.12.4" } }` | `pnpm why -r undici` |

Every listed undici version should be 8.12.4. This does not update Node's
built-in undici or another package's bundled copy. Sources: [#2098], [#2095].
No new manifest entry: this carries forward the
[previous override advice](host-upgrade-0.43.0.md#undici-in-the-host-dependency-tree-2081).

### SQLite stores decide their format before any write (#2286)

Sources: [#2295], [#2309]. Manifest entries: `core-sqlite-node-entry`, `sqlite-stores-refuse-before-write`, `client-journal-exact-format`.

SQLite stores check the unchanged main file before writable open, pragmas or
DDL. Refusal preserves bytes and creates no sidecars, except for
[WAL-only format metadata](#wal-only-format-metadata).

The Node entry `@byok-sdk/core/sqlite-node` exports
`readSqliteFileUnchanged(path, readMetadata)` for copy-and-own stores. It reads
existing non-empty files read-only and immutable; `:memory:`, missing and
zero-length files return `undefined`. Call it before writable open. The core
root does not export it; lazy Node imports let Worker bundles resolve it.
`sqliteOpenPath` / `sqliteFileUri` use Windows extended-length paths for both
opens, including paths past `MAX_PATH`; `:memory:` remains unchanged.

- Local task journals must have exactly the current tables and columns. Old
  `local_artifact_ref`, `local_cleanup_candidate` or `local_storage_usage`
  tables cause `JournalUnavailableError`; they are no longer dropped. Format
  refusals and read-only open failures stay in place. Unreadable SQLite files
  are still quarantined; other stores report `SqliteReadOnlyOpenError` for
  read-only open failures.
- A durable replica with a different pi-durable schema is refused with
  `DurableReplicaFormatError`, without migration. A replica lock path holding
  another database is also refused without writing it.
- Released journals and replicas are current. Export or preserve refused
  stores before starting the candidate.
- Copy-and-own Desktop `HostStore`, basic Clarification and goal/btw stores,
  and MCP `BetaLedger` follow this check. The basic stores share a database
  through one `host_format` row per store. Existing tables without that
  metadata require a separate new path.

### Host ledgers record their format (#2286)

Sources: [#2309]. Manifest entries: `host-ledger-format-table`, `host-ledger-format-api`, `keys-store-refuse-before-write`, `reject-hosted-store-version-2`.

`HostLedger` from `@byok-sdk/server/execution-core` uses
`host_store_format(owner, version)` as its sole format authority: `k4` for
itself, `k8` for Bot collaboration. Before writable open, a missing, unknown
or mismatched layer, or tables without format metadata, raises
`HostStoreFormatError` (`host_store_format_unsupported`).

All previously released ledgers lack this table and are refused. Complete or
abandon collaboration work and export needed history with the old build; open
a new ledger at a new path for the candidate.

- `HostLedgerOptions.expectedFormats` names layers besides `k4`;
  `ledger.formats` exposes the rows. Open Bot ledgers with
  `new HostLedger(file, tenant, { ...botLedgerOptions, projectionOutboxLimits })`
  using `botLedgerOptions` from `@byok-sdk/bot-collaboration`.
  `BotCollaboration` refuses ledgers without it; `inspectLedger` reports
  older ledgers as `rejected`.
- Remove `LedgerState.version`, `CollaborationState.version`,
  `OldCollaborationStateError` and collaboration `new-path-repair` handling.
  `LedgerDump` and `SWITCH_EXPORT_VERSION` are 2; older dumps/exports are refused.
- The hosted Postgres example uses `STORE_VERSION` 3. Version 2 scopes raise
  `HostedStoreVersionError` under the scope lock before writes; schedulers
  skip them. Finish or abandon their work, then use a new schema/database.

For provider stores, follow [keys custody checks](#credentials-and-provider-keys).

### Credentials and provider keys

Sources: [#2290], [#2309], [#2287]. Entries `retire-compatibility-apis`
(removed Keychain option; no dedicated unprefixed-secret entry),
`reject-older-provider-kind-store`, `keys-store-refuse-before-write`,
`wire-v7-v6-enrollment-entry-deleted`.

- An unprefixed provider Keychain entry raises `KEYCHAIN_SECRET_DECODE_FAILED`.
  Delete that entry in the OS keychain, then configure the provider again.
  Keep the decode-error UI; there is no `KEYCHAIN_LEGACY` code.
- `SqliteProviderProfileStore` refuses a `provider_profile` store missing
  custody tables with `PROVIDER_STORE_SCHEMA_STALE` before WAL/DDL. Preserve it
  and configure a separate current store and providers. Read-only open failure
  raises `PROVIDER_STORE_UNAVAILABLE`; released keys stores remain accepted.
  Its configuration lock uses `sqliteOpenPath`, like the store.
- With wire v7, the client recognizes a v6 enrollment by format without
  decoding its key. `start` deletes it and requires re-pairing; `pair` deletes
  it and performs first pairing; `clear` deletes it. Status only reports it.
  This enrollment deletion does not delete old databases.

### Wire v7

**With the wire v7 merge.**

Sources: [#2277], [#2285], [#2283], [#2291], [#2293], [#2302], [#2303], [#2305]. Manifest entries: `wire-v7`, `wire-v7-execution-target`, `wire-v7-steer-refused`, `wire-v7-no-server-capabilities`, `wire-v7-decline-codes`, `wire-v7-retired-flags-and-bounds`, `wire-v7-decline-reason-bound`, `wire-v7-server-execution-target`, `wire-v7-server-steer-refused`, `wire-v7-server-sqlite-store`, `wire-v7-cloud-executor`, `wire-v7-cloud-steer-refusal-reads`, `wire-v7-cloud-terminal-executor`, `wire-v7-cloud-unclaimed-task-reports`, `wire-v7-cloud-steer-text-bound`, `wire-v7-dataplane-postgres-new-database`, `wire-v7-dataplane-store-epoch`, `wire-v7-dataplane-stores`, `wire-v7-client-negotiation-halt`, `wire-v7-client-execution-target`, `wire-v7-client-decline-reason-detail`, `wire-v7-client-selection-before-native-sessions`, `claim-accepted-before-runtime-start`.

`PROTOCOL_VERSION` is 7. There is no v6 reader: a v6 peer and a v7 peer
cannot talk to each other.

#### New store

v7 requires new stores; v6 receipts, history and attempts are not migrated.
Export needed history with the old build. Rotate K4 frozen work and outbox
snapshots, and follow [credential handling](#credentials-and-provider-keys).

- Postgres: run migrations on a **new database**, then write storage
  entitlements and retention policy. Use the same role, database and
  `search_path` for migration and cloud startup: both act on its first schema.
  `0040_wire_v7.sql` refuses any populated table, including Host configuration,
  before changes; otherwise it records epoch 7 in `byok_wire_epoch`.
- Embedded SQLite: point `storage.path` at a **new file**. Schema 10 refuses
  v6 schemas 6 to 9 with `SqliteSchemaError` `SQLITE_SCHEMA_UNSUPPORTED`.
  `inspectSqliteStore` reports `new-path-repair`, an inspection label, not
  automatic repair. A pending mailbox row from another major raises
  `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`.

#### What a v6 daemon sees

- **Not paired again:** expected to stop at authentication with
  `device_revoked`. Verify with the deployed v6 daemon that it halts without
  reconnecting forever.
- **Paired again into the v7 store:** its lone `conn.hello` gets
  `rejected` with `protocol_version_unsupported`. It reads that as a refused
  handshake and halts with `handshake_rejected`.

A v7 daemon that reaches a v6 cloud gets HTTP 400 on its hello and halts with
`ProtocolNegotiationError` (`code: 'protocol_negotiation_failed'`,
`localVersion`, `httpStatus`; `peerVersion` only when the peer stated it).
Upgrade both sides to resolve it.

Add `protocol_negotiation_failed` to Host halt-reason switches. The client
uses it for hello rejection `protocol_version_unsupported` (HTTP 200) or a
4xx except 401, 403, 409, 413 and 429. Halted `DaemonLifecycle` carries
`httpStatus`; CLI start, diagnostics and support bundles print it.
`whenOpen()` rejects with `DaemonHaltError` caused by
`ProtocolNegotiationError`. A 404 usually means a wrong base URL or unmounted
messages route.

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

A device reports an undelivered steer as
`task.steer_refused { steerMessageId, reason }`. Known reasons are
`input_too_large`, `steer_unsupported`, `task_not_active`; the list is open.
The first reason wins and remains plaintext on sealed tasks.

Save the `{ messageId }` from `TaskHandle.steer` or the envelope id from
`ByokCloud.steerTask`; enqueueing is not a delivery receipt. Read refusals with:

| Surface | Single read | Page read |
| --- | --- | --- |
| Embedded | `tasks.readSteerRefusal(taskId, messageId)` | `tasks.listSteerRefusals(taskId, { afterRevision, limit })` |
| Cloud | `ByokCloud.readSteerRefusal(tenant, taskId, steerMessageId)` | `ByokCloud.listSteerRefusals(tenant, { taskId, afterRevision, limit })` |

These reads include refusals after the terminal, when the task event feed has
ended. Before terminal, add `{ kind: 'steer_refused', messageId, reason, at }`
to exhaustive `ServerTaskEvent` switches. Cloud accepts a refusal in any task
state only for a steer it sent that device/task, without changing task state.
Refusal rows carry no content and survive archive, redaction, retention and
device retirement; tenant erasure removes them.

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
Source: [#2293].

#### Steer text bound

Plaintext `task.steer` is limited to 65,536 UTF-8 bytes
(`TASK_STEER_TEXT_MAX_BYTES`). Cloud `steerTask` and embedded
`TaskHandle.steer` reject longer text with `ByokCloudError`
`coordination_input_invalid` before enqueueing. Sealed steer text is not
checked on the device. `conn.hello` carries at most 64 capability flags.

#### Cloud (`@byok-sdk/cloud`)

- **Claim and terminal executor.** `TaskAttempt.claimedExecutor` records the
  winning claim. Replays and later terminals must echo it. The offer target
  allows any executor under `auto`, otherwise only the named runtime/harness.
  Before claim, cancel carries none and `task.complete` is rejected. Unclaimed
  `daemon_interrupted` recovery may name an admitted executor allowed by the
  target, without recording a claim. `TerminalResult.executor` and
  `projectTerminalResult`'s third argument reflect the claim and are absent
  for unclaimed tasks.
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
- **Reports before a claim** (#2289). Only `task.claim`, `task.decline`,
  `task.cancelled` and `task.fail` with `recovery` are accepted from the
  offered device before claim. All other reports return `task_not_claimed`
  (wire `not_permitted`) without state changes. Other devices still get
  `task_not_found_for_device`.
- **Renamed fields.** `SteerRejectedError.executor` replaces `.runtime`, and
  `TerminalResult.executor` replaces `.harnessId`.
- For steer receipts and input limits, see [refusal reads](#tasksteer_refused)
  and [text bounds](#steer-text-bound).
- **`POST /byok/messages`** answers an entry of another wire major with
  `rejected` and `protocol_version_unsupported`, and an unknown type with
  `rejected` and `type_unsupported`, each with HTTP 200. The handshake answer
  carries `ingress` and no `capabilities`.

#### Cloud data plane (`@byok-sdk/cloud-dataplane`)

- Prepare the [new database](#new-store) before starting cloud.
- **Startup check.** `createPostgresCloudStores` rejects a database whose
  epoch is not 7, or that has none, with `PostgresStoreEpochUnsupportedError`
  (`code: 'POSTGRES_STORE_EPOCH_UNSUPPORTED'`, `requiredEpoch`, `foundEpoch`
  when present) and changes nothing. It replaces the pending-mailbox check:
  `PostgresMailboxProtocolUnsupportedError` and
  `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` are removed. Match the new code
  where you matched the old one.
- `PostgresTaskSteerRefusalStore` supplies `steerRefusals` (table
  `task_steer_refusal`); `createPostgresCloudStores` includes it. Its lifecycle
  follows [steer refusal retention](#tasksteer_refused); tenant erasure includes
  it in `TENANT_ERASURE_TABLES`.
- A claimed task stores exactly one executor in `claimed_runtime` or
  `claimed_harness_id`, enforced by CHECK.
- Per-task locks use new keys for steer refusals and approval timelines.
  Follow the [cutover order](#during-the-upgrade).

#### Embedded server (`@byok-sdk/server`)

- Prepare the [new SQLite file](#new-store) before starting the server.
- **Dispatch.** `DispatchInput` takes one required `target` in place of
  `runtime`, `harnessId` and `dispatchSelection`. Pass `{ lane: 'auto' }` to
  keep the device's own runtime choice. An execution-core intent names a
  concrete target; `auto` is refused there.
- **Claimed executor.** `TaskSnapshot.claimedExecutor` and the `task.state`
  server event's `claimedExecutor` replace `claimedRuntime` and
  `claimedHarnessId`; `SteerRejectedError.executor` replaces `runtime`.
- Apply the shared [steer refusal](#tasksteer_refused) and
  [text bound](#steer-text-bound) changes.
- **Event cursors.** `tasks.events` cursors start with `te2.`; a `te1.`
  cursor is refused with `cursor_unknown`. Start a new read.

#### Start the runtime after an accepted claim (#2294)

Sources: [#2305] for [#2294], [#2303]. Entries `claim-accepted-before-runtime-start`,
`wire-v7-client-execution-target`.

The daemon starts the runtime and sends `task.started` only after an
`accepted` or replayed `duplicate` claim, costing one round trip. A refusal
produces one non-retryable `task.decline`, reason
`claim refused: <refusal reason>`, without `code`. An unsettled claim reaches
`runtime startup deadline exceeded` (retryable) at the existing startup
deadline (default 30 seconds), which also bounds reconnects. Cancel and shutdown
use the claimed-before-start terminal path. Wait for `task.started` before
steering a running task. The client permanently settles `type_unsupported`
and advances its cursor.

#### Custom stores for steer refusals

Sources: [#2277], [#2285]. Entries `wire-v7-steer-refused`,
`wire-v7-cloud-steer-refusal-reads`.

Implement `TaskSteerRefusalStore` and
`MailboxStore.readMessage(tenant, { deviceId, messageId })`: an exact
retained-row lookup without ack.

#### Cancel runs ahead of a hung steer (#2304)

Source: [#2311] for [#2304]. No dedicated entry; refusal surfaces are
`wire-v7-steer-refused` and `wire-v7-server-steer-refused`.

Send cancel without waiting for `steer()`. It runs immediately; later controls
wait for cancel. Teardown rejection of the pending steer reports
`task_not_active`; a steer resolving after cancel sends no refusal. Neither
sends another terminal. Use [refusal reads](#tasksteer_refused) after the feed ends.

### Pairing registration fence (#2045)

**With the wire v7 merge.**

Sources: [#2282], [#2287]. Manifest entries: `wire-v7-pair-fencing`, `wire-v7-pair-field-bounds`, `wire-v7-tenant-id-text`, `wire-v7-pairing-enrollment-port`, `wire-v7-pairing-product-id-bound`, `wire-v7-pairing-product-id-refused`, `wire-v7-client-pairing-errors`, `wire-v7-device-credential-attempt`, `wire-v7-auth-manager-pair`, `wire-v7-pair-gate-split`, `wire-v7-pair-new-code-fresh-key`, `wire-v7-v6-enrollment-entry-deleted`, `wire-v7-auth-errors-without-server-text`, `wire-v7-access-token-in-memory`.

`POST /byok/pair` fences machine supersession with a compare-and-set on the
machine's current device.

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
  attempt always names its store. Remove that handling.
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
- **Wire bounds.** `PairRequest.deviceName` and `PairResponse.deviceId` allow
  1 to 64 UTF-16 code units; tenant ids allow 1 to 200. All require well-formed
  text without control characters. An astral character counts as two units.
  `isPairingText(value, maxUnits)` enforces this alongside
  `PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH` / `PAIR_RESPONSE_DEVICE_ID_MAX_LENGTH`.
  `tenantId` / `isTenantId` now reject all controls and unpaired surrogates.
  Fix invalid tenant ids and set `deviceName` when a hostname exceeds the bound;
  config check and pairing reject it (`PairingInputInvalidError`, field
  `deviceName`). A `machineId` resolver must return lowercase hex SHA-256 or
  raises the same error with field `machineId`. An invalid response device id
  raises `AuthResponseInvalidError` without writes. Pairing validates all
  writes before `device.json`, including the encoded OS entry's 2,400-byte fit.
- **Access tokens stay in memory.** Remove `accessToken` and `expiresAt` from
  injected `DeviceCredentialBackend` read/replace records (`DeviceRecord`).
  `replace` always discards a staged attempt. First request after start and
  after `401` exchanges a token through `/byok/challenge` and `/byok/token`;
  renewal writes nothing. For v6 entries, see [credential handling](#credentials-and-provider-keys).

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

Grok tasks set `GROK_DISABLE_AUTOUPDATER=1` regardless of task environment and
no longer write the updater's `agent` link. Arrange Grok updates outside tasks.

### Pi tasks and extension runs (#2299)

Sources: [#2301], [#2307], [#2313]. Manifest entries: `pi-turn-own-run`.

The first prompt's `streamingBehavior: 'followUp'` joins an active extension
run; its remaining output belongs to the task. Unrelated runs no longer settle
the turn or contribute progress, usage or tool frames. Extension errors remain
visible; a prompt handled without a run ends immediately.

For output free of user extension runs, use `agentUserContext: 'excluded'`
and Host-owned `agentExtensionPaths`. Extension settlement/compaction hooks
can still drop the first prompt, so wire startup deadlines to cancellation.
Startup waits now stop on abort, including durable startup (#2307, #2313;
no separate manifest entries).

### Runtime adapter changes (#2235, #2296)

#### Unconfirmed models fail non-retryable (Codex, agy)

Sources: [#2242], [#2298]. Manifest entries: `model-confirmation-non-retryable`.

A requested model that the runtime does not confirm now fails start with
`ModelConfirmationError`: `task.fail.retryable: false`, `failure.class: 'unknown'`.
A direct adapter throws a start `RuntimeExecutionFailure` with non-retryable retry.
Change the requested model or its access before sending a new task. Do not
retry the same mismatch as transient. dsh, Grok, and OpenCode are unchanged.

#### agy model mismatches wait up to the request deadline

Sources: [#2242], [#2298]. Manifest entries: `agy-model-confirmation-deadline`.

Allow agy's 30-second request deadline in Host startup timeouts. A conflicting
model notification may be superseded by a valid confirmation; only a mismatch
persisting to the deadline fails.

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

Revoke and machine supersession now clear presence, challenge nonces and
inbound dedup state in all SDK compositions. Previously in-memory and SQLite
state could survive until expiry or restart. Custom directories must follow
the ports below, while keeping [assertion replay entries](#device-retirement-keeps-assertion-replay-entries-2264).

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

The removal order is stop/unregister while `current` exists, remove
`current`, remove unit/launcher, then payloads, snapshots and receipt.
A failed/refused/timed-out stop removes nothing. A later unit-removal failure
leaves no `current`, so no payload starts. Retry `uninstall()` after fixing
the cause; Windows user-scope retry skips a missing stop program when no
launcher runs. Failed first-install cleanup uses the same order.

### Runtime status carries every observation field inline

Sources: [#2288]. Manifest entries: `runtime-status-inline`, `runtime-status-side-arrays-refused`.

Read `versionVerdict`, `versionChange`, `executablePath` and
`executableSource` inside `runtimes[]` in control `status` and `doctor`,
as in `Daemon.status()`. Remove reads of `runtimeVersionVerdicts`,
`runtimeVersionChanges` and `runtimeExecutables`. Older daemons sending
these arrays cause `ControlStatusShapeUnsupportedError`: status is unavailable
and doctor probes runtimes locally. Run both commands from the daemon's release.
Audit/support bundles still omit verdicts, restart comparisons and paths.

### Version verdict is the one runtime version warning

Sources: [#2288]. Manifest entries: `runtime-version-verdict-only`.

Remove `RuntimeDetectResult.advisory` and `RuntimeDetectionAdvisory`.
Custom `detect()` results carrying `advisory` are refused by
`validateRuntimeDetectResult()`; return `versionVerdict` or
`runtimeVersionDetectionFields()`. For unqualified versions, the sole warning is
`versionVerdict: { state: 'warn', qualifiedVersion }`;
`RuntimeObservation.qualifiedVersion` projects it. Replace
`availability.advisory.qualifiedVersion` with
`availability.versionVerdict?.state === 'warn' ? availability.versionVerdict.qualifiedVersion : undefined`.

### Agent memory outbox version 2 is refused

Sources: [#2288]. Manifest entries: `agent-memory-outbox-version-error`, `agent-memory-outbox-v2-rejected`.

Before deployment, archive or remove any Agent home's
`.byok/agent-memory-redacted-outbox-v2.json` holding version 2 state. Its pending
mutations will not publish. Otherwise projection fails with
`AgentMemoryOutboxVersionUnsupportedError` (`stateVersion: 2`), without
further reading, rewriting or deleting the file; a higher writer epoch cannot
replace it.

### Todo extension reads one config location

Sources: [#2288]. Manifest entries: `todo-config-legacy-location-refused`.

Move existing todo settings to `$XDG_CONFIG_HOME/rpiv-todo/config.json` before
deployment (`~/.config/rpiv-todo/config.json` only when `XDG_CONFIG_HOME` is
unset). If XDG points elsewhere and only the old file exists, loading the
bundled Pi extension throws `TodoConfigLegacyLocationError` naming both paths.
It checks existence without reading the old content.

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

## During the upgrade

1. Keep old writers stopped. Initialize the [wire v7 stores](#new-store)
   and the [K4/K8 and hosted stores](#host-ledgers-record-their-format-2286)
   prepared before deployment. Sources: [#2283], [#2291], [#2309].
2. Deploy cloud first, then daemons and CLI from the **same candidate release**.
   Plan downtime: v6 and v7 peers cannot communicate, and their cloud processes
   must never share a database. Sources: [#2277], [#2291], [#2303]; entries
   `wire-v7`, `wire-v7-dataplane-store-epoch`, `wire-v7-client-negotiation-halt`.
3. Re-pair every device and configure providers following
   [credentials and provider keys](#credentials-and-provider-keys).
   Sources: [#2290], [#2287]; entries `retire-compatibility-apis`,
   `wire-v7-v6-enrollment-entry-deleted`.

## After the upgrade

Before restoring traffic, verify these paths with the candidate release:

- Run config check, `status` and `doctor` from the daemon's release. Check
  pairing, provider access and the [inline runtime status](#runtime-status-carries-every-observation-field-inline).
  Sources: [#2288], [#2287], [#2290].
- Confirm a task reaches `task.started` only after its claim is accepted,
  then reaches a terminal. Exercise steer/cancel and the
  [refusal reads](#tasksteer_refused). Sources: [#2305], [#2311], [#2285].
- Confirm the Host opens the new ledger and cloud stores, and an older store
  produces its [typed format error](#sqlite-stores-decide-their-format-before-any-write-2286).
  Check preserved artifacts against the [WAL exception](#wal-only-format-metadata).
  Sources: [#2295], [#2309], [#2283], [#2291].
- Exercise revoke and machine supersession: [device state](#device-retirement-clears-device-scoped-state-2237)
  and [E2EE member packages](#e2ee-member-state-on-retirement-2267) disappear,
  while unexpired assertion replay entries remain. Sources: [#2266], [#2268], [#2278].
- Exercise [service uninstall/reinstall](#service-uninstall-stops-before-it-removes-current-2274)
  on supported platforms, including retry after a failed stop. Sources: [#2275], [#2280].

## Known residuals

### WAL-only format metadata

Sources: [#2295], [#2309], [#2283]. Manifest entries: `sqlite-stores-refuse-before-write`, `client-journal-exact-format`, `host-ledger-format-table`, `keys-store-refuse-before-write`, `wire-v7-server-sqlite-store`.

An older store that crashed before its first checkpoint can hold its schema
only in WAL. Its format is then decided on a writable connection; closing after
refusal checkpoints WAL into the main file and removes `-wal` and `-shm`.
Logical content remains, but bytes change. This applies to the SQLite stores
above, including Host ledgers, keys and the v7 server. New stores checkpoint
immediately after schema creation to shorten this window.

Preserve the main file **and sidecars together** before trying the candidate
if an untouched artifact is required.

### Grok login preserved during excluded tasks

If Grok replaces its auth link with a login file, the SDK leaves that file in
execution scratch, reports a cleanup `RuntimeDisposalFailure`, skips retention
for that execution, and blocks later Grok starts. The user moves the file back
to their Grok home or deletes it and logs in again. The SDK never restores or
deletes it. Source: [#2258]; entry `grok-agent-user-context`.

### Integration and adoption evidence

Verify the candidate's store refusals, pairing and v6 handshake halts against
its manifest before release. This guide is not evidence that those checks
passed. Sources: [#2295], [#2309], [#2287], [#2303].

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
