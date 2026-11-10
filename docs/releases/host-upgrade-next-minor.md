# Host upgrade to the next MINOR

Draft checklist for a Host moving from the current release to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

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
SELECT tenant_id, recorded_at,
       json_extract(j, '$.deviceId') AS device_id,
       json_extract(j, '$.payload.agentRef.agentId') AS agent_id
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

For each Q1 row, find exactly one Q2 row with the same tenant and `device_id`, whose `json_extract(agent_ref_json, '$.agentId')` equals Q1's `agent_id`. If a match is missing or ambiguous, resolve it before upgrading. For each matched task, call `byok.tasks.abandon(taskId, 'operator')` through the old Host, then upgrade and dispatch with a new task id. These offers never reached the device; do not use `cancel` for this cleanup. Do not replay the old recorded offer with the newly omitted `runtime` bytes.

## OpenCode Host MCP toolsets

No Host configuration change is required (#1632). OpenCode now advertises `mcpToolsets: true` and passes an admitted task's Host MCP servers through ACP on session open and resume. A Host may offer configured toolsets to OpenCode using the existing toolset selection. The loopback contract exercised OpenCode 1.19.5 and 2.2.6 on macOS arm64 and Windows x64. OpenCode v2 still refuses Agent `memory-reader` tasks because its session-local appended instruction channel is unqualified.

## Release and verification checklist

- [ ] Review the final train diff and upgrade manifest for additional breaking changes; complete the pending sections above.
- [ ] Pin the Host's direct and resolved SDK dependencies to the release graph.
- [ ] Apply the Host's backup, stop, precheck, smoke and rollback gates, adjusted to the final release.
- [ ] Check Codex retention settings and resume behavior where `agentUserContext: 'excluded'` is enabled.
- [ ] Exercise foreground and, where supported, background Pi subagents and workflows in each packaged product on its target platforms.

Documentation checks do not establish release, platform or production acceptance.
