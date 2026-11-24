# Host upgrade to the next MINOR

This checklist starts after the published 0.46.0 release. Hosts on an earlier release first follow the
[0.46.0 checklist](host-upgrade-0.46.0.md) and its predecessors.

## Settled device capabilities (#2471)

- `@byok-sdk/client` adds `Daemon.whenCapabilitiesSettled({ signal })` and exports `DaemonCapabilitiesSettlement`, `DaemonMemoryBackendProofState`, and `DaemonDeploymentDiscoveryState`. Embedded Hosts that dispatch capability-conditional offers (such as `agentMemoryCommit: 'on-success-if-advertised'`) immediately after startup should await `daemon.whenCapabilitiesSettled({ signal })` instead of stopping at `whenOpen({ signal })` alone. `Daemon` gains a required member, so Host test doubles typed as `Daemon` must add `whenCapabilitiesSettled`. A resolved call alone does not mean rollback protection is on: treat it as on only when `result.status === 'settled' && result.capabilities.includes('agent-memory-commit-on-success')`. On `status: 'disconnected'`, or on `settled` without the flag (`memoryBackend` `unproven`, `unsupported`, `refused` or `not-configured`), wait (bounded) for the next open and call again, or decline the offer or choose an unprotected path explicitly.
- `@byok-sdk/server` projects `readonly capabilities?: readonly CapabilityFlag[]` onto `MachineInfo` (`machines.list()`) from the device's latest accepted `conn.hello` (filtered to known `CapabilityFlag` values and omitted before the first handshake).

## detect-signal-prepare-detected

- Additive; no Host action required. Every built-in adapter class (`ClaudeAdapter`, `CodexAdapter`, `OpenCodeAdapter`, `PiAdapter`, `AgyAdapter`, `GrokAdapter`, `DshAdapter`) now declares `detect(signal?: AbortSignal)`, as `RuntimeAdapter.detect` already did. An abort stops the running probe child, including `claude auth status --json` and `codex login status`, and `detect()` rejects with `signal.reason`.
- `RuntimeAdapterPrepareInput.detected` carries the offer's own admission observation. The daemon fills it on every offer. A built-in adapter's `prepare()` reuses it, without another `--version` or `--help` probe, when it names the executable the adapter resolves at prepare time. It probes afresh when the field is absent or names another executable. `detect()` itself still observes freshly on every call.
- A Host adapter that wraps a built-in adapter's `prepare()` can pass `detected` through to drop its duplicate probe. A Host adapter that ignores the field keeps its current behavior. [#2469](https://github.com/Ancienttwo/byok-sdk/issues/2469)
