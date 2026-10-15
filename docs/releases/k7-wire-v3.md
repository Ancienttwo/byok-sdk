# K7: structured outcomes and wire major 3

Status: unreleased source change for #468. This note does not authorize a
package release or a production upgrade.

Result-document offers now carry `{mode:'result-document', contract, schema}`.
The SDK-reserved `byokagentresult` server exposes only `submit_result`, with
that frozen schema. The daemon validates and fsyncs the outcome before it
returns a staged receipt. Only a successful runtime with a staged outcome
produces `task.complete.document`; the terminal is journaled before sending.
Failure, cancellation and interruption never deliver staged audit data.
Successful completion without a submission fails non-retryably.

Remove `DaemonConfig.resultDocument` and `ResultDocumentExtractor` integrations.
Configure an Agent home and durable terminal journal, and instruct the model
to call `submit_result`. Supplying removed daemon config fields raises
`DaemonConfigFieldRemovedError` with the removed `field`. Durable Pi uses the
same validation/staging channel and no longer emits its own `{text}` document.

Prepared SummaryJobs must put the exact `terminalProjection` in both the
preparation request and offer. The preparation freezes exactly one result
tool when no Host MCP or memory tools are selected. Schema changes alter the
request and tool-manifest digests. The durable record version changes from
10 to 11; old records are refused without migration. #466's S2 fixture must
migrate to this one-tool shape before further prepared-provider measurements.
The Salesko SummaryJob migration and paid S3 measurements are separate work.

`createPostgresCloudStores` now returns a promise. Await it before constructing
the cloud. Its read-only startup fence pages through pending outbox rows and
throws `PostgresMailboxProtocolUnsupportedError` if any carries another major.
The fence runs on each composition, so per-request Worker compositions scan
all pending rows each time; account for this cost when sizing the mailbox.
There is no optional assertion or synchronous factory alias.

## Coordinated upgrade

1. On the old SDK, stop submitting new executions. Let pending server mailbox
   entries be processed and acknowledged; settle in-flight executions and
   confirm every daemon pending terminal.
2. Stop writers and retain the existing state/backup. Upgrade the embedded
   server or hosted cloud/dataplane first, then daemon clients. A Topology L
   application upgrades both sides together after draining.
3. A v2-only hello is refused by v3 and receives no offer. There is no v2
   reader, alternate result mode, or result-document capability negotiation.
4. Pending old-major SQLite rows stop startup with
   `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`; Postgres uses
   `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED`. Daemon recovery offers and pending
   terminals use `DaemonJournalProtocolUnsupportedError`. These checks do not
   rewrite or delete the old rows. Preserve the store and use the old SDK to
   finish draining, or explicitly provision a new state directory and enroll
   again under the Host's resubmission policy.

The v2 corpus and published release hashes remain immutable. The new v3
corpora prove current-decoder self-consistency and v2 rejection. The v3
release registry starts empty; cross-release compatibility remains unproven
until an actual v3 artifact is published and pinned.
