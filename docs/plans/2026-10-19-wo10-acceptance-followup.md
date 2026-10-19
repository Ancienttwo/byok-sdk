# WO-10 acceptance follow-up

Base: `fae8f2d6`. Branch: `codex/k8a-bot-collaboration`. PR: #530.

## P1 map

K8a owns cards, application actions, versioned routine state, and the wake
outbox. K4 owns execution FIFO, SQLite transactions, and projection delivery.
Only this branch and worktree will change.

## P2 trace

A pending card expires during sync. It currently publishes a projection and
creates an unbudgeted model turn. A confirmed card calls its connector inside
the serial chain. Projection upload removes its row, but later sync restores
that row. Wake validation currently throws before the malformed delivery can
settle. Successful cancel retry leaves its failure status behind.

## P3 decisions

- Expiry is passive state in the next ContextPack. It creates no model turn.
- Pass AbortSignal to the connector. Enforce a finite timeout even if it ignores
  that signal. Keep the existing idempotency key and atomic result commit.
- Persist a once-only decision projection marker in the card transaction.
- Apply routines, cards, questions, then self continuations.
- Reject late and conflicting decisions. Keep same-decision replay idempotent.
- Audit an invalid wake time and resolve without creating an occurrence.
- Clear retry status after successful cancel when no pending failed row remains.
- Use application state version 1. Reject unsupported or unversioned stored state
  without resetting it. Do not add a silent migration path.
- Correct the old K4 test title to 368 days without changing its assertions.

Cross-Bot delegation (platform PRD sections 9.4 and 14.2) is deferred.
PENDING-AIMPACT: ContextPack size/window/history policy, K4 stacking, and the
relative imports into K4 internals. Do not change those boundaries or the PRD.

## Verification and delivery

Add focused regressions. Justify any changed existing assertion in the PR body.
Run root typecheck, focused tests, both affected example suites, API surface,
and diff check. Get a read-only review of implementation and tests. Commit and
push normally. Update the PR body with the final scope and observed checks.
Keep the PR draft state. Do not merge, rewrite history, or deploy.

## Review and regression evidence

Independent read-only Codex review used the separate Herdr `wo10-review` pane.
Round 1 found an expiry ordering gap: a direct input could freeze pending
before sync refreshed expiry. A new test reproduced the stale offer with
exit 1. Sync now refreshes expiry before it freezes any new ContextPack.
The same test then passed. Round 2 closed this finding and found no new
reportable issue. No test assertion was weakened.

The existing expired-confirmation test now expects `Card expired` rejection.
This implements the explicit acceptance request. Its assertions for expired
state and no connector call stay unchanged. The K4 boundary test changes
only its title from 366 to 368. Its assertions stay unchanged.

The connector timeout test uses an uncooperative connector. It checks abort,
queued input/answer/decision/wake progress, an unknown-outcome result, and no
late-result overwrite. Projection tests upload, sync, and reopen the Host.
The decision projection is delivered once. Version tests reject unknown and
unversioned state without replacing it. No migration or reset is included.

## Current verification

| Check | Exit | Result |
| --- | --- | --- |
| `bun run typecheck` | 0 | All workspace typechecks passed |
| Bot focused acceptance/routine/retry tests | 0 | 20 passed |
| Bot example package tests | 0 | 34 passed |
| K4 `src/scheduling-recovery.test.ts` | 0 | 9 passed |
| `bun run check:api-surface` | 0 | Nine package goldens match |
| `git diff --check` | 0 | Passed |

All checks above completed before push. Logs are under `/tmp`:
`wo10-acceptance-typecheck-final.log`, `wo10-acceptance-package-final.log`,
`wo10-acceptance-k4.log`, `wo10-acceptance-api.log`, and
`wo10-acceptance-focused-final.log`.

## Scope left open

Cross-Bot delegation is deferred. Full K8a first-row acceptance is not claimed.
PENDING-AIMPACT remains unchanged: ContextPack size/window/history policy,
K4 stacking, and relative imports into K4 internals. No PRD text was changed.
No paid Pi success-rate measurement, undraft, merge, history rewrite, branch
removal, or deployment is part of this task.

Result: the authorized acceptance fixes passed verification and the second
read-only review. The PR body records the existing assertion change and all
deferred scope. Full K8a first-row acceptance remains incomplete.
