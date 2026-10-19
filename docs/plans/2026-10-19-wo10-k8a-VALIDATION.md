# WO-10 K8a VALIDATION

当前范围：跨 Bot 委派推迟到 K8b，安排在 #530 和 #531 合入后的第一张工单。
本轮跨 Bot 代码与测试已撤除（尚未写入，无需 revert）。

Status: recorded local checks passed for the single Bot slice. Full K8a first-row
acceptance for cross-Bot delegation is deferred to K8b.

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
does not cover cross-Bot delegation, which is deferred to K8b. The accepted
branches are merged locally. There were no merge conflicts. Production example code passed the
independent read-only Codex review. All five required checks passed on the
recorded source commit. Those checks do not prove cross-Bot delegation.
No paid Pi success-rate measurement is claimed.

Local commit chain: `d4530a14`, `eb83465e`, `cd469d6d`, `7bde22c1`, `0cfcc773`.
The final validation commit contains documentation only.

The earlier ContextPack and K4-import hold is superseded by the latest local
fix request. K4 already has Draft #532. No restack is performed.

---

## PRODUCT RULINGS 2026-10-19 (doc honesty)

Aimpact approved product rulings that affect K8a collaboration scope. This note is documentation honesty only; no behavior change in this commit.

- History: recent-N truncate by token budget + explicit truncation notice; do not block-when-full.
- Non-@ messages: background context only; must not trigger a reply.
- Late-joining Bots: messages after join only.
- K4: separate Draft PR #532 first; restack this branch onto it afterward; remove squashed K4 copy from #529.
- Cross-Bot delegation: deferred until after #530+#531 land (first WO of K8b).
- #525 `BOT_TURN_OUTCOME_LIMITS` remains HOLD pending Aimpact confirm.

## Corrected local scope, 2026-10-19

Cross-Bot delegation is withdrawn from #530 and deferred to the first K8b work
order after #530 and #531 land. No cross-Bot code or test was written in this
round, so no revert is needed. Ordinary merge `04d18bdc` syncs origin/main at
`433deced`; `a1c1226e` stays an ancestor. #531 head `23132486` is not merged.

### P3 package boundary and schema tests

- `host.test.ts`, `acceptance.test.ts`, `wake-retry.test.ts`, `routines.test.ts`:
  imports now use the K4 package exports. Existing assertions are unchanged.
  The test fixture is accessed through the package's test-support subpath.
- New `schema-budget.test.ts`: verify checked-to-flat fallback only for
  schema-over-budget, Host-defect errors without fallback, all eight routine
  ids retained, bounded outcome/schema sizes, and a self-only delegate enum.
- K4 exports expose existing functions only. Its runtime behavior is unchanged.

The new scope permits ContextPack budgets and K4 package exports in this branch.
The previous PENDING-AIMPACT notes below the historical checks are superseded
for these two implementation items. No PRD text is changed.

### P2-2 ContextPack tests and policy

- New `context-budget.test.ts` checks the declared recent window, omitted-turn
  count, outcome summaries, current routine definitions, unseen rejections,
  UTF-8 overflow blocking, no execution or timer spin while blocked, flat
  schema overflow blocking, and rejection release after unstarted cancellation.
- The schema-block integration case asserts block/no intent and retention of
  authorized ids. Its first draft incorrectly required two composer calls per
  Host drain. One drain has two sync passes. That incidental call-count check
  was replaced with semantic assertions. `schema-budget.test.ts` still proves
  exactly one checked attempt and one flat fallback per schema composition.
- New `host.test.ts` case uses the real SDK and daemon to check one-time Bot
  feedback and frozen ContextPack identity. Existing assertions stay unchanged.
- `routines.test.ts` binds the same horizon equality assertion to the public
  `WAKE_MAX_FUTURE_MS` name adopted from #523. No numeric expectation changes.

Defaults: 12 recent turns and 32 KiB serialized UTF-8 ContextPack JSON. Selected
turns carry action-name summaries, not full outcome documents. The window
reports its omitted count. Only current routine definitions travel. Rejected
actions are reserved by a frozen input; unstarted terminal failure releases
that reservation. A pack above its byte cap blocks with a persisted reason.
Blocked turns do not schedule a retry loop. These limits do not trim strings.

### P2-3 and P2-4 test changes

- `acceptance.test.ts`: strengthen the hung-connector case with a persisted
  `failed` conclusion. The four card decision states are unchanged. The existing
  timeout, abort, queued input/answer/decision/wake progress, and late-result
  assertions stay in place. No earlier expectation is removed.
- `host.test.ts`: add only the self-continuation crash boundary. A wrapper throws
  before the real `executions.submit`. The parent outcome marker and child input
  must already be durable. A new SQLite HostLedger connection and `recover()`
  must produce one child start, generation zero, and exactly the frozen offer
  payload. Repeated recovery must not make a second child or submit.
- No cross-Bot path or test is added. Cross-Bot delegation is withdrawn from
  this scope and belongs to the first K8b work order after #530 and #531 land.

## Current local-only delivery rules

The corrected synchronization baseline is `04d18bdc` over origin/main
`433deced`. It contains `a1c1226e`. It does not merge #531 head `23132486`.
Cross-Bot delegation is withdrawn from #530 and deferred to K8b.
K4 already has Draft #532. No new K4 PR is suggested or opened.
The PR body is written only to the requested `_ops/bot-wo/PR-530-body.md`.
No push, gh pr edit, package source change, or history rewrite is performed.
Final checks and the audit-to-commit table follow after verification.

### Admission review corrections and test changes

Read-only review found three P2 admission gaps in the first local pass.
Two new regression tests reproduced them: reducible history still measured
36,340 bytes and an unchanged 40,000-character blocked request became runnable
after 13 short inputs. `/tmp/wo10-local-admission-red.log` exited 1.

- New `context-budget.test.ts` cases retain the current candidate in byte
  accounting after it leaves chronological history, trim only older history
  with an explicit omission count, cancel a blocked turn idempotently without
  K4 intent, and settle a blocked routine occurrence so its pending version can
  activate. No prior assertion is changed. The eight context cases passed in
  `/tmp/wo10-local-admission-green.log`.
- The declared 12-turn window is a maximum. Older entries can be omitted to
  meet the byte budget. Current request and non-history data are not cut.
  Irreducible overflow remains blocked. This keeps the recorded history ruling
  while preventing current-request budget bypass.
- Pre-admission cancellation is an application transaction. It publishes one
  cancelled owner result. Sync never materializes that terminal turn.

A second read-only review will check these corrections. Cross-Bot delegation
stays withdrawn and deferred to K8b. No packages/ source is changed.
