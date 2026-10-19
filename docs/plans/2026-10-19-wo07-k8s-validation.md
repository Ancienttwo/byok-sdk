# WO-07 K8-S validation

## Scope

Baseline: `docs/bot-mode-prd@8e8839a3`.
Input: WO-03 v4, sections 2.6, 4, 5, 6 and 8.
The input is in the `bot-m0-outcome-routine-draft` worktree at
`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md`.

P1: `protocol/result-schema.ts` owns K7 admission and outcome validation.
The protocol package owns outcome fragments. The core package has no protocol
import. Host code owns recurring schedules. The server accepts single instants.

P2: Fragment composition calls K7 admission. Offer decode calls that same guard.
Outcome validation checks the frozen schema. A Host calls the routine function
and passes its returned instant to the wake queue. The tests use these real
entrypoints. The workerd test bundles the same core source without Node support.

P3: Keep the K7 subset and the Host scheduling boundary. Add no runtime scheduler
or dependencies. Use shared field schemas and name-only `oneOf` branches.
Use a conservative canonical byte bound. Keep the proposed v4 limits marked as
pending product confirmation.

## Changes and directed evidence

- Add all 14 outcome action fragments and the v4 action types.
- Keep `checked` as the default schedule shape. Let the Host use `flat` only
  after `schema-over-budget`, before it freezes the offer.
- Keep `not-subset`, `schema-over-budget`, `over-budget` and
  `draft-over-budget` as separate error codes.
- Bound number values at 25 bytes and integer values at 24 bytes. Tighten an
  integer range only when both ends have magnitude below `1e21`.
- Test the full K7 depth, zero-item arrays, escaped strings, union bounds,
  open drafts, and callback data. No `toJSON` method or accessor can run in the
  tested enumerable and non-enumerable cases.
- The three tested Host variants have outcome bounds of 43,261, 61,895 and
  16,710 bytes. Each bound is at most 65,536. Each witness passes the real
  outcome validator. Each schema passes offer decode. These bounds depend on
  the supplied Host enums; the composer checks each new schema.
- Add `checkRoutineSchedule`, `nextRoutineOccurrence`, the four routine
  constants, and the `routine_schedule_invalid` core error code.
- Test 22 directed calendar cases and 13 zone cases in both Node and real
  workerd. These include DST gaps and overlaps, Lord Howe, Samoa, month ends,
  leap years, weekdays, repeated weekdays, and exact occurrence instants.
- Compare 400 generated schedules with a fixed-offset instant oracle.
  Compare 120 daily or weekly schedules near ten DST changes with a minute-scan
  oracle. The oracles obtain weekday names from Intl.
- Scan yearly schedules over 30 occurrences in eight zones and 72 dates.
  Assert that each measured gap is within 368 days.
- Add a server test for weekday-list parity. Update protocol and core API
  goldens. Update measured entry budgets and the generated README table.

## Test assertion changes

The existing core constraint assertions have two deliberate additions:

1. Add `./routine-schedule` to the allowed root modules. This admits the new
   pure module. The import and clock restrictions stay in place.
2. Add the six new runtime exports to the frozen export list. The test still
   requires an exact sorted match.

All other tests in this slice are new. No old assertion was removed or relaxed.
No change was made to `wakes.test.ts`.

## Independent review

Herdr reviewer: `wo07-review`, pane `w9:p2F`, Codex with a separate context.
The reviewer used read-only access. Round one found one P3 issue: a
non-enumerable `toJSON` callback could run in the byte-bound helper.
The fix checks that descriptor before it filters enumerable fields.
Regression tests require a callback count of zero for methods and accessors.
Round two passed. The reviewer found no test assertion changed to fit a defect.
The reviewer reran the ten byte-bound tests. It did not certify full checks or
API goldens.

## VALIDATION

Environment: Node 24.21.0, Bun 1.4.3. The final build completed before the final
read-only checks. No dependencies or version numbers changed.

| Required command | Exit | Result |
| --- | --- | --- |
| `bun run build` | 0 | All workspace builds passed. |
| `bun run typecheck` | 0 | All workspace type checks passed. |
| `bun run test` | 1 | Client stopped the root chain: 3 failed, 3,989 passed, 30 skipped. Later packages were not reached by this command. |
| `bun run check:api-surface` | 0 | All nine declaration goldens and entry policies passed. |
| `bun run check:version-authority` | 0 | Dispatch 0.27.0 and keys 0.12.0 agree with the docs. |

Separate package checks passed:

| Check | Result |
| --- | --- |
| `packages/protocol`: `bun run test` | 33 files, 1,309 tests passed. |
| `packages/core`: `bun run test` | 16 files, 451 tests passed. |
| `packages/server`: `bun run test` | 53 files, 558 tests passed, 19 skipped. |
| `packages/cloud-do`: `bunx vitest run test/routine-schedule.test.ts` | One real workerd test passed, with all 22 directed cases and 13 zone cases. |
| `git diff --check` | Passed. |

The root test failures were:

1. `packages/client/src/__tests__/execution-recovery-kill.test.ts:835`:
   the runtime-start list was empty after the marker file appeared.
2. `packages/client/src/__tests__/pi-durable-daemon-recovery.test.ts:125`:
   the child stdout did not contain the ready marker within the wait.
3. `packages/client/src/__tests__/session-workspace-store.test.ts:45`:
   the concurrent-write test exceeded 10 seconds. Cleanup also reported
   `ENOTEMPTY` for that test's directory.

Each failed test passed when selected alone on this branch. Each also passed
when selected alone in a clean, separately installed and built
`8e8839a3` worktree. These isolated passes do not prove the cause of the full
run failures. No client source, assertion or timeout was changed. The root
check remains failed; this document does not claim that all five checks passed.

Local logs: `/tmp/wo07-build.log`, `/tmp/wo07-typecheck.log`,
`/tmp/wo07-test.log`, `/tmp/wo07-api.log`, `/tmp/wo07-version.log`,
`/tmp/wo07-protocol-full.log`, `/tmp/wo07-core-full.log`,
`/tmp/wo07-server-full.log`, `/tmp/wo07-workerd-focused.log`.
The three isolated comparisons are in `/tmp/wo07-head-*.log` and
`/tmp/wo07-baseline-*.log`.

Final entry budgets match measured closure bytes. No dependency or codegen
permission changed:

| Entry | Bytes |
| --- | ---: |
| `@byok-sdk/core` | 126,269 |
| `@byok-sdk/protocol` | 127,135 |
| `@byok-sdk/cloud` | 533,443 |
| `@byok-sdk/cloud-dataplane` | 783,315 |
| `@byok-sdk/ui-runtime` | 561,703 |

The latter three entries include the changed core or protocol closure. Their
budgets therefore changed with the two direct package budgets.

## Dependency and limits

WO-368 owns `MAX_FUTURE_MS` and the two wake horizon assertions.
WO-368 commit `6042c8f1` exists on `codex/wake-horizon-368`. It is not in this
branch. This slice does not change those files. On this baseline the server still has a
366-day wake limit. A 368-day core horizon therefore needs WO-368 before Host
integration. The new spec section states the core contract. The existing wake
queue paragraph retains the baseline limit for WO-368 to update.

Core resolution uses the engine's ICU data. It assumes a gap of at most one day
and at most one offset change in the resolution window. The measured zone and
year samples do not prove future time-zone laws. The device Host remains the
schedule authority. Host code must handle a null successor visibly.

The initial implementation used local commits only. The acceptance follow-up
uses normal commits and a normal push to PR #525. It does not change Draft
status, merge history, another WO branch, or deployment.


## Acceptance follow-up (2026-10-19)

Scope: the four items from the Claude read-only acceptance review of PR #525.

P1: The three consumer builds keep core and protocol imports external.
The API closure walker adds the complete size of each reachable workspace
module once. It does not measure a final application bundle after tree shaking.
The new protocol root export makes the Bot fragments available to Host code.
The new core root export makes the routine helpers available to Host code.

P2: Rebuild the core and protocol sources at `8e8839a3` with the current tsup
config and installed toolchain. Compare those root modules with this branch.
Run the same closure walker with the two baseline modules substituted in that
process. No installed or tracked dist file changes during that comparison.
The three consumer sources did not change in WO-07.

| Root module | Baseline bytes | WO-07 bytes | Increase |
| --- | ---: | ---: | ---: |
| core | 120,544 | 126,269 | 5,725 |
| protocol | 115,614 | 127,135 | 11,521 |

| Entry | Baseline closure | WO-07 closure | Old budget | Budget increase |
| --- | ---: | ---: | ---: | ---: |
| cloud | 516,197 | 533,443 | 519,419 | 14,024 |
| cloud-dataplane | 766,069 | 783,315 | 767,924 | 15,391 |
| ui-runtime | 544,457 | 561,703 | 550,505 | 11,198 |

Each static closure increases by 17,246 bytes. Each consumer reaches the two
larger root modules. The budget increases differ because the old budgets had
different remaining margins. There is no new third-party dependency.

P3: Keep the required public root exports and the measured closure budgets.
Removing the Bot export would remove the requested Host API. A consumer bundle
size claim would require a separate application build. The PR body records the
static closure cost instead of claiming such a measurement.

Merge order: PR #523 first, then PR #525, then the WO-10 consumer PR #530.
PR #523 was still OPEN when checked in this follow-up. Do not merge main into
this branch. The horizon parity test remains conditional on #523 reaching main.
No server horizon constant or wake assertion changes in this follow-up.

A real-path probe uses yearly March 10 at 12:00 in `America/New_York`.
From `2031-03-10T16:00:00Z`, core returns `2032-03-10T17:00:00Z`.
The gap is 31,626,000,000 ms: 366 days plus one hour.
The current server's 366-day bound rejects that instant with
`WAKE_AVAILABLE_AT_INVALID`. PR #523 must land before this Host integration.

PENDING-AIMPACT: confirm `BOT_TURN_OUTCOME_LIMITS` before merge.
Those proposed limits are frozen public API values and are enforced by the
fragments. No limit value changes in this follow-up. No product decision is
inferred from the acceptance review.

The routine test moves the minute-scan oracle comment to `dstOracle`, fixes
callback indentation, and reports the current core horizon in its diagnostic.
The assertion conditions, expected instants, sample counts, and timeouts do not
change. The PR body records this test change explicitly.

Follow-up checks passed with exit 0: `bun run typecheck`; core
`bunx vitest run src/__tests__/routine-schedule.test.ts src/__tests__/constraints.test.ts`
(149 tests in two files); and `bun run check:api-surface` (all nine goldens).
`git diff --check` also passed. The earlier full-suite failure above stays
recorded. This follow-up does not claim a new full-suite pass.

Local evidence is under `_ops/wo07-review/` in this worktree:
`closure-measurements.json`, `horizon-probe.json`, `typecheck.log`,
`core-focused.log`, and `api-surface.log`.
