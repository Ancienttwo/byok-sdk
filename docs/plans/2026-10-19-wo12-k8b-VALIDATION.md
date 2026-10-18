# WO-12 K8b VALIDATION

Status: PASS for implementation and final required checks. Two independent
review rounds are complete. All three findings have fixes and regression
evidence. The final small fix has no third independent verdict.

Base: accepted WO-10 `56a4df05`.
Branch: `codex/k8b-group-chat`.
Implementation: `b8d00664`. Review fixes: `20bd2a51`, `0ff86092`.
Environment: macOS, Node `v24.21.0`, Bun `1.4.3`.

## P1 map

K8b extends `examples/bot-collaboration`. K4 retains Agent FIFO, frozen input,
terminal authority, SQLite outcome transactions, and the once-only marker.
K8-S supplies every group and management schema fragment. No SDK package,
public API golden, feature flag, or legacy execution path changed.
The two `.ai/context` files named in root AGENTS.md are absent in this checkout.
No scoped agent context was added.

## P2 trace

The new integration tests use the real embedded SDK, SQLite stores, HTTP,
daemon, writer leases, home projections, and submit_result helper. The runtime
adapter is synthetic. There is no paid model call.

Main Bot submits three Bot profiles and one room in one outcome. The room uses
the three local ids. Each profile creates a durable projection operation. A
held real daemon projection keeps the selected seat without a K4 intent. On
exact accepted readback, the Host freezes and dispatches that member's input.
The daemon writes the persona into that Bot's home. The group offer omits
messageEgress. Its result-document speech enters room history once.

A busy member waits in its ordinary Agent FIFO. At 240 seconds the room marks
it busy and cancels its unstarted intent. The next selected member can run.
First observed claim starts an independent 240-second running grace. Its
deadline is stored and never reset by later scans. A member that exceeds this
running grace releases the room order, but retains its
K4 writer. A subsequent ordinary turn stays queued behind it. Its late post
uses the seat id. Reopening SQLite and reconciling again does not duplicate it.
Removing a member invalidates waiting seats. Running results enter audit only.
Completed post, pass, and failure states remain unchanged.

## P3 decisions and bounds

One serial Host consumer owns all application transitions and profile controls.
Ordinary turns retain K8a actions. Group turns require structured speech and
can add seats only through structured room_call. Text never adds a seat.
The optional admin mode is refused. The admin identity affects budget only.

If a round has I initial seats and admin indicator A, it can reserve at most
I + 4 + 4A seats. Admission checks this bound before each reservation. It also
checks the member counter against two, or four for that round's admin. Every
reservation spends budget. Completion, pass, failure, busy, and removal do not
refund it. Batch room calls mutate a copy and commit only if the entire batch
passes. These conditions preserve both bounds by induction over reservations.

An autonomous child has at most four initial members because K8-S caps a
room_call at four. A root permits at most three children. The largest user
round has 12 initial members and an admin, so at most 20 seats. Each child has
at most 12 seats. Thus one user root can reserve at most 20 + 3 * 12 = 56 seats.
Per-member counters can make this upper bound smaller. The late-post counter
starts at zero, increments only below ten, and never decreases. Thus at most
ten late posts enter history for one user root. New user input creates a new
root. Terminal application and speech share K4's once-only transaction marker.

The active team cap is 24. A room cap is 12 distinct members. Team notes cap
at 20 entries of 300 characters. History above 100 entries or ContextPack above
64 KiB blocks a seat with a reason. No authorized enum or history is truncated.
The SDK composer also refuses schema or maximum-outcome byte excess.

Profile updates freeze a new revision and wait for an exact applied readback.
Known old intents must settle before profile-control dispatch. A device
terminal can precede local writer cleanup. The first projection can hit that
lease and remain pending until reconnect. The Host reads all prior deliveries
and persists each new retry id before sending the same revision and digest.
Retry delay starts at one second and caps at 60 seconds. SDK revision ordering
prevents old controls from replacing newer persona. An accepted readback must
match device, AgentRef, request id, and digest. Only then can new input use it.

## Verification evidence

Dependencies: `bun ci`, exit 0, `/tmp/wo12-install.log`.
Initial build: exit 0, `/tmp/wo12-build-initial.log`.
Example typecheck: exit 0.
Inherited K8a tests: 23/23 passed, `/tmp/wo12-inherited.log`.
Combined example tests: 36/36 passed, `/tmp/wo12-example-all.log`.
Two more policy tests brought policy coverage to 8/8, exit 0,
`/tmp/wo12-policy-final.log`.
After the review fixes, all 40 example tests passed in 33.90 seconds, exit 0,
`/tmp/wo12-review-fixes.log`. Example typecheck passed on the same source.
The final late-terminal fix passed all 46 example tests in 35.55 seconds,
exit 0, `/tmp/wo12-late-terminal-fix.log`. Example typecheck also passed.

The first integration run exposed two failures. The room waiting deadline
raced K4's waiting deadline. Room grace now controls admission at 240 seconds;
K4 retains its ordinary 300-second fallback. Persona update hit a real writer
cleanup window. Durable projection retries now restore progress. A later
archive test exposed a queued cancellation left until the next wake. The Host
now drains queued cancellations to a fixed point. Test assertions and timeouts
were not changed to resolve any failure. Temporary diagnostic writes were
removed before commit.

No inherited test file or assertion changed. New tests cover structured
selection, seat limits, atomic batch refusal, the admin counter, ten late posts,
three autonomous rounds, current-role checks, private-context separation,
context blocking, note limits, duplicate local ids, exact profile admission,
real persona writes, speech/pass/failure, FIFO, removal, update, archive, and
SQLite recovery. Policy tests validate state rules. They do not replace the
real SDK integration paths.

The first five-command run on `b8d00664` passed build (12.56 seconds) and
typecheck (8.72 seconds). It was stopped during full test to apply the two
confirmed review findings. It is not a completed five-check result. Its logs
and partial results are under `/tmp/wo12-required-round1/`.
A second run on `20bd2a51` passed build (12.35 seconds) and typecheck
(7.18 seconds). It was stopped during full test after the last review finding.
Its partial evidence is under `/tmp/wo12-required-final/`.
The final five-command run on `0ff86092` keeps its evidence under
`/tmp/wo12-required-complete/`. Its `results.json` records the source commit,
command, exit code, and duration. This run returned:

| Command | Exit | Seconds |
| --- | --- | --- |
| `bun run build` | 0 | 12.29 |
| `bun run typecheck` | 0 | 7.92 |
| `bun run test` | 1 | 254.54 |
| `bun run check:api-surface` | 0 | 5.84 |
| `bun run check:version-authority` | 0 | 0.07 |

Full test stopped in the unchanged client package. One assertion failed at
`packages/client/src/__tests__/mcp-toolsets.test.ts:768`. The active task count
was still one when the existing wait ended. Client totals were 3991 passed,
one failed, and 30 skipped. No K8b test had run in that command yet.
The entire packages tree, scripts, manifests, and lockfile have no diff from
accepted base `56a4df05`. No assertion, timeout, worker count, or source was
changed to resolve this failure.

The failing file then passed all 29 tests in 3.00 seconds, exit 0, with the
same command options: `/tmp/wo12-client-failure-focused.log`. A full
`bun run test` retry passed on the same source and default options. Exit 0,
684.22 seconds. Its evidence is `/tmp/wo12-required-complete/test-retry.log`
and `test-retry.json`. Client passed 3992 tests and skipped 30. The K8b example
passed 46/46 tests in this full command. K4 Host tests passed 38/38. The first
client failure and later pass are both retained. No source or test change
occurred between these two full runs.

Final effective required-check results on source `0ff86092`:

| Command | Exit | Seconds | Evidence |
| --- | --- | --- | --- |
| `bun run build` | 0 | 12.29 | `results.json` |
| `bun run typecheck` | 0 | 7.92 | `results.json` |
| `bun run test` | 0 on retry | 684.22 | `test-retry.json` |
| `bun run check:api-surface` | 0 | 5.84 | `results.json` |
| `bun run check:version-authority` | 0 | 0.07 | `results.json` |

All evidence paths in this table are under `/tmp/wo12-required-complete/`.
API surface matched all nine package goldens. Version authority passed.
Docker-dependent tests used the repository default skip behavior. The final
handoff commit changes this validation document only.

## Independent review

Fresh Codex context: Herdr agent `wo12-review`, pane `w9:p2N`, tab `w9:t1A`.
The reviewer is in a separate right-hand pane. This tab contains three panes.
Review is read-only and includes a test-integrity review. It does not run a
second full suite. Round 1 reviewed `56a4df05..b8d00664` and found two P2 issues:

| Finding | Fix in `20bd2a51` | Regression |
| --- | --- | --- |
| Removal rewrites completed post and pass | Skip completed states before membership checks; still revoke pending late seats | Completed post/pass remain equal; late seat becomes removed |
| Waiting time reduces running grace | Persist first observed claim and an independent running deadline | Wait 239 seconds; remain running until 479 seconds |

The reviewer confirmed real profile-control retries, queued-cancellation
convergence, bounds, role and membership checks, frozen input, FIFO, exact
readback, and once-only speech. It found no assertion weakened in round 1.

Two pure fixture sequences gained a claim-observation step in the fix commit.
They previously set execution.started then jumped directly to timeout. The
new contract starts running grace at first Host observation. The extra step
models that observation before time advances. Every prior assertion and
timeout remains unchanged. Two new regressions test the review findings.
This is the complete test-fixture change list. No inherited K8a test changed.
Round 2 reviewed the resulting scope through `20bd2a51`. It confirmed both
first-round fixes. It accepted the claim-observation fixture steps and found
no changed assertion or timeout. It found one further P2: a seat already marked
late skipped intent.conclusion and stayed late after a failure terminal.
K4 does not call applyOutcome for a failed or cancelled execution.

Commit `0ff86092` reads terminal conclusions before skipping a released late
seat. It also preserves the removed state. Three pure cases cover failed,
cancelled, and declined conclusions. Three real SDK cases cover failed,
missing-outcome, and cancelled late executions, then reopen SQLite. They prove
failed seat status, its reason, and no post. All existing assertions remain.
All 46 example tests passed after this fix. The final five-check run uses this
source. No third review was requested under the two-round limit. The last
small fix has local regression evidence, not a third independent verdict.
The reviewer made no file edit and ran no full suite. Its final readback is
retained at `/tmp/wo12-review-round2.json`.

## Limits

The tests prove synthetic Host and SDK paths. They do not measure Pi model
success rate or production operation. No Docker dataplane was started.
The owner API caller must authenticate and authorize the owner. Runtime
connector isolation remains a deployment responsibility. Rooms support mention
mode. History, projection attempts, and audit retention are product concerns.
Use a fresh example ledger. This change does not migrate an earlier K8a ledger.
No push, PR, merge, paid call, or deployment is authorized or performed.


## Result

RESULT: DONE. K8b scope is implemented in the accepted K8a Host. Structured
mentions control seats. Budgets, independent grace periods, late terminals,
removal, and all six Main Bot actions have regression coverage. The five
required checks have passing final results on source `0ff86092`. Independent
Codex review ran twice. Three P2 findings were fixed. The last fix has focused
and full regression evidence, without a third review under the two-round limit.

Local source commits:

- `b8d00664f95a5e1072c6219fe7c1286c088baa06`: K8b implementation and tests.
- `20bd2a5118ae4c46cb7b90873ae973f89e5fe9b8`: immutable completed seats and separate running grace.
- `0ff860925cf26f1788fed7ab46023c75e7359aca`: settle failed late terminals.

Only `examples/bot-collaboration` and `docs/plans` changed. No inherited test
assertion was changed. No push, PR, merge, paid Pi call, or deployment occurred.
