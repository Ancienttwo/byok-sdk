# K8b Cross-Bot acceptance

Issue: #540. Approved plan: [Cross-Bot](../../docs/plans/2026-10-19-k8b-cross-bot.md).
Implementation base: `b5a456f0`. X5 source: `208a91bc`.
X5 and this X6 documentation are in Draft PR
[#578](https://github.com/Ancienttwo/byok-sdk/pull/578).
This document records repository evidence. It does not claim a production pass.

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
The full five-command run is in progress. Its evidence is
`_ops/k8b-x5/required/results.json` in the working tree.
Build and typecheck passed. The final focused X5 run passed 12/12 tests across
four files, exit 0, 53.76 seconds. Final full-suite results will replace this
paragraph before the session closes. A pending or failed command is not PASS.

No inherited test assertion or timeout changed. The existing encoding fixture
uses the longer state string. Its byte assertions and constants stay equal.
The X5 record lists all new fixture synchronization and discovery fault input.
Independent read-only Opus review ran twice and returned APPROVE with notes.
Small follow-up fixes have local evidence and no third independent verdict.

## Open acceptance rows

| Row | State | Missing evidence |
| --- | --- | --- |
| Two-device embedded-server delegation | Focused PASS | Full-suite terminal result pending above |
| Hosted `submitAgentExecution` cross-device path | OPEN | Downstream hosted Host adapter and execution evidence |
| Two Topology L Host processes | OPEN | Implemented service relay and durable request/verdict recovery tests |
| Two physical computers | OPEN | A run on separate machines; synthetic machine identity does not prove this |
| Real Pi and `submit_result` success rate | OPEN | Separately authorized paid runtime run and measured success rate |
| Downstream deployment, macOS/Windows product acceptance | OPEN | Fixed downstream build and device acceptance |

The two-process relay document defines `delegation.request` and
`delegation.verdict` outbox rows. It is not a relay implementation.
Q19 assigns K4 service rows downstream. It does not waive platform PRD §14.2
Cross-Bot rows. Docker dataplane skips are separate from Bot acceptance.
Draft status, local checks and review do not imply merge, release or deployment.
