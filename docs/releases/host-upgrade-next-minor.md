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

## Host-leading Pi child commands

Hosts that send a task instruction beginning with a pi-subagents child-starting command must change those instructions before upgrading (#1642). The ordinary Pi RPC host now returns `pi_host_command_denied` for `/run` (including `--bg` and `--fork`), `/prompt-workflow`, `/subagents-refine`, `/subagents-check-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles` and `/subagents-watchdog` (including `on` and `session on`). Enabling watchdog can start a workspace language server and a model reviewer whose tools bypass session approval. The refusal applies to initial prompts, steering, follow-ups and queued input, including command aliases, and returns a failed RPC response even while a settlement handler is running.

Request the child or review through the model's `subagent` tool instead. Under `auto`, the task's normal tool authorization applies, and each workflow child must pass the nested `subagent_launch` admission. Treat a refused command as a failed task instruction and update its source; retrying the same leading command will fail again. Host text is never rewritten by the SDK.

No Host action is required if task instructions do not invoke those leading commands. `/skill:` commands, file prompt templates and other extension commands keep their behavior. A slash command appearing mid-text, in model output or in a tool result stays content. Verify a supported `subagent` tool request and a refused leading `/run` request in each Host product before rollout. See the [Pi subagents specification](../spec.md#pi-subagents) and [runtime evidence](../researches/2026-11-10-pi-host-command-gate.md).

## Pending train changes

- TODO (#1641): Document OpenCode MCP toolsets and any Host upgrade steps after the change lands.

## Release and verification checklist

- [ ] Review the final train diff and upgrade manifest for additional breaking changes; complete the pending sections above.
- [ ] Pin the Host's direct and resolved SDK dependencies to the release graph.
- [ ] Apply the Host's backup, stop, precheck, smoke and rollback gates, adjusted to the final release.
- [ ] Check Codex retention settings and resume behavior where `agentUserContext: 'excluded'` is enabled.
- [ ] Exercise foreground and, where supported, background Pi subagents and workflows in each packaged product on its target platforms.

Documentation checks do not establish release, platform or production acceptance.
