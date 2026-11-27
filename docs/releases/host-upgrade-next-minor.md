# Host upgrade to the next MINOR

This checklist starts after the published 0.47.1 release. Hosts on an earlier
release first follow the [0.47.0 checklist](host-upgrade-0.47.0.md) and its predecessors.

## Node.js 24.22.3 minimum

The public SDK packages declare `engines.node` as `>=24.22.3`. Upgrade Node
to 24.22.3 or later on Hosts and daemon machines before installing the new
SDK. Rebuild Node SEA launchers with a supported Node executable.

## Pi 1.6.1 closure

- Re-prepare Pi inputs compiled with 1.6.0 before dispatch. The new closure
  rejects the old identity with `preparation_runtime_identity_mismatch`. Rebind
  Host accounting rulings to the new runtime identity.
- The pinned keys catalog follows pi-ai 1.6.1. If lookup for a previously
  cataloged model returns `not_in_catalog`, select an available model for
  that provider before preparing inputs. A removed ID in
  `ModelRoutePolicy.default_models` opens a new draft as manual with
  `pi_model: null` when the policy still allows that ID. Update the default to
  an available model or supply the manual Pi model configuration.
- In the Baseten catalog, `deepseek-ai/DeepSeek-V4.1-Flash-1017` and
  `deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast` lose `medium` and gain `xhigh`.
  `moonshotai/Kimi-K3.1-Pro` loses `minimal` and gains `max`. Its `xhigh` is
  explicitly disabled in 1.6.1 and was already unavailable in 1.6.0. Review
  defaults and select a supported level when choosing these catalog entries.
- Stored profiles whose catalog entry was removed or whose saved configuration
  no longer matches the entry reopen as manual. The draft retains the saved
  `pi_model` configuration and thinking level.
- Existing pi-durable 1.6.0 SQLite replicas can open in place.

## OAR 0.138.1 (#2521)

- Pass `{ allowPrintMode: true }` to `AgyAdapter.accountUsage()` to continue reading Antigravity quota. For local control IPC, include `allowPrintMode: true` in the `runtimes.usage` request. With the option omitted or false, the call returns `{ kind: 'unsupported', reason: 'print_mode_disabled' }` without starting agy. Opting in runs the `models` authentication check and `/usage` through the SDK-owned reader.
- Antigravity CLI 1.5.18 is the qualified version. Update to 1.5.18 to clear the default advisory for an older supported version. The SDK sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` for agy subprocesses.
- Codex still receives the Host's exact structured answer. The SDK scrubs the secret fields from the matching native answer echo before recording or projection.

## Suggested runtime versions (#2524)

- Import `checkSuggestedRuntimeVersion` from `@byok-sdk/client` to show an advisory for an installed runtime below OAR's suggested minimum for recent models. Pass the SDK runtime ID from the observation, such as `agy` for Antigravity. The check returns advice under that ID and uses the bundled `suggestedRuntimeVersions` snapshot by default.
- The Host may fetch `SUGGESTED_RUNTIME_VERSIONS_URL` on its own schedule, pass the decoded JSON through `parseSuggestedRuntimeVersions`, and supply a valid manifest to the check. The SDK performs the comparison offline. Compatibility floors, Host version policy, and the `required` and `available` upgrade states retain their existing meanings.

## Host-selected service tier (#2523)

- To select a tier, check for `harness-service-tier` and
  `harnesses[].capabilities.serviceTier` on the intended Codex or Claude
  harness. Set `target.serviceTier` to `fast` or `default`. Codex also accepts
  native tier IDs advertised by the chosen model.
- Set `target.serviceTierFallback: 'default'` only if the same harness also
  advertises `serviceTierFallback` and standard service is acceptable. Both
  adapters verify the applied tier before the first prompt and report it as a
  `service_tier` activity event. A device that reconnects without the required
  support declines the queued offer before starting it.
- The wire major stays at v8. Offers that omit both fields continue to use
  the runtime's configured tier.

## OAR 0.136.0 (#2512, #2513)

- `OpenCodeAdapter.listModels()` on OpenCode 2.x reads the catalog from a private `opencode serve --stdio` loopback listener instead of `opencode models --standalone`. Entries now carry `displayName`, `provider` and `effortLevels`, and a cold catalog no longer comes back id-only. The listener is stopped when the read ends, is cancelled or times out. On OpenCode 1.x and 2.x, `effortLevels` no longer lists the native `default` variant. No Host action.
- `AgyAdapter.accountUsage()` window labels drop agy's trailing "Remaining" (`Shared · Weekly Limit Remaining` becomes `Shared · Weekly Limit`), because the window reports a used ratio. A Host that matches on the old label text must update it.
- `ClaudeAdapter` declines an MCP elicitation request (`form` or `url`) at once. Before, it hung an unattended task and ended a task with `nativeInteractions` as an unknown native request. Other unknown native requests still end the task.
- With `nativeInteractions`, `CodexAdapter` launches Codex with `-c features.default_mode_request_user_input=true`, so structured questions reach the Host outside plan mode. The qualified version stays 0.169.0.
  With `nativeInteractions` configured, `prepare()` rejects Codex versions below 0.107.0 or unrecognized version output with `runtime_unavailable`.
