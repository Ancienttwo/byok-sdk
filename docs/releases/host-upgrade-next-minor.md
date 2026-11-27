# Host upgrade to the next MINOR

This checklist starts after the published 0.47.1 release. Hosts on an earlier
release first follow the [0.47.0 checklist](host-upgrade-0.47.0.md) and its predecessors.

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

## OAR 0.136.0 (#2512, #2513)

- `OpenCodeAdapter.listModels()` on OpenCode 2.x reads the catalog from a private `opencode serve --stdio` loopback listener instead of `opencode models --standalone`. Entries now carry `displayName`, `provider` and `effortLevels`, and a cold catalog no longer comes back id-only. The listener is stopped when the read ends, is cancelled or times out. On OpenCode 1.x and 2.x, `effortLevels` no longer lists the native `default` variant. No Host action.
- `AgyAdapter.accountUsage()` window labels drop agy's trailing "Remaining" (`Shared · Weekly Limit Remaining` becomes `Shared · Weekly Limit`), because the window reports a used ratio. A Host that matches on the old label text must update it.
- `ClaudeAdapter` declines an MCP elicitation request (`form` or `url`) at once. Before, it hung an unattended task and ended a task with `nativeInteractions` as an unknown native request. Other unknown native requests still end the task.
- With `nativeInteractions`, `CodexAdapter` launches Codex with `-c features.default_mode_request_user_input=true`, so structured questions reach the Host outside plan mode. The qualified version stays 0.169.0.
  With `nativeInteractions` configured, `prepare()` rejects Codex versions below 0.107.0 or unrecognized version output with `runtime_unavailable`.
