# Host upgrade to the next MINOR

Draft checklist for changes after 0.43.0. Earlier Hosts must first apply the [0.43.0 Host upgrade checklist](host-upgrade-0.43.0.md) and preceding checklists.

Add future Host-visible changes here; do not amend the 0.43.0 cut's upgrade-manifest entries. The 0.43.0 release record archived that manifest unchanged and established the 0.43.0 release snapshot as the next baseline.

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

## OAR 0.109.0 (#2235)

The vendored OAR moves from 0.105.0 to 0.109.0 (`packages/client/vendor/oar/4eb5919/`, fork branch `byok/0.109.0`). No public type, export or configuration field changes. The upgrade manifest declares the three behavior-only breaking changes below as `model-confirmation-non-retryable`, `agy-model-confirmation-deadline` and `claude-queued-write-failure`.

### Unconfirmed models fail non-retryable (Codex, agy)

When a Codex or agy start ends with the runtime keeping a model other than the requested one, OAR now throws `ModelConfirmationError` and the start fails non-retryable. The `task.fail` for that start carries `retryable: false` and `failure.class: 'unknown'`; earlier releases sent `retryable: true`, with `failure.class` `unknown`, or `runtime_exited` when the runtime process had exited on its own. The `reason` text is unchanged: `codex <method> kept model <reported> although <requested> was requested` for Codex, `ACP config_option_update left model at <reported> although <requested> was requested` for agy. A Host that embeds an adapter directly sees the same values on the `RuntimeExecutionFailure` that `start` rejects with (`phase: 'start'`, `retry: 'non-retryable'`).

Do not retry these starts as transient: the same request asks for the same model and gets the same answer. Change the requested model or update the runtime's model access, then send a new task. dsh already failed this case non-retryable (`UnsupportedOptionError`) and is unchanged. Grok and OpenCode do not confirm the applied model through OAR this way, and OpenCode's own readback check was already non-retryable; both are unchanged.

### agy model mismatches wait up to the request deadline

agy confirms a model switch from its `config_option_update` notifications. 0.43.0 failed the start on the first notification that reported another model (`packages/client/vendor/oar/2f81b34/shared/acp/config-updates.ts:32-35`). Now a conflicting notification is only an observation: a notification with the requested model still confirms the switch immediately, and the start fails only when the request's deadline runs out with agy still reporting another model (`packages/client/vendor/oar/4eb5919/shared/acp/config-updates.ts:50-57`). That deadline is agy's request timeout, 30 s (`packages/client/vendor/oar/4eb5919/runtimes/antigravity/session.ts:42`). The Host sees two differences:

- A conflicting notification followed by the requested model now starts the task; 0.43.0 sent `task.fail`.
- A real mismatch reaches the Host as `task.fail` about 30 s after the switch instead of immediately.

A Host that bounds agy starts with its own timeout shorter than 30 s now hits that timeout first and never receives the `ModelConfirmationError` failure; allow at least the 30 s deadline before giving up on an agy start that requested a model. Do not treat a start that succeeds after an earlier conflicting update as suspect: the model agy finally reported is the requested one.

### agy runs with `--gemini-dir`

agy's ACP command now carries `--gemini-dir <owned home>/.gemini`, the directory the adapter already sets through `GEMINI_HOME`. The argument is passed only to the agy process; no event, error or record changes. The device's agy must accept `--gemini-dir` under `agy acp` (1.5.2 lists it; the qualified 1.5.1 has fixture evidence only). If an allowlist or wrapper validates agy's argv, add the flag.

### Claude queued follow-up write failures

`ClaudeAdapter` session `followUp()` sends a busy-refused instruction through OAR's queue. OAR now always holds a queued input (record `queued: "adapter"`) and writes it to Claude as a separate `toRuntime` prompt request when Claude's own turn ends. Host events for a queued follow-up are unchanged; the held record and the prompt request are internal records and are not projected to events.

One failure path changes. If Claude's own turn ends between the busy refusal and the queue, 0.43.0 wrote the input inside `queue()` (`packages/client/vendor/oar/2f81b34/shared/stream-json/session.ts:247-259`), and a failed stdin write rejected `followUp()` with retryable `RuntimeExecutionFailure` `claude follow-up instruction transport failed` (`packages/client/src/adapters/claude/claude-adapter.ts:772-775`). The write now happens after the queue request is answered (`packages/client/vendor/oar/4eb5919/shared/stream-json/session.ts:253-263`), outside the writes `followUp()` awaits, so `followUp()` resolves. The write failure fails the Claude process (`packages/client/src/adapters/claude/stream-session.ts:94-99`), and the session's `events` iteration then throws the retryable run failure for the ended process: `claude runtime event transport failed` or `claude runtime process ended before a terminal result frame` (`packages/client/src/adapters/claude/claude-adapter.ts:671-684`).

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

