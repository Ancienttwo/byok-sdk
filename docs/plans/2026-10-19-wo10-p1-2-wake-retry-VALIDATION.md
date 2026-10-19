# WO-10 P1-2 wake retry validation

Scope: P1-2 only, from `_ops/bot-wo/REV-batch2-claude.md`.
Base: `56a4df05`. Branch: `codex/k8a-bot-collaboration`.
Cross-Bot delegation (P1-1) stays deferred and unchanged.

## P1 map

`BotCollaboration.process` arms the retry timer. `flushWakes` consumes the
application wake outbox. Each row has a routine id, sequence, and optional
persisted retry time. `HostLedger.transaction` writes SQLite with FULL sync.

## P2 trace and reproduction

A failed schedule stores `retryAt = now + 60_000`. The old dispatcher stops
all routine queues at that failure. Its timer still reads later rows without
a retry time and schedules a drain after 1 ms. Each drain writes transactions
without making an outbox attempt.

Two new regression tests failed on the unchanged base. Each recorded 500
Host ledger transactions in 100 fake milliseconds. The red run exited 1.
Evidence: `/tmp/wo10-p1-2-red.log`.

The tests use real SQLite Host and SDK stores. They inject schedule or cancel
failures at the wake API boundary. They count actual Host transactions.
No existing test file, assertion, skip, or timeout was changed.

## P3 decision and fix

Keep one serial consumer and the existing persisted 60-second retry time.
A failed or not-yet-due head blocks only its own routine. Other routines can
proceed. Later operations of the blocked routine cannot overtake its head.
The timer reads only the first pending row per routine, in sequence order.
It waits until that head's persisted retry time. Blocked followers cannot
move the timer forward.

After a flush, a remaining eligible head has a future retry time. Failed heads
can therefore cause one retry per 60 seconds, not one idle drain per millisecond.
A successful retry can then consume its queued followers in order.
No feature flag, state migration, or alternate execution path was added.

## Checks

| Command | Exit | Result |
| --- | --- | --- |
| `bun run --cwd examples/bot-collaboration test -- src/wake-retry.test.ts` | 0 | 2 passed |
| `bun run --cwd examples/bot-collaboration test` | 0 | 25 passed |
| `bun run --cwd examples/bot-collaboration typecheck` | 0 | Passed |
| `bun run typecheck` | 0 | Passed |
| `git diff --check` | 0 | Passed |

The schedule test checks `schedule_retrying` and the persisted retry time.
It checks zero extra transactions before retry, two attempts over 60 seconds,
and at most ten transactions in that window. It also checks that a second
routine proceeds. The cancel test queues a schedule behind a failed cancel.
It checks zero writes before the deadline and cancel-before-schedule recovery.

Logs: `/tmp/wo10-p1-2-targeted.log`, `/tmp/wo10-p1-2-package.log`, and
`/tmp/wo10-p1-2-typecheck.log`.

## Review and result

Independent read-only Codex review passed in Herdr agent `wo10-review`,
pane `wA:p4P`. It found no actionable P1/P2 issue and no weakened assertion.
The review covered this P1-2 delta only. It reused the recorded test evidence.
Only P1-2 is addressed. No push or remote PR action is part of this change.
