# Task Review: issue-103-mailbox-cursor-atomicity

> **Status**: Passed
> **Plan**: plans/plan-20260831-2304-issue-103-mailbox-cursor-atomicity.md
> **Contract**: tasks/contracts/20260831-2304-issue-103-mailbox-cursor-atomicity.contract.md
> **Notes File**: tasks/notes/20260831-2304-issue-103-mailbox-cursor-atomicity.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-31 23:54
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass; independent gatekeeper found no P0-P3 finding after the
  Postgres zero-cursor correction.
- Change type: bugfix / migration / shared core contract
- Intended files changed: contract `allowed_paths` only.
- Actual files changed: 21 tracked or untracked work-package files; all are
  listed by the contract.
- Commands passed: focused route 15/15; in-memory core 71/71; real Postgres
  core 71/71; real Postgres cloud/cleanup/catalog 72/72; root typecheck,
  build, full test, deploy SQL check, strict contract, strict workflow, and
  diff checks.
- Residual risks: migration was exercised only on disposable Postgres;
  production migration and deploy remain separately gated.
- Reviewer action required: none for local source acceptance.
- Rollback: revert the core port, both implementations, route, migration, and
  tests as one work package.

## Mode Evidence

- Selected route: bugfix with root-cause prover, read-only architecture map,
  implementation, then independent gatekeeper.
- P1/P2/P3 evidence: active plan `Agentic Routing` and implementation notes.
- Root cause or plan evidence: tracked non-zero pre-fix artifact proves the
  forged future cursor advanced durable acknowledgement on the clean base.

## Verification Evidence

- Waza `/check` run: not invoked; independent gatekeeper reviewed the exact
  diff and returned PASS with no P0-P3 finding.
- Commands run: contract `commands_succeed`; root `bun run typecheck`, `bun run
  build`, and `bun run test`; `bun run check:deploy-sql`; strict workflow and
  diff checks.
- Manual checks: the gatekeeper inspected the guarded Postgres statement and
  confirmed only `moved_zero` or `moved_positive` can drive outbox marking.
- Supporting artifacts: pre-fix failure artifact, contract run logs, and
  gatekeeper verdict.
- Implementation notes reviewed: yes.
- Run snapshot: subject-bound acceptance evidence pending.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` requirements.

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded.
- Findings: none

## Behavior Diff Notes

- A mailbox cursor can advance only to a cursor previously recorded as
  delivered by the server; an enqueued sequence is not delivery authority.
- Unsafe integer cursors fail with 400; safe future cursors fail with 409 and
  leave cursor and outbox state unchanged.
- Reads remain non-acknowledging. In-memory delivery and acknowledgement share
  the per-device serializer; Postgres delivery/ack bounds and outbox marking
  remain atomic.

## Residual Risks / Follow-ups

- Forward migration `0016` still requires an independently approved production
  migration/deploy slice. This review covers source and disposable database
  evidence only.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Forged/unsafe/zero/normal cursor paths pass in both compositions. |
| Product depth | 9/10 | Protects the HTTP route, shared port, both stores, smoke caller, and schema invariant. |
| Design quality | 9/10 | One server-owned delivery authority; no enqueue-derived or handler-local fallback. |
| Code quality | 9/10 | Typed conflict, explicit migration, conformance parity, and atomic Postgres statement. |

## Failing Items

- None.

## Retest Steps

- Re-run: contract `commands_succeed`, especially both real Postgres suites.
- Re-check: migration readback and production rollout only under a separate
  approved deployment contract.

## Summary

- PASS. The forged future-cursor data-loss path is closed without changing
  normal monotonic replay semantics; the exact diff is ready for local
  subject-bound acceptance.
