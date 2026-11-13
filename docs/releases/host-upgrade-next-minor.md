# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Pi cache warming stops at settlement (#1949)

No configuration change is needed. Every SDK Pi RPC session now caps its settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings, instead of answering each idle `cache_warming_decision` with `stop`. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file.

## Retained records elide past the limit (#1932)

`maxRetainedBytes` (default 16 MiB) bounds only native and tool payloads. Past it the oldest are elided in place and the task keeps running. The limit also covers the native payload of a runtime request and its reply. Text and reasoning are kept whole, because the folds read them, so `maxRetainedBytes` is not a bound on total retained bytes (#2056). `ClaudeAdapterOptions` gains `maxRetainedBytes` with the same validation and default.

For Claude this is the existing behavior (since #1892). For Codex, Grok, Antigravity, OpenCode and dsh it changes: their text used to count toward the 16 MiB total and passing it failed the task with `<runtime> retained record byte budget exceeded`. That failure no longer occurs, and their text now has no byte bound.

- A task's text grows with the provider's per-turn output limit times the number of turns. A Host that needs a hard bound sets `maxDurationMs`: the offer's `limits.maxDurationMs`, or `DaemonConfig.defaultMaxDurationMs`.
- A Host that matched the failure message drops that match; it no longer occurs.
- A Host that passes no `maxRetainedBytes` needs no change.
