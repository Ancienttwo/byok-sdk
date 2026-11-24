# Host upgrade to the next MINOR

This checklist starts after the published 0.46.0 release. Hosts on an earlier release first follow the
[0.46.0 checklist](host-upgrade-0.46.0.md) and its predecessors.

## Settled device capabilities (#2471)

- `@byok-sdk/client` adds `Daemon.whenCapabilitiesSettled({ signal })` and exports `DaemonCapabilitiesSettlement`, `DaemonMemoryBackendProofState`, and `DaemonDeploymentDiscoveryState`. Embedded Hosts that dispatch capability-conditional offers (such as `agentMemoryCommit: 'on-success-if-advertised'`) immediately after startup should await `daemon.whenCapabilitiesSettled({ signal })` instead of stopping at `whenOpen({ signal })` alone. `Daemon` gains a required member, so Host test doubles typed as `Daemon` must add `whenCapabilitiesSettled`. A resolved call alone does not mean rollback protection is on: treat it as on only when `result.status === 'settled' && result.capabilities.includes('agent-memory-commit-on-success')`. On `status: 'disconnected'`, or on `settled` without the flag (`memoryBackend` `unproven`, `unsupported`, `refused` or `not-configured`), wait (bounded) for the next open and call again, or decline the offer or choose an unprotected path explicitly.
- `@byok-sdk/server` projects `readonly capabilities?: readonly CapabilityFlag[]` onto `MachineInfo` (`machines.list()`) from the device's latest accepted `conn.hello` (filtered to known `CapabilityFlag` values and omitted before the first handshake).
