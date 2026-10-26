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
  `tasks.cancel`, and decide its pending approval with `tasks.approve` or
  `tasks.reject` (the same path and refusals as `TaskHandle.approve` and
  `reject`). Steering needs a `TaskHandle`, which only a dispatched resume
  returns.
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
- `Daemon.approve` and `Daemon.reject` take `{ approvalId }` and report the
  decision to the server as `task.approval_resolved`.
- Runtime adapters take `RuntimeTaskInput` from `@byok-sdk/client`. The wire
  type `TaskOfferPayload` is removed.
- byok-mcp-server (example) runs every task as the key's Agent. A
  `tasks.dispatch` key without an AgentRef fails authentication with
  `invalid_input`; revoke it and issue a new key with one. A device runs one
  task of a key at a time, whatever the key's `runningTasks` quota allows.

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
  sent again and stay until retention removes them. An expired dead letter
  also stays: `replayDeadLetter` decodes it under v4 and refuses its v3
  bytes with `cleanup_invalid_input`, and `discardDeadLetter` drops it.

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

## Compatibility evidence

The v2 and v3 corpora and registries are read-only. The new v4 corpora prove
current-decoder self-consistency. Published 0.30.2, the last v3 release, is
the rejection oracle: it rejects every v4 envelope. The v4 release registry
starts empty, so cross-release compatibility stays unproven until a v4
release is published and pinned.
