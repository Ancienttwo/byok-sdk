# Durable activity log contract

This MINOR breaking change is A1 of the #1113 stack. **A1 is not deployable and
is not a merge candidate on its own.** A2a supplies the Postgres activity adapter and migration 0034, and
A2b the embedded SQLite adapter with the in-place 7→8 schema step; the
complete stack remains non-deployable until final acceptance.
No old activity-tail reader or writer is used as a fallback.

The complete A1–A5 stack remains a reviewed, frozen Draft chain until A5 final
acceptance. A2 depends on the frozen/merged #1164 in-place SQLite upgrade
mechanism and adds the next 7→8 step. No re-enrollment or new-state directory
is required. The subsequent slices integrate canonical lifecycle transactions,
approval retention, cross-instance wakes and the union stream reader.

## Host and store API changes

`ActivityTail.entries` now contains one row per source envelope: `progress`
(an entire event batch), `sealed-progress` (opaque C3 ciphertext), or
`artifact` (plaintext artifact metadata/content). Sealed artifacts remain
outside the log pending #1045 item 6. Existing sealed-artifact admission/blob
handling is not a promise that they were persisted in this log.

Use `projectTimelineEvents` on a plaintext progress entry to obtain its event
projection. This is the single projection used by ui-runtime and the example
Host; it does not decrypt ciphertext or render artifacts. The plaintext
live-activity Host example explicitly rejects artifact and sealed entries
until the application supplies the appropriate presentation/decryption
contract, instead of silently omitting them. Its per-event redaction
identity/order/correlation checks remain in force.

`readActivity(tenant, taskId, { after })` resumes by the store-assigned revision.
Pass the complete returned cursor, including version, tenant/task binding and
generation. The old `{ batchSeq, eventIndex }` cursor is not a log cursor.
TimelineEvent and TimelineOrderKey use store `revision` plus within-entry `offset` for ordering. Source `batchSeq` and `eventIndex` remain provenance; callers constructing projected events must supply the new ordering fields. Empty admitted progress batches retain an envelope row and replay identity even though their event projection is empty.
Readers get `activity_history_gap` for legacy/generation-mismatched cursors,
positions below the retained floor, or expired/removed history; invalid
shapes/types, bindings and future revisions get `activity_cursor_invalid`. A fresh read without
`after` is an explicit choice to start from the retained history, not an
implicit recovery of missing entries.

ActivityTail.after records the exclusive revision lower bound actually served (zero for an unfiltered read); it does not advance the retention floor or change the cursor. Timeline batch-gap detection consumes `TimelineMetadata.log` (the retained row revisions, floor and served after bound), populated by `replayTimeline`. Gap scanning starts at max(floor, after), so an intentional page prefix is not missing history. A retained empty or artifact row still proves continuity. Incremental events alone no longer infer revision loss: a jump can skip a row that projects zero events. Supply log continuity metadata or rely on the typed cursor gap for missing-history authority; within-row offset gaps remain visible.

`dropped` counts evicted envelope rows; `sourceDropped` separately records
producer-reported loss. A batch is never partially evicted. The returned
`retainedBytes` counts canonical sorted-key JSON UTF-8 bytes of complete rows,
including revision, timestamp, metadata and encoded ciphertext. The default
and maximum bounds are 1,000 rows and 4 MiB per task. Existing smaller capacity
and terminal-window settings may remain within those maxima; the first append
fixes the task's bounds. An oversized entry is rejected atomically without
evicting history, advancing the revision or completing its envelope receipt.

`expiresAt` is absent while active. The store's new `settle` boundary freezes
the first terminal timestamp, final revision and terminal-relative deadline
(default/max ten minutes). Reads/replays cannot renew it. New output after
settlement is refused. In A1 this boundary is implemented and tested by the
in-memory store; integration into **every canonical lifecycle transaction**
is A3 and must not be claimed complete here. Consequently this intermediate
head is not a production retention implementation.

Payload eviction/expiry retains source-envelope hashes and cursor floor
metadata. The hash uses the same sealed comparison projection as admission,
so a resealed retry of the same content remains idempotent after eviction.
Changed content under the same identity is refused. Removed content cannot
be resurrected through direct store replay. A3 supplies final retirement and
transactional cleanup integration; per-task payload caps do not bound the
number of tasks or source fences. Operators must retain tenant quotas and
canonical task retirement.

## Final-stack cutover

Stop all old writers/readers and fence old binaries before the one-shot schema
cutover. No legacy row conversion or dual read/write is permitted. New history
starts in a new generation: pre-cutover activity history is **not carried
over**. Reject old cursors with an explicit gap, then drop `activity_tail`.
Preserve canonical task/approval state and original terminal times; do not
grant already-terminal tasks a fresh retention interval. Rehearse the exact
Postgres and in-place SQLite migrations at the final frozen stack head.

The direct activity HTTP route removal is covered by the preceding
[O4 migration](1113-activity-envelope-only.md). External callers must be
checked against operator inventory before release.


## Postgres A2a

Apply the [one-shot cutover](../../deploy/runbooks/activity-tail-cutover.md#one-shot-cutover)
only at final-stack acceptance. 0034 starts an empty activity log and drops
`activity_tail`; it does not convert old history. The adapter uses shared
`createActivityEntry` and `activitySourceHash` exports so all adapters agree
on entry metadata, byte accounting and resealed replay identity. Head-row
transactions serialize append, settle, cursor reads and bounded cleanup.
Restarted processes read the same generation/revisions; no in-process cache
is a replay authority. Redaction/archive retain a removed-history fence;
tenant erasure removes entry/fence rows before heads. Canonical lifecycle
atomicity and artifact object-reference ownership remain A3 work.

## SQLite A2b

The embedded SQLite composition now persists the activity log in its database
file (schema 8) instead of process memory, through the same shared
`createActivityEntry`, `activitySourceHash` and `activityEntryBytes` exports as
the other adapters. A schema 6 or 7 file is upgraded in place when it opens, in
the open transaction: 6→7 as before, then 7→8 creates `activity_log_head` and
`activity_log_entry` empty. No pre-upgrade activity history exists to carry over,
because earlier builds never wrote it to disk. Pairings, tasks, approvals and
other rows are kept; no re-enrollment or new state directory is needed. A v8
file missing either table is refused as `SQLITE_SCHEMA_INVALID`, never
recreated, and builds before schema 8 cannot open the upgraded file.

After a restart the same generation and revisions are served, so a cursor
taken before the restart resumes after it. Malformed persisted rows fail closed.
The terminal-task archive now removes activity content inside its transaction
(a rollback restores it) and keeps a removed head, so a later read with a
cursor reports `activity_history_gap` and a later append is refused. Canonical
lifecycle atomicity remains A3 work, and cross-process invalidation A4.

## Task output closure (A3)

A task's activity log and approval timeline now close in the same commit as
the attempt write that first closes the task's output. That write is either:
- the task's first terminal (a device terminal, an abandonment, or a device
  retirement);
- an accepted Host cancellation, also for a claimed task still in
  `cancel_requested`.

From then on:

- **Late output is refused.** A `task.progress`, `task.artifact` or
  `task.await_approval` that arrives after the close is refused with
  `task_settled_by_cloud`. A redacted or archived task gets the same answer,
  so removing content no longer changes it. Before this, late output was
  stored, or on a redacted task completed as received. `ApprovalTimelineStore`
  `append` on a closed timeline throws the new `approval_timeline_settled`, and
  `resolvePending` returns `absent`: a request still pending at the close can
  no longer be decided.
- **The deadline is frozen.** Both expire ten minutes after the closing
  instant. Reads, replays and later terminals never renew it, and an active
  task's log still never idle-expires.
- **A task that logged nothing is closed too.** `readActivity` and
  `readApprovalTimeline` return an empty closed tail carrying `terminalAt` and
  `expiresAt` where they used to return `undefined`. Removal counts
  (`ephemeralRowsDeleted`) count only a log or timeline that held history.
  Archive, redaction and expiry clear a closed tail's entries and keep its row
  as the fence, so a late observation never recreates it.

The approval timeline's retention changes with it:
- **No idle expiry.** An open timeline keeps its observations until its task's
  output closes. `ApprovalTimelineAppendInput.ttlMs` is removed, and
  `ApprovalTimelineTail` gains `terminalAt`; its `expiresAt` is now present only
  once closed.
- **Bounded by count and bytes.** At most 50 observations and
  `MAX_APPROVAL_TIMELINE_BYTES` (1 MiB) of serialized observations are kept,
  the oldest evicted first and counted in `dropped`. The pending request is
  never evicted. One event is at most `MAX_APPROVAL_EVENT_BYTES`, and
  `capacity` must be 2 to 50; either violation is refused as
  `coordination_input_invalid`. `pendingApprovalObservation` and
  `retainApprovalObservations` are exported for custom adapters.

The built-in compositions do this at the storage boundary:
- Postgres: the trigger that migration 0035 adds on `task`;
- SQLite: the same trigger, created with the v8 schema;
- in-memory: the attempt state.

So every lifecycle path closes the log, bulk retirement included. Under that
trigger, Postgres locks the task row before its head, the same order as
redaction and the archive; append locks only the head. A custom composition
must close its activity log and approval timeline in the same commit as its
first terminal or accepted cancellation, for example with
`ActivityStore.settle`.

Upgrading closes the log and timeline of every task whose output had already
closed, at its original deadline, never a new ten minutes. An open task's
timeline loses its idle deadline and keeps every observation, including one
the old deadline had already lapsed:
- Postgres: 0035 runs a one-shot backfill;
- SQLite: the open that creates the v8 log runs it.

A terminal task from before `terminal_at` was recorded closes at its last
update. A v8 SQLite file without the closure trigger is refused as
`SQLITE_SCHEMA_INVALID`. Deploy 0035 and the code together: the new
Postgres approval adapter reads the `terminal_at` column 0035 adds, and an
older adapter's idle deadline on an open row violates 0035's
`approval_timeline_tail_closed` constraint, so each fails against the other's
schema.
