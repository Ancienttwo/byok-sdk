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
| durable shell groups | Validated ps snapshot, no non-zombie group members | Signal EPERM is remembered; the same snapshot decides live versus gone. An unreadable snapshot throws `RuntimeDisposalFailure`, quiescence stage, `durable shell group snapshot unavailable`. A live refused group at the deadline retains the signal-stage refusal reason. |
| owned process tree | `kill(-pgid, 0)` normally; `processSignalState` on errors | ESRCH is gone. Existing EPERM handling consults ps to distinguish live members from zombies and throws its existing typed snapshot-unavailable failure if ps fails. Successful kill(0) needs no process-table read. Existing `signalGroup` owns signal refusal errors and their reason text. |
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

With the fix, both regression cases passed. Complete affected files passed:
234 tests passed, 3 platform skips across owned-process-group-reap,
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
Head adds `isLiveProcessState` and `killProcessGroupsUntilGone` beside the existing
functions, without wrapping them in `__esm` or adding an `init_` function. The
new import therefore introduces no extra initialization wrapper in these entries.

| Entry | Old normalized budget | New measured budget | Increase |
| --- | ---: | ---: | ---: |
| @byok-sdk/client/adapters | 559137 | 559541 | 404 B |
| @byok-sdk/client/testing | 521107 | 521511 | 404 B |
| @byok-sdk/client#byok-pi-runtime-host | 586809 | 587167 | 358 B |

The other affected static closures grow by 565 B and fit their existing budgets:
@byok-sdk/client, @byok-sdk/bot-collaboration, its testing entry, and bin:byok-agent.
Raw and normalized growth agree. The maximum entry growth is 565 B.
