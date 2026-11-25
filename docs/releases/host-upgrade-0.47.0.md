# Host upgrade to 0.47.0

This checklist covers the 0.46.1 → 0.47.0 upgrade. Hosts on an earlier release
first follow the [0.46.0 checklist](host-upgrade-0.46.0.md) and the
[0.46.1 launchd repair instructions](v0.46.1.md#residual-boundary) where applicable.

0.47.0 keeps wire v8. Existing 0.46.1 server databases, daemon journals,
provider stores, and device pairings carry forward in place.

## Settled device capabilities (#2471)

- `@byok-sdk/client` adds `Daemon.whenCapabilitiesSettled({ signal })` and exports `DaemonCapabilitiesSettlement`, `DaemonMemoryBackendProofState`, and `DaemonDeploymentDiscoveryState`. Embedded Hosts that dispatch capability-conditional offers (such as `agentMemoryCommit: 'on-success-if-advertised'`) immediately after startup should await `daemon.whenCapabilitiesSettled({ signal })` instead of stopping at `whenOpen({ signal })` alone. `Daemon` gains a required member, so Host test doubles typed as `Daemon` must add `whenCapabilitiesSettled`. A resolved call alone does not mean rollback protection is on: treat it as on only when `result.status === 'settled' && result.capabilities.includes('agent-memory-commit-on-success')`. On `status: 'disconnected'`, or on `settled` without the flag (`memoryBackend` `unproven`, `unsupported`, `refused` or `not-configured`), wait (bounded) for the next open and call again, or decline the offer or choose an unprotected path explicitly.
- `@byok-sdk/server` projects `readonly capabilities?: readonly CapabilityFlag[]` onto `MachineInfo` (`machines.list()`) from the device's latest accepted `conn.hello` (filtered to known `CapabilityFlag` values and omitted before the first handshake).

## detect-signal-prepare-detected

- All seven built-in adapters now declare `detect(signal?: AbortSignal)`, as `RuntimeAdapter.detect` already did. An abort stops the running probe child, including `claude auth status --json` and `codex login status`, and `detect()` rejects with `signal.reason`.
- `RuntimeAdapterPrepareInput.detected` carries the offer's admission observation. Codex, OpenCode, Antigravity, Grok, and DSH reuse an available observation once if the same adapter instance made it, then launch the probed command. With a missing, copied, hand-built, foreign, or already used observation, they probe again. Claude reuses the verified invocation when available and resolves its binary directly otherwise. Pi continues to resolve its launch through the selected SDK lane. Each call to `detect()` makes a fresh observation.
- A Host adapter that wraps a built-in adapter's `prepare()` can pass the original `detected` through to reuse it. [#2469](https://github.com/Ancienttwo/byok-sdk/issues/2469)

## Decorated adapters keep fast admission detection (#2495)

- Additive. `@byok-sdk/client/adapters` exports `delegateAdmissionDetection(decorator, inner)`. A Host that wraps a built-in adapter (for example to add toolset or disposal guards) calls it once after building the wrapper. Task admission then runs the built-in's fast detection, which skips the login probe, instead of the wrapper's full `detect()`. Under delegation the wrapper's own `detect()` does not run at admission. Admission falls back to `decorator.detect` when any adapter in the chain has a reassigned or spied `detect`, or when the chain does not end at a built-in adapter with a fast path (today `ClaudeAdapter` and `CodexAdapter`). The call throws `TypeError` for a cycle, a different descriptor `id` or `versionPolicy`, or decorator `platforms` wider than the inner adapter's.
- `ClaudeAdapter`, `AgyAdapter` and `GrokAdapter` now return `prepared.detected` (`version`, `executableSource`, `versionVerdict`) when `prepare()` reuses the admission observation, as `CodexAdapter`, `OpenCodeAdapter` and `DshAdapter` already did.
- Calling `delegateAdmissionDetection` alone only removes the duplicate probe at admission. Neither the fast path nor `prepared.detected` carries `authPresent`. A Host that also wants to drop the second `detect()` inside its wrapper's `prepare()` must check the login through the prepared operation's `resolveRuntimeLaunch` (subscription selections) instead, and read the version as `prepared.detected?.version ?? (input.detected?.kind === 'available' ? input.detected.version : undefined)` (only an `available` observation has `version`).
- A wrapper's `prepare()` must pass `input.detected` to the inner `prepare()` unchanged and return the inner result's `detected`. Without it, an offer with search exposure on a non-`sdk-entry` runtime fails closed with the search-unavailable decline, and the daemon skips its post-prepare `versionVerdict` block check.

## Host ledger reader (#2474)

- Additive; no Host action required. `@byok-sdk/server/execution-core` exports `readHostLedger(path)`, which reads every tenant of a K4 Host ledger without opening it for writing, including commits still in its WAL. It reads a private copy, so the database, WAL and SHM files are not written and none is created. A Host that queries `host_ledger` with its own SQL for diagnostics or ordering can switch to it.
- Branch on `kind`. `ok` lists each tenant ordered by tenant, with `application`, `intents` and `executions`, or `corrupt_row` for a malformed row; the other rows are still returned. `absent` (`no_file`, `no_table`) means there is nothing to read. `retryable` (`snapshot_changed`, `hot_journal`) means no consistent state could be taken this time: back off and read again, and do not treat it as empty. `unreadable` (`not_a_file`, `not_sqlite`, `corrupt`, `format_unsupported`, `open_failed`) is a ledger-level error; a ledger without K4 format 1 is `format_unsupported`.

## OAR 0.131.0 (#2487)

- `DshAdapter` accepts MCP servers with stdio `env` and `type: 'http'` entries with `headers`; it used to decline them before claim. OAR mounts them in memory through the bridge. `DaemonConfig.mcpToolsets` still rejects `env` and `headers`, so this reaches the SDK's own task-scoped servers and a Host that calls the adapter directly. A failed mount fails the start, and its message goes through the credential redactor described below.
- The session credential redactor now covers the MCP servers of all six OAR adapters (Claude, Codex, Grok, Antigravity, OpenCode, DSH) with one rule (#2493). In addition to the existing credential-name, authorization-header, and URL-password rules, it registers MCP `env` and header values and bare bearer tokens that are at least eight characters long and contain a digit or a character outside letters and `/ - _ .`. The redactor matches registered values raw and with one or two levels of JSON escaping in events, start errors, and stderr. See the [known issues](v0.47.0.md#known-issues) for the limits of this rule.
- The Antigravity CLI qualified version is `1.5.16` (the default agy version policy and the `agy` runtime release record). Under the default `unqualified: 'warn'` policy, an installed 1.5.11 now gets the unqualified-version warning; update agy to clear it.
- OAR's Codex session sends the caller's sandbox on `thread/resume`. `CodexAdapter` sets `codexSandbox` as an app-server launch override (`-c sandbox_mode`) and opens with `sandboxMode: 'inherit'`, so its `thread/resume` carries no `sandbox` field and its behavior is unchanged. No Host action.
