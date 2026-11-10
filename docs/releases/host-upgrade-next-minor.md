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

## OpenCode Host MCP toolsets

No Host configuration change is required (#1632). OpenCode now advertises `mcpToolsets: true` and passes an admitted task's Host MCP servers through ACP on session open and resume. A Host may offer configured toolsets to OpenCode using the existing toolset selection. The loopback contract exercised OpenCode 1.19.5 and 2.2.6 on macOS arm64 and Windows x64. OpenCode v2 still refuses Agent `memory-reader` tasks because its session-local appended instruction channel is unqualified.

## Bot collaboration vendoring

Hosts that vendor K8 must also copy `src/adapter-steps.ts` in Layer 2 (#1664). The local and hosted adapters use it for terminal routing, synchronous Host intent handling and Bot outcome port assembly. The hosted example now exports K8's `IntentOutcomeError` class; use that shared class for `instanceof` checks.

## Release and verification checklist

- [ ] Review the final train diff and upgrade manifest for additional breaking changes; complete the pending sections above.
- [ ] Pin the Host's direct and resolved SDK dependencies to the release graph.
- [ ] Apply the Host's backup, stop, precheck, smoke and rollback gates, adjusted to the final release.
- [ ] Check Codex retention settings and resume behavior where `agentUserContext: 'excluded'` is enabled.
- [ ] Exercise foreground and, where supported, background Pi subagents and workflows in each packaged product on its target platforms.

Documentation checks do not establish release, platform or production acceptance.
