# `tasks.events` reads the durable activity log

This MINOR breaking change (#1113, option A) makes the activity log the one
progress authority for the embedded server too. `ByokServer.tasks.events` and
`TaskHandle.events()` no longer read an in-process relay buffer. Each read
projects three stores: task state and the approval timeline, read the way
`tasks.get` reads them, and the task's activity log, the same log that
`ByokCloud.readActivity` serves. The relay only wakes readers after a commit.
It depends on the [SQLite activity log](1113-durable-activity-log.md#sqlite-a2b)
so that a cursor survives a restart.

## What changes for a Host

- **Cursors resume across a restart.** A `TaskEventEntry.cursor` names what the
  reader consumed of each source: activity log generation and revision with an
  offset inside a progress batch, approval revision and last state. Pass it as
  `after` in this or a later process over the same SQLite file; a reader
  stopped halfway through a batch gets the rest of it. Cursors are opaque and
  still task-bound.
- **Old cursors are refused.** A cursor from an earlier SDK (`<feedId>.<seq>`)
  is `TaskEventsUnavailableError` `cursor_unknown` on the first `next()`, as a
  restart already made it. Recover with a fresh read without `after`, or with
  `from: 'state'`. No pre-upgrade history is replayed.
- **State is coalesced, not replayed.** A read yields the task's current state
  when it changed since the reader's position, not every transition it went
  through. A reader that starts after a task went Offered → Claimed → Running
  sees `Running`. A Host that needs each transition this instance observed
  reads `ByokServer.events.subscribe()` (`task.state`), which is unchanged for
  tasks this instance dispatched. A Host that waited on `events()` for an
  intermediate state should wait for that state or a later one, or read
  `tasks.get`.
- **Window order.** Each read yields the pending approval request when it is
  new, the state when it changed, then activity in log order. A terminal
  state comes after the activity logged before it and ends the feed. A fresh
  read of a running task therefore starts with its current state, followed by
  all retained activity.
- **`from: 'state'`** starts at the pending request and current state, then
  only activity logged after the read began.
- **Terminal tasks stay readable.** `feed_expired` is gone: a terminal task's
  feed is its retained activity, then its terminal state. Once the activity is
  removed (archive), the read is the terminal state alone.
- **Truncation** now means the activity log dropped entries before the reader
  reached them (1,000 entries / 4 MiB per task, or archive). One
  `{ kind: 'error', reason: 'events_truncated' }` entry stands for the gap; its
  cursor resumes at the start of what is retained.
- **Removed options and exports.** `CreateByokServerOptions.taskEventBufferLimit`
  and `taskEventRetentionMs`, and the exports `DEFAULT_TASK_EVENT_BUFFER_LIMIT`
  and `DEFAULT_TASK_EVENT_RETENTION_MS`, are removed; the log's own bounds
  apply. `TaskEventsUnavailableError.reason` is `'cursor_unknown'` only.
- **Wake-ups.** A commit in this process wakes its readers at once. A reader
  no wake reached reads again within one second, so a transition with no
  envelope or Host call behind it (a device retirement, an abandonment by
  maintenance) is still seen. `TaskHandle.result()` reads the terminal result
  the same way; after `close()` it rejects instead of reporting a missing
  result.
- **`ByokServer.events.subscribe()`** announces state for tasks this instance
  dispatched. A task this instance did not dispatch (after a restart) is no
  longer announced there because a `tasks.events` read began.

## Hosted Hosts (Topology H)

`ByokCloud` gains no stream. Read one task's progress with
`readActivity(tenant, taskId, { after: tail.cursor })`, passing the complete
returned cursor; the cursor resumes across restarts of any composition whose
activity store persists (Postgres, SQLite).

## Not in this change

Activity admission does not yet close at a task's terminal, and the log has no
terminal-relative expiry until lifecycle transactions settle it (#1113 A3).
Cross-process wake-ups (#1113 A4) are not needed by the embedded server, which
has one storage owner. Sealed progress stays out of the embedded server, which
refuses sealed dispatch; a hosted Host reads it from `readActivity` as opaque
ciphertext.
