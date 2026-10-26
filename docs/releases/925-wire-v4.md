# #925: wire major 4

Status: unreleased source change for #925 stage 1. This note does not
authorize a package release or a production upgrade.

Wire v4 removes the offers that carried no Agent identity and the approval
paths kept for pre-M5 peers. A v3 envelope is rejected. There is no v3
reader and no capability negotiation between the two majors.

## What changes on the wire

- Every offer is Agent-bound. `conn.ack`, `task.offer`,
  `task.offer_with_toolsets`, `task.offer_sealed` and
  `task.offer_with_toolsets_sealed` are gone. The long-poll response carries
  the server's capabilities, as it already did.
- `approvalId` is required on `task.await_approval`, `task.approve` and
  `task.reject`. A decision resolves only the approval it names; one that
  names no pending approval is stale and resolves nothing.
- `task.approval_resolved` is baseline. The daemon reports every approval it
  resolves locally. The server learns of a local resolution only from that
  report: progress or an artifact while a task awaits approval is applied,
  and the task keeps awaiting approval.
- The `strict-agent-only` and `approval_resolved` capability flags and the
  approval-targeting flag are removed.

## Host and daemon API

- `ByokServer.dispatch` resumes an Agent session and needs `agentRef` and
  `sessionRef`. Start fresh work with `executions.submit`. `executions.submit`
  returns no `TaskHandle`; read the task with `tasks.get`, cancel it with
  `tasks.cancel`. `TaskHandle.approve`, `reject` and `steer` exist only on a
  dispatched resume. A Host that approved or steered a fresh task through the
  removed legacy `dispatch` must now resume the session with `dispatch` to
  get a handle, or let the device resolve the approval locally.
- The daemon runs Agent offers only. Configure `DaemonConfig.agentHome`; a
  daemon without one declines every offer. `DaemonConfig.strictAgentOnly` is
  removed and raises `DaemonConfigFieldRemovedError`. `workspaceRoot` is no
  longer required.
- `Daemon.approve` and `Daemon.reject` take `{ approvalId }`.
- Runtime adapters take `RuntimeTaskInput` from `@byok-sdk/client`. The wire
  type `TaskOfferPayload` is removed.

## Stored v3 receipts

The kernel keeps two receipt families that hold wire bytes and never expire:
offer receipts (`task-offer:<messageId>`, `{ deviceId, type, payload }`) and
terminal receipts (`task:<taskId>:terminal`, a v3 envelope). A v4 server
reads only v4 bytes. Unmigrated receipts break task readback: `tasks.get`,
`tasks.list`, `tasks.offer` and `tasks.deviceTerminal` read them through the
offer and terminal projections.

The one-shot migration maps every receipt with one table,
`WIRE_V3_TO_V4_TYPES` (`@byok-sdk/protocol`).
`migrateWireV3Receipt(kind, body)` (`@byok-sdk/cloud`) returns `unchanged`,
`migrated` (a terminal is re-encoded with the v4 `encodeEnvelope`, so its
bytes and hash change) or `refused`. A run that refuses any receipt changes
nothing and throws `WireV4ReceiptMigrationError`, which lists each refused
receipt. An offer receipt of a removed offer type cannot be migrated.
`migratePostgresReceiptsToWireV4(pool)` (`@byok-sdk/cloud-dataplane`) runs it
over `device_request_receipts` in one transaction.
`migrateSqliteReceiptsToWireV4(path)` (`@byok-sdk/server`) runs it over a
stopped embedded store's `request_receipt` table; it takes the file's exclusive
ownership, so it fails while a server owns the file. The migration ships in
0.31.x only and is removed in the next minor.

## Coordinated upgrade

1. On the old SDK, stop submitting new work. Let pending server mailbox
   entries be processed and acknowledged; settle in-flight executions and
   confirm every daemon pending terminal.
2. Stop writers and keep a backup of the existing state.
3. Run the receipt migration against the stopped store. If it refuses, the
   store is unchanged; decide what to do with the listed receipts before
   running it again.
4. Start the v4 embedded server or hosted cloud, then v4 daemon clients. A
   Topology L application upgrades both sides together.

Pending v3 mailbox rows still stop startup with the existing wire-major
fences (`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`,
`POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED`,
`DaemonJournalProtocolUnsupportedError`). These checks do not rewrite or
delete rows.

## Compatibility evidence

The v2 and v3 corpora and registries are read-only. The new v4 corpora prove
current-decoder self-consistency. Published 0.30.2, the last v3 release, is
the rejection oracle: it rejects every v4 envelope. The v4 release registry
starts empty, so cross-release compatibility stays unproven until a v4
release is published and pinned.
