# Issue #147 implementation notes

> Status: source gates and architecture/security reviews passed; integration handoff in preparation
> Plan: plans/plan-20260906-0350-issue-147-task-offer-journal.md
> Contract: tasks/contracts/20260906-0350-issue-147-task-offer-journal.contract.md

## P1: Architecture map
Protocol messages registry owns the complete five-type task-opening family. Client create-daemon projects that classification into ReceivedEnvelopeRecord; SQLite append owns journal_task creation; ConnectionManager advances cursor only after onEnvelope. Terminal send and startup recovery consume the same row. No cloud settlement/doctor/Salesko changes.

## P2: Concrete trace and root cause
On base 440907ee2c44051b427d9ed4fe1431d93ffff72d, toJournalEnvelopeRecord had three offer literals, missing task.offer_for_agent_with_egress and task.offer_for_agent_with_egress_fresh. Acknowledged offers produced journal_envelope but zero journal_task; recordTerminal reported unknown task, and startup listRecoverable found nothing. The final regression uses real TestServer/daemon/SQLite, not a mocked opensTask value.

## P3: Decision
Move the five payload entries into an internal protocol task-offer registry, spread those same entries into MESSAGE_PAYLOAD_SCHEMAS, derive readonly TASK_OFFER_TYPES/TaskOfferType and isTaskOfferType. The client deletes its duplicated list. No runtime prefix heuristic, compatibility path, wire change, dependency, schema migration or cursor reordering. The 447-line API declaration expansion is generated type closure, not additional product behavior. At 10x volume, the existing bounded journal/pressure policy remains the limiting surface.

## Evidence
- `issue-147-pre-fix.log`: production source unchanged at base; Node22.22.0; 4 failed /5 passed. Failures are exactly the two egress types in creation and interrupted-lifecycle cases; missing task rows and unknown-task warnings observed. Fixture setup mistakes were corrected before this captured run.
- `issue-147-post-fix.log`: 9/9 passed after fix. Final suite strengthens dedup by waiting for the later persisted cursor and asserting exactly one adapter start for executable offers.
- `issue-147-source-test.log`: final full suite on Node22.22.0 via Bun1.4 launcher, 3660 passed/133 skipped, exit0. Includes existing journal integration (blocked append before cursor), crash, SQLite, pressure, long-poll/dedup and unavailable-mode suites. Skips are existing platform/external-provider coverage, not #147 cases.
- `issue-147-contract-check.json` and `.log`: 21 criteria /0 failures, all six root required checks plus regression proof and diff check.
- `issue-147-source-evidence.json`: per-file SHA256 and source fingerprint for the tested source/test/API subject.

## Test boundary
Five protocol-declared offers must create one task row at acknowledgement; duplicate envelope is absorbed and a second distinct envelope for the same task does not start another session. The toolset case deliberately lacks a local toolset and is declined: it still requires a task row, without adapter start. Actual terminal + interrupted recovery are tested for the other four variants, including both egress types. Existing strict resume contract is honored by a real AgentSessionHandoffStore fixture.

Interrupted recovery is a deterministic SQLite VACUUM snapshot captured after persisted acknowledgement and task.started, before terminal. The original run then produces and journals its real task.complete. After graceful teardown, restore the unfinished snapshot and start a real daemon; assert nonempty interrupted recovery_marker, no synthesized terminal and no resumed runtime. This is source integration evidence, NOT a SIGKILL, compiled binary or released-artifact acceptance claim.

## Scope and isolation
Independent branch codex/issue-147-task-offer-journal at /Users/kito/Projects/byok-sdk-wt-issue-147, based on refreshed origin/main 440907e. Primary checkout initially claude/event-spill@152206c, later moved by its owner; provider catalog branch and other worktrees not edited. Harness active markers are local to this worktree. plan-to-todo only changed todos timestamp; that incidental change was removed here.

## Remaining boundaries
Latest observed release v0.13.0; no version mutation or publication here. PR149 runtime-event-spill is an active integration neighbor (observed head4342a237f5b97bcb2d7c70900a342bdd8ab55793). Resolve create-daemon.ts/protocol index/API snapshot overlaps against its eventual frozen subject, then run integration acceptance. Review Markdown/source checks do not substitute for the harness-required typed Claude AcceptanceReceipt. No receipt or user waiver is manufactured. Downstream exact-pin and the Salesko acknowledged-interrupted recovery_marker rerun follow a separately coordinated real release. WP3 remains deferred.

Captured text logs retain command output with trailing whitespace normalized for git diff --check. This changes no reported assertions or exit codes.
