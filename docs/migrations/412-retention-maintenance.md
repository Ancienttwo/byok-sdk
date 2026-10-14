# Cloud retention and maintenance (#412)

This is a 0.x breaking change. Each expired-state port owns one bounded
`collectExpired(tenant, { now, limit, ...cutoffs })`, returning
`{ removed, expired, releasedBytes, more }`. Custom implementations must add it
to mailbox, presence, quota, objects, device assertion replay, receipts, nonces,
pairing codes, activity and approvals. Use the retention conformance suites.

- Replace `MailboxStore.collectRetired` and its input/result types with
  `collectExpired` / `MailboxCollectExpiredInput` / `CollectExpiredResult`.
  Collection is tenant-wide, with one shared limit for deleted acked rows and
  expired pending rows. Pending rows remain evidence; mailbox collection never
  reads or writes accounting counters and reports `releasedBytes: 0n`.
- Replace replay `deleteExpired` and public quota `expireReservations` with
  their port's `collectExpired`. Admission still expires reservations through
  the same private settlement path. Committed reservations remain identity;
  only old expired/aborted reservations are deleted.
- Replace `server.mailbox` with `await server.maintenance.runNow()`. Configure
  policy and interval at construction. The server always schedules maintenance
  (5 minutes ±20%, limit 500 by default), joins concurrent calls, and waits for
  the pass to settle before closing storage. There is no disable flag.
- Hosted cron/alarm calls `cloud.runMaintenance({ tenant, now, policy, limit })`.
  Read/write tenant policy through `PostgresRetentionPolicyStore` exported from
  `@byok-sdk/cloud-dataplane/runtime`. Missing policy fails closed. Delete calls
  to `PostgresCloudCleanup.runTenant` and its policy methods; there is no alias.
  Dead-letter operations, reconciliation and usage rebuild remain operator APIs.
- All SDK receipt families and unknown prefixes are identity fences. The
  derived request class is empty. Identity receipts, redeemed pairing codes and
  durable task/session history never expire under this policy.
- Bind real byte deletion when constructing core object stores. In-memory core
  construction requires `objectBytes: { deleteObject(tenant, hash) }`; deployed
  cloud/server compositions bind their byte owner. PG compositions require
  `objectStorage`; standalone object stores require their physical deleter.
- Consume `MaintenanceReport.steps` or `observer.onMaintenance`. A failed step
  reports `failedRows` and any confirmed `committed` counts; unknown counts and
  remainder are omitted. One failed step does not suppress later steps. A
  server `maintenance.failed` event carries either `report` or `errorCode`.

Default retention is acked mailbox 24h, unacked mailbox 7d, request receipts
24h and orphan grace 24h. Durations are positive bigint milliseconds. The
kernel performs one bounded pass, without looping on `more`.

Installed schema is unchanged. `cleanup_job` has no writer; historical rows
remain until a separately approved forward migration removes the table.
