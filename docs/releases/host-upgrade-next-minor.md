# Host upgrade to the next MINOR

Draft checklist for a Host moving from the current release to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Service install requires a healthy start

`ServiceInstallation.install()` now runs the same health check as `upgrade()`
after installing and starting the service (#1966). A Host that relied on
`install()` succeeding without a healthy start must now handle
`ServiceInstallationError` code `install_health_check_failed` and allow for
`healthTimeoutMs` (default 60000 ms). The error carries the start or health
check failure as `cause`; `upgrade()` keeps its existing error behavior.
Add the new code to exhaustive matches over `ServiceInstallationErrorCode`.

For CLI installs before pairing, enable `serviceEnrollment: { enabled: true }`
in the config; otherwise pair first. An embedded Host can instead pass its
own `healthCheck`. An unpaired daemon without service enrollment halts on start,
so the default check fails. With service enrollment, `awaiting-enrollment`
is healthy even before pairing.

If the service fails to install, activate, start or pass its health check,
install removes the unit, launcher, `current`, installation record and the
staged version directory, including on a same-id
reinstall. No service remains after successful cleanup. Host stores, daemon
stores and OS credentials are preserved. If removal fails, the error carries
an `AggregateError` with both the original and removal failures as `cause`
and names the remaining artifacts in its message. Install enforces the
health-check deadline even if a custom check ignores abort or succeeds late.
For install, the clock starts after start returns; unit writes, activation,
start and cleanup stop are outside it. Platform commands have no time bound
today; [#1971](https://github.com/Ancienttwo/byok-sdk/issues/1971) tracks that
separate lifecycle change. Cleanup waits for an in-flight platform command
to settle first. The CLI error
includes the cause message and the before-pairing requirement.

After an upgrade, a failed same-id reinstall leaves `previous`,
`versions/<previous-id>`, `snapshots/` and `upgrade-receipt.json` intact,
since they belong to other versions. With the installation record removed,
CLI uninstall cannot discover the root. Construct the installation with the
explicit `installRoot` and call `uninstall()`, or reinstall into the same
root before using CLI uninstall.
See [Versioned installs](../device-setup.md#versioned-installs).

## Clearing a device enrollment without a daemon

An uninstaller that built a daemon per store only to call `daemon.unpair()` can call `clearDeviceEnrollment({ productId, storeDir, nativeAssetRoot })` instead (#1841); it needs no `productName`, `serverUrl` or `localAgentRelease`. It refuses with `DeviceEnrollmentClearError` `store_owned` while a daemon, doctor or installer holds the store, so call it after the service has stopped, and before deleting the store directory. It clears only the SDK device enrollment of the account it runs as, never Host secrets, and leaves the delivery cursor file. A Host that matched the text of `unpair()`'s credential-deletion error reads `DeviceEnrollmentClearError.code === 'clear_failed'` instead. See [Clearing an enrollment without running the daemon](../device-setup.md#clearing-an-enrollment-without-running-the-daemon).

## Loopback listener close waits for handlers

`LoopbackListener.close()` now resolves only after every dispatched handler has settled; before, it destroyed connections and resolved while a handler could still run. Requests not yet dispatched get 503. There is no timeout. Shut down in the order `daemon.stop()`, `listener.close()`, `server.close()`, and do not make a request-scoped hook wait on anything the Host releases after `listener.close()`, or `close()` never resolves. See [Embedded path](../device-setup.md#embedded-path).

## Per-task settlement awaitable

A Host that decides a task is over by combining `completed`, `failed`, `cancelled`, a terminal `outbound-rejected` and `execution-record` with its own wrapper around each adapter's `session.close()` can replace both with `await daemon.whenTaskSettled(taskId, { signal })` (#1838). It resolves once the terminal's first settlement was published locally and the runtime's first disposal outcome is known: `disposal: 'failed'` matches a `runtime-disposal-failed` event for the task's runtime (not a failed release of an offer-owned scratch, `runtimeId: 'scratch'`), and `disposal: 'none'` means this daemon held no runtime for the task, including every task that settled before a restart. Call it after the task's `offered` event or later; an id the daemon never saw offered and has no journal row for rejects with `DaemonTaskUnknownError`. After a restart the result reflects the journal's current truth, so a refused terminal that was replaced reads as its replacement, never the reverse. `stop()` rejects no pending wait: pass a signal if a wait can span `stop()`. `Daemon` gains the member, so a test double typed as `Daemon` adds `whenTaskSettled`.

A wait on a task whose offer the journal refused now rejects with the append's error, `LocalStorageEmergencyError` under local-storage emergency (#1901); retry the wait after the offer is redelivered. An aborted wait keeps nothing on the daemon.

## Packaged Hosts resolve SDK hosting from the asset root

A single-file Host that ships `copySdkPackagingAssets` output can replace its hand-built `sdkHelperHost`, `runtimes.pi.packageDir`, `nativeAssetRoot` and `agentMemoryHelperAssetRoot` with one `resolveSdkHosting({ assetRoot, helperHost })` call at startup (#1839). Spread `hosting.daemon` into `DaemonConfig` and `hosting.adapters` into `RuntimeAdaptersConfig`, merging `hosting.adapters.runtimes.pi` into the Host's own `runtimes`; pass `hosting.daemon.nativeAssetRoot` to `readDeviceEnrollmentStatus` and to `loadSdkKoffiAsset` in a provider launcher. A missing required asset now throws `SdkHostingAssetsMissingError` at that call instead of failing at the first Windows credential, Job Object or memory helper use. Hosts that keep setting the four fields directly need no change.
## Service payload manifest meta and Host verification

No action is required (#1842). `byok-payload.json` keeps `version: 1` and gains an optional `meta` object for Host data, which the SDK copies verbatim and does not interpret. A Host can write the manifest at build time with `writeServicePayloadManifest(dir, { id, meta })` from `@byok-sdk/client/packaging`, and move its own payload checks (Node floor, file-size ceilings, file modes) into `ServiceInstallationOptions.verifyPayload`, which runs on the staged copy that will run; a throw there is `payload_invalid`. An updater still on the previous SDK stages a new payload with `meta` unchanged but never runs `verifyPayload`. Staging the same `id` again with different manifest bytes, `meta` included, is now `version_conflict` instead of keeping the old copy silently, and a file the manifest lists but the payload lacks is `payload_invalid` from `stage` and from `readPayloadManifest`, which accepted it before, instead of a raw `ENOENT` at copy time. See [Versioned installs](../device-setup.md#versioned-installs).
## Agent memory start refusal classes

A task that an Agent home's memory refuses before its runtime starts now carries a typed `task.fail.failure.class` (#1843): `agent_memory_resident_over_limit`, `agent_memory_resident_multiple_links`, `agent_memory_resident_not_regular_file`, `agent_memory_resident_not_utf8`, `agent_memory_snapshot_over_file_limit`, `agent_memory_snapshot_over_byte_limit` or `agent_memory_snapshot_refused`. The list is `AGENT_MEMORY_START_REFUSALS` from `@byok-sdk/protocol/constants`. The reason text is unchanged, so a Host that parses the reason prefix keeps working, but it should branch on `readTaskFailure(failure).class` instead.

A Host on 0.41.0 reads these as `unknown` with `reportedClass` until it upgrades. A missing file, a changed home identity and an I/O failure stay `unknown`. A task that seals its output sends `unknown` for every refusal, so a Host that seals output takes the verdict before dispatch from `checkAgentMemoryHome` (see [Agent memory home check](#agent-memory-home-check)). `TaskFailureReading` gains a member: an exhaustive `switch` over `readTaskFailure(failure).class` stops compiling until it handles the new classes. `agent_memory_resident_not_regular_file` cannot be repaired by a write task: the file has to be replaced outside a task. A `MEMORY.md` that is already not a regular file when the offer arrives is declined before claim with reason text and no class. Code that constructs `AgentMemorySnapshotLimitError` must pass the bound it hit as the new first argument.
## Agent memory home check

`checkAgentMemoryHome(home, { commit?: { filesystem? } })` in `@byok-sdk/client/agent-memory` is additive: nothing existing changes. It returns `{ ok: true }` or `{ ok: false, code, reason }` with the class and reason the device would send for the same home. It throws when it cannot decide (missing `MEMORY.md`, a changed home identity, an I/O error, no secure memory filesystem; on macOS and Windows pass the helper's filesystem as `commit.filesystem` and close it yourself), and it is advisory because it holds no lease and has no task id. Its verdict is about the home: the device applies the resident refusals only to a task that carries `MEMORY.md` into its prompt and the snapshot refusals only to a task with `agentMemoryCommit`; the repair task (`agentMemory:"none"`, no commit) is never refused, so do not gate it on the verdict. Unlike the failure class, the check is not hidden on a task that seals its output. A Host that copied the device's limits (AiphaBee's `residentMemoryBreach` and `memoryBreach`) can replace that copy with this call.

## OAR 0.99.0 driver base (#1863)

A Grok follow-up sent while Grok runs a turn of its own is held until that turn closes; budget the task deadline for that wait. Grok 429s that name a spending limit now fail as `quota` or `billing` (non-retryable) instead of retryable `rate_limited`. A Codex older than OAR needs, or with an unreadable `config.toml`, fails the start as non-retryable `invalid_request`. Confirm that the Host does not retry those classes as transient.

## Grok qualified version 1.0.77

The Grok adapter qualifies Grok 1.0.77 (#1884). A device on another version, 1.0.52 included, now reports `runtime_version_unqualified` with `qualifiedVersion: '1.0.77'`; the default policy stays `warn`, so tasks still run. A Host that pins its own Grok `versionPolicy` is unchanged. Grok's own turns, and the follow-up hold they cause, need 1.0.70 or later.

## Claude on the OAR stream-json session (#1853)

No Host action. The Claude adapter's events, capabilities, launch arguments and failure classes are unchanged. Two failure texts change: a Claude process that exits after the first instruction but before `system/init` fails the start with `claude exited before yielding an authoritative session id: …` (was `claude initial instruction transport failed`), and the exit diagnostic reads `claude exited (code=N); stderr: …`. A Host that matches those texts should branch on `failure.class`, which is unchanged. A follow-up sent while Claude runs a turn of its own (a background task wake) is held and sent when that turn ends; budget the task deadline for that wait.

## OpenCode start failures

OpenCode now reports unclassified start failures as retryable infrastructure failures. A native process that exits on its own reports `runtime_exited` during start or a turn; an archived resume target is non-retryable, while a target in use is retryable. Session limits accept fractional interrupt milliseconds and report invalid limits as `invalid opencode interrupt timeout` or `invalid opencode retention budget` (#1681).

Hosts already read `task.fail.retryable` and need no code change. Confirm that the Host does not cache OpenCode start failures as permanent failures.

## Codex session retention

Codex Agent tasks with `agentUserContext: 'excluded'` keep rollouts under `<Agent home>/.byok/codex/`. The exempt `agent-runtime-sessions` class is removed from `PROTECTED_CLASS_IDS`, `ProtectedClassId` and `PROTECTED_CLASS_BOUNDS`. The new `codex-session-store` class is in `EXPIRING_CLASS_IDS` and `ExpiringClassId`. Replace the old literal wherever the Host reads retention classes and treat the new class as expiring (#1608).

A rollout expires when its last write is older than `storage.retention.ttlMs['codex-session-store']`. The default is 31 days, or the `session-ledger` TTL plus one day if that is longer. An explicit value must be at least the ledger TTL plus one day, or configuration fails with `LocalStorageConfigError`. A live session ledger keeps its thread's rollout, and a home running or resuming a task is skipped. Resuming a pruned thread fails with the existing non-retryable missing-thread failure.

Rollouts previously remained until the Host removed the Agent home. Set a higher TTL before upgrading if users need idle threads to remain resumable longer. See [retention bounds](../host-local-storage-layout.md#retention-bounds) for the sweep and storage details.

## Pi subagents in packaged products

Bun-compiled products can run background Pi subagents and workflows when they ship `pi-subagents/` and `pi-subagent-extensions/` beside the real executable. Rebuild the Pi assets with `copyPiRuntimeAssets` and ship those directories in the install root (#1631). The install root has the binary's filesystem trust; the checks reject symlinks and detect swaps within each process, but do not authenticate the runner against the host or detect replacement before process startup.

When those directories are absent, Bun products retain foreground non-workflow subagents using configured Pi assets. Explicit async and all workflows are refused. A default-async call can return a receipt before its background job fails with the missing-assets reason. Present invalid assets are fatal. Node SEA and interpreter bundles retain foreground non-workflow subagents and refuse background runs and all workflows, including `async: false`.

Bun workflows retain upstream VM restrictions without Node's permission layer. G1 and child approval govern tool events, not arbitrary JavaScript after a VM escape. See [Pi background subagents](../adapter-capabilities.md#pi-background-subagents-in-packaged-products-1589) and the [Pi subagents specification](../spec.md#pi-subagents).

## Agent memory helper protocol 4

Direct callers of `openAgentMemoryFilesystemHelper` must add the required `ancestorRoot` argument. Pass the canonical `binding.resolution.hostStorageRoot` from the Agent-home binding that owns `canonicalHome`; do not substitute the home or `agentsRoot`. The daemon carries this existing authority automatically, so its Agent-home configuration is unchanged (#605).

Upgrade the daemon and its SDK helper assets together. The private `open` request now requires `ancestorRoot` and protocol 4, and open reports helper version `"4"`. Every other request/response protocol or helper version is rejected. There is no protocol-3 reader, omitted-root default or fallback. Source integrations using `helperAgentMemoryIntentBackend` must pass `ancestorRoot` as the second argument and move optional `assetRoot` to third.

The selected `hostStorageRoot` must already exist durably before the first helper open. Unix keeps its existing same-volume traversal, but refuses open with `ancestor_volume_mismatch` if a volume boundary prevents reaching the selected ancestor. Put the agents directory on the same volume as `hostStorageRoot` before retrying. This cross-volume refusal was approved by the owner on 2026-11-10 in the t4 question dialog. The Windows barrier flushes the selected root through home and initializes real `.byok` and `notes` directories; it does not prove creation of the root itself. Root initialization: [#1652](https://github.com/Ancienttwo/byok-sdk/issues/1652). Windows `strictLedgerBarrier` remains false and intent remains unadvertised pending A7 recovery evidence.

On macOS, every same-volume ancestor of `hostStorageRoot` must be readable; a traverse-only ancestor (for example mode `0711`) makes the root barrier fail closed.

## Host-leading Pi child commands

Hosts that send a task instruction beginning with a pi-subagents child-starting command must change those instructions before upgrading (#1642). The ordinary Pi RPC host now returns `pi_host_command_denied` for `/run` (including `--bg` and `--fork`), `/prompt-workflow`, `/subagents-refine`, `/subagents-check-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles` and `/subagents-watchdog` (including `on` and `session on`). Enabling watchdog can start a workspace language server and a model reviewer whose tools bypass session approval. The refusal applies to initial prompts, steering, follow-ups and queued input, including command aliases, and returns a failed RPC response even while a settlement handler is running.

Request the child or review through the model's `subagent` tool instead. Under `auto`, the task's normal tool authorization applies, and each workflow child must pass the nested `subagent_launch` admission. Treat a refused command as a failed task instruction and update its source; retrying the same leading command will fail again. Host text is never rewritten by the SDK.

No Host action is required if task instructions do not invoke those leading commands. `/skill:` commands, file prompt templates and other extension commands keep their behavior. A slash command appearing mid-text, in model output or in a tool result stays content. Verify a supported `subagent` tool request and a refused leading `/run` request in each Host product before rollout. See the [Pi subagents specification](../spec.md#pi-subagents) and [runtime evidence](../researches/2026-11-10-pi-host-command-gate.md).

## Pi OpenCode Go profiles

Hosts that do not use OpenCode Go need no configuration change. For a model
served by OpenCode Go, including through a local gateway, set the new optional
`pi_model.providerId: 'opencode-go'` and explicitly set
`pi_model.api: 'openai-completions'`. This lets Pi replay prior thinking as
`reasoning_content` and send OpenCode session headers. Models not served by
OpenCode Go must not set the field. Profiles that omit it retain
`byok-sdk-<profile_ref>`. The prepared lane refuses it (#1586).

Saving the optional field changes the exact profile hash, so refresh any
pinned binding after saving it. RPC launches
now refuse model-runtime configuration/composition errors before selecting a
model or creating a session; repair the declared settings if admission fails
with `keys_profile_model_composition_failed`.

## OpenCode Go key checks and profile stores

Choose `provider_kind: 'opencode-go'` explicitly for direct OpenCode Go
profiles. `checkProviderKey` then sends a fresh `x-opencode-session` per check
and identifies the keys package/version in its User-Agent. Pi conversations
also need the explicit Pi declaration described above; provider kind never
selects Pi's provider id (#1547, #1551).

The new kind widens the SQLite `provider_kind` CHECK set. A store from 0.41.0
or earlier reports `migration-required` in the precheck. Stop all store users,
take a backup, and call the candidate's `migrateProviderProfileStore(path)`
before opening it. A Host using `createServiceInstallation` supplies that
call in its `migrate` program; without one, upgrade stops with
`store_migration_required`. Profiles and their credential-store key references
are preserved; users do not re-enter keys. Opening never migrates a store.
Rollback restores the pre-migration store snapshot before running the older
SDK. See the [store migration sequence](host-upgrade-0.41.0.md#stores).

## Embedded server offer admission

**Breaking (server; #1672).** Embedded `dispatch` and `executions.submit` now use the same offer admission as the direct cloud kernel lanes. Hosts that catch input errors must use the kernel's error class and code or schema path:

| Refusal | Error class | Code or schema path |
| --- | --- | --- |
| Device lacks `dispatch-selection` or `toolset-selection` | `ByokCloudError` | `agent_capability_missing` |
| Resume dispatch has no exact `sessionRef` | `ByokCloudError` | `coordination_input_invalid` |
| Invalid façade input, including an empty task/device id, an in-flight task id, or message context without message egress | `ByokCloudError` | `coordination_input_invalid` |
| A memory-reader selects a writing memory mode | `ZodError` | `['agentMemory']` on dispatch; `['payload', 'agentMemory']` on submission |
| `runtime` differs from `dispatchSelection.runtimeId` | `ZodError` | `['runtime']` on dispatch; `['payload', 'runtime']` on submission |

Submission passes invalid input to the kernel, including null and undefined from JavaScript callers. Sealed fields on plaintext submission remain refused with `ByokCloudError` / `coordination_input_invalid`. Retrying an offer recorded before a mailbox append failure uses the recorded admission without rechecking the device's capabilities.

Dispatch no longer fills in `runtime` from `dispatchSelection.runtimeId`. If the Host omits `runtime`, it stays absent in the recorded offer and mailbox payload; the daemon selects the adapter from `runtimeId`. A Host that also supplies `runtime` must make it equal to that selection. See the [protocol's dispatch selection contract](../protocol.md).

### Operator step for embedded SQLite Hosts

Before upgrading, inspect each embedded Host store using `sqlite3 -readonly <store>` and run Q1 below. An AiphaBee local-agent research Host keeps this store at `<research host root>/server.sqlite`; other embedded Host stores contain both `request_receipt` and `task_attempt` tables. Q1 finds recorded, undelivered resume offers whose bytes contain both `dispatchSelection` and the old derived `runtime`:

```sql
-- Q1
WITH o AS (
  SELECT tenant_id, key, recorded_at,
         CASE WHEN json_valid(body) THEN body END AS j
  FROM request_receipt
  WHERE key LIKE 'task-offer:%'
)
SELECT o.tenant_id, o.key AS receipt_key, o.recorded_at,
       json_extract(j, '$.deviceId') AS device_id,
       json_extract(j, '$.payload.agentRef.agentId') AS agent_id,
       json_extract(j, '$.payload.agentRef') AS agent_ref_json
FROM o
WHERE json_extract(j, '$.payload.session.mode') = 'resume'
  AND json_extract(j, '$.payload.dispatchSelection') IS NOT NULL
  AND json_extract(j, '$.payload.runtime') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM request_receipt d
    WHERE d.tenant_id = o.tenant_id
      AND d.key = 'task-offer-delivered:' || substr(o.key, 12)
  );
```

If Q1 is empty, no offer cleanup is required. Otherwise run Q2 to find offered attempts with no mailbox row:

```sql
-- Q2
SELECT a.tenant_id, a.task_id, a.device_id, a.agent_ref_json, a.offered_at
FROM task_attempt a
WHERE a.status = 'offered'
  AND NOT EXISTS (
    SELECT 1 FROM mailbox_message m
    WHERE m.tenant_id = a.tenant_id
      AND m.device_id = a.device_id
      AND CASE WHEN json_valid(m.body)
               THEN json_extract(m.body, '$.task_id') END = a.task_id
  );
```

### Prove each receipt-to-task mapping before abandoning

Q2 supplies candidates, not proof of receipt ownership. Keep Q1's `(tenant_id, receipt_key)` and full `agent_ref_json` with the inventory. Do not choose a task merely because it is the only Q2 row for a device and Agent.

The key is `task-offer:<messageId>`; its suffix is a hash-derived UUID, not an encoded task id. The kernel computes `messageId` from the UTF-8 bytes of `JSON.stringify({ domain: 'byok:task-offer', tenant, taskId, deviceId, agentRef })`, in that property order, using the complete attempt `agentRef` (including `profileRevision`). It takes the first 16 bytes of SHA-256, sets the UUID version nibble to `8` and the variant bits to binary `10`, and formats the result as a lowercase UUID. See [offer identity](../../packages/cloud/src/offer-identity.ts). There is no inverse key-to-task decoder: prove the association by recomputing the key for a candidate task.

Use the old Host's existing `await byok.tasks.offer(candidate.task_id)` to perform that derivation. This read-only API loads the durable attempt within the Host's tenant, computes its message id, reads exactly `task-offer:<messageId>` within that same tenant, and validates the stored target and full AgentRef. See [offer readback](../../packages/cloud/src/api/task-reads.ts). No new helper or device dispatch is required.

1. Bind the old embedded Host to the Q1 row's exact `tenant_id`. Its configured `productId` must produce `tenant_id === 'product:' + productId`. Never use a candidate or readback from another tenant.
2. For each Q1 row, consider Q2 rows only within that tenant, with the same `device_id` and full AgentRef (`agentId` and `profileRevision`). For each candidate, read `offer = await byok.tasks.offer(candidate.task_id)`. A match requires all of: `offer` exists, `offer.taskId === candidate.task_id`, `offer.deviceId === Q1.device_id`, `offer.delivered === false`, its full `offer.payload.agentRef` equals Q1's parsed `agent_ref_json`, and **`'task-offer:' + offer.messageId === Q1.receipt_key`**. The exact key equality, computed from the attempt, proves the task identity.
3. Build and verify the complete mapping before any mutation. Every Q1 `(tenant_id, receipt_key)` must match exactly one Q2 `(tenant_id, task_id)`, and every mapped `(tenant_id, task_id)` must occur exactly once in that mapping. Retain the receipt key, message id and verified task id together in the inventory. Device/Agent equality alone never satisfies this check.
4. If a candidate read fails, a Q1 row has no match or multiple matches satisfying every identity check, or two Q1 rows map to the same task, **stop and do not abandon any task**. Resolve the association before upgrading; do not infer it from candidate count or timestamps.
5. Only after all checks pass, call `byok.tasks.abandon(verifiedTaskId, 'operator')` through that same old Host for each verified task. Then upgrade and dispatch with new task ids. These offers never reached the device; do not use `cancel` for this cleanup. Do not replay the old recorded offer with the newly omitted `runtime` bytes.

## OpenCode Host MCP toolsets

No Host configuration change is required (#1632). OpenCode now advertises `mcpToolsets: true` and passes an admitted task's Host MCP servers through ACP on session open and resume. A Host may offer configured toolsets to OpenCode using the existing toolset selection. The loopback contract exercised OpenCode 1.19.5 and 2.2.6 on macOS arm64 and Windows x64. OpenCode v2 still refuses Agent `memory-reader` tasks because its session-local appended instruction channel is unqualified.

## Bot collaboration is a package

K8 is published as `@byok-sdk/bot-collaboration` (#1845), on the same version as the other SDK packages. Vendoring K8 is no longer a supported route: delete the copied source, its provenance record and the copy script, and install the package at the SDK version you install. Its runtime dependencies are `@byok-sdk/protocol`, `@byok-sdk/server` and `@byok-sdk/client`. `vitest` and `@hono/node-server` are optional peers, needed only for `./testing`.

Map your imports to the four entries (see the entry table in the [package README](../../packages/bot-collaboration/README.md#entries)):

- `.`: the L Host: `BotCollaboration` and its option types, `botCompactVeto`, `createBotPersonaProjection`, and `teamSnapshot` with its errors. Node only.
- `./host-kit`: the L modules a Host adapter composes (model, channel, delivery, routines, team, migration, retention, dreaming, adapter steps, commit, switch), including `CollaborationState`, `Turn`, `RetentionRefused`, `IntentOutcomeError` and `migrateWouldDo`. It never loads `@byok-sdk/client`, so a Worker can bundle it.
- `./rules`: the remaining pure rules. They load only `@byok-sdk/protocol` and `@byok-sdk/server/execution-core/canonical`, so they need no `node:sqlite`.
- `./testing`: the shared vectors, the L test Host, and the K4 test data `policy` and `template(deviceId, agentId)`.

Names that the copied source exposed but no entry exports are not public; a Host that needs one opens an issue. K8 changes are listed under the regular `Breaking`, `Added` and `Changed` entries of `CHANGELOG.md` from this release on.

H vendors also receive one outbox projection row per stored inbound destination from sync; an unchanged destination reuses its projection row (#1664 PR-3b).

## Doctor names a refused control endpoint

No Host configuration change is required (#1688). When the daemon refuses its control endpoint with `private_dir_symlink`, `private_dir_not_directory`, `private_dir_foreign_owner`, `private_dir_mode`, `socket_path_not_socket` or `socket_mode`, it keeps running without the endpoint and records the code and path under a `controlEndpoint` key in `operational-health.json`. The key exists only while the endpoint is refused; the next successful bind removes it. `byok-agent doctor` then reports `control endpoint refused: <code> <path>` instead of `daemon offline`. `OperationalHealthFileInspection` gains an optional `controlEndpointRefusal` on its `valid` branch. An older daemon reads a health file that still has this key as corrupt, so downgrade only after a daemon run that bound its endpoint.

## Runtime environment lanes in doctor

No Host configuration change is required (#1688). `RuntimeEnvironmentReport` gains an optional `lanes` list of `RuntimeEnvironmentLaneReport`, also carried by the `runtimes.environment` control method and `byok-agent doctor`. The Pi adapter reports a `pi-prepared` lane unless it is a durable adapter, and a `pi-keys-profile` lane when a BYOK launcher is configured. An `sdk` lane lists the names its launch removes; the `pi-keys-profile` lane says only that the keys launcher passes its fixed names. A Host that sets `runtimeEnvironment.pass` names such as `PI_OFFLINE` can read there which lanes never give them to the runtime. No lane narrows differently than before. A Host that builds a `RuntimeEnvironmentReport` itself may omit `lanes`.

## Per-runtime environment policy

`runtimes.<id>.runtimeEnvironment` sets the environment policy of one SDK-built runtime (#1759), on `DaemonConfig`, a config file and `createRuntimeAdapters` alike. It replaces the top-level `runtimeEnvironment` for that runtime; it is not merged with the top-level `pass`, so a name the top-level `pass` lists does not reach a runtime that sets its own policy. A runtime without the field keeps the top-level policy, so an existing configuration keeps its meaning. Pi's effective policy must not pass `PI_PACKAGE_DIR`. The Pi prepared and Pi keys-profile lanes still ignore `pass`. `DaemonEffectiveRuntime` gains an optional `runtimeEnvironment`, each runtime's effective policy, and `byok-agent config check` prints it under each runtime; its JSON keeps the top-level `runtimeEnvironment` (the configured default) and adds `effective.runtimes[].runtimeEnvironment`. No Host change is required.

To give a key to one runtime only, name it on that runtime instead of in the top-level `pass`:

```ts
const adapterConfig = {
  runtimeAllowlist: ['pi', 'claude', 'codex', 'dsh', 'agy'],
  runtimes: {
    dsh: {
      home: '/var/lib/acme/dsh',
      model: { provider: 'deepseek', model: '<model id>', keyEnv: 'ACME_DSH_KEY' },
      runtimeEnvironment: { pass: ['ACME_DSH_KEY'] },
    },
    agy: { home: '/var/lib/acme/agy', runtimeEnvironment: { pass: ['GEMINI_API_KEY'] } },
  },
};
```

The DeepSeek key then reaches only dsh and the Gemini key only agy; pi, claude and codex get neither. A Host that builds dsh and agy with separate `createRuntimeAdapters` calls only to scope their keys can build them in one call.

## Bot collaboration autonomy and missing ports

K8 rules now build the Bot autonomy gate themselves (#1665). A Host adapter that builds its own `OutcomePorts` removes the `autonomy` member; a direct caller of `applySpeech` or `applyDelegate` passes an `AutonomyGate`. A refusal for a missing Host port is now `MissingPortError` from `rules/commands.ts`, with `code` `missing_port` and the port `kind`; the message text is unchanged, so match on `code` instead of the message.

## Version policy source

The seven built-in adapter option types (`AgyAdapterOptions`, `ClaudeAdapterOptions`, `CodexAdapterOptions`, `DshAdapterOptions`, `GrokAdapterOptions`, `OpenCodeAdapterOptions`, `PiAdapterOptions`) no longer accept the internal `versionPolicySource` option (#1682). A Host that constructs an adapter directly deletes `versionPolicySource` from the options object. `versionPolicy` itself, `DaemonConfig.runtimes.<id>.versionPolicy` and the version verdicts they produce are unchanged: a Host policy still replaces the descriptor default wholesale.

## Hosted passes

The hosted Bot collaboration index no longer exports `HostedSubmitter`, `HostedReconciler`, `HostedDueScheduler`, `HostedReplyChecker`, `HostedDeviceObserver`, `HostedRoutineScheduler` or `HostedOutboxSender` (#1668). A Host that built its own passes constructs one `HostedPasses(pool, store, ports)` and calls `run()` every `ports.intervalMs`; it runs the passes in the order the Worker used, and a missing required port is a type error. `HostedPasses`, `HostedPassPorts`, `HostedPassTimings`, `PassReport`, `PassFailure` and `PassSynced` replace the pass assembly and the Worker's `PassReport`.

| Before | Now |
| --- | --- |
| submitter and reconciler `port` | `ports.task` |
| reply checker `port`, device observer `port` | `ports.replies`, `ports.devices` |
| sender `projections`, `homes`, `channel`, `connector` | `ports.projections`, `ports.homes`, `ports.channel`, `ports.connector` |
| scheduler `intervalMs` | `ports.intervalMs` |
| the composed sync function | `ports.sync` (the options) and `passes.syncScope` |
| `changed` callbacks, and the other pass options | wired by `HostedPasses`; the rest go in `ports.timings` |

Pass the command entry `sync: passes.syncScope` and `failStuckIntent: (scope, key) => passes.failStuckIntent(scope, key)`; the latter syncs the touched scope after the call.

## Hosted Bot autonomy (#1662)

The hosted Bot collaboration example now enforces Bot autonomy: an outcome of a Bot in `observe` no longer runs `create_routine`, a cross-Bot `delegate` or `room_call`; it stores a `would_do` entity and a `would-do:<id>` projection instead, as the local Host does. Two steps, in order:

1. Run `HostedCollaborationStore.migrate()` once on every existing schema before the new code serves. It replaces `entity_kind_check` and moves any `wouldDo` rows that an older L import left in a scope frame into `would_do` entity rows. Without it the first would-do write fails with `violates check constraint "entity_kind_check"`.
2. Every existing Bot is now `observe`. Call `HostedCommandEntry.setBotAutonomy(credential, botId, 'auto')` for each Bot that must keep acting on its own. The method is owner only.

## Hosted outbox sender (#1663)

The hosted Bot collaboration Worker now runs `HostedOutboxSender` in every pass, after the submitter: projections reach the new `host_projection` table, and a Bot with a pending home operation becomes ready, so its Turn freezes. Before serving the new code, run `hostProjectionDdl(HOST_SCHEMA)` once from Node (`CREATE TABLE IF NOT EXISTS`, safe to repeat). The first pass then sends the backlog, at most 100 rows per pass. A card or delivery row that the Worker has no port for is listed in the pass report's `send.failed` instead of staying silent.

## Isolated service lifecycle gate root

No Host change is required (#1732). `CreateServiceLifecycleOptions` gains an optional `gateRoot`. On macOS, install, repair and uninstall then hold the `service-lifecycle` gate in that directory instead of `/tmp/byok-pm-<uid>`, so tests or parallel consumers can drive separate lifecycles without refusing each other with `lifecycle_owner_busy`. Lifecycles exclude each other only when they use the same root, so production code should omit it. Only the lifecycle's gate moves: `claimServiceLifecycleOwner`, `releaseServiceLifecycleOwner` and `localStateRelocation` still lock the default root, so a lifecycle on a `gateRoot` no longer excludes them. The root must be an absolute path and gets the same check as the default root. An absent root is created with mode 0700. A gateRoot owned by the process user is set to 0700; a symlink, non-directory or foreign-owned path is refused. The refusal's code is `private_dir_symlink`, `private_dir_not_directory` or `private_dir_foreign_owner`, and `private_dir_mode` when the root cannot be set to 0700. The check covers the root itself, not a swap of its parent, so choose a root whose parent directory other users cannot write. The option takes effect on macOS only: Linux and Windows ignore it, a relative path included, because their gate is an abstract socket or a named pipe with no filesystem root.

## Bot collaboration cancel results

The hosted `HostedCommandEntry.cancelTurn` and `cancelDelegation` return `TurnCancelResult` and `DelegationCancelResult` instead of `void` (#1666), as the local Host does. A cancel returns `cancelled` when it committed, `cancel_pending` when an earlier cancel has no terminal yet, and `already_settled` when the target had ended; the last two write nothing and send no second K4 cancel. Cancelling an ended delegation no longer throws: it returns `already_settled` with the `verdict`. A refused delegation cancel throws `DelegationError` with `code` `unknown_delegation` or `not_cancellable` (end a `reply_held` or `uncertain` delegation with `abandonDelegation`). `DelegationError` and both result types are exported from `@byok-sdk/example-hosted-bot-collaboration` and from K8 `rules/delegation`.

## Hosted device slots and Host intent cancel (#1756)

The hosted submitter now applies the local Host's device slot rule: per scope and device, at most `deviceConcurrency` (default 8, a new `HostedSubmitter` option, also in `HostedPassTimings.submitter`) tried rows hold a slot, and a row that is not user-source leaves one slot free. A row with no slot waits at its FIFO head; nothing is cancelled to make room. A Host that relied on submitting more than 7 non-user rows per device at once sets a larger `deviceConcurrency`. `HostedCollaborationStore.cancelHostIntent(scope, key, clock)` is new: check the owner, call it, then sync the scope. It returns `IntentCancelResult` and refuses with `HostIntentError`, both exported from `@byok-sdk/example-hosted-bot-collaboration` and from K8 `rules/delegation`.

## Bot collaboration switch contract

The owner switch records and errors are defined once, in `@byok-sdk/bot-collaboration` (#1667), and are imported from `@byok-sdk/bot-collaboration/host-kit`: `SwitchHeader`, `SwitchReceipt`, `SwitchExportMark`, `exportMarkOf`, `SwitchExportedError`, `SwitchImportedError` and `DeviceSwitchingError`. The root of `@byok-sdk/bot-collaboration` does not export them. The hosted example root still exports the classes, `SwitchReceipt` and `SwitchExportMark`, but the hosted `./switch` and `./binding` modules no longer do. `DeviceSwitchingError` takes `target: 'L' | 'H'`. The messages of `SwitchExportedError`, `SwitchImportedError` and `DeviceSwitchingError` changed and their `code` values did not, so match on `code`. The local `refuseImported` now throws `SwitchImportedError` (`switch_imported`) instead of a plain `Error`.

## Bot collaboration legacy ledger branches

The examples no longer read three old stored shapes (#1669). Before the upgrade, while the Host still runs v0.41.0, prove that none remains; the new code has no branch that reads them.

- H store: run `migrate()` once with v0.41.0 H for each schema. Then find the schemas with `SELECT table_schema FROM information_schema.columns WHERE table_name='scope' AND column_name='state_version'` and run this read-only query for each one. `unmigrated_dreams` must be 0 in every row; otherwise do not upgrade.

  ```sql
  SELECT s.state_version, count(*) AS scopes, count(*) FILTER (WHERE s.frame::jsonb ? 'dreams' AND d.scope IS NULL) AS unmigrated_dreams
  FROM "<schema>".scope s LEFT JOIN "<schema>".dream_state d ON d.scope = s.scope GROUP BY s.state_version
  ```

  The new H `migrate()` no longer moves frame `dreams` into `dream_state` (the `wouldDo` move stays). A scope row whose `state_version` is not `STORE_VERSION` is still refused with `HostedStoreVersionError`.

- L ledger: run this read-only query (`sqlite3 -readonly <file> <SQL>`) on each `HostLedger` file. `legacy_home` must be 0 in every row. If it is not, keep running the current Host until those home writes end, and query again.

  ```sql
  SELECT tenant, json_extract(body,'$.application.collaboration.version') AS version,
    (SELECT count(*) FROM json_each(body,'$.application.collaboration.team.homeOperations') o
     WHERE json_extract(o.value,'$.status')='pending' AND json_extract(o.value,'$.sent') IS NOT 1 AND json_extract(o.value,'$.retryAt') IS NOT NULL) AS legacy_home
  FROM host_ledger
  ```

  A pending Agent home write now counts as possibly sent, and blocks a switch export with `home_sent`, only when it is marked `sent`; a `retryAt` alone no longer counts.

- Vendored Hosts: `src/history.ts` is removed from the `vendor host` layer. A Host that copied it imports `HISTORY_MAX_BYTES` and `HISTORY_MAX_ITEMS` from `rules/history` instead.

## Bot replies wait for the Turn outcome (#1762)

A Bot reply is now visible only when its Turn's outcome committed: iff the Turn's intent concluded `succeeded` with that reply's task id. Before, an accepted reply was queued for the channel at once, so a daemon stop between the reply and the outcome posted the reply and dropped every action of the outcome.

- The channel delivery of an accepted reply starts in the new `DeliveryState` `staged`. The outcome transaction that concludes the intent `succeeded` promotes it to `pending`, so a channel reply now arrives after the Turn's outcome, not mid-Turn. A staged delivery whose intent concludes otherwise is `rejected` with the new code `outcome_not_applied`, and its Turn stays `failed`. A Host that reads deliveries handles both values. A pending or unknown reply delivery now keeps its reply route token until it settles or the route expires.
- Persisted format: no migration and no schema change. L stores the new state in its ledger JSON. H stores it in the `delivery` entity JSON, which has no CHECK on `state`; H inserts a delivery's `outbox` row only when the delivery is promoted, so a staged or withheld delivery has none. `STORE_VERSION` is unchanged. A reply delivery that is already `pending` before the upgrade is still sent once; every reply accepted after it is staged.
- Operator step for hosted (H) Hosts: stop every old H process before a new one starts. In a rolling deploy, an old worker's `finish` has no promotion, so a reply that a new worker staged stays staged after its intent concluded `succeeded`, and a new worker's sync then withholds it as `outcome_not_applied`. A mixed deploy can drop such a reply; it never shows a reply early.
- A Turn that runs past its reply route token answers through the conversation's active push route, with a new delivery id, or not at all: its reply delivery is rejected `reply_route_expired`, or no delivery is queued when the token had already expired at acceptance. Before, a reply sent mid-Turn usually still had its token.
- Operator step for Hosts on K8: a Host that shows or uploads replies from `replies` must skip a reply unless `core.intent(turnId)` has `conclusion === 'succeeded'` and `taskId` equal to the reply's task id. For example, AiphaBee adds this check to its `k8RootUploads`. Until a Host adds it, its own upload still shows a reply before the outcome commits; K8's channel no longer does. A Host with a channel takes K8's delivery state as the authority, because the conclusion check alone passes a message that K4 accepted after a `succeeded` conclusion. See [Reply visibility](../../packages/bot-collaboration/README.md#reply-visibility).

## K4 transaction rows and required command store capabilities

`OutcomeTransaction` and `OccurrenceTransaction` gain `rows: ApplicationRows`, the application row port of the same commit (#1756), as `MessageTransaction` already has. The port closes when the transaction ends. A Host whose `applyOutcome` or occurrence hook only reads the transaction needs no change; code that builds a transaction object itself, such as a test double, adds `rows`.

K8 `CommandStore.archived` and `admitted` are required. A vendoring Host that calls `commitCommand` passes both: `archived` reads a command record that retention moved, and `admitted` hands the added ids to `refuseRetired` before the commit. The local Host's K4 outcome, message and occurrence callbacks commit through `commitInRows` (`commit.ts`) and the hosted routine fire through `commitInStore` (`retention.ts`), so these commits now refuse a retired Turn, input or round id with `RetiredIdentityError` and write nothing. What a Host sees for each refusal:

- L outcome: the Turn's outcome fails with `IntentOutcomeError` code `outcome_failed`.
- L message: the message handler throws.
- L occurrence and H routine fire: the slot records no occurrence and stays due. H retries it every `backoffMs` and reports `pass.failed`, and the routine does not advance past that slot.

None of these is reachable in normal flow: new Turn, input and round ids are fresh, so the refusal guards only against corrupt state. No persisted format changes.

## Would-do rows name their Turn

A would-do row gains a required `turnId`: the Turn whose outcome proposed the action (#1756). Retention moves each row with that Turn's root, into the `wouldDo` archived rows, so `wouldDoRecords` and the stored `wouldDo` map list only the rows of roots still in the state. The row id and the `would-do:<id>` projection key are unchanged; the projection body gains `turnId`. No DDL changes, and `STORE_VERSION` stays 2.

Operator step, once per store, before the new code serves:

- Local (L) Host: run `migrateWouldDo(ledger)` on each ledger. A Host such as AiphaBee runs it on each device ledger.
- Hosted (H) Host: run `HostedCollaborationStore.migrate()` on each schema. It now returns `{ wouldDoBackfilled, wouldDoArchived }`.

The migration fills `turnId` from the K4 task id `taskId(turnId, generation)` of each live Turn intent: L checks every generation of the intent, H joins `intent` and `intent_execution`. A row whose intent was already compacted, or whose Turn already left the state, cannot be linked to a Turn. It moves to the `wouldDo` archived rows and is counted in `archived` (L) or `wouldDoArchived` (H). Those rows are settled history, never read by a Turn; the count is how many rows leave the would-do feed early. Record it. A second run returns zeros.

A switch export or import refuses a would-do row without `turnId` (`invalid`), so migrate the source before a switch. A switch in flight across the upgrade holds an export that old code sealed with rows that have no `turnId`, and the new code's verify refuses it: abort the switch (`abortSwitch`), run the migration on the source, then export again. A store that skipped the step refuses every `retain` call and every `wouldDoRecords` read with `A would-do row has no turnId: run migrateWouldDo (local) or HostedCollaborationStore.migrate() (hosted) first`, and changes nothing, until the migration runs.

## Offer selection rules

`@byok-sdk/protocol` exports `offerSelectionViolation(payload)` and the types `OfferSelectionRule` and `OfferSelectionViolation` (#1674). The offer selection rules have one definition, which the Host offer schemas and the daemon both run. A `HostOfferPlainPayloadSchema` or `HostOfferSealedPayloadSchema` issue carries `params.rule`, and the daemon declines the same offer with `task.decline.code` equal to that rule:

| Rule (`params.rule` and decline `code`) | Schema path |
| --- | --- |
| `agent_memory_selection_invalid` | `['agentMemory']` (reader with a read-write `agentMemory`), then `['agentMemoryCommit']` (reader with `agentMemoryCommit`) |
| `native_sessions_selection_invalid` | the first `nativeSessions` field combination it breaks, in the order of the [Offer selection rules table](../protocol.md#32-declined-vs-failed-m1-gap-5) |
| `runtime_selection_mismatch` | `['runtime']` |
| `harness_selection_conflict` | `['harnessId']` |

Rules are checked in that order, and a payload that breaks several reports only the first: one `ZodError` issue instead of one per rule. A Host that counted these issues or read a later path must read the first issue's `params.rule`. The order is a contract, defined by the **Offer selection rules** table in [protocol §3.2](../protocol.md); a later rule is appended at the end only.

These declines are non-retryable, and their `reason` is `<rule>: <message>`. Classify them by `code`; `reason` is display text only. `readDeclineCode` reads the four codes as typed values; an earlier SDK reads them as `unknown` with `reportedCode`.

**Behavior change (#1757).** The reader + `agentMemoryCommit` rule and the `nativeSessions` combination rules moved out of the wire `task.offer` refinement into `offerSelectionViolation`. `TaskOfferPlainPayloadSchema`, `TaskOfferSealedPayloadSchema`, `TaskOfferPayloadSchema` and `parseMessage` now accept such an offer; the Host offer schemas still refuse it, now with one issue carrying `params.rule`. A device that receives one declines it non-retryably with that code, and its cursor moves past the offer; before, the envelope failed decoding and froze the device's acknowledgement cursor. A Host that validates offers with the wire schema and sends through a non-SDK sender now gets this non-retryable decline instead of a submit-time refusal: validate Host input with `HostOfferPlainPayloadSchema` / `HostOfferSealedPayloadSchema` or `offerSelectionViolation`. Structural offer rules (prepared shape, `egressPolicy`, `routineRef`) still fail decoding.

**Breaking (cloud).** Enqueueing an offer whose `harnessId` the device did not advertise now throws `ByokCloudError` with code `agent_capability_missing` instead of `coordination_input_invalid`; the message is unchanged. A Host that branches on `coordination_input_invalid` for this refusal must branch on `agent_capability_missing`.

## Socket fallback directories carry the uid

No Host code change is required (#1759). A store whose `<storeDir>/control.sock` or `<storeDir>/mutex.sock` is longer than 100 UTF-8 bytes binds in a fallback directory under `/tmp`. Its name now carries the process uid: `/tmp/byok-<uid>-<hash>/sock` for the control socket and `/tmp/byok-store-mutex-<uid>-<hash>/sock` for the store mutex. Stores whose natural paths fit, and Windows named pipes, keep their addresses.

Stop the daemon of the previous version before you upgrade such a store. A new CLI derives the new control address and cannot reach an old daemon, so `byok-agent status` reports the daemon as not reachable and `byok-agent doctor` reports `daemon offline`. `byok-agent doctor --fix` then takes the store lease, which the old daemon still holds, so it changes nothing: the CLI prints `store mutation lease is already held by an active daemon process` (`DaemonOwnerActiveError`, role `daemon`) and exits 1. The SDK operator action `quarantineDeviceOperationalHealth` returns `DeviceOperatorError` with `store-busy` instead. A new daemon started while the old one runs is refused by the same lease with `DaemonOwnerActiveError`: the old daemon's `daemon-owner.json` lease and the path-mutation gate do not depend on the fallback name. An empty old `/tmp/byok-<hash>` or `/tmp/byok-store-mutex-<hash>` directory left by a crashed daemon is no longer reclaimed; remove it by hand if no byok process uses it.

Do not share one store between users. Because the fallback name now carries the uid, two uids on the same long-path store (for example `sudo byok-agent doctor --fix` on another user's store) no longer contend for one fallback mutex. A live owner lease still refuses the second process, but two processes of different uids that start at the same moment and both reclaim a stale lease are not serialized against each other: the path-mutation gate is per uid as well.

## Scope key packages are version 2 only

`openScopeKeyPackage` refuses a version 1 scope key package with `key_package_invalid` (#1789). Every package must name the recipient's KEM epoch as `recipientKemEpoch`, and the recipient opens it only with that KEM key. `ScopeKeyPackageV1` and `ScopeKeyPackageV2` are no longer exported; `ScopeKeyPackage` is the one package type. SDK writers have sealed only version 2 since 0.30.2, and a 0.30.2 or later Host refuses a version 1 put. A device no longer re-wraps a version 1 package during a KEM rotation, because core cannot open it.

The Host read shape narrows too: `E2eeScopeKeyPackageSchema` in `@byok-sdk/protocol` is now the version 2 shape for both puts and reads, and `E2eeScopeKeyPackageV2Schema` is removed; use `E2eeScopeKeyPackageSchema`. The put path is unchanged; it already took version 2 only. A Host read that meets one stored version 1 row fails the whole read (every package of that scope or page) with `e2ee_member_state_unreadable`, not only that package.

Only a Host that served `e2ee.member` on 0.30.0 or 0.30.1, or stored packages sealed by 0.29.0 core, can hold a version 1 row. Before upgrading, run this count on every Host store:

- Postgres: `SELECT count(*) FROM e2ee_scope_key_package WHERE (package::jsonb)->>'v' = '1'`
- embedded SQLite: `SELECT count(*) FROM e2ee_scope_key_package WHERE json_extract(package, '$.v') = 1`

Upgrade only when it returns 0. If it does not, stay on the previous version and run a KEM rotation on each member that is the recipient of a version 1 row: the previous version re-wraps, as version 2, each package addressed to that member whose sender is still a current member of the scope policy. Run the count again before upgrading. The SDK ships no migration for these rows.

A rotation leaves a version 1 row in place when its sender is no longer a current member of the scope, so the count can stay above 0. If version 1 rows remain after the rotation, stay on the previous version and open an issue: the SDK has no automatic way to re-wrap them.

## Runtime failures have no category

`RuntimeExecutionFailure` and `RuntimeExecutionFailureInput` no longer have a `category` field, and `RuntimeFailureCategory` is no longer exported from `@byok-sdk/client` or `@byok-sdk/client/adapters` (#1758). Nothing read it: `retry` is the only retry authority and `failure` the only failure class, and the wire projection (`reason`, `retryable`, `failure`) is unchanged. A Host or runtime adapter that constructs a `RuntimeExecutionFailure` deletes the `category` key from the input object; TypeScript reports it as an unknown property until then. Code that names `RuntimeFailureCategory` or reads `.category` deletes that reference. Load runtime adapters and the daemon from the same client version: an older client's `isRuntimeExecutionFailure` refuses a failure without `category` and reports it as an adapter-contract violation.

## Every task attempt has an Agent identity

`TaskAttemptStore.open` is removed (#1780). `reserveAgentOffer` is the only way to create a task attempt, and `TaskAttempt.agentRef` is required, as is `agentRef` on `recordStatus`; server `TaskSnapshot.agentRef` is required too. A store that implements `TaskAttemptStore` drops `open` and always returns `agentRef`. No build since v0.31.0 creates an attempt without an Agent identity. Builds up to v0.30.2 did, through the legacy `enqueueOffer` and `enqueueToolsetOffer`, and the rows they wrote are still stored: task rows are never deleted.

This build reads such a row as an error. On Postgres, a task read, a task page or the archive step that meets one throws `ByokCloudError` `task_attempt_agent_ref_missing`, naming the task, `retireAgentlessTasks` and migration 0039; a page that contains one fails as a whole. Task counts (`countByStatus`) do not read the Agent columns and keep working. The gate is `verifyMigrations()`: serve this build only after it passes, which it does only once 0039 has applied.

**Postgres (cloud-dataplane).** The settle build is **v0.41.0**: it uses migrations 0001–0037, still reads tasks without an Agent identity, and has every call needed to settle them. Do not settle on 0.22.0 (Salesko's current release): there `cancelTask` leaves a claimed task at `cancel_requested`, which is not terminal, and there is no `abandonTask`. The order is: count, settle on v0.41.0, upgrade, migrate to 0038, run `retireAgentlessTasks`, migrate to 0039.

The v0.41.0 steps (settle, export) run as an operator script on the v0.41.0 packages (`@byok-sdk/cloud` and `@byok-sdk/cloud-dataplane` at 0.41.0) against the Host's database: an application built on 0.22.0 does not run on them, and those calls are not in 0.22.0. `retireAgentlessTasks` has no CLI either; call it from an operator script on this build. Do every v0.41.0 step before the upgrade: once 0038 is applied, v0.41.0's `verifyMigrations()` reports it as `unexpected`, so v0.41.0 must not serve that database again.

1. Set the Host schema (for example `SET search_path TO byok_control;`), run this read-only count and record it.

   ```sql
   SELECT tenant_id,
          count(*)                                                                 AS no_agent_ref,
          count(*) FILTER (WHERE status NOT IN ('complete','failed','cancelled'))  AS no_agent_ref_live,
          count(*) FILTER (WHERE status IN ('complete','failed','cancelled') AND EXISTS (
            SELECT 1 FROM outbox o
             WHERE o.tenant_id = task.tenant_id AND o.state = 'pending'
               AND o.device_id IN (task.device_id, task.owner_device_id)
               AND strpos(o.body, '"task_id":' || to_json(task.task_id)::text) > 0)) AS no_agent_ref_pending_delivery,
          min(updated_at)                                                          AS oldest_update,
          max(updated_at)                                                          AS newest_update
     FROM task
    WHERE agent_id IS NULL
    GROUP BY tenant_id
    ORDER BY tenant_id;
   SELECT count(*) AS no_agent_ref_total FROM task WHERE agent_id IS NULL;
   ```

2. If `no_agent_ref_live` is above 0 anywhere, upgrade to v0.41.0 (its `migrate()` applies 0023–0037 to a 0.22.0 schema) and settle those tasks there. `cancelTask` cancels an unclaimed task at once and asks a claimed task's device to stop; a claimed task stays `cancel_requested` until its device reports. For a task whose device is gone, or that stays `cancel_requested`, call `abandonTask(tenant, taskId, 'operator')`: it moves any unfinished task to `cancelled` without the device. Repeat the count until `no_agent_ref_live` and `no_agent_ref_pending_delivery` are 0 everywhere.

   Also on v0.41.0: a terminal task can still have an offer or cancel envelope `pending` in a mailbox (its device registered but offline). `retireAgentlessTasks` refuses such a task (`pending_delivery`), because it archives at once instead of after the retention window. `no_agent_ref_pending_delivery` counts them. Either bring the device online so it receives the rows; or call `revokeDevice(tenant, deviceId)` for a device that will not return: revocation retires the device and moves its pending rows to `expired`; or, keeping the device, dead-letter just those rows with `mailbox.expirePending(tenant, { deviceId, seqs })` on the core stores (`createPostgresCoreStores` from `@byok-sdk/cloud-dataplane`), taking `device_id` and `seq` from the same `outbox` match as the count.

   **Export first, in every case.** `retireAgentlessTasks` ignores the retention window: every legacy task's receipts become tombstones at once, however recent. Before upgrading, on the build the Host runs (0.22.0 and v0.41.0 both have these reads), read what the Host must keep: `readTaskResult(tenant, taskId)` (the typed result) or `readTerminalReceipt(tenant, taskId)` (the raw terminal), for each `task_id` from `SELECT tenant_id, task_id FROM task WHERE agent_id IS NULL`. On v0.41.0 the offer read (`readTaskOffer`) does not serve these tasks.
3. Stop the application and install this build. Run the package migrations (`migrate()` over the new `dist/sql`) with only 0001–0038 present, for example a copy of `dist/sql` without `0039_task_agent_ref_not_null.sql`. 0038 creates `task_agentless_retired`. If you run every file instead, 0039 refuses as in step 5, and only 0039 rolls back: each file applies in its own transaction. A migrate wrapper that always runs every file (Salesko's `byok-control` migrate does) therefore applies 0038 and then exits with 0039's refusal (exit code 2 there) on this first pass. That is expected: continue with step 4.
4. Run `retireAgentlessTasks` from an operator script on this build, with the Host's database URL and schema:

   ```ts
   const pool = createByokPool({ connectionString: process.env.DATABASE_URL!, options: '-c search_path=byok_control' });
   console.log(await retireAgentlessTasks(pool, { clock: { now: () => new Date() }, crypto: createWebCrypto() }));
   await pool.end();
   ```

   (`createByokPool` and `retireAgentlessTasks` from `@byok-sdk/cloud-dataplane`, `createWebCrypto` from `@byok-sdk/cloud`.) `retired` gives this run's count per tenant. For each terminal task without an Agent identity it does what the archive step does (its offer, terminal and message receipts become tombstones, its object references are released), removes its board item, and moves its row, whole, into `task_agentless_retired`. It refuses before any change, listing per tenant how many are `task_not_terminal` and how many have a `pending_delivery`, if any would not archive (go back to step 2 on v0.41.0); it stops with the task named if the archive still refuses one. It can be run again; a later run retires what is left and returns an empty count. Record the total from the table, which holds across reruns and interrupted runs: `SELECT tenant_id, count(*) FROM task_agentless_retired GROUP BY tenant_id ORDER BY tenant_id;`.
5. Run the migrations again with every file. 0039 locks `task`, refuses with `0039_task_agent_ref_not_null: N task(s) have no Agent identity; nothing was changed. ...` while any such row remains (go back to step 4, or to step 2 on v0.41.0 for one that is not terminal), and otherwise makes `task.agent_id` and `task.agent_profile_revision` NOT NULL. Hold `task` locked for that one scan.

A retired task id stays used: `enqueueAgentOffer` with that `taskId` throws `agent_task_already_exists`. No Agent identity is invented. A retired task's mailbox rows, activity log and approval timeline stay as the archive step leaves them, until retention or tenant erasure; tenant erasure also erases `task_agentless_retired`.

**Embedded SQLite.** The SQLite schema moves to version 9 when a version 8 file is opened. The step changes nothing else; it refuses a file that holds any task attempt without an Agent identity with `SqliteSchemaError` `SQLITE_SCHEMA_UNSUPPORTED`, naming the count, and leaves the file at version 8. No SQLite file this build can open was written by a build that created such attempts (every adoptable file is from v0.31.0 or later), so the expected count is 0. To check before upgrading, open the state file read-only (`sqlite3 -readonly <file>`):

```sql
SELECT count(*) FROM task_attempt WHERE agent_ref_json IS NULL;
```

A version 9 file cannot be opened by an earlier build.

## Declarations resolve under NodeNext

The published declaration files spell every relative specifier with its
runtime extension (`./x.js`, `./x/index.js`), so a Host that compiles with
`moduleResolution` NodeNext or Node16 now resolves the SDK types (#1828).
Before this release such a Host got untyped (`any`) SDK imports with
`skipLibCheck: true`, or TS2834 errors with `skipLibCheck: false`. Hosts on
Bundler resolution see no change. A NodeNext Host may now see type errors in
code that compiled against `any`; fix them against the real types.

## Runtime isolation bits follow adapter options

The `isolation` bits that hello, presence and `task.claim` report for Claude, Codex, Pi and Grok now follow the options each adapter was constructed with (#1633, #1637); before, they always reported the best case. A Host that routes or admits work on those bits, for example `userMcpServers` or `userMemory`, now sees `false` for a source its device inherits (the default `agentUserContext`, or `agentUserMcpServers` other than `'excluded'`). Construct the adapter with the excluded option where the Host needs that source excluded; code that reads `*_RUNTIME_CAPABILITIES` still gets the best case.

## Pi 1.5.2 closure

The official Pi closure moves from 1.5.0 to 1.5.2 (#1864). Prepare again every preparation compiled for 1.5.0: its runtime identity names the old closureDigest, so it declines with `preparation_runtime_identity_mismatch`. Check stored provider profiles against `piModelConfigFromPinnedCatalog` before the upgrade; 12 OpenRouter and Vercel AI Gateway entries that pi-ai 1.5.2 dropped return `not_in_catalog`. pi-durable replicas keep their document and schema versions, so this release and 0.41.0 open each other's replicas.

No configuration change is needed for the new Pi defaults. Pi 1.5.1 keeps prompt caches warm for up to 30 minutes between runs by default (`cacheWarming: "idle"`). Because a Host cannot see or bound that spend, the SDK caps each Pi RPC session's settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file. A pi-subagents child is disposed when its run ends, and disposal cancels its warmer, so no child warms after its run either. On the native Pi auth route, a task on the built-in `anthropic` provider at `api.anthropic.com` now sends only new messages and continues the server-side thread, falling back to a full request when the server refuses; a keys profile route sends full requests as before. A native launch with no Host model selection still uses the device's Pi settings; only when those name no default model does Pi pick its per-provider default, which is now `claude-opus-5-5` for `anthropic`.

## Embedded pairing and connection wait

`Daemon` gains two required members, `pairEmbedded(server)` and `whenOpen({ signal })` (#1840). A Host test double typed as `Daemon` must add both.

An embedded Host that pairs its daemon against its own in-process server replaces its `createPairingCode` and `pair` calls with `daemon.pairEmbedded(byokServer)`. It reads the store's enrollment under the daemon owner lease and never starts the daemon. An unpaired store against a server with no devices pairs and returns the new device. A paired store whose device `machines.list()` reports is returned unchanged. Every other state throws `EmbeddedPairingError` and writes nothing: `enrollment_missing` (unpaired store, server already lists devices), `device_unknown` (the server does not list this store's device), `re_pair_required` (the device record has no OS credential entry) or `store_not_bound` (the OS entry holds another storeDir's enrollment). The enrollment record is the one device id authority; a Host that keeps its own copy compares it with the returned `deviceId`. If the server database is lost while the store survives, the refusal is `device_unknown`; if the store is lost while the server keeps devices, it is `enrollment_missing`.

A Host that polls `status().lifecycle` for `running/open` after `start()` calls `await daemon.whenOpen({ signal: AbortSignal.timeout(ms) })` instead. It rejects with `DaemonHaltError` on a halt, `DaemonNotOpenError` (`stopped` or `crashed`) when the run ended otherwise, and with `signal.reason` on abort.

## Hermes runtime adapter removed

The SDK no longer drives Hermes Agent as a runtime (#1854). These exports are
removed, with no alias and no stub:

- `HermesAdapter`, `HermesAdapterOptions`, `HermesModelSelection` and
  `HermesByokLauncher` from `@byok-sdk/client` and `@byok-sdk/client/adapters`;
- `runHermesProviderLauncher`, `parseHermesProviderLauncherRequest`,
  `hermesProviderModel`, `HERMES_PROVIDER_KEY_ENV` and
  `HermesProviderLauncherRequest` from `@byok-sdk/keys`;
- `'hermes'` from `FakeRuntimeAdapterId` in `@byok-sdk/client/testing`.

A Host that constructed `HermesAdapter` deletes that adapter and its imports,
and retires its Hermes custody launcher process. The SDK no longer creates or reads the directory
it passed as `HermesAdapterOptions.home`; the Host may delete it. The device then no longer advertises the `hermes`
harness, so enqueueing an offer with `harnessId: 'hermes'` throws
`ByokCloudError` with code `agent_capability_missing`, like an offer for any
harness the device does not advertise. `DaemonConfig` and
`createRuntimeAdapters` never had a Hermes runtime: a `runtimes.hermes` key is
reported and ignored as an unknown field, before and after this release.
Hermes as a byok MCP client (`examples/byok-mcp-server/docs/hermes.md`) is
unchanged.

The adapter code is archived at the git tag `archive/hermes-runtime-adapter`.
It comes back when upstream OAR ships a Hermes runtime, or when a product needs
the Hermes runtime; it is then restored from that tag through the OAR fork
rules of #1851.

## Release and verification checklist

- [ ] Review the final train diff and upgrade manifest for additional breaking changes; complete the pending sections above.
- [ ] Before rebaselining, re-diff the 23 items of the `dts-node-next-specifiers` manifest entry against 0.41.0: the entry carries no per-item digest, so any change beyond the `.js` specifier spelling needs its own entry (#1828).
- [ ] Run the H `unmigrated_dreams` and L `legacy_home` queries on v0.41.0; both must be 0 before the upgrade (#1669).
- [ ] Run `HostedCollaborationStore.migrate()` on every existing hosted schema, then set `setBotAutonomy(..., 'auto')` for each Bot that must keep acting on its own (#1662).
- [ ] Run `migrateWouldDo(ledger)` on each L ledger and `HostedCollaborationStore.migrate()` on each H schema; record the archived would-do count (#1756).
- [ ] Run `hostProjectionDdl(HOST_SCHEMA)` once before serving the new Worker, and watch `send.failed` in the first pass reports (#1663).
- [ ] On every hosted Postgres store, run the agent-identity count, settle live ones on v0.41.0, migrate to 0038, run `retireAgentlessTasks` and record its count, then migrate to 0039 (#1780).
- [ ] Pin the Host's direct and resolved SDK dependencies to the release graph.
- [ ] Apply the Host's backup, stop, precheck, smoke and rollback gates, adjusted to the final release.
- [ ] Check Codex retention settings and resume behavior where `agentUserContext: 'excluded'` is enabled.
- [ ] Exercise foreground and, where supported, background Pi subagents and workflows in each packaged product on its target platforms.

Documentation checks do not establish release, platform or production acceptance.

## Windows configured roots refuse links

On Windows, the SDK now refuses a configured root that passes through a symbolic link or a junction to a drive-letter path (#1759). Construction fails with `configured_path_untrusted_link`, reason `windows_link`, and the message names the link and its target. The rule covers `agentHome.hostStorageRoot`, `storeDir`, the local-state relocation roots, `storage.scratchRoot`, `storage.skillPackDataDirs` and `piByokLauncher.sessionDir`. `new AgentHomeLayout` reports it as `AgentHomeResolutionError` and relocation as `LocalStateRelocationIntegrityError`.

Before, a `hostStorageRoot` behind a link was followed silently, and relocation already refused the same root. A `storeDir` behind a link failed later in the scratch, retention or relocation checks. Subst drives, mapped network drives and mount points to a volume with a drive letter still resolve to their final path. A mount point to a volume with no drive letter is expected to fail construction. A subst or mapped drive whose backing path contains a link is still followed, because only the configured spelling is checked. POSIX keeps its trusted-link rule.

Before upgrading a Windows Host, check every configured root for a link in its existing ancestors, for example with `dir /AL` on each parent or `(Get-Item <path>).LinkType` in PowerShell. Point a linked setting at the physical directory, the link's target. Roots without a link keep their identities. Changing `storeDir` to its physical spelling changes its control pipe name and Agent-home owner id, so stop the daemon before changing it.

## Host model-route entries can declare a default thinking level

`ModelRouteHostEntry` accepts an optional `default_thinking_level` (#1856), additive. A Host that keeps its own default-level rule for a Host entry can move it onto the entry; the level must be one its `config` supports, or `modelRouteContext` throws. Entries without the field behave as before.
## In-memory device credential backend (#1844)

`@byok-sdk/client/testing` exports `InMemoryDeviceCredentialBackend`, a `DeviceCredentialBackend` held in memory. A Host that hand-rolls a memory backend for its tests deletes it and injects this one as `deviceCredentials`, so a test that builds a daemon never writes an enrollment to the Keychain or Credential Manager. No runtime Host change is required.
