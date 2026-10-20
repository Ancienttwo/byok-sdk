# K8b X5: second-device validation

Issue: #540. Base: `b5a456f0` on `origin/main`.
Branch: `codex/k8b-x5-second-device`.
Scope: the approved Cross-Bot plan, X5 and §3.9.

## P1 map

The collaboration Host owns the team, delegation records and projections.
K4 owns each device/Agent FIFO, frozen execution input and settlement.
`BotOptions.models` already selects device placement when a Bot is created.
The SDK owns pairing, delivery, claims, message disposition and device terminals.
No SDK package, public API golden, dependency or wire contract changes.
The root `.ai/context` files are absent. No scoped context was added.

## P2 trace

A real embedded server enrolls two SDK daemons. Each has separate credentials,
SQLite journal, workspace and Agent homes. A Main Bot outcome creates B from
the remote model template. The real persona projection writes B's `AGENTS.md`
on the second root. An A outcome delegates to B. The frozen B offer and SDK
claim name the second device. A's adapter does not run it.

B uses the real `submit_result` helper and message acceptance path. The Host
checks the task, device, AgentRef and destination binding. It writes one
verdict and one report Turn on A. A runs the report on the first device.
Reopening the Host SQLite ledger does not duplicate B or the report.

For the offline case, B first enrolls and applies its persona. The test stops
only B's daemon and waits for real presence expiry. A and the HTTP server
stay online. The SDK retains B's offered, unclaimed task. The Host shows
`waiting_device`. At deadline minus one there is no verdict. At the original
five-minute deadline, K4 cancels and reads the SDK attempt. The delegation
becomes `expired`. A gets one report. Recovery and reconnect keep generation
zero and do not run that cancelled offer. A separate test reconnects before
the deadline and runs the same frozen task once. Another cancels while waiting.

## P3 decision and bounds

Presence supplies display evidence only. It cannot change submit, retry,
generation, deadline, unit accounting or verdict. A missing discovery port,
missing device row, failed read or one-second I/O expiry supplies no new
offline fact. Real delegation tests cover missing, failed and stalled discovery.
Only a delivered and unclaimed offer can enter `waiting_device`. Persona and
FIFO waits stay queued. A claim changes waiting to running. Cancel includes
waiting in the existing arbitration and Main Bot enum.

The unit test compares the full intent, execution, budgets and units before
and after presence changes. They remain equal. Re-observation emits no second
event. The instruction generator now uses the longest open state,
`waiting_device`, with the existing byte assertions and bounds unchanged.

## Test integrity and review

No inherited assertion or timeout changes. The existing encoding fixture
changes only its status value from `reply_pending` to `waiting_device`.
This tests the new longest state. Every encoding assertion stays in place.

The new integration fixture uses the public `machineId` override with the
second root's sha256. Without it, the SDK correctly supersedes the first
same-machine enrollment. The initial failed enrollment run is retained.
The fixture waits for actual SDK task cleanup before home reuse. It also
waits for both session creation and Host claim observation. The original
5000 ms limits remain. The expiry test uses real Host time during startup,
then sets the supplied clock only for its deadline boundary checks.
No production clock or SDK behavior changes to satisfy those tests.

One read-only Claude Opus reviewer ran in Herdr (`k8b-x5-review`, `w9:p38`).
Two rounds returned APPROVE with notes. It checked test integrity and the real
SDK path. It ran no tests and made no edits. Subsequent local changes bound
discovery I/O, cover discovery failures and use the longest encoding state.
Those small changes have local verification, without a third review round.
The suggested presence-TTL increase was not applied. Very heavy machine load
can still make the short synthetic presence lease expire during an online test.

## Verification

Environment: macOS, Node v24.21.0, Bun 1.4.3.

All five required checks passed. The full `bun run test` passed on the final
X5 code, exit 0, 1053.04 seconds. Bot collaboration passed 252/252 tests in
33 files, 266.02 seconds. The final focused X5 run passed 12/12 tests across
four files, 53.76 seconds. No full-suite retry was needed.

| Command | Exit | Seconds |
| --- | --- | --- |
| `bun run build` | 0 | 11.78 |
| `bun run typecheck` | 0 | 7.11 |
| `bun run test` | 0 | 1053.04 |
| `bun run check:api-surface` | 0 | 5.57 |
| `bun run check:version-authority` | 0 | 0.07 |

The final build, typecheck and two contract checks ran after the small
example follow-ups. The full test had already read those final example files.
Source code is `208a91bc`; later commits change Markdown only.
API surface matched all nine package goldens. Version authority passed.
Docker-dependent dataplane tests used the repository's default skips.
No Docker substrate or paid Pi call was started.

Local evidence: `_ops/k8b-x5/required/effective.json`, `results.json`,
`final-checks.json`, `test.log`, and the four `*-final.log` files.
`_ops/k8b-x5/focused.log` records the focused run.
Hosted CI is separate and can remain queued or running on these Draft PRs.

## Acceptance limits

The runtime is the plan's synthetic adapter. Transport, storage, daemons,
message acceptance and result helper are real. Both logical devices run on
one test computer and in one test process. This proves no Host instance on
B. It does not prove two physical computers, a paid Pi call or production.

The hosted `submitAgentExecution` path and two Topology L Host processes
remain OPEN under plan §3.9 and platform PRD §14.2. The relay is a documented
contract only in `examples/bot-collaboration/SECOND-DEVICE.md`. Q19 does not
waive either row. Docker dataplane and platform model success rates remain
outside this evidence. The work opens Draft PRs only.
