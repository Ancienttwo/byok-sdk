# K8b Cross-Bot acceptance

Issue: #540. Approved plan: [Cross-Bot](../../docs/plans/2026-10-19-k8b-cross-bot.md).
Implementation base: `b5a456f0`. X5 source: `208a91bc`.
X5 and this X6 documentation are in Draft PR
[#578](https://github.com/Ancienttwo/byok-sdk/pull/578).
The separate PRD text is in Draft PR
[#579](https://github.com/Ancienttwo/byok-sdk/pull/579), based on
`origin/main@b5a456f0`. It changes no code or tests.
This document records repository evidence. It does not claim a production pass.

## Windows persona consumer / issue #738 (2026-10-23)

`createBotPersonaProjection` now writes `AGENTS.md` with the SDK
`writeHomeFile` (#738, slice R6 of #606). It does not open or flush a directory.
`scripts/ci/run-windows-bot-tests.mjs` therefore excludes no suite: the 14
persona suites of the #611 list below run on Windows with unchanged assertions.
The Windows contract is the owner decision O6: each file is atomic under a
process crash and the file is flushed. There is no promise for an OS crash or a
power loss (see README). The Windows evidence is the
`built adapter lifecycle smoke (windows-latest)` job of the PR that makes this
change. Local results do not establish Windows support.

## Windows CI qualification / issue #611 (2026-10-21)

Baseline: main `80a340836fe38abec718e2980d39d91b33964ac4`.
The Windows leg of `built adapter lifecycle smoke` now invokes
`node scripts/ci/run-windows-bot-tests.mjs` after its pinned Node install,
Bun install and full build. Vitest executes on Node; this is not a separate
Bun-runtime qualification. K8 source changes and runner changes select this
job family through `selectImpact`.

Local macOS arm64, Node 24.18.0 / Bun 1.4.3: the exact eligibility runner passed
20 files / 182 tests, zero skipped among the selected files. Workspace build,
typecheck, API surface and version authority are checked separately. Windows
execution and main-green acceptance remain pending until the PR's job and
subsequent main run pass; local results do not establish Windows support.

### Explicit Windows exclusions (removed by #738)

#738 removed these exclusions. The text below records the #611 state.
Each excluded file is printed with its reason in the Windows job log. These
14 suites call `openTeam`, whose actual `createBotPersonaProjection` consumer
opens and fsyncs a directory. That persistence contract is POSIX-only (see
README); no replacement consumer or weakened durability barrier is supplied.
Entire suite files are excluded, including any mixed pure cases within them.
Linux/macOS normal package runs keep all tests. This CI slice does not qualify
Windows persona persistence, physical devices or live models.

- `src/acceptance-fixes.test.ts`
- `src/channel-team.test.ts`
- `src/coalesce-team.test.ts`
- `src/cross-bot-cancel.test.ts`
- `src/cross-bot-chain.test.ts`
- `src/cross-bot-device.test.ts`
- `src/cross-bot-discovery.test.ts`
- `src/cross-bot-encoding.test.ts`
- `src/cross-bot-join.test.ts`
- `src/cross-bot-lifecycle.test.ts`
- `src/cross-bot-reliability.test.ts`
- `src/cross-bot.test.ts`
- `src/group-chat.test.ts`
- `src/main-bot-cancel.test.ts`

`windows-examples.test.mjs` checks this list against the actual persona-fixture
imports, so a new persona suite requires an explicit inventory decision. It
also proves that K4/K8 and runner changes retain the Windows job selection.
No existing test assertion, timeout or platform condition was edited.

## P1 map

`BotCollaboration` owns team profiles, placement, authority, delegation rows,
reply acceptance, joins, budgets and projections. K4 owns device/Agent FIFO,
frozen execution inputs, settlement and the once-only outcome transaction.
The SDK owns enrolled devices, delivery, claims and canonical terminals.
The only K8b public protocol change is XS, `cancel_delegation`, already in the
base. X1–X6 and X2M use example code and documentation.

## P2 trace

An A outcome creates B's request and reserves units in one Host transaction.
K4 submits the frozen input. B's daemon claims it and uses the result helper.
The Host accepts the exact-bound message, then settles the chain's verdict.
The join writes A's report membership once. K4 runs the report in A's FIFO.
A continuation inherits origin authority, hop and open delegation. It moves
the chain only when the successor Turn is actually committed.

The integration tests use real SDK transport and SQLite. The device tests
also use real enrollment and two daemons. The runtime adapter is synthetic.
See the [X5 record](../../docs/plans/2026-10-20-k8b-x5-VALIDATION.md) for its
clock, cleanup, machine identity, review and failure history.

## P3 decisions and bounds

The root budget is 12. A fan-out with `n` accepted requests reserves
`n + max(n, 1)` units. Admission counts all reservations from earlier batches.
At most `n` A reports can follow `n` accepted requests, including late reports.
A refusal-only outcome reserves one report unit when free, or delivers without
starting a model. Such a report has no delegation fragment. Self continuation
uses the separate limit of four. Cross-Bot hop cannot exceed four.

Reply bodies have an 8192-byte UTF-8 cap. Request and reply bodies occur once
in length-framed instruction blocks. Construction enforces the whole
instruction bound. History can be trimmed with a notice. Authorization enums
are never silently cut. A schema that cannot fit blocks with a visible reason.
The longest open state, `waiting_device`, is in the encoding bound fixture.

## Acceptance map

The table maps plan acceptance to tests. The final required-check result below
states which tests ran. A mapped test is not a claim about physical hardware,
a paid model or a deployment.

| Slice | Evidence files in `src/` | Behavior checked |
| --- | --- | --- |
| X1 | `cross-bot.test.ts`, `cross-bot-chain.test.ts`, `cross-bot-reliability.test.ts`, `cross-bot-encoding.test.ts` | Same-device request/reply; exact acceptance; terminal failures; recovery before submit; duplicate message; hop; authority; continuation end; frozen profile; FIFO; instruction/schema bounds |
| X2 | `cross-bot-cancel.test.ts`, `delegation.test.ts` | Cancel versus first acceptance; partial reply; queued cancel without intent; cancel redelivery; uncertain; abandon; late-terminal audit |
| X2M | `main-bot-cancel.test.ts` | Owner-authority Main Bot cancel; current-role check; schema gates; resolved target; capped enum and omitted count |
| X3 | `cross-bot.test.ts`, `cross-bot-join.test.ts`, `delegation-join.test.ts` | One fan-in report; uncertain sibling; no empty batch; late single report; interleaved and randomized budget accounting |
| X4 | `cross-bot-lifecycle.test.ts` | Target archive before intent, queued, offered, claimed, held and uncertain; initiator archive; no duplicate report; enum refresh |
| X5 | `cross-bot-device.test.ts`, `delegation-device.test.ts`, `cross-bot-discovery.test.ts` | Two enrolled devices and separate homes; exact device claim; offline wait and expiry; same-task reconnect; queued cancel; presence-only display; failed/stalled discovery |
| X6 | This file, `README.md`, `SECOND-DEVICE.md`, Host guide and separate PRD docs Draft | Usage, ownership, relay contract, evidence limits and approved PRD refinements |

## Required checks

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

No inherited test assertion or timeout changed. The existing encoding fixture
uses the longer state string. Its byte assertions and constants stay equal.
The X5 record lists all new fixture synchronization and discovery fault input.
Independent read-only Opus review ran twice and returned APPROVE with notes.
Small follow-up fixes have local evidence and no third independent verdict.

## Open acceptance rows

| Row | State | Missing evidence |
| --- | --- | --- |
| Two-device embedded-server delegation | PASS | Synthetic runtime; same test computer. Physical and hosted gaps remain below |
| Hosted `submitAgentExecution` cross-device path | OPEN | Downstream hosted Host adapter and execution evidence |
| Two Topology L Host processes | OPEN | Not in the first release (#606 O4). Implemented service relay and durable request/verdict recovery tests |
| Two physical computers | OPEN | A run on separate machines; synthetic machine identity does not prove this |
| `submit_result` cell: Pi 1.4.0, `zai/glm-5.3-flash`, darwin-arm64, `submit-result-v1` @ `v0.30.2` | OPEN | Run reported in [#977](https://github.com/Ancienttwo/byok-sdk/issues/977#issuecomment-6433620715); sanitized manifest and trial records not attached. [Method](../../docs/submit-result-measurement.md), [#977 gate record](../../docs/plans/2026-10-27-977-pi-product-gate.md) |
| `submit_result` cell: Pi 1.4.0, proxy `zai/glm-5.3-flash`, darwin-arm64, reply cell, AiphaBee `aiphabee-bot-chat-ask-user.v1` @ 0.30.2 | OPEN | Downstream counted run reported in [#977](https://github.com/Ancienttwo/byok-sdk/issues/977#issuecomment-6428287503); proxy cell, not native provider; sanitized export not attached |
| `submit_result` cell: Pi 1.4.0, native `zai/glm-5.3-flash`, darwin-arm64, same AiphaBee reply cell | OPEN | Uncounted calibration only; counted run needs an owner-authorized paid run |
| `submit_result` cell: Pi, win32-x64, same AiphaBee reply cell | NOT RUN | Windows device run |
| `submit_result` cells: Claude / Codex / Grok | NOT RUN | Separately authorized real-runtime datasets; not part of the #977 Pi gate |
| Downstream deployment, macOS/Windows product acceptance | OPEN | Fixed downstream build and device acceptance |

The two-process relay document defines `delegation.request` and
`delegation.verdict` outbox rows. It is not a relay implementation.
Q19 assigns K4 service rows downstream. It does not waive platform PRD §14.2
Cross-Bot rows. Docker dataplane skips are separate from Bot acceptance.
Draft status, local checks and review do not imply merge, release or deployment.
