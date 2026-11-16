# Host upgrade to the next MINOR

Draft checklist for changes after 0.43.0. Earlier Hosts must first apply the [0.43.0 Host upgrade checklist](host-upgrade-0.43.0.md) and preceding checklists.

Add future Host-visible changes here; do not amend the 0.43.0 cut's upgrade-manifest entries. The 0.43.0 release record archived that manifest unchanged and established the 0.43.0 release snapshot as the next baseline.

## Retired compatibility paths

Remove `migrateProviderProfileStore` from AiphaBee's `user-installer.ts` and
`byok-host` coordinator. Remove `migrateWouldDo` and `WouldDoMigration` from
`toolset-migration.ts` and the `byok-host` bot-collaboration re-exports.
Provider profile stores with an earlier provider-kind schema are refused with
`PROVIDER_STORE_SCHEMA_STALE`; would-do ledger rows without `turnId` are refused
with `would_do_unsupported_old`. Keep the old files intact and explicitly
configure a separate current store. Hosted stores also reject would-do rows
held in an old frame or lacking `turnId` without converting or archiving them.
Hosted stores with an old `entity_kind_check` are refused with
`hosted_schema_unsupported_old` before any DDL. The server ledger opening
boundary is handled separately by #2286.

`scopeSecretStore`, `listPiCatalogModels`, `sealedRoutineInstruction`, the
TruthStore provider profile adapter, and the local Host switch importer and its
commit/discard APIs are removed. Use `SecretStore.scope(secretScopeId(scope))`,
read model choices from `modelRouteView`, and construct the instruction at the
member endpoint. Hosts using the TruthStore adapter must configure a supported
profile store. Local Host switch export remains available and is to be evaluated
separately; there is no local import path for its peer's exported document.

## SQLite stores decide their format before any write (#2286)

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
refused; recreate it with this version or move its rows yourself.

Not handled: the format is read from the main file. A store created by an older
version that crashed before its first checkpoint holds its schema only in its
WAL; its format is decided on a writable connection, and when that connection
closes after the refusal SQLite checkpoints the WAL into the main file and
removes the `-wal` and `-shm` files. The refused store keeps its logical content,
but its file bytes change. This applies to every store above, the Host ledger and
the keys store below. Such a store holds almost no data. New stores checkpoint
right after creating their schema, which keeps that window short.

## Host ledgers record their format (#2286)

`@byok-sdk/server/execution-core` `HostLedger` records the ledger's format in a
`host_store_format(owner, version)` table, one row per layer: `k4` for the ledger
itself and `k8` for a Bot collaboration ledger. It is the only format authority;
the ledger body and the Bot collaboration state no longer carry a `version`. An
existing ledger is decided on its unchanged main file, before the writable
open, pragmas or DDL, and is refused with `HostStoreFormatError` (code
`host_store_format_unsupported`) when a row's version differs, an expected layer
is missing, an unknown layer is present, or it has tables but no
`host_store_format`. A refused file is not migrated, repaired or deleted.

Every ledger written by 0.43.0 or earlier has no `host_store_format` and is
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
- `LedgerState.version` and `CollaborationState.version` are removed.
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

## Bot collaboration inbound conversation identity (#2250)

`@byok-sdk/bot-collaboration` `inboundKey(message)` now hashes channel,
conversation kind, conversation id and platform message id. Direct and group
conversations with the same id no longer share inbound or receive command
identities. Existing team configurations remain valid, including a room id
that equals a Bot id.

Every inbound key changes. An event already in flight across the upgrade can
be admitted again once because its previous deduplication identity no longer
matches. Drain inbound delivery before upgrading, or account for that one-time
redelivery. Hosts that persist or compare inbound keys must use the new keys;
there is no compatibility lookup of the old key.

## Bot collaboration round inbound disposition (#2255)

`@byok-sdk/bot-collaboration` `inboundDispositions()` and its `inbound:`
projections now describe whether a room input got an answer. An existing root
Turn remains authoritative, including explicit root cancellation. Without a
root Turn, a succeeded or delivered seat wins over any failed or cancelled
seat, so cancelling a sibling after an answer no longer changes `answered`
to `cancelled`. If no seat succeeded, a failed or cancelled seat means
`failed`; otherwise the input remains `coalesced`. Even cancelling all seats
does not cancel the round root.

Hosts that render or consume these dispositions must treat `cancelled` as
root or batch cancellation and accept `failed` for seat-only cancellation.
Re-reading existing ledger rows uses this precedence too. No store migration
is needed.

## Device retirement keeps assertion replay entries (#2264)

On the Postgres data plane (`@byok-sdk/cloud-dataplane`
`createPostgresCloudStores()`), `devices.revoke()` and machine supersession
through `devices.register()` or `pairing.redeemAndRegister()` no longer delete
the retired device's `device_assertion_replay` rows. Each row stays until its
assertion expires (at most 5 minutes after issue) and `collectExpired` removes
it. Before, re-registering the same `deviceId` with the same public key let a
device or task assertion spent before the retirement authenticate once more.

The in-memory and SQLite compositions never deleted these entries and are
unchanged. A Host that implements its own `@byok-sdk/cloud` `DeviceDirectory`
must not delete replay entries on revoke or supersession either. No schema
change or migration is needed; replay retention stays bounded by the assertion
TTL.

Expired replay rows are not removed on their own. Pass the replay authority as
`createByokCloud({ deviceAssertionReplay })` and run `runMaintenance()` on a
schedule; without the authority the `deviceAssertionReplay` step reports
`not-configured` and expired rows accumulate.

## Grok tasks no longer run the Grok updater (#2269)

`GrokAdapter` (`DaemonConfig.runtimes.grok`) now starts every Grok agent
process with `GROK_DISABLE_AUTOUPDATER=1`, Grok's documented process switch
for its updater. The SDK sets it last, so a `GROK_DISABLE_AUTOUPDATER` in the
task environment, including `0` or an empty value, no longer reaches Grok.

Under `agentUserContext: 'inherit'`, a task started from a managed Grok install
with `GROK_HOME` at that install used to run Grok's updater module, which wrote
an `agent` link into the install's `bin/`. SDK tasks no longer change the
user's Grok install and no longer check for Grok updates. Grok the user runs
still updates itself. Under `agentUserContext: 'excluded'`, Grok already
skipped its updater, because the SDK-owned `GROK_HOME` is not a managed
install.

Host action: if your product relied on Grok tasks to keep the user's Grok
current, update Grok outside SDK tasks, for example by having the user run
Grok or its installer.

## Pi tasks and extension runs (#2299)

A Pi extension can start a run of its own: from `session_start`, a timer, or
one of its hooks. Pi RPC events name no run, so before this change a pi-rpc
task could lose its start or its turn to such a run.

- A task that starts while an extension run is active used to fail as
  non-retryable `RuntimeExecutionFailure` `Agent is already processing`. Its
  first prompt now carries `streamingBehavior: 'followUp'`, so the input joins
  that run. The turn ends when that run settles, and its events include the
  rest of that run's output.
- An extension run that settles before the task's prompt is accepted, or that
  runs between turns, no longer ends the task's turn early. Frames written
  outside the task's turn, such as that run's progress, usage and tool
  events, are no longer reported as the task's events. When the task's input
  joins a run in the middle of a tool call, that call's result is not reported
  either. Every `extension_error` is still reported, because Pi does not say
  which prompt or run it belongs to.
- A first prompt that Pi handles without a run, such as an extension command,
  now ends the turn at once instead of waiting for the next settlement.

The turn boundary relies on Pi 1.5.2's implementation order (runs never
overlap; a started prompt is answered before its run begins), which a test
pins against the installed Pi.

One case is not covered. When an extension run is still in its `agent_settled`
hook and that hook starts compaction, Pi defers the task's first prompt and
then drops it without any response. The start stays pending until the Host's
own start deadline; #2300 bounds it inside the SDK.

Host action: none. Extensions reach a pi-rpc task under the default
`agentUserContext: 'inherit'` (the user's Pi agent directory and settings
packages, and `.pi/extensions` in the task workspace) and through
`agentExtensionPaths` in either mode. A Host that needs task output free of
extension runs uses `agentUserContext: 'excluded'` and lists only Host-owned
`agentExtensionPaths`.

## OAR 0.110.0 (#2235, #2296)

The vendored OAR moves from 0.105.0 to 0.110.0 (`packages/client/vendor/oar/552a4f9/`, fork branch `byok/0.110.0`). No public type, export or configuration field changes. The upgrade manifest declares the three behavior-only breaking changes below as `model-confirmation-non-retryable`, `agy-model-confirmation-deadline` and `claude-queued-write-failure`.

### Unconfirmed models fail non-retryable (Codex, agy)

When a Codex or agy start ends with the runtime keeping a model other than the requested one, OAR now throws `ModelConfirmationError` and the start fails non-retryable. The `task.fail` for that start carries `retryable: false` and `failure.class: 'unknown'`; earlier releases sent `retryable: true`, with `failure.class` `unknown`, or `runtime_exited` when the runtime process had exited on its own. The `reason` text is unchanged: `codex <method> kept model <reported> although <requested> was requested` for Codex, `ACP config_option_update left model at <reported> although <requested> was requested` for agy. A Host that embeds an adapter directly sees the same values on the `RuntimeExecutionFailure` that `start` rejects with (`phase: 'start'`, `retry: 'non-retryable'`).

Do not retry these starts as transient: the same request asks for the same model and gets the same answer. Change the requested model or update the runtime's model access, then send a new task. dsh already failed this case non-retryable (`UnsupportedOptionError`) and is unchanged. Grok and OpenCode do not confirm the applied model through OAR this way, and OpenCode's own readback check was already non-retryable; both are unchanged.

### agy model mismatches wait up to the request deadline

agy confirms a model switch from its `config_option_update` notifications. 0.43.0 failed the start on the first notification that reported another model (`packages/client/vendor/oar/2f81b34/shared/acp/config-updates.ts:32-35`). Now a conflicting notification is only an observation: a notification with the requested model still confirms the switch immediately, and the start fails only when the request's deadline runs out with agy still reporting another model (`packages/client/vendor/oar/552a4f9/shared/acp/config-updates.ts:50-57`). That deadline is agy's request timeout, 30 s (`packages/client/vendor/oar/552a4f9/runtimes/antigravity/session.ts:42`). The Host sees two differences:

- A conflicting notification followed by the requested model now starts the task; 0.43.0 sent `task.fail`.
- A real mismatch reaches the Host as `task.fail` about 30 s after the switch instead of immediately.

A Host that bounds agy starts with its own timeout shorter than 30 s now hits that timeout first and never receives the `ModelConfirmationError` failure; allow at least the 30 s deadline before giving up on an agy start that requested a model. Do not treat a start that succeeds after an earlier conflicting update as suspect: the model agy finally reported is the requested one.

### agy runs with `--gemini-dir`

agy's ACP command now carries `--gemini-dir <owned home>/.gemini`, the directory the adapter already sets through `GEMINI_HOME`. The argument is passed only to the agy process; no event, error or record changes. The device's agy must accept `--gemini-dir` under `agy acp` (1.5.2 lists it; the qualified 1.5.1 has fixture evidence only). If an allowlist or wrapper validates agy's argv, add the flag.

### Claude queued follow-up write failures

`ClaudeAdapter` session `followUp()` sends a busy-refused instruction through OAR's queue. OAR now always holds a queued input (record `queued: "adapter"`) and writes it to Claude as a separate `toRuntime` prompt request when Claude's own turn ends. Host events for a queued follow-up are unchanged; the held record and the prompt request are internal records and are not projected to events.

One failure path changes. If Claude's own turn ends between the busy refusal and the queue, 0.43.0 wrote the input inside `queue()` (`packages/client/vendor/oar/2f81b34/shared/stream-json/session.ts:247-259`), and a failed stdin write rejected `followUp()` with retryable `RuntimeExecutionFailure` `claude follow-up instruction transport failed` (`packages/client/src/adapters/claude/claude-adapter.ts:772-775`). The write now happens after the queue request is answered (`packages/client/vendor/oar/552a4f9/shared/stream-json/session.ts:253-263`), outside the writes `followUp()` awaits, so `followUp()` resolves. The write failure fails the Claude process (`packages/client/src/adapters/claude/stream-session.ts:94-99`), and the session's `events` iteration then throws the retryable run failure for the ended process: `claude runtime event transport failed` or `claude runtime process ended before a terminal result frame` (`packages/client/src/adapters/claude/claude-adapter.ts:671-684`).

This affects only a Host that embeds `ClaudeAdapter` directly; the daemon does not call `followUp()`, so daemon Hosts need no change. An embedding Host must treat a resolved `followUp()` as accepted for delivery, not as written, and handle the failure from `events` as it handles any mid-turn process failure: the follow-up was not delivered, so resend it on a new session.

## Removed unused client APIs

### Task terminal evidence

`AgentSessionHandoffStore.getTaskTerminal()` is removed. Stop calling the unused
read API. Production failure handling still awaits `recordTaskTerminal()` to
persist evidence before sending `task.fail`; use that write receipt when recording
a failure. There is no public terminal-evidence read replacement.

### Team workspaces

`LocalTeamWorkspace.getWorkspace()`, `updateWorkspace()` and
`validateMemberLease()` (also exposed by `LocalTeamWorkspaceService`) are removed,
along with the unused
`UpdateTeamWorkspaceInput` declaration. Use `listWorkspaces()` to inspect workspace
definitions. Validate a member lease by performing the intended `postMessage()`,
`readMessages()` or `ackMessages()` operation; each resolves the lease itself.
There is no public in-place membership/limit update API. Create a separately named
workspace with the desired definition and issue its member leases instead.

### Egress drop receipts

`AgentEgressController.dropReceipts()` and `AgentEgressDropReceipt` are removed,
including the unused in-memory receipt buffer. `noteTransportDrop(reason)` no
longer accepts an optional `AgentRef`; pass only the drop reason. Use `status()` for each lane's
`dropped`, `replaced` and `lastDropReason`. Per-drop history is no longer retained;
Hosts needing an audit history must collect it at their own transport boundary.

### Standalone daemon log writer

`openDaemonLog()` and `DaemonLog` are removed. An embedding Host that writes its
own individual log lines must own its log sink, append complete lines and apply
its own retention/rotation policy. `DaemonLogOptions` remains because the daemon's
internal process-output router still uses it. That router captures all stdout
and stderr for the daemon process; it is not a same-semantics replacement for a
Host's standalone line writer and is not exported from the package entrypoint.

### Service exit disposition

`serviceExitDisposition()` and `ServiceExitDisposition` are removed.
`EXIT_CODE_CONTRACT` and `ExitCode` remain for documented exit statuses. Hosts
with their own service supervision must configure stop on exit 0 and restart on
failure in that supervisor. The SDK-generated launchd, systemd and WinSW units
already enforce that policy; `daemonExitCode()` remains unchanged.

### Pi RPC close wait

`PiRpcClient.waitClosed()` is removed from the published declaration closure.
Hosts that inject a `spawnFn` and need to observe child transport closure must
subscribe to their owned child's `close` event. Consumers can drain `events` and
inspect `terminalError` / `processExited` for RPC termination. `dispose()` remains
the explicit process-tree cleanup receipt; calling it initiates termination and
is not a passive close wait. Internal process-tree cleanup still waits for the
client's private close promise.

### Aliases and convenience factories

`AGENT_CONTENT_READ_CAPABILITY_WORKSPACE`, `AGENT_CONTENT_READ_CAPABILITY_TRANSCRIPT`
and `AGENT_CONTENT_READ_CAPABILITY_ARTIFACT` are removed; read the same names from
`AGENT_CONTENT_READ_CAPABILITIES.workspace`, `.transcript` and `.artifact`.
`TOOL_AUTHORIZATION_MODES` and `TOOL_FILE_ACCESS` are removed; the
`ToolAuthorizationMode` and `ToolFileAccess` types remain. `DaemonEventKind` is
removed; use `DaemonEvent['kind']`.

`createAgentHomeProjection()` and `AgentHomeProjectionFunction` are removed. Pass
the projection object itself: `agentHome.projection: { prepare: async ({ agentRef, cwd }) => { ... } }`.

### Installed skill-pack listing

`listInstalledSkillPacks()` is removed. `installSkillPacks()` returns what it
installed and kept, and `projectSkillPack()` copies one installed pack by name;
a Host that needs an inventory keeps the names it installed.

### Truth memory client

`TruthMemoryClient`, `TruthMemoryClientError` and their option, input and result
types (`LocalMemoryFilter`, `MemorySelector`, `TruthManifestQueryInput`,
`TruthManifestRecord`, `TruthMemoryClientErrorCode`, `TruthMemoryClientOptions`,
`TruthMemoryMetric`, `TruthSnapshotCandidateInput`, `TruthSnapshotWriteInput`,
`TruthTerminalWriteInput`, `TruthWriteBody`, `TruthWriteResult`,
`VerifiedTruthRecord`) are removed. No Host used them. The cloud truth routes and
`createStoredDeviceProofSigner()` are unchanged; a Host that writes truth records
calls those routes with a device proof from that signer.

## Blocked Turn projection ids (#2245)

`@byok-sdk/bot-collaboration` publishes a Turn that cannot freeze as `blocked:<turnId>:<code>:<fingerprint>` with `{ owner, turnId, code, reason }`. 0.43.0 published `blocked:<turnId>` with `{ owner, turnId, reason }` each time the reason changed, so a reason that carries a model name or a byte count gave one id two values and K4 `project` threw `Projection identity conflict`. The upgrade manifest declares this as `bot-blocked-projection-id`.

- `code` is `unavailable_model`, `schema_over_budget` or `current_request_too_large`. `reason` keeps the full details, such as the model name or byte counts.
- The fingerprint is the first 12 hex digits of the SHA-256 of the canonical JSON of `{ code, reason }`. Each id has one value.
- A Turn whose reason changes while it stays blocked gets one more `blocked:` id per reason. The byte count of `schema_over_budget` follows the team, so each team change can add one row while the Turn stays blocked. A reason that comes back republishes the same id and value; deduplicate by id.

A Host that routes projections by the `blocked:` prefix needs no change. A Host that builds `blocked:<turnId>` or reads the turn id from the projection id must match the `blocked:` prefix and read `turnId` and `code` from the value.

## Pi Agent skills from DaemonConfig (#2169)

`DaemonConfig.runtimes.pi.agentSkillPaths` (also `PiRuntimeConfig` for
`createRuntimeAdapters`) takes the absolute skill files or directories a Host
authorizes for Pi Agent tasks. It projects to
`PiAdapterOptions.agentSkillPaths`, so a Host no longer has to build its own
`PiAdapter` and call `createDaemonWithAdapters` to hand Pi its skills. Unset
keeps the default `[]`; no Host action is required.

- Config check refuses a relative, duplicated or NUL-carrying path, and a
  non-empty list together with `runtimes.pi.durableLane`, as
  `DaemonConfigInvalidError` at `runtimes.pi.agentSkillPaths`.
- The prepared lane still refuses Agent resources before spawning.
- A skill path that is missing or unreadable when an Agent task starts now
  fails that start before Pi spawns, as a non-retryable `RuntimeExecutionFailure`.
  It used to surface as a retryable `runtime_exited` start failure, so the
  task was retried against the same missing file. This applies to an embedded
  `PiAdapter` too.
- Under a file-scoped offer the SDK's scoped `read` refuses a skill outside the
  granted roots (`outside_scope`), so the model cannot load it on its own;
  `/skill:<name>` still expands it. Symlinks are followed and the owner is not
  checked. See [Host-provided skills](../adapter-capabilities.md#host-provided-skills-by-runtime-1846).

## In-memory blob factory

`@byok-sdk/cloud` removes `createInMemoryBlobs(objects, bytes)`. It only
returned `bytes.bind(objects)`. Call `bind(objects)` on the `InMemoryBlobBytes`
from `createInMemoryBlobBytes()` instead; it returns the same `InMemoryBlobs`.

## Device retirement clears device-scoped state (#2237)

`DeviceDirectory.revoke()` and machine supersession in `register()` (also
reached through `pairing.redeemAndRegister()`) now delete the retired device's
presence hint, challenge nonces and inbound dedup ledgers in every SDK
composition: in-memory, the embedded SQLite server and Postgres. Before, only
Postgres deleted them; in memory and on SQLite a revoked device's presence hint
stayed until its TTL, and its nonces and dedup ledgers stayed until expiry or
restart. Device-assertion replay entries are still kept until they expire
(#2264).

### Store ports gain deleteDevice

`@byok-sdk/core` `PresenceStore` and `@byok-sdk/cloud` `NonceStore` and
`InboundDedupStore` each gain a required
`deleteDevice(tenant, deviceId): Promise<void>`. It deletes every hint, nonce
or dedup entry of that `(tenant, deviceId)`; for dedup that is the
device-physical ledger and every Agent-bound ledger. A deleted record reads as
one never written. Hosts with their own implementation of any of these ports
add the method. `InMemoryPresenceStore`, `InMemoryNonceStore` and
`InMemoryInboundDedupStore` implement it.

### In-memory composition wiring

`createInMemoryCloudStores()` takes a required `presence: PresenceStore` after
`mailbox`; pass the core stores' `presence`:

```ts
createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox, core.presence, objectBytes);
```

`new InMemoryDeviceDirectory(tasks, mailbox, state)` takes a required third
argument of the new type `DeviceScopedStores`
(`{ presence, nonces, dedup }`, each needing only `deleteDevice`). Pass the
stores the rest of the composition reads.

### Retirement contract for a custom DeviceDirectory

A Host with its own `DeviceDirectory` calls `deleteDevice` on its presence,
nonce and dedup stores on both retirement paths:

- Only once the registration change is durable: inside the same transaction
  when the stores share its storage, otherwise after commit and before the next
  registration change starts. A retirement that fails or rolls back deletes
  nothing.
- `revoke(tenant, deviceId)` deletes that state even when no row was removed,
  so calling `revoke` again recovers a cleanup that failed, and also clears
  state a write racing the first revoke recreated.
- Never delete device-assertion replay entries.

`ByokCloud.listPresence()` on the in-memory composition no longer shows a
retired device until its TTL.

Deleting the dedup ledger has one cost. If the **same** `deviceId` is
registered again after a revoke or supersession and resends an envelope the
cloud processed before the retirement, that envelope is processed a second
time. Task-bound envelopes for the retired device's attempts are still refused,
because retirement cancelled those attempts; what can run twice is
`conn.hello` and Agent facts with no task. The shipped `POST /byok/pair` route
never reuses an id: it mints a new `deviceId` for every pairing. Only Host code
that calls `DeviceDirectory.register()` or `pairing.redeemAndRegister()` with a
`deviceId` it chose can reach this. Such a Host keeps its own envelope-level
idempotency across re-registration if it needs it.

### Postgres stores

`@byok-sdk/cloud-dataplane` `PostgresPresenceStore`, `PostgresNonceStore` and
`PostgresInboundDedupStore` implement `deleteDevice`. Postgres `revoke()` now
deletes the presence, nonce and dedup rows of the id even when no device row
was left, so a repeated revoke clears rows a racing write recreated. The same
now holds for its E2EE member state (see below). No schema change.

## E2EE member state on retirement (#2267)

Revoke and machine supersession now delete the retired device's E2EE member
state in every composition that has an E2EE member store: its member key
registration, both pairing MACs, and the scope key packages addressed to its
member. Before, only Postgres deleted it; the in-memory store kept it, so
`ByokCloud.readScopeKeyPackages()` still returned the retired member's
packages. The member chain, scope epochs and their `keyId`s, shred records,
the member's KEM floor and recorded proof requests stay.

The store is now one field of the composition, `CloudStores.e2eeMember`, so
the routes and the device directory that retires it always use the same one.

### E2EE member store moves into CloudStores

`ByokCloudOptions.e2eeMemberStore` is removed. Get the store from the
composition factory's opt-in and pass the stores as `cloud`:

```ts
// Postgres
const stores = await createPostgresCloudStores({ pool, clock, crypto, objectStorage, rateLimit, e2eeMember: true });
const cloud = createByokCloud({
  cloud: stores, // stores.e2eeMember is a PostgresE2eeMemberStore
  capabilities: fullCapabilityDeclaration(1, { includeE2eeMember: true }),
  // ...the rest of the options, without e2eeMemberStore
});

// In memory
const composition = createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox, core.presence, objectBytes, undefined, { e2eeMember: true });
// or: createInMemoryByokCloud({ e2eeMember: true }), which also declares e2ee.member
```

A Host that builds `CloudStores` and its directory itself, without a standard
factory's opt-in, must give the same instance to `CloudStores.e2eeMember` and
to its device directory (see the retirement contract below). Nothing checks
this at run time: a second instance would serve the routes while retirement
cleans the other one.

### Capability ports read cloud.e2eeMember

`e2ee.member` is still bound both ways: declaring it without
`cloud.e2eeMember`, or passing `cloud.e2eeMember` without declaring it, is
refused at construction (`capability_over_declared`,
`capability_port_undeclared`), and the error names the port
`cloud.e2eeMember`. `CapabilityPorts` loses `e2eeMemberStore` and gains
`cloud?: Pick<CloudStores, 'e2eeMember'>`. A caller of
`capabilityDeclarationForPorts()` passes `cloud: stores` instead of
`e2eeMemberStore`.

### InMemoryE2eeMemberStore is no longer exported

Use the in-memory composition's opt-in (`stores.e2eeMember` above). A
standalone instance would not be retired with the directory's devices.

### E2eeMemberStore gains deleteDevice

`E2eeMemberStore` gains a required `deleteDevice(tenant, deviceId): Promise<void>`.
It deletes the scope key packages addressed to the member the device
registered, then that registration with its device pairing MAC, then the
client pairing MAC. It keeps the chain, epochs, `keyId`s, shred records, the
member's KEM floor and recorded proof requests; a device with no state is a
no-op. A Host with its own store implements it.

### Retirement deletes E2EE member state

A Host with its own `DeviceDirectory` and an E2EE member store deletes the
member state on both retirement paths, under the same rules as presence,
nonces and dedup: only once the registration change is durable (or in the
same transaction when the store shares its database), and on every `revoke`,
whether or not a row was removed. `DeviceScopedStores` takes it as optional
`e2eeMember`.

What a Host sees:

- After a revoke or supersession, `readScopeKeyPackages()` omits the retired
  member's packages in every composition.
- The retired member id can be registered by another device. In memory this
  used to fail with `e2ee_member_key_conflict`. The id keeps its KEM floor.
- Postgres `revoke()` now deletes E2EE member rows of the id even when no
  device row was left.
- A package put to the retired member id after the retirement is not removed:
  cleanup finds packages through the device's registration, which is gone.

### E2EE composition opt-ins

Additive: `CloudStores.e2eeMember`, `DeviceScopedStores.e2eeMember`, the
`{ e2eeMember: true }` options of `createInMemoryCloudStores()`,
`createInMemoryByokCloud()` and `createPostgresCloudStores()`, and
`PostgresE2eeMemberStore.deleteDevice()`.

## Service uninstall stops before it removes `current` (#2274)

This corrects a 0.43.0 regression. `@byok-sdk/client`
`ServiceInstallation.uninstall()` now stops and unregisters the service while
`current` still points at the installed payload, then removes `current`, then
the unit and launcher, then `previous`, `versions/`, `snapshots/` and the
receipt. 0.43.0 removed `current` before the stop (#2011), so a Windows stop
program under `current` was gone when the stop ran, and every uninstall failed
with `service_stop_failed`.

- A stop that fails, times out or is refused (a stop program that exits
  non-zero, a refused or timed-out `launchctl bootout`) throws as is, without
  a retry, and removes nothing: the unit and `current` both stay, so the
  service can start again, for example at the next login, until `uninstall()`
  is retried.
- A unit whose removal fails after the stop stays without `current`, so a
  boot or login starts no payload, as in 0.43.0 (#2011, #2279). A timed-out
  `daemon-reload` after the unit files are removed is thrown the same way.
- A Windows `user` scope lifecycle's `stop()`, and the stop inside
  `uninstall()`, now run the Host's `stop` program only while a launcher
  runs. With none running they write the stop marker and return. A retried
  `uninstall()` therefore finishes after `current` is gone, instead of
  failing with `service_stop_failed` because a stop program under `current`
  no longer exists (#2279).
- A first install that fails to activate, start or pass its health check
  cleans up in the same order: stop and unregister, remove `current`, then
  the unit and launcher. A leftover unit can no longer start the payload that
  failed its health check. When the unit cannot be removed, the
  `install_health_check_failed` message lists `service unit and launcher`
  first among the remaining artifacts; when the stop fails, it lists
  `service registration, current pointer` before it.

Retry `uninstall()` after any failure; a retry finishes once the cause is
fixed. No Host change is needed for a stop program that runs from under
`current`.

## Wire v7

Draft. Phase 0 landed the protocol contract; phase 1 (cloud, server, client)
and phase 2 (integration) complete this section. Items marked "phase 1" are
not in the SDK yet. The wire facts are in
[the protocol](../protocol.md).

`PROTOCOL_VERSION` is 7. There is no v6 reader: a v6 peer and a v7 peer
cannot talk to each other.

### Operator order

1. Export the Host history you need from the v6 store.
2. Upgrade the cloud (embedded server, `@byok-sdk/cloud`,
   `@byok-sdk/cloud-dataplane`) onto a new store.
3. Pair every device again into the new store.
4. Upgrade the daemons.

Between the cloud upgrade and a daemon's upgrade, that v6 daemon halts. Plan
the window. AiphaBee's Local Agent and byok-host upgrade in the same release.

### New store

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

### What a v6 daemon sees

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

### Offer `target` and claim `executor`

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
  `claimedHarnessId`. Host offer and task APIs that took `runtime`,
  `harnessId` or `dispatchSelection`: phase 1.

### `task.steer_refused`

A device reports a steer it received and did not deliver with
`task.steer_refused { steerMessageId, reason }`. Reasons: `input_too_large`,
`steer_unsupported`, `task_not_active`; the list is open. The first reason
wins. The report is plaintext on sealed tasks too.

The Host feed of a task's refusals ends at the task's terminal. A refusal the
cloud commits after the terminal is read by steer id only. Host APIs
(`readSteerRefusal`, the refusal list and its cursor, the steer message id
returned by `TaskHandle.steer`): phase 1.

### Removed fields and flags

- `capabilities` on the `GET /byok/events` and `POST /byok/messages`
  responses: the server advertises nothing.
- `limits.maxTokens` on `task.offer`.
- The offer selection rules `runtime_selection_mismatch` and
  `harness_selection_conflict`.
- The device flags `steer` and `provider-profile-binding`.
- `WireAddition.kind`, `.rule` and `.advertisedBy`.

### Decline codes

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
See [Decline codes](../protocol.md#decline-codes).

### Steer text bound

A plaintext `task.steer` text is at most 65,536 UTF-8 bytes
(`TASK_STEER_TEXT_MAX_BYTES`); the sender refuses a longer one before it
enqueues. A sealed steer is not checked on the device. `conn.hello` carries
at most 64 capability flags.

### Cloud (`@byok-sdk/cloud`)

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

### Cloud data plane (`@byok-sdk/cloud-dataplane`)

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

### Embedded server (`@byok-sdk/server`)

- **SQLite store.** The schema is version 10 and no older file is upgraded in
  place. Opening a file from a v6 build (schema 6 to 9) fails with
  `SqliteSchemaError` `SQLITE_SCHEMA_UNSUPPORTED`, and `inspectSqliteStore`
  reports `new-path-repair`. Point `storage.path` at a new file, keep the old
  one for the history export, and pair the devices again.
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

### Daemon (`@byok-sdk/client`)

- **Start after an accepted claim** (#2294). The daemon starts the runtime and
  sends `task.started` only after the cloud accepts its `task.claim`. A refused
  claim ends the attempt with one non-retryable `task.decline` whose `reason`
  is `claim refused: <refusal reason>`, with no `code`. A claim still unsettled
  at the offer's startup deadline fails with `runtime startup deadline exceeded`
  (retryable). A Host that saw `task.started` refused after a lost claim now
  sees that decline instead.

### Phase 1 and 2 items

- Host APIs for steer refusals and their cursors (te2): phase 1.
- Upgrade-manifest entries for the cloud, server, client and store changes, and their API surface: phase 1 and 2. Phase 0 lists the protocol and port entries.

## Removed cloud and data-plane APIs

These names had no caller in the SDK or its known Hosts. Remove the import and
use the replacement named here.

### `@byok-sdk/cloud`

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

### `@byok-sdk/cloud-dataplane`

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

## Runtime status carries every observation field inline

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

## Version verdict is the one runtime version warning

`RuntimeDetectResult.advisory` and the `RuntimeDetectionAdvisory` type are
removed. An unqualified runtime version is reported only as
`versionVerdict: { state: 'warn', qualifiedVersion }`, and
`RuntimeObservation.qualifiedVersion` is that warning's projection. A custom
runtime adapter whose `detect()` still returns `advisory` is refused by
`validateRuntimeDetectResult()`; return `versionVerdict` instead (or
`runtimeVersionDetectionFields()` output). A Host that read
`availability.advisory.qualifiedVersion` reads
`availability.versionVerdict?.state === 'warn' ? availability.versionVerdict.qualifiedVersion : undefined`.

## Agent memory outbox version 2 is refused

An Agent home whose `.byok/agent-memory-redacted-outbox-v2.json` still holds the
0.32.0 version 2 state is no longer upgraded in memory. Memory projection for
that home fails with `AgentMemoryOutboxVersionUnsupportedError`
(`stateVersion: 2`); the file is neither read further, rewritten nor deleted, and
a higher writer epoch does not replace it. Remove or archive the file to resume
projection. Its pending memory mutations, if any, are not published.

## Todo extension reads one config location

The bundled Pi todo extension reads its settings only from
`$XDG_CONFIG_HOME/rpiv-todo/config.json` (`~/.config/rpiv-todo/config.json`
when `XDG_CONFIG_HOME` is unset). It no longer falls back to
`~/.config/rpiv-todo/config.json` when `XDG_CONFIG_HOME` points elsewhere:
if the `XDG_CONFIG_HOME` file is absent and the old one exists, loading the
extension's config throws `TodoConfigLegacyLocationError` naming both paths.
Only the old file's existence is checked; its content is never read. With a
todo config at the old location, Pi reports this error when it loads the todo
extension; moving the file fixes it.

## DaemonConfig rejects unknown fields

`@byok-sdk/client` `validateDaemonConfig()`, `checkDaemonConfig()`,
`createDaemon()` / `createDaemonWithAdapters()` and the `byok-agent` config
loader now refuse every unknown `DaemonConfig` field as an `unknown_field`
error, with a "did you mean" hint when one is close. Before, an unknown field was
a warning and the daemon started (Q4'), and a field removed in an earlier
release (`permissionDefaults`, `agentEgress.sanitizer`, `mcpLaunchCwd`,
`toolImplementationAuthority`, `hostedJournal`, `strictAgentOnly`,
`gitWorkspace`, `workspaceRoot`, `resultDocument`,
`maxConcurrentMutableSessionsPerAgentHome`, `durablePi`,
`agentMemoryFilesystem`) threw `DaemonConfigFieldRemovedError`. Those fields
are now unknown fields too: an embedded Host gets `DaemonConfigInvalidError`,
and the CLI exits with the config error. `overrides.hostedJournal` and
`overrides.gitWorkspace` throw a `TypeError`.

Removed with it: `DaemonConfigFieldRemovedError` (and its setup-catalog code
`daemon_config_field_removed`), the `removed_field` issue code,
`DaemonConfigIssue.severity` and `.migration` (every issue is an error),
`DaemonEffectiveConfig.warnings` (also gone from `Daemon.status().config`) and
`byok-agent config check --strict`, which now prints usage. A config that
rolls back to an older daemon no longer starts with fields that release does
not know; remove them first. Run `byok-agent config check` against each config
file before upgrading and delete every field it reports. The published
`daemon-config.schema.json` now closes every object (`additionalProperties:
false`) and declares the root `$schema`, so an editor that applies it flags
the same unknown fields.

## MCP frame ceiling has one authority

`@byok-sdk/client/mcp-server` `MCP_SERVER_MAX_FRAME_BYTES` is unchanged at
1 MiB. It is now a re-export of the same constant the SDK MCP client's read
buffer and the HTTP server's `maxOutboundFrameBytes` default use, so the three
can no longer drift apart. No Host change.

