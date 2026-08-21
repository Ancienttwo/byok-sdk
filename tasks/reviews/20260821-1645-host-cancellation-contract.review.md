# Task Review: host-cancellation-contract

> **Status**: Accepted
> **Plan**: plans/plan-20260821-1645-host-cancellation-contract.md
> **Contract**: tasks/contracts/20260821-1645-host-cancellation-contract.contract.md
> **Notes File**: tasks/notes/20260821-1645-host-cancellation-contract.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-21 18:07
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:6959bbfeec6a076959ebe8ea4d6f770f22178b0983eb19562c14764775707505
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 1edbfdd9ad33df3da4d0f1ac43f9067981c001ec

## Human Review Card

- Verdict: accepted by contract-bound user waiver after the external Claude
  review produced no verdict in either bounded attempt.
- Change type: code-change
- Intended files changed: U1 cloud, dataplane, client, conformance, additive
  migration, docs, and contract-scoped workflow artifacts.
- Actual files changed: matches the contract allow-list; U4 execution
  contract/notes/review were removed from the U1 branch ancestry.
- Commands passed: contract 14/14; real PostgreSQL + MinIO cancellation and SQL
  invariants; build; typecheck; full test; strict workflow; final
  `verify-sprint`.
- Residual risks: no external Claude verdict and no remote CI, publish, deploy,
  or production migration evidence.
- Reviewer action required: none for the local candidate; PR/CI and release
  authority remain separate.
- Rollback: revert the U1 commits; the migration is additive and has not been
  applied to production.

## Mode Evidence

- Selected route: parallel implementation workers plus independent read-only
  exact-SHA gatekeeper; contract-bound user waiver after Claude was unavailable.
- P1/P2/P3 evidence: host `cancelTask()` -> atomic tombstone and mailbox ->
  offer suppression or running-session interrupt/close -> cancellation-first
  terminal projection; one authority and no compatibility fallback.
- Root cause or plan evidence:
  `plans/plan-20260821-1645-host-cancellation-contract.md` and the U1 notes.

## Verification Evidence

- Waza `/check` run: not used; independent gatekeeper reviewed the exact frozen
  candidate and returned PASS.
- Commands run: all 14 contract exit criteria, including hard-env PostgreSQL +
  MinIO tests, build, typecheck, full test, and strict workflow.
- Manual checks: product/runtime tree equality across the final history cleanup;
  clean worktree before receipt; no U4 contract ancestry in U1.
- Supporting artifacts: `.ai/harness/checks/latest.json` and the prepared run
  snapshot below.
- Implementation notes reviewed: yes.
- Run snapshot:
  `.ai/harness/runs/run-20260821T174236-42112-20260821-1645-host-cancellation-contract.json`.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract-specific `manual_checks` were declared; all exit criteria are
  machine-verifiable and passed.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:6959bbfeec6a076959ebe8ea4d6f770f22178b0983eb19562c14764775707505
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 1edbfdd9ad33df3da4d0f1ac43f9067981c001ec
> **Verification Evidence SHA256**: sha256:432d172d8fee8df12584283548b532148ccdee789c103b14833e9c6078551aad
> **Issued At**: 2026-08-21T10:06:58.468Z

- Summary: Owner-approved user waiver after frozen candidate passed contract, PostgreSQL/MinIO, full checks, and independent internal gate; Claude external review was unavailable after both bounded attempts.
- Findings: none

## Behavior Diff Notes

- Host cancellation atomically persists a tenant-scoped tombstone and device
  delivery; duplicate requests reuse the same durable authority.
- Cancelled offers are suppressed across filtered cursor pages, while running
  tasks reuse the existing client interrupt/close lifecycle.
- Accepted cancellation outranks later terminal success in both status CAS and
  business projection.

## Residual Risks / Follow-ups

- Claude produced no review text after the bounded `fable` and `opus` attempts;
  this is accepted explicitly by the recorded user waiver, not represented as
  an external pass.
- Remote CI, registry publication, deployment, production migration, and secret
  mutation remain unperformed and unauthorized by this review.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 0/10 | |
| Product depth | 0/10 | |
| Design quality | 0/10 | |
| Code quality | 0/10 | |

## Failing Items

- None in the locally verified subject.

## Retest Steps

- Re-run the contract's `commands_succeed` matrix with PostgreSQL and MinIO
  configured, then `repo-harness run verify-sprint --prepare-acceptance` after
  any semantic change.
- Re-check the typed AcceptanceReceipt because subject, target, contract, goal,
  or verification drift invalidates it.

## Summary

- U1 is accepted locally by typed user waiver and may enter the separately
  authorized PR/CI ship gate; this review grants no publish or deploy authority.
