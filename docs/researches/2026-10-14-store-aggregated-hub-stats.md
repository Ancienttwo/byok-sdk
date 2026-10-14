# Store-aggregated HubStats (#415 remainder)

Scope: the two gaps left after #403: durable-store aggregation and inbound
refusal counters. Offer-receipt dispatch facts, client retention, maintenance
(#412), and connection presence (#413) keep their existing authorities.

## P1: authority and ownership

`TaskAttemptStore` owns attempts and cancellation markers. Its three drivers
are in-memory cloud, embedded SQLite, and Postgres cloud-dataplane. The
tenant-bound wrapper and `ByokCloud` expose reads to the server facade.
`HubStats` and `tasks.list()` project those same records. Approval state is
derived from the approval timeline; the embedded SQLite composition still
uses an in-memory approval store, so approval pauses do not survive restart.

The previous server `LiveTaskIndex` mirrored task writes through decorators and
loaded all SQLite attempt history at open. It could miss writes made directly
to the store. This slice removes the mirror, its decorators, and its startup
scan together, leaving the task store as the only task-count authority.

The inbound gate already emits `onInboundRefused` with a closed reason. The
server previously supplied only `TaskEventRelay.onInboundCommitted`. The new
composed observer preserves that relay call and counts refusals separately.

## P2: reads and observable result

`server.stats()` calls `ByokCloud.countTaskAttempts(tenant)` once, walks all
`listTaskAttempts({active: true, limit: 100})` pages, then reads the approval
timeline of each walked attempt. The aggregate contributes only settled
statuses and marker-bearing rows; active status counts in that aggregate are
ignored. The walk contributes in-flight states. `taskStateOf` is shared by
the stats projection and task snapshots, with cancellation overriding status.

`TaskAttemptCounts.byStatus` contains every status, counting only records with
no cancellation marker. `cancellationRequested` counts marker-bearing records
regardless of coarse status. Drivers fail closed on unknown persisted statuses.
`active: true` selects offered/claimed/running records without such a marker,
with the existing exclusive taskId cursor and required positive integer limit.

An inbound rejection reaches the composed observer after the gate decides its
result. The server increments exactly that reason in its zero-filled
`HubStats.inboundRefusals` record. Counters last for one server instance; returned
records are snapshots. Duplicate and rate-limited results do not increment them.

## P3: non-atomic counts and index tradeoff

Counts are exact at quiescence, but the read sequence is not a transaction.
Under kernel lifecycle writes, settled tasks cannot return to the active walk.
Aggregate-first therefore avoids double counting; a task settling after the
aggregate and before its page can be absent from one result. Walk-first could
count that same task in both active and settled buckets. Subtracting walked
approval tasks from an earlier status aggregate could produce negative counts
for tasks created or moved between reads. No subtraction, clamp, retry, or
second process authority is introduced.

The no-double-count argument depends on kernel-reachable transitions. A direct
custom port caller can write unmarked `cancel_requested` and later return to an
active status. This slice does not change `recordStatus` semantics and makes
no universal lower-bound guarantee for arbitrary direct port mutations.

The call count is one aggregate plus pages/readbacks proportional to active
tasks, independent of settled-history length. Aggregate row work still grows
with tenant history. SQLite installs the covering index
`(tenant_id,status,cancellation_requested_at,task_id)` on every open in its
existing initialization transaction, including existing v4 files. No schema
version changes. An active query uses `INDEXED BY`: the planner's 20,000-row
SQLite probe otherwise preferred the primary key and examined settled history;
the hinted query examined its four active rows. The aggregate uses a covering
index scan. First open of an existing large file pays a one-time index build
while holding the SQLite write lock.

Postgres has no stats-specific index in this slice. Correctness is covered by
the same port conformance, while query-plan performance is unmeasured. There
is no in-repo Postgres stats consumer; the current facade uses memory or
SQLite. Before a hosted consumer polls these reads, measure `EXPLAIN ANALYZE`
on history-heavy tenants and bound a task index/query-shape migration. The
transactional migration runner cannot use `CREATE INDEX CONCURRENTLY`; a build
would block task writes. This deferred performance decision does not change
task retention or durable-history collection.

## Verification surfaces

- Three-driver task conformance: zero-filled counts, marker separation,
  tenant isolation, active keyset paging and invalid query rejection.
- Server stats: all public states, cancellation precedence, direct store
  writes, >100 active attempts, zero versus 200 settled-history read cost,
  three read-race traces, SQLite restart and immutable offer facts.
- SQLite ownership: existing v4 files gain the index; opening no longer
  materializes historical rows, while corrupt rows still fail when read.
- Inbound observer/server observability: refusal vocabulary, reason counts,
  accepted relay events and isolated counter snapshots.
- API goldens: cloud, cloud-dataplane and server only. Custom cloud-store
  implementations must implement `countByStatus` and the `active` list filter.
