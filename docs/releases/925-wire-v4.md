# #925: wire major 4

Status: unreleased source change for #925, stages 1 and 2. Both ship in
0.31.0, with no release between them. This note does not authorize a package
release or a production upgrade.

Wire v4 removes the offers that carried no Agent identity and the approval
paths kept for pre-M5 peers, merges the Agent offer types into one
`task.offer`, and turns each `*_sealed` type into a payload branch of its
plaintext type. A v3 envelope is rejected. There is no v3 reader and no
capability negotiation between the two majors.

## What changes on the wire

- Every offer is Agent-bound. `conn.ack` and the runtime-only offers (the
  v3 `task.offer`, `task.offer_with_toolsets`, `task.offer_sealed` and
  `task.offer_with_toolsets_sealed`) are gone; v4 reuses the name
  `task.offer` for the merged Agent offer (below). The long-poll response
  carries the server's capabilities, as it already did.
- `approvalId` is required on `task.await_approval`, `task.approve` and
  `task.reject`. A decision resolves only the approval it names; one that
  names no pending approval is stale and resolves nothing.
- `task.approval_resolved` is baseline. The daemon reports every approval it
  resolves locally. The server learns of a local resolution only from that
  report: progress or an artifact while a task awaits approval is applied,
  and the task keeps awaiting approval.
- The `strict-agent-only` and `approval_resolved` capability flags and the
  approval-targeting flag are removed.
- An Agent offer with `harnessId` needs the device's `custom-harness` flag,
  as the removed offers did; a declared harness inventory alone is no longer
  enough. Bundled daemons always advertise the flag. A third-party daemon
  that declares harnesses without it has such offers refused.
- One offer type. `task.offer_for_agent`, `task.offer_for_agent_with_egress`,
  `task.offer_for_agent_with_egress_fresh`, `task.offer_prepared` and the
  three `task.offer_for_agent*_sealed` types are one `task.offer`. It carries
  a required `session`: `{ mode: 'resume', sessionRef }` or
  `{ mode: 'fresh' }`. `sessionRef` is 1 to 512 characters; v3
  `task.offer_for_agent` accepted any string. A prepared offer is the one with
  `preparation`; it has no `instruction`, is fresh, needs `egressPolicy`, and
  selects a prepared `agentMemory` mode. A fresh offer needs `egressPolicy`,
  `messageEgress` needs `egressPolicy`, and `routineRef` appears only on a
  fresh sealed offer. A fresh offer without `egressPolicy` can no longer be
  expressed (it was a `task.offer_for_agent` without `sessionRef`).
- Sealed is a payload branch. `task.steer_sealed` and the seven sealed task
  outputs (`task.decline_sealed`, `task.progress_sealed`,
  `task.artifact_sealed`, `task.await_approval_sealed`,
  `task.complete_sealed`, `task.fail_sealed`, `task.cancelled_sealed`) are
  their plaintext type with a `sealed` member, and a sealed offer is a
  `task.offer` with `sealing` (a task that seals only its output has
  `sealing` and no `sealed`). The payload of each branch is unchanged. A
  sealed offer's ciphertext is bound to family `task.offer`; a sealed steer or
  output keeps its plaintext type as family. A prepared offer is never sealed.
- `EnvelopeSchema` has 28 branches (47 in v3).
- Both offer branches are strict, and so is every nested control object,
  `limits` included, except the shared `BlobRef` inside an `instruction`
  blob reference. A daemon that does not know an offer field stops its
  cursor instead of stripping it.
- A daemon checks the offer's gates itself. Before it opens a sealed offer
  or starts anything, it computes the flags the offer needs and declines it
  non-retryably when its own `conn.hello` lacks one, with `reason`
  `offer_capability_missing: this daemon does not advertise <flags>`. A task
  whose `sealing` includes `task-output` is declined with the existing sealed
  code `sealed_key_unavailable` instead, and the missing flags appear only in
  the device log. There is no new decline code.
- Admission: the gates of the v3 Agent offer types are field and value rows
  on `task.offer` (`docs/protocol.md`, Freeze rule). The only difference from
  0.30.2 besides `harnessId` above: a prepared offer also needs
  `agent-memory-selection`. A daemon advertises it together with
  `agent-home-contract`, so a device that took prepared offers before still
  does. No other flag became baseline: the flags a daemon advertises with
  `agent-home-contract` and the egress flags stay gates.

## Host and daemon API

- `ByokServer.dispatch` resumes an Agent session and needs `agentRef` and
  `sessionRef`. Start fresh work with `executions.submit`. `executions.submit`
  returns no `TaskHandle`; read the task with `tasks.get`, cancel it with
  `tasks.cancel`, and decide its pending approval with `tasks.approve` or
  `tasks.reject` (the same path and refusals as `TaskHandle.approve` and
  `reject`). Steering needs a `TaskHandle`, which only a dispatched resume
  returns.
- A Host that moves fresh work from `dispatch` to `executions.submit` has no
  per-task event stream for it yet. `TaskHandle.events()` carried the
  task's Agent events, artifacts and approval requests; for a submitted task,
  `byok.events.subscribe()` reports only `task.created` and `task.state`, and
  `tasks.get` reads the current snapshot. Progress and artifact events are not
  available for submitted tasks at this commit; #1022 adds a per-task event
  stream in 0.31.0.
- `dispatch` refusals come from the Agent lane: an unknown or revoked device
  is `agent_capability_missing` (was `device_not_found`), and an existing
  taskId is `agent_task_already_exists` (was `coordination_input_invalid`).
  Update any Host code that matches on the old codes.
- The daemon runs Agent offers only. Configure `DaemonConfig.agentHome`; a
  daemon without one declines every offer. `DaemonConfig.strictAgentOnly` is
  removed and raises `DaemonConfigFieldRemovedError`.
- Git workspace mode is removed. `DaemonConfig.gitWorkspace`,
  `DaemonOverrides.gitWorkspace` and `DaemonConfig.workspaceRoot` raise
  `DaemonConfigFieldRemovedError`; delete them from the daemon config. The
  `byok-agent workspaces` command is gone, and the `workspace` retention
  class leaves `ProtectedClassId` and `RetentionClassId`. The daemon leaves
  `<storeDir>/git-workspaces.json` and old task directories untouched.
- Latest-value Agent activity no longer coalesces `error` events. Every
  event still passes the egress bounds; each accepted `error` of a progress
  batch is sent, and the other events coalesce to their last. Every v4 fresh
  offer runs with egress, so this keeps a daemon artifact refusal or upload
  failure from being replaced by the runtime's next event.
- `Daemon.approve` and `Daemon.reject` take `{ approvalId }` and report the
  decision to the server as `task.approval_resolved`.
- Runtime adapters take `RuntimeTaskInput` from `@byok-sdk/client`:
  `instruction` (required), `runtime`, `harnessId`, `dispatchSelection`,
  `limits`, and `sessionRef` only when the offer resumes. `TaskOfferPayload`
  is now the wire type of `task.offer` (plaintext or sealed branch), not the
  adapter input.
- byok-mcp-server (example) runs every task as the key's Agent. A
  `tasks.dispatch` key without an AgentRef fails authentication with
  `invalid_input`; revoke it and issue a new key with one. A device runs one
  task of a key at a time, whatever the key's `runningTasks` quota allows.

## Host code: offer and sealed types

A Host that only calls `ByokServer.dispatch()` and does not read offers or
terminal envelopes only recompiles: `dispatch` writes the payload itself. Any
other Host changes its code:

- Compare `type === 'task.offer'` instead of the Agent offer type names or
  `isTaskOfferType`. Compare the plaintext type instead of a `*_sealed` type,
  then tell the branch apart with `payload.sealed !== undefined`
  (`payload.sealing !== undefined` on `task.offer`) or
  `isSealedPayload(type, payload)`. Narrow before reading a plaintext field
  such as `summary`, `events`, `inline` or `reason`:
  `MESSAGE_PAYLOAD_SCHEMAS['task.complete']` and the other sealable types are
  unions, and so are `TaskCompletePayload` and its siblings.
- Write `session` in every offer payload you submit:
  `{ mode: 'resume', sessionRef }` where you set `sessionRef` before, and
  `{ mode: 'fresh' }` on `submitAgentExecution` / `executions.submit`,
  `submitSealedAgentExecution` and `enqueuePreparedOffer`. Each lane keeps its
  method (`enqueueAgentOffer`, `enqueueAgentEgressOffer`,
  `enqueuePreparedOffer`, `submitAgentExecution`, `enqueueSealedAgentOffer`,
  `enqueueSealedAgentEgressOffer`, `submitSealedAgentExecution`) and refuses
  a `session` that does not fit it. The payload you submit is the wire
  payload, so the offer read back is equal to it.
- `TaskOfferReadback.type` (`readTaskOffer`, `tasks.offer`) is always
  `'task.offer'`. `DeviceTerminal.envelope.type` (`readDeviceTerminal`,
  `tasks.deviceTerminal`) is one of `task.complete`, `task.fail`,
  `task.decline` and `task.cancelled`; a sealed terminal has `payload.sealed`.
- A member that seals an offer itself binds family `'task.offer'`. A routine
  template keeps family `routine.template`, so stored templates still open.

`@byok-sdk/protocol` removed and replaced these exports:

| Removed | Use |
| --- | --- |
| `TaskOfferForAgentPayloadSchema`, `TaskOfferForAgentWithEgressPayloadSchema`, `TaskOfferForAgentWithEgressFreshPayloadSchema`, `TaskOfferPreparedPayloadSchema` and their payload types | `TaskOfferPayloadSchema` / `TaskOfferPayload` (both branches), `TaskOfferPlainPayloadSchema` / `TaskOfferPlainPayload` |
| `TaskOfferForAgentSealedPayload`, `TaskOfferForAgentWithEgressSealedPayload`, `TaskOfferForAgentWithEgressFreshSealedPayload` | `TaskOfferSealedPayloadSchema` / `TaskOfferSealedPayload` |
| `TASK_OFFER_TYPES`, `isTaskOfferType`, `TaskOfferType` | `type === 'task.offer'` |
| `isSealedMessageType`, `SealedMessageType` | `isSealedPayload(type, payload)`, `isSealableMessageType`, `SealableMessageType` |

New: `SessionSelectionSchema` / `SessionSelection` and
`TaskSteerSealedPayloadSchema`. The `Task*SealedPayload` types of `task.steer` and the
outputs stay, as the sealed branch types. `SEALED_SPLIT_TABLE` is keyed by the
plaintext type (`task.offer`, `task.steer` and the seven outputs); it has no
`plainType`, and its new `marker` (`sealing` or `sealed`) names the field that
picks the sealed branch. Its `task.offer` entry forbids `preparation`.

## Stored v3 state

There is no migration. Offer and terminal receipts and mailbox rows hold wire
bytes, and a v4 build reads only v4 bytes. A store a v3 build wrote, embedded
SQLite or hosted Postgres, is not supported: start v4 on a new store. The
owner chose this on 2026-10-27 because no deployment holds wire v3 data.

Pending v3 mailbox rows stop startup with the existing wire-major fences
(`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`, `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED`,
`DaemonJournalProtocolUnsupportedError`). These checks do not rewrite or
delete rows.

## Coordinated upgrade

1. Drain the v3 deployment: stop new submissions, let every pending mailbox
   row be processed and acknowledged, every in-flight execution reach a
   terminal, and every daemon pending terminal be acknowledged by the server.
2. Stop the v3 Host and the v3 daemons.
3. Start the v4 embedded server or hosted cloud on a new store, then the v4
   daemon clients. A Topology L application upgrades both sides together.

A Host that keeps offer inputs of its own, for example a ledger of frozen
payloads it submits again or compares with the offer it reads back, holds
v3 shapes: no `session`, and old type names. A v4 lane refuses them, and a
comparison with the v4 read-back fails. Start such a ledger afresh as well.

For AiphaBee and any other Host built on `examples/host-execution-core`:

- Vendor host-execution-core again from 0.31.0. The vendored copy is pinned
  byte for byte, and its offer model and frozen-offer comparison name the v3
  types.
- Add `session: { mode: 'fresh' }` wherever the Host builds an execution
  payload itself, test fixtures included.
- Start the K4 ledger afresh. A frozen v3 input fails the v4 schema on
  submit, and its delivered check reads back a v4 offer that differs from it.

## Compatibility evidence

The v2 and v3 corpora and registries are read-only. The new v4 corpora prove
current-decoder self-consistency. Published 0.30.2, the last v3 release, is
the rejection oracle: it rejects every v4 envelope. The v4 release registry
starts empty, so cross-release compatibility stays unproven until a v4
release is published and pinned.
