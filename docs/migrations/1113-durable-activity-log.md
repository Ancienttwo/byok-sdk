# Durable activity log contract

This MINOR breaking change is A1 of the #1113 stack. **A1 is not deployable and
is not a merge candidate on its own.** The Postgres activity adapter fails
closed at construction until A2 supplies the new schema and implementation.
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
