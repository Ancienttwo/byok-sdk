# WO-10 K8a VALIDATION

Status: recorded local checks passed for the single Bot slice. Full K8a first-row
acceptance is not complete. Cross-Bot delegation is deferred by Aimpact.

## Scope

This work implements self continuations and single Bot actions. Delegation to
other Bots, as specified in platform PRD sections 9.4 and 14.2, is deferred.
This report does not claim full K8a first-row coverage. Paid Pi submit_result
success-rate measurement remains separate WO-10b work. The PRD is unchanged.

Environment: macOS, Node `v24.21.0`, Bun `1.4.3`.

Branch: `codex/k8a-bot-collaboration`.
Base: WO-05 K4 `e5afad26`.

## Integration

| Commit | Change | Conflicts |
| --- | --- | --- |
| `d4530a14` | Merge accepted WO-07 `f1274a4d` | None |
| `eb83465e` | Merge accepted wake horizon `6042c8f1` | None |
| `cd469d6d` | K8a implementation and new tests | Not applicable |
| `7bde22c1` | Review fixes, input policy, and added regressions | Not applicable |
| `0cfcc773` | Set the synthetic clock before Host and daemon startup | Not applicable |

Both merges used `--no-ff`. There was no rebase. README and spec text merged
automatically. No conflict-resolution changes were needed.

## P1 map

K4 retains the FIFO, SQLite transaction, frozen offer, terminal readback,
and once-only outcome marker. K8-S supplies public schema fragments and
calendar functions. K8a owns application policy in `examples/bot-collaboration`.
The application ledger stores routine versions, cards, questions, turns,
budgets, rejections, and ordered wake operations.

## P2 trace

The synthetic tests use the embedded SQLite SDK server and a real daemon.
The adapter calls the real submit_result helper. The SDK accepts the message
and terminal. K4 reads deviceTerminal and applies the outcome transaction.
K8a then runs a self continuation through the same FIFO. A confirmed card
calls a synthetic Host connector and creates an action_result turn.
A real scheduled SDK wake starts a routine execution. Its terminal produces
an owner projection with source routine.

## P3 decisions

K4's immutable routine API stays unchanged. The K4 wake horizon now matches
the accepted SDK horizon at 368 days. K8a keeps its versioned definitions in
the application ledger. All K8a commands and wake store calls share one serial
consumer. Persistent sequence numbers define recovery order.

Each routine permits two unsettled occurrences. A third due slot receives a
capacity decision. An update stops replenishment of the old chain. It keeps
accepted old work and a due armed slot. It switches only after old work
settles. Resume keeps current while pending work remains unsettled.

The admission bound follows by induction. The initial in-flight set is empty.
A matching delivery adds one row only when the size is below two. Settlement
only removes rows. A pending update prevents new old-version successors.
A due armed old slot can be accepted once. Redelivery cannot add another row.
The new version starts only when the old set is empty. Thus the total accepted
unsettled count stays at most two across an update.

## Verification

The first focused run passed 14 tests. After more recovery and ordering
coverage, the focused run passed 17 tests in 14.92 seconds. Evidence:
`/tmp/wo10-focused-2.log`. A later run passed 22 tests in 25.61 seconds at
`/tmp/wo10-focused-final.log`. One added connector commit-fault test passed
at `/tmp/wo10-connector-crash.log`. Example typecheck passed on `7bde22c1`.

An intermediate scheduled-wake test failed. Its 100 ms clock margin elapsed
before the outcome commit. The correct calendar then selected the next day.
The fixture now leaves 30 seconds and re-arms the real SDK timer after its
synthetic Date jump. No assertion or timeout was relaxed. Temporary diagnostic
output was removed. The passing 22-test run includes this corrected fixture.

The first five-command chain is retained at `/tmp/wo10-required-checks/`.
Build, typecheck, API surface, and version authority passed. Test returned 1
after 605.57 seconds. The new example had 22 passes and one failure. Its
scheduled-wake fixture moved Date backward after daemon startup. That caused
presence rate-limit errors and blocked completion. No SDK source changed.

Commit `0cfcc773` sets the test clock before startup. All assertions and timeouts
stay unchanged. All 23 focused tests then passed in 16.20 seconds. Evidence:
`/tmp/wo10-clock-startup-fixed.log`. This is a fixture-only change after the
second code review. Production source remains the reviewed `7bde22c1` source.

The final five-command chain runs on `0cfcc773`. Each command keeps output
under `/tmp/wo10-required-final/`. Its `results.json` records the source commit,
command, exit code, and duration. Final results:

| Command | Exit | Seconds |
| --- | --- | --- |
| `bun run build` | 0 | 14.1 |
| `bun run typecheck` | 0 | 8.23 |
| `bun run test` | 0 | 663.91 |
| `bun run check:api-surface` | 0 | 6.21 |
| `bun run check:version-authority` | 0 | 0.07 |

The full test command passed on the final source commit. The new example passed
23/23 tests in that command. K4 Host regression tests passed 38/38.
API surface matched all nine package goldens.
Version authority passed. Docker-dependent dataplane tests used the repository's
default skip behavior. No Docker substrate was started for this baseline.
These are historical results for `0cfcc773`. Later acceptance fixes and current
checks are recorded in `2026-10-19-wo10-acceptance-followup.md`.

WO-10 did not change inherited test assertions. The accepted wake-horizon
merge carries its own boundary assertion changes. New WO-10 assertions cover
the contract:
self budget and hop, four card states, answers, failed outcomes, rejections,
ordinary schema authority, horizon parity, stable slot identity, snapshots,
capacity, generation, pause/resume, cancellation, and wake operation order.
The old K4 boundary test uses WAKE_HORIZON_MS. Its existing assertions now
exercise 368 days without an assertion change. The acceptance follow-up
corrects its title from 366 to 368 without changing the assertions.

## Independent review

Reviewer: fresh Codex context, Herdr agent `wo10-review`, pane `wA:p4P`,
tab `wA:t22` (`WO-10-review`). This is a separate tab with one pane.
The inherited caller pane id was stale. No existing pane was changed.
Review scope: `eb83465e..cd469d6d`. The reviewer is read-only and includes
a check for tests bent to fit implementation bugs.

Round 1 requested changes: one P1 and two P2 findings on `cd469d6d`.

| Finding | Fix in `7bde22c1` | Evidence |
| --- | --- | --- |
| Immediate terminal can strand a continuation | Drain until all application turns have a K4 intent | Real SDK immediate five-turn chain |
| Empty update advances version | Refuse before ledger mutation; report in ContextPack | Pure state test and full outcome path |
| Answer shares the old continuation budget | Use a stable answer id as a new user budget root | Exhausted old root, answer replay, and new continuation |

The same change rejects duplicate targets and option ids and normalizes
weekdays. It exposes serial turn cancellation. It covers missing outcomes.
The connector fault test applies an external effect, rolls back the SQLite
result commit, reopens the ledger, and replays the same connector key.
There is one external effect and two connector calls.

Round 2 passed code review for `7bde22c1`. All three findings were closed.
The reviewer found no new actionable issue. It confirmed that no assertion was
weakened. It accepted the real scheduled-wake fixture correction and the
SQLite commit-fault test. Final acceptance still required the five command
exits when the reviewer finished. This report records those exits separately.
The reviewer made no edit and ran no second full suite.

## Limits

The synthetic runtime makes no paid Pi request. It proves Host protocol paths,
not a model success rate. The Host connector must deduplicate by the card id.
A crash after an external effect can replay that connector call.
The deployment must use an Agent profile without external connector tools
or credentials. This example is not a runtime sandbox.
History, version, and audit retention remain product responsibilities.

## Result

RESULT: the single Bot slice is implemented. Full K8a first-row acceptance
is not complete. Cross-Bot delegation is deferred by Aimpact. The accepted
branches are merged locally. There were no merge conflicts. Production example code passed the
independent read-only Codex review. All five required checks passed on the
recorded source commit. Those checks do not prove cross-Bot delegation.
No paid Pi success-rate measurement is claimed.

Local commit chain: `d4530a14`, `eb83465e`, `cd469d6d`, `7bde22c1`, `0cfcc773`.
The final validation commit contains documentation only.

PENDING-AIMPACT: ContextPack size/window/history policy, K4 stacking, and
relative imports into K4 internals. This follow-up does not decide these items.

---

## PRODUCT RULINGS 2026-10-19 (doc honesty)

Aimpact approved product rulings that affect K8a collaboration scope. This note is documentation honesty only; no behavior change in this commit.

- History: recent-N truncate by token budget + explicit truncation notice; do not block-when-full.
- Non-@ messages: background context only; must not trigger a reply.
- Late-joining Bots: messages after join only.
- K4: separate Draft PR #532 first; restack this branch onto it afterward; remove squashed K4 copy from #529.
- Cross-Bot delegation: deferred until after #530+#531 land (first WO of K8b).
- #525 `BOT_TURN_OUTCOME_LIMITS` remains HOLD pending Aimpact confirm.
