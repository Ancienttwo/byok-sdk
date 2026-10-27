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

New: `SessionSelectionSchema` / `SessionSelection`, `TaskSteerSealedPayloadSchema`
and `wireV4FormOf`. The `Task*SealedPayload` types of `task.steer` and the
outputs stay, as the sealed branch types. `SEALED_SPLIT_TABLE` is keyed by the
plaintext type (`task.offer`, `task.steer` and the seven outputs); it has no
`plainType`, and its new `marker` (`sealing` or `sealed`) names the field that
picks the sealed branch. Its `task.offer` entry forbids `preparation`.

## Stored v3 state

The kernel keeps two receipt families that hold wire bytes and never expire:
offer receipts (`task-offer:<messageId>`, `{ deviceId, type, payload }`) and
terminal receipts (`task:<taskId>:terminal`, a v3 envelope). A v4 server
reads only v4 bytes. Unmigrated receipts break task readback: `tasks.get`,
`tasks.list`, `tasks.offer` and `tasks.deviceTerminal` read them through the
offer and terminal projections.

A task offered on a removed offer type is a legacy task. It has no
AgentRef and no v4 form, so the migration deletes it instead of mapping it.
Every other receipt is mapped with one table, `WIRE_V3_TO_V4_TYPES`
(`@byok-sdk/protocol`): `migrateWireV3Receipt(kind, body)`
(`@byok-sdk/cloud`) returns `unchanged`, `migrated` (a terminal is re-encoded
with the v4 `encodeEnvelope`, so its bytes and hash change) or `refused`.

The table carries the stage 2 renames. Every v3 Agent offer type becomes
`task.offer`, and `wireV4FormOf(v3Type, payload)` derives its `session`: a
resume type turns `sessionRef` into `{ mode: 'resume', sessionRef }`, and a
fresh or prepared type gains `{ mode: 'fresh' }`. A `task.offer_for_agent`
without `sessionRef` has no v4 form and is refused `invalid_under_v4`, as is
an offer whose payload v4 would change in any other way (for example a
`limits` key the strict v4 `limits` does not have). Each other `*_sealed`
type becomes its plaintext type with the payload unchanged; a sealed terminal
receipt is re-encoded like any other.

The migration can run again. A stored `task.offer` whose payload carries an
`agentRef` is a v4 receipt: it is `unchanged` when it parses under v4. A
stored `task.offer` without an AgentRef is a v3 runtime-only offer, which
marks a legacy task.

One gap remains. A migrated sealed offer receipt keeps its ciphertext, which
is bound to the v3 offer type name as its family. Re-opening that historical
sealed offer under v4 fails, because v4 opens a sealed offer under family
`task.offer`. Nothing in the SDK opens a stored offer again.

The migration runs in two steps. Each store has its own pair:

| Store | Preflight | Migration |
| --- | --- | --- |
| Postgres (`@byok-sdk/cloud-dataplane`) | `preflightPostgresWireV4Migration(pool)` | `migratePostgresToWireV4(pool, confirmedLegacyTasks)` |
| SQLite (`@byok-sdk/server`) | `preflightSqliteWireV4Migration(path)` | `migrateSqliteToWireV4(path, confirmedLegacyTasks)` |

1. The preflight is read-only. It returns `{ legacyTasks, unmappable }`:
   each legacy task as `{ tenantId, taskId, deviceId, type }` (`type` is
   `null` when the offer receipt was never recorded), and every row the
   migration cannot carry into v4.
2. The operator reviews the list and passes `legacyTasks` back unchanged.
   In one transaction the migration deletes every row those tasks own, then
   re-encodes the remaining offer and terminal receipts. It returns
   `{ migrated, unchanged, deletedTasks }`.

The migration fails and changes nothing when:

- the confirmed list is missing or differs from what the store holds:
  `WireV4LegacyTaskListMismatchError` (code
  `wire_v4_legacy_task_list_mismatch`);
- any row is unmappable: `ReceiptMigrationUnmappableError` (code
  `wire_v4_migration_unmappable`), whose `unmappable` lists each row.

A row is unmappable when it is:

- an offer or terminal receipt with no v4 form;
- on Postgres, an approval timeline entry without the `approvalId` v4
  requires (SQLite keeps the timeline in memory). The migration never makes
  up an id;
- a pending mailbox row of a non-legacy task whose bytes are not v4. A v4
  daemon fails to decode it and its cursor stops there. Acked rows are never
  sent again and stay until retention removes them. An expired row also
  stays. On Postgres it is a dead letter: `replayDeadLetter` decodes it
  under v4 and refuses its v3 bytes with `cleanup_invalid_input`, and
  `discardDeadLetter` drops it. On SQLite nothing removes it (see
  "Expired v3 mailbox rows on SQLite" below).

Deleting a legacy task removes its offer, delivered and terminal receipts,
its mailbox rows, its Agent message admission, its `sealed-task` object
reference and its task attempt. On Postgres it also removes the approval and
activity tails, the message draft, the terminal truth object reference, the
`task.terminal` attested record and the `task-redaction:<taskId>` audit
receipt. Object bytes are left to orphan GC. The id is then free: a new
Agent task may reuse it. Inbound reads the redaction receipt as "this task
was redacted" and would release a new task's sealed artifact at once, so the
receipt cannot stay. `migratePostgresToWireV4` returns each deleted receipt
in `deletedRedactionReceipts` (`tenantId`, `taskId`, `redactedAt`, `counts`);
keep that list as the audit record. Only the Postgres store redacts tasks.
Memory-projection metering receipts stay: they are keyed by Agent and epoch,
and nothing reads them by taskId.

The SQLite pair takes the file's exclusive ownership, so it fails while a
server owns the file. Both pairs ship in 0.31.x only; 0.32.0 removes them
(#1017).

## Coordinated upgrade

1. On the old SDK, stop Host enqueues. Let the daemons receive and
   acknowledge every pending mailbox entry before you migrate; settle
   in-flight executions and confirm every daemon pending terminal.
2. Let every approval recorded without an id expire: wait
   `DEFAULT_APPROVAL_TIMELINE_TTL_MS` (10 minutes) and let maintenance
   collect the tail.
3. On Postgres, replay or discard each dead letter before the upgrade:
   replay it with `PostgresCloudCleanup.replayDeadLetter` while v3 devices
   still run if the device must still get it, or delete it with
   `discardDeadLetter`. After the upgrade a pre-v4 dead letter cannot be
   replayed; it stays until `discardDeadLetter` drops it.
4. Stop writers and keep a backup of the existing state.
5. Run the preflight, review the legacy tasks and unmappable rows, then run
   the migration with the confirmed list. If it fails, the store is
   unchanged; resolve the listed rows and start again from the preflight.
6. Start the v4 embedded server or hosted cloud, then v4 daemon clients. A
   Topology L application upgrades both sides together.

A Host that keeps offer inputs of its own, for example a ledger of frozen
payloads it submits again or compares with the offer it reads back, holds
v3 shapes: no `session`, and old type names. A v4 lane refuses them, and a
comparison with the v4 read-back fails. Let every such intent finish before
step 1, or migrate the ledger yourself with the same mapping
(`wireV4FormOf`).

For AiphaBee and any other Host built on `examples/host-execution-core`:

- Vendor host-execution-core again from 0.31.0. The vendored copy is pinned
  byte for byte, and its offer model and frozen-offer comparison name the v3
  types.
- Add `session: { mode: 'fresh' }` wherever the Host builds an execution
  payload itself, test fixtures included.
- Drain the K4 ledger: let every intent written before the upgrade end before
  step 1. A frozen v3 input fails the v4 schema on submit, and its delivered
  check reads back a v4 offer that differs from it.
- Run the receipt migration before the Host reads an old task by id.
  `tasks.get`, `tasks.offer` and `tasks.deviceTerminal` read the offer and
  terminal receipts, and fail on unmigrated v3 bytes.

Pending v3 mailbox rows also stop startup with the existing wire-major
fences (`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`,
`POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED`,
`DaemonJournalProtocolUnsupportedError`). These checks do not rewrite or
delete rows.

### Retries of messages acked before the upgrade

The migration leaves acked mailbox rows as v3 bytes. An acked row stays for
the acked retention, 1 day by default. Within it, a retry that names the
same messageId reads that row back and fails with an envelope decoding
error; nothing is delivered twice. After the retention the row is gone, and
the retry is a new message, as any retry after the retention is today.

These paths read a row back by messageId:

- Host operations: an offer (`executions.submit`, `dispatch`), an approval
  decision, a steer, a scope key package notice, and a cancellation of a task
  whose cancellation was already enqueued.
- Device reports the cloud acknowledges: a reliable Agent egress event, a
  content-read receipt and an Agent message publish.

After the upgrade steps above, such a retry follows only a Host request
that lost its response before the stop, or a daemon that stopped between
acking a mailbox row and clearing its local spool.

### Expired v3 mailbox rows on SQLite

Retention removes only acked rows. An expired row (a pending row its device
never received in time) stays: the SQLite store never deletes one and has no
`discardDeadLetter`. The two read-backs by messageId do not check a row's
state, so a v3 expired row keeps failing with an envelope decoding error for
as long as it exists. For example, a task cancelled while its device was
offline leaves an expired v3 `task.cancel` row; after the upgrade every
`tasks.cancel` retry for that task fails to decode, permanently. An offer,
approval decision or steer retried with the messageId of an expired row
fails the same way. Postgres avoids this through upgrade step 3, which
replays or discards each dead letter first; SQLite has no such step, and
these messageIds stay unusable.

## Compatibility evidence

The v2 and v3 corpora and registries are read-only. The new v4 corpora prove
current-decoder self-consistency. Published 0.30.2, the last v3 release, is
the rejection oracle: it rejects every v4 envelope. The v4 release registry
starts empty, so cross-release compatibility stays unproven until a v4
release is published and pinned.
