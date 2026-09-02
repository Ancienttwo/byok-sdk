# Task Review: issue-109-control-backpressure

> **Status**: Accepted
> **Plan**: plans/plan-20260901-0409-issue-109-control-backpressure.md
> **Contract**: tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md
> **Notes File**: tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-01 04:30
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:d15d9de794cbce6a516473f6a94cfa5898bb2daaa7393fa74d82e21efbfbde1b
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576

## Human Review Card

- Verdict: pass; independent exact-diff review found no confirmed P0-P2 issue.
- Change type: code-change
- Intended files changed: `control-server.ts`, `control-server.test.ts`, and the named #109 workflow artifacts.
- Actual files changed: exactly the contract allowlist, including the accepted #108 dependency normalized against `main`.
- Commands passed: baseline artifact then focused test (including asynchronous socket-error teardown), root build/typecheck/test, client typecheck/build, strict workflow, and whitespace check.
- Residual risks: per-connection retained output is capped, but kernel buffering and the number of authenticated connections remain external to this writer's budget.
- Reviewer action required: none.
- Rollback: revert the writer and tests together to base `42a8b92`.

## Mode Evidence

- Selected route: strict regression-first local transport reliability bugfix.
- P1/P2/P3 evidence: plan `plans/plan-20260901-0409-issue-109-control-backpressure.md` records the connection owner map, precise response/event-to-socket trace, and one-writer decision.
- Root cause or plan evidence: pre-fix artifact proves baseline writes twice after the first false return; contract Root Cause Evidence binds the test and artifact.

## Verification Evidence

- Independent review: exact #109 diff plus the added asynchronous socket-error guard inspected; no confirmed P0-P2 issue.
- Commands run: see implementation notes and final local commit evidence.
- Manual checks: authenticated real Unix-socket connections combine the fake `write(false)`/throw oracle with actual handshake, frame delivery, close, listener, and abort behavior; the server socket then emits `error` from a timer while output remains queued, proving asynchronous error teardown removes the drain listener and prevents a later write.
- Supporting artifacts: pre-fix artifact and focused control-server suite.
- Implementation notes reviewed: `tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md`.
- Run snapshot: local strict workflow check after final documentation update.

## Manual Check Evidence

No non-built-in manual check is required by this contract. The focused suite is the deterministic/runtime oracle.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-plugin
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:d15d9de794cbce6a516473f6a94cfa5898bb2daaa7393fa74d82e21efbfbde1b
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576
> **Verification Evidence SHA256**: sha256:cda7c8a3bc2aaa9ec657183447d43f70d3c31db44df491b500ca74f304a955ff
> **Issued At**: 2026-08-31T20:44:02.045Z

- Summary: GitHub #109 bounds each authenticated control connection's retained outbound queue, stops writes until drain, and aborts active streams on overflow or socket failure; exact-delta review found no confirmed P0-P2 issue, with accepted #108 retained as the normalized dependency.
- Findings: none

## Behavior Diff Notes

- The outbound writer is private to a connection and does not alter the control wire schema or synchronous `emit` API.

## Residual Risks / Follow-ups

- The 1 MiB ceiling covers JavaScript-retained frames per authenticated connection, not Node/kernel buffers or aggregate connections.

## Failing Items

- None in scope.

## Retest Steps

- Re-run: focused control-server suite and the root required checks on the exact local commit.
- Re-check: queue bytes before direct write, false/drain FIFO behavior, and all terminal teardown paths against the frozen contract.

## Summary

- PASS: issue #109 behavior and acceptance criteria are complete on the frozen candidate; receipt projection is recorded separately by the parent gate.
