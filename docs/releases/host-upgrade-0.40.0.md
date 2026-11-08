# Host upgrade to 0.40.0

Use this checklist for a Host moving from 0.39.0 to 0.40.0. Earlier Hosts must first apply the [0.39.0 checklist](host-upgrade-0.39.0.md) and its predecessors. The source base is `f3eabd041`; pin the Host's direct and resolved SDK dependencies to the released versions in its lockfile.

## Required Host actions

- **Windows packages:** Koffi moves from 3.2.0 to 3.3.7 in client and keys. Rebuild packaged Windows native assets with `copySdkNativeAssets` and update literal pins of `sdkNativeAssetTargets` or `sdkDistributionManifest` Windows x64 version, URL, integrity and SHA256 metadata. The supported targets and signing policy are unchanged.
- **Hosted Bot storage:** H now runs full dreaming using K8's shared rules. Run the hosted example's `store.migrate()` to create the per-scope `dream_state` table before using the updated store; back up and verify rollback against the final release. Hosts vendoring K8 should copy the updated [example](../../examples/bot-collaboration/README.md#compaction). Remove uses of the removed `recordUnsupportedDream` and `DREAM_UNSUPPORTED_ON_H` exports.
- **Linux provider credentials:** The Pi provider launcher now selects `LinuxSecretServiceSecretStore`. Ensure Secret Service and `secret-tool` are available on applicable devices; unavailable service fails closed. Secrets are sent on stdin. Trusted tool resolution is available from Node-only `@byok-sdk/core/system-tool`.
- **ACP event consumers:** `tool_use` now waits for settled tool input. Update UI, authorization and event timing assumptions that relied on the initial partial input; exercise affected flows with complete input.

## Dreaming and native sessions

H uses per-scope dreaming configuration, shared model selection, instruction and pack limits, skip reasons, success-only mark advancement and compaction protection until result sync. H and L share user-first priority for unsubmitted routine, `bot_request` and dream intents; device slot reservation is unchanged. With `BotOptions.history`, marks advance only through settled history actually read; no new completed row yields `no_new_turns`. Ensure the history authority returns completed rows if the Bot should dream.

`buildDreamInstruction` now asks the model to correct outdated facts in place, keep only a one-line note to prevent repeated mistakes, delete duplicate or unhelpful content, and organize linked topic notes with an index summary for each page. Review this behavior wherever the Host uses the exported builder. Memory writer guidance also states copy limits and that ordinary fresh and resumed `on-success` writes are kept only on success.

K8 requests native-session input for the dream window when advertised; `dreaming.nativeSessions: false` disables it. Device `DaemonConfig.nativeSessions` defaults off: opt in only on macOS or Linux with a Pi memory lane and configured `sessionDir`. Both server and device must advertise `native-sessions`. Host offers may use `nativeSessions: { fromMs, toMs, ifAdvertised: true }` to omit the window when unsupported; frozen replay preserves the recorded resolution. Offers require a fresh session, `agentMemory: 'none'`, no terminal projection, and no commit, `homeAccess`, preparation, `requiredToolsets`, `messageEgress` or `harnessId`. The memory-only in-memory lane suppresses progress and result text; sanitized tool argument summaries, not tool results, are sent to the model provider. Review the privacy and platform acceptance requirements in [security](../security.md#native-session-input).

Pi's memory-lane admission consumes exactly one local `{ type: 'byok_host_ready', sessionId }` receipt per session start and requires the ID to match the native session. The receipt carries no tool provenance; do not rely on the removed provenance-confirmation contract. Unsupported offers decline before claim with `native_sessions_unsupported`, including when the device owner disables the feature after enqueue. Handle it as non-retryable for sealed tasks; plain declines use the same code. Its sealed `task.decline` row and the offer field use the two-way capability gate.

## Optional OpenCode adoption

`OpenCodeAdapter` (`harnessId: 'opencode'`) is opt-in. The platform list is empty, so OpenCode has no qualified native platform in this release; task-scoped Host MCP qualification also awaits native canaries. Check the [qualification evidence](../researches/2026-11-08-opencode-native-qualification.md) for the intended combination before offering dispatch. Configure explicit Host model candidates in `runtimes.opencode.models`; the adapter verifies native session model readback, rejects mismatches, and retries once with the next candidate on a pre-output rate limit, recording a non-terminal `model_switch` diagnostic. It does not switch after output starts.

OpenCode inherits native user context, MCP configuration and transcript storage; all isolation guarantees are false. Assess those exposures before opting in. The SDK runs the official CLI directly without a gateway or injected credentials. The SDK holds no OpenCode key; models that need one, such as OpenCode Go, take it from the device environment (login shell or `runtimeEnvironment.pass`) or OpenCode’s own native login, like other native settings; no such model is qualified in this release, and SDK key custody for OpenCode is tracked in [#1547](https://github.com/Ancienttwo/byok-sdk/issues/1547).

## Other Host-visible changes

- Use `ByokServer.tasks.activity(taskId, { after? })` and `tasks.approvalTimeline(taskId)` for tenant-bound ui-runtime replay. Both return `undefined` when no tail is retained; activity validates its cursor.
- Enqueue `agentMemoryCommit: 'on-success-if-advertised'` to resolve the commit from device capability instead of platform inference. Literal `on-success` retains its strict gate; frozen templates retain the recorded resolution. Protocol exports the shared Host offer schemas and payload types.
- Use protocol or `@byok-sdk/protocol/constants` exports `AGENT_MEMORY_MAX_FILE_BYTES` (256 KiB), `AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES` (512), and `redactSecrets` for Host prechecks and shared redaction. Existing memory validation is unchanged.
- `DaemonEvent` and `DaemonRecord` can report file-scope audit mode `memory` for the internal Pi dreaming lane; Host-configurable policies remain `home` or `workspaces`.
- `AgyAdapter` supports steer on an active turn. Handle a refused steer as an infrastructure error. Vendored OAR moves from 0.92.0 to 0.94.0.
- Pi provider errors fail the turn with a redacted diagnostic while preserving usage. dsh terminal usage now includes subagent tokens; context occupancy remains root-only. `@byok-sdk/keys` `runCommand` returns exit code 127 for signal termination or stdin errors.
- `pi-web-access` moves from 0.45.0 to 0.47.0, including optional search providers, proxy fixes, PDF text results and native temporary clone paths. `@hpke/core` moves from 1.9.0 to 1.10.0 for encryption tests, and `@modelcontextprotocol/client` from 2.3.1 to 2.4.0 in client and the MCP server example. Revalidate integrations that depend on these behaviors.

## Release and verification checklist

The train adds capability-gated native-session offer and decline wire rows; the conditional memory-commit option itself leaves the device wire unchanged. The embedded activity reads add no store format change. The train has no new `deploy/sql` migration; H's example store migration above is separate. Check the final release's wire, store, migration and rollback boundaries before use.

- [ ] Record the release commit, tag, final manifest and publication; review every final breaking entry and pin the release graph.
- [ ] Apply the backup, stop, precheck, smoke and rollback gates in the [0.39.0 checklist](host-upgrade-0.39.0.md#checklist), adjusted to the final 0.40.0 authorities.
- [ ] Walk affected flows on each target platform, including Windows packaged native assets, Linux Secret Service, and dreaming where enabled.
- [ ] Qualify each intended OpenCode OS/version and Host MCP combination before offering it; verify model readback, retry diagnostics and process cleanup.

Documentation checks do not establish release, platform or production acceptance.
