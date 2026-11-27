# Host upgrade to the next MINOR

This checklist starts after the published 0.47.1 release. Hosts on an earlier
release first follow the [0.47.0 checklist](host-upgrade-0.47.0.md) and its predecessors.

## OAR 0.136.0 (#2512, #2513)

- `OpenCodeAdapter.listModels()` on OpenCode 2.x reads the catalog from a private `opencode serve --stdio` loopback listener instead of `opencode models --standalone`. Entries now carry `displayName`, `provider` and `effortLevels`, and a cold catalog no longer comes back id-only. The listener is stopped when the read ends, is cancelled or times out. On OpenCode 1.x and 2.x, `effortLevels` no longer lists the native `default` variant. No Host action.
- `AgyAdapter.accountUsage()` window labels drop agy's trailing "Remaining" (`Shared · Weekly Limit Remaining` becomes `Shared · Weekly Limit`), because the window reports a used ratio. A Host that matches on the old label text must update it.
- `ClaudeAdapter` declines an MCP elicitation request (`form` or `url`) at once. Before, it hung an unattended task and ended a task with `nativeInteractions` as an unknown native request. Other unknown native requests still end the task.
- With `nativeInteractions`, `CodexAdapter` launches Codex with `-c features.default_mode_request_user_input=true`, so structured questions reach the Host outside plan mode. That needs Codex 0.107.0 or later; the qualified version stays 0.169.0.
