# Host upgrade to the next MINOR

Draft checklist for a Host moving from the current release to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

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

## Bot collaboration vendoring

Hosts that vendor K8 must also copy `src/adapter-steps.ts` in Layer 2 (#1664). The local and hosted adapters use it for terminal routing, synchronous Host intent handling and Bot outcome port assembly. The hosted example now exports K8's `IntentOutcomeError` class; use that shared class for `instanceof` checks.

H vendors also receive one outbox projection row per stored inbound destination from sync; an unchanged destination reuses its projection row (#1664 PR-3b).

## Doctor names a refused control endpoint

No Host configuration change is required (#1688). When the daemon refuses its control endpoint with `private_dir_symlink`, `private_dir_not_directory`, `private_dir_foreign_owner`, `private_dir_mode`, `socket_path_not_socket` or `socket_mode`, it keeps running without the endpoint and records the code and path under a `controlEndpoint` key in `operational-health.json`. The key exists only while the endpoint is refused; the next successful bind removes it. `byok-agent doctor` then reports `control endpoint refused: <code> <path>` instead of `daemon offline`. `OperationalHealthFileInspection` gains an optional `controlEndpointRefusal` on its `valid` branch. An older daemon reads a health file that still has this key as corrupt, so downgrade only after a daemon run that bound its endpoint.

## Runtime environment lanes in doctor

No Host configuration change is required (#1688). `RuntimeEnvironmentReport` gains an optional `lanes` list of `RuntimeEnvironmentLaneReport`, also carried by the `runtimes.environment` control method and `byok-agent doctor`. The Pi adapter reports a `pi-prepared` lane unless it is a durable adapter, and a `pi-keys-profile` lane when a BYOK launcher is configured; the Hermes adapter reports a `hermes-custody` lane when a BYOK launcher is configured. An `sdk` lane lists the names its launch removes; the `pi-keys-profile` lane says only that the keys launcher passes its fixed names. A Host that sets `runtimeEnvironment.pass` names such as `PI_OFFLINE` can read there which lanes never give them to the runtime. No lane narrows differently than before. A Host that builds a `RuntimeEnvironmentReport` itself may omit `lanes`.

## Bot collaboration autonomy and missing ports

K8 rules now build the Bot autonomy gate themselves (#1665). A Host adapter that builds its own `OutcomePorts` removes the `autonomy` member; a direct caller of `applySpeech` or `applyDelegate` passes an `AutonomyGate`. A refusal for a missing Host port is now `MissingPortError` from `rules/commands.ts`, with `code` `missing_port` and the port `kind`; the message text is unchanged, so match on `code` instead of the message.

## Version policy source

The eight built-in adapter option types (`AgyAdapterOptions`, `ClaudeAdapterOptions`, `CodexAdapterOptions`, `DshAdapterOptions`, `GrokAdapterOptions`, `HermesAdapterOptions`, `OpenCodeAdapterOptions`, `PiAdapterOptions`) no longer accept the internal `versionPolicySource` option (#1682). A Host that constructs an adapter directly deletes `versionPolicySource` from the options object. `versionPolicy` itself, `DaemonConfig.runtimes.<id>.versionPolicy` and the version verdicts they produce are unchanged: a Host policy still replaces the descriptor default wholesale.

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

## Isolated service lifecycle gate root

No Host change is required (#1732). `CreateServiceLifecycleOptions` gains an optional `gateRoot`. On macOS, install, repair and uninstall then hold the `service-lifecycle` gate in that directory instead of `/tmp/byok-pm-<uid>`, so tests or parallel consumers can drive separate lifecycles without refusing each other with `lifecycle_owner_busy`. Lifecycles exclude each other only when they use the same root, so production code should omit it. Only the lifecycle's gate moves: `claimServiceLifecycleOwner`, `releaseServiceLifecycleOwner` and `localStateRelocation` still lock the default root, so a lifecycle on a `gateRoot` no longer excludes them. The root must be an absolute path and gets the same check as the default root. An absent root is created with mode 0700. A gateRoot owned by the process user is set to 0700; a symlink, non-directory or foreign-owned path is refused. The refusal's code is `private_dir_symlink`, `private_dir_not_directory` or `private_dir_foreign_owner`, and `private_dir_mode` when the root cannot be set to 0700. The check covers the root itself, not a swap of its parent, so choose a root whose parent directory other users cannot write. The option takes effect on macOS only: Linux and Windows ignore it, a relative path included, because their gate is an abstract socket or a named pipe with no filesystem root.

## Bot collaboration cancel results

The hosted `HostedCommandEntry.cancelTurn` and `cancelDelegation` return `TurnCancelResult` and `DelegationCancelResult` instead of `void` (#1666), as the local Host does. A cancel returns `cancelled` when it committed, `cancel_pending` when an earlier cancel has no terminal yet, and `already_settled` when the target had ended; the last two write nothing and send no second K4 cancel. Cancelling an ended delegation no longer throws: it returns `already_settled` with the `verdict`. A refused delegation cancel throws `DelegationError` with `code` `unknown_delegation` or `not_cancellable` (end a `reply_held` or `uncertain` delegation with `abandonDelegation`). `DelegationError` and both result types are exported from `@byok-sdk/example-hosted-bot-collaboration` and from K8 `rules/delegation`.

## Bot collaboration switch contract

The owner switch records and errors are defined once, in `@byok-sdk/example-bot-collaboration/migration` (#1667): `SwitchHeader`, `SwitchReceipt`, `SwitchExportMark`, `exportMarkOf`, `SwitchExportedError`, `SwitchImportedError` and `DeviceSwitchingError`. The roots of both packages still export the classes and `SwitchReceipt` (and the hosted root `SwitchExportMark`), but the local `./switch` and `./topology` modules and the hosted `./switch` and `./binding` modules no longer do; a deep import moves to `./migration`. `DeviceSwitchingError` takes `target: 'L' | 'H'`. The messages of `SwitchExportedError`, `SwitchImportedError` and `DeviceSwitchingError` changed and their `code` values did not, so match on `code`. The local `refuseImported` now throws `SwitchImportedError` (`switch_imported`) instead of a plain `Error`.

## Release and verification checklist

- [ ] Review the final train diff and upgrade manifest for additional breaking changes; complete the pending sections above.
- [ ] Pin the Host's direct and resolved SDK dependencies to the release graph.
- [ ] Apply the Host's backup, stop, precheck, smoke and rollback gates, adjusted to the final release.
- [ ] Check Codex retention settings and resume behavior where `agentUserContext: 'excluded'` is enabled.
- [ ] Exercise foreground and, where supported, background Pi subagents and workflows in each packaged product on its target platforms.

Documentation checks do not establish release, platform or production acceptance.
