# Raft Computer 1.0.45: startup design reference

## Reference identity

The current study target is the installed Raft Computer 1.0.45 arm64 package.
The installer and the executable both report 1.0.45.
The package contains a Node SEA JavaScript bundle.
Static extraction did not execute that bundle.

- Carrier SHA-256: `f4ed4b082bb292ade511d3657ed1476c886235e17296690cf4ea201ac8a78de0`.
- Main source SHA-256: `516105acf884162a9d47a1309d5c5ae183cdd6072910142947ca8caed7805517`.
- Main source: 37,801,141 bytes, starting at carrier byte offset 93,012,092.
- The [current immutable vendor carrier URL](https://hands.build/dl/raft-computer-cli/releases/ef0c7cb9-e3df-49f2-b96f-23ca0830fbdb/darwin-arm64) was resolved from the main channel on 2026-10-11. The URL was checked for availability; its bytes were not downloaded again to prove equality with the installed carrier.

The original TypeScript study copy is still the official 1.0.43 snapshot.
Its commit is `26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6`.
The public mirror does not yet supply an exact 1.0.45 source snapshot.
A minor version gap is not proof that all behavior is equal.

## Observed structures in 1.0.45

| Structure | Extracted main-source line | Observation |
| --- | --- | --- |
| AgentStartCoordinator | 794256 | One object owns starting, queued entries, queue order, capacity, and the pump timer |
| RuntimeProcessBindingFence | 795437 | Runtime bindings track process identity, launch identity, and session identity |
| planAgentInboxSideEffect | 761299 | Decisions produce structured plans and effects |
| applyAgentInboxStateMachineEffects | 763089 | A separate operation applies those effects |

These are static observations from the installed 1.0.45 bundle.
They establish that the mechanisms used in the design discussion remain present.
They do not establish full architectural or runtime equivalence with 1.0.43.
The extraction files and hashes are retained in the owner's RAFT-study workspace.
No Raft program body is included in this repository.

The older readable source links remain useful as secondary reference:

- [AgentStartCoordinator](https://github.com/botiverse/raft-source/blob/26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6/packages/daemon/src/agentStartCoordinator.ts#L53).
- [RuntimeProcessBindingFence](https://github.com/botiverse/raft-source/blob/26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6/packages/daemon/src/runtimeProcessBindingFence.ts#L89).
- [AgentInboxStateMachine](https://github.com/botiverse/raft-source/blob/26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6/packages/daemon/src/agentInboxStateMachine.ts#L116).

These links are explicitly for the 1.0.43 mirror. They are not 1.0.45 source links.

## Application to byok-sdk

Issue [352](https://github.com/Ancienttwo/byok-sdk/issues/352) extracts byok's own startup owner.
It keeps byok's runtime-start, terminal queue, context authority, and lease order.
It adds no runtime framework or public package.
The implementation moves existing byok behavior into a private module.
It does not import or copy Raft implementation code.
The owner confirmed that byok keeps its current MIT license.
No license file or manifest license field changes are needed.
