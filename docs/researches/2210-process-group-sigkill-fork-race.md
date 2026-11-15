# SIGKILL delivery racing a process-group fork (#2210)

## Scope and cause

Baseline: `d85d0166606f402de64d1a41655af43780467d62` (`origin/main` at dispatch).
The issue's two macOS CI observations show a live `sleep 600` with `ppid=1`
remaining in the owned group after one SIGKILL delivery. A member forked during
that delivery, so waiting alone could never empty the group. The new loop retries
SIGKILL while the caller's original gone predicate remains false.

## Gone and refusal audit

| Caller | Gone predicate | EPERM and unreadable-table behavior |
| --- | --- | --- |
| durable shell groups | Validated ps snapshot, no non-zombie group members | First-delivery EPERM is remembered; the same snapshot decides live versus gone. Retry EPERM is left to that predicate and never changes the initial refusal record. An unreadable snapshot throws `RuntimeDisposalFailure`, quiescence stage, `durable shell group snapshot unavailable`. A live refused group at the deadline retains the signal-stage refusal reason. |
| owned process tree | `kill(-pgid, 0)` normally; `processSignalState` on errors | ESRCH is gone. Existing EPERM handling consults ps to distinguish live members from zombies and throws its existing typed snapshot-unavailable failure if ps fails. Successful kill(0) needs no process-table read. The first `signalGroup` delivery owns the existing refusal wait/errors; retry ESRCH and EPERM return immediately so the original quiescence deadline and error decide. |
| failed migrate-record write | Only ESRCH from `kill(-pgid, 0)` | EPERM and every other probe error continue waiting; no process-table read. Signal errors remain swallowed; an unproved group still throws `MigrateRunning` and retains the pending recovery state. |

No caller switches predicate kind. Only the ps state check `!stat.startsWith('Z')`
is shared. Budgets remain 2 seconds, `killGraceMs`, and 5 seconds. SIGTERM stages
and Windows branches remain as before. The login-shell best-effort send remains
outside this change.

## Local red/green evidence

The tests were added before production changes, in commit `5bd571b48`. On the
baseline production code, on the local Darwin arm64 machine:

- `owned-process-group-reap.test.ts`, `durable disposal reaps members born while
  the group continuously forks`: the bounded 20-group test failed after 2090 ms
  with `RuntimeDisposalFailure: durable shell groups did not quiesce`. Delivery
  was native, with no mock or injected signal behavior.
- `runtime-process-tree.test.ts`, `disposal reaps members born while the group
  continuously forks`: failed after 2199 ms with `RuntimeDisposalFailure:
  forking fixture runtime process group remained live after SIGKILL`. The
  existing `killFn` injection point starts an actual in-group forker after the
  pre-kill snapshot and delivers the first SIGKILL only to the original root.
  This deterministically models members missed during the first delivery;
  subsequent deliveries use the native group signal. No production seam was added.
- The existing migrate-record write-failure test was extended to include a real
  continuously forking member. Both its original and fork variants passed on
  baseline code locally; no deterministic migration red is claimed.

The red commands were:

```sh
bun run --filter @byok-sdk/client test -- src/__tests__/owned-process-group-reap.test.ts src/__tests__/runtime-process-tree.test.ts -t 'members born while the group continuously forks' --reporter=verbose
bun run --filter @byok-sdk/client test -- src/__tests__/runtime-process-tree.test.ts -t 'members born while the group continuously forks' --reporter=verbose
```

The EPERM retry regression was also run before its correction, against production
head `111442e2a`: a successful first delivery followed by EPERM on resends yielded
`elapsed: 2000` and `stage: signal`, instead of the configured 80 ms and
`stage: quiescence`. The existing killFn hook supplies these answers while a
real owned child remains live. With the correction, the test asserts settlement
at exactly 80 ms of fake time and the original `remained live after SIGKILL`
reason. Its child is independently reaped in afterEach.

With the fix, all regression cases passed. Complete affected files passed:
235 tests passed, 3 platform skips across owned-process-group-reap,
runtime-process-tree, and lifecycle-installation; pi-durable-launcher passed all
25 tests. The forking groups are recorded at creation and independently killed
repeatedly in afterEach, including when the product disposer under test fails.
The process-tree fixture uses its own directory; other fixture children inherit
the owned worktree or test-directory cwd. No unrelated process was terminated.

Local build, typecheck, and version-authority checks passed. The API declaration
goldens are unchanged. The initial API check identified three exact byte-budget
overflows; the coordinator authorized only measured budget increases with no
extra allowance, after checking for initialization wrappers.

## Entry bytes and initialization audit

Base and head used the same installed build tools. An isolated baseline worktree
was built without changing production sources in the task worktree. Count regexes
were `\b__esm\b` and `\binit_\w+` against the emitted entry files.

| Emitted entry | Base `__esm` / `init_` occurrences | Head `__esm` / `init_` occurrences |
| --- | ---: | ---: |
| adapters/index.js | 9 / 22 | 9 / 22 |
| testing/index.js | 9 / 19 | 9 / 19 |
| bin/pi-runtime-host.js | 6 / 14 | 6 / 14 |

The process-signal-state section is direct function declarations on both sides.
The process-tree module already imported processSignalState from this utility on
base; the change adds an imported binding, not a new dependency edge.
Head adds `isLiveProcessState` and `killProcessGroupsUntilGone` beside the existing
functions, without wrapping them in `__esm` or adding an `init_` function. The
new import therefore introduces no extra initialization wrapper in these entries.

| Entry | Old normalized budget | New measured budget | Increase |
| --- | ---: | ---: | ---: |
| @byok-sdk/client/adapters | 559137 | 559610 | 473 B |
| @byok-sdk/client/testing | 521107 | 521580 | 473 B |
| @byok-sdk/client#byok-pi-runtime-host | 586809 | 587207 | 398 B |

The other affected static closures grow by 634 B and fit their existing budgets:
@byok-sdk/client, @byok-sdk/bot-collaboration, its testing entry, and bin:byok-agent.
Raw and normalized growth agree. The maximum entry growth is 634 B.

## GitHub macOS stress evidence

TEMP commit `5e042845eee371bb1f8ca0140b1d3436671f102d`,
[workflow run 43660432809](https://github.com/Ancienttwo/byok-sdk/actions/runs/43660432809):

| Runner | CPU-pressure processes | Rounds | Single-case passes / failures | Result |
| --- | ---: | ---: | ---: | --- |
| macos-latest | 3 yes | 50 | 150 / 0 | [success, job 132648316660](https://github.com/Ancienttwo/byok-sdk/actions/runs/43660432809/job/132648316660) |
| macos-15-intel | 4 yes | 50 | 150 / 0 | [success, job 132648316393](https://github.com/Ancienttwo/byok-sdk/actions/runs/43660432809/job/132648316393) |

Each round runs the native durable fork case, the deterministic process-tree
fork case, and the original unreadable-process-table case separately. Thus each
runner exercised 1000 native continuously forking durable groups in addition to
the other cases. Both logs contain rounds 1 through 50, 150 one-test-pass
summaries, and no failed-test summary or FAIL marker. There are no failure
residual rows to report.

The TEMP job used only contents: read, no user secrets, no artifact upload, and
explicit cleanup of its own yes children. Its commit was dropped after the two
jobs succeeded. The final ci.yml diff is zero. The temporary workflow's fixed
job-inventory test rejected the extra TEMP job; this is not product acceptance.
CI on the final head supplies merge evidence. These stress runs precede the
retry-EPERM correction, which has its own deterministic deadline/error regression
and subsequent validation on the revised head.
