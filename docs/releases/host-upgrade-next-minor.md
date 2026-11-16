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
was left, so a repeated revoke clears rows a racing write recreated. Its E2EE
member state is still deleted only with a row the call removed (#2267). No
schema change.

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
  (`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`). The hosted data plane's store
  check: phase 1.

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

### Phase 1 and 2 items

- Host APIs for steer refusals and their cursors (te2): phase 1.
- Upgrade-manifest entries for the cloud, server, client and store changes, and their API surface: phase 1 and 2. Phase 0 lists the protocol and port entries.
