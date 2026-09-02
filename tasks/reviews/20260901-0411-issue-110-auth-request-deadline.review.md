# Task Review: issue-110-auth-request-deadline

> **Status**: Accepted
> **Plan**: plans/plan-20260901-0411-issue-110-auth-request-deadline.md
> **Contract**: tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md
> **Notes File**: tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-01 04:21
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:2a4f83bdd056920dc227915a90fa19395ca74d97e0f5310a75751e3d625b4bae
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576

## Human Review Card

- Verdict: pass; independent exact-diff review found no confirmed P0-P2 issue.
- Change type: bugfix
- Intended files changed: AuthManager, daemon config composition, auth/config tests, HTTP fixture, plan/contract/review/notes/pre-fix artifact.
- Actual files changed: matches contract allowed paths.
- Commands passed: focused auth/config Vitest, client typecheck/build, root build/typecheck/test, `git diff --check`.
- Residual risks: a first root test run saw an out-of-scope cloud-dataplane wrangler dry-run test exceed its 5s local timeout; its isolated rerun and the full root rerun passed without a source change.
- Reviewer action required: none.
- Rollback: revert the AuthManager request deadline/controller, daemon config composition, fixture and coupled tests together.

## Mode Evidence

- Selected route: strict bugfix
- P1/P2/P3 evidence: plan §§ P1/P2/P3 and contract `Root Cause Evidence` trace the credential mutation tail through pair/challenge/token/body read to shutdown.
- Root cause or plan evidence: deterministic pre-fix artifact records four short-guard failures on the base behavior.

## Verification Evidence

- Waza `/check` run: not invoked; dispatch requested repo-harness strict workflow instead.
- Commands run: focused client test/typecheck/build; root build/typecheck/test; static contract preflight; `git diff --check`.
- Manual checks: independent review confirmed each pair/challenge/token HTTP and body operation has one bounded controller, stop aborts before awaiting the tail, and only actual 401 responses revoke.
- Supporting artifacts: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.pre-fix.txt`.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/checks/latest.json` remains a workflow-owned projection and must not be treated as an AcceptanceReceipt.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [x] No non-built-in manual check is declared by the contract.
  - Evidence: deterministic auth/daemon tests cover the declared behavior.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-plugin
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:2a4f83bdd056920dc227915a90fa19395ca74d97e0f5310a75751e3d625b4bae
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576
> **Verification Evidence SHA256**: sha256:c9b5635040ccd88f93c8148328ce834a70c4e7aa531e3a6890c257536e4e4509
> **Issued At**: 2026-08-31T20:45:19.365Z

- Summary: GitHub #110 bounds each pair, challenge, token, and response-body operation, aborts active auth I/O before shutdown waits on credential mutation, and preserves revocation and credential authority; exact-diff review found no confirmed P0-P2 issue.
- Findings: none

## Behavior Diff Notes

- Pair, challenge, token body, and error-body operations now share one AuthManager request controller through body parse.
- Shutdown aborts the active request before awaiting the credential mutation tail.
- Deadline/cancellation is `AuthRequestAbortedError`; revocation stays constrained to real challenge/token 401 responses.

## Residual Risks / Follow-ups

- No partial credential persistence was observed in the timeout/cancellation guards.
- The 15s production default is configurable through `DaemonConfig.authRequestDeadlineMs`; the contract tests use short deterministic deadlines. It applies per auth HTTP/body operation, not to the whole multi-request renewal transaction.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | All GitHub #110 acceptance cases pass. |
| Product depth | 9/10 | Deadline, shutdown, persistence, and revocation boundaries are covered. |
| Design quality | 10/10 | AuthManager remains the single cancellation authority. |
| Code quality | 9/10 | Small typed surface with deterministic race/body tests. |

## Failing Items

- None in the bounded source scope.

## Retest Steps

- Re-run: `bun run --cwd packages/client test -- src/__tests__/daemon-auth.test.ts src/__tests__/bin-config.test.ts`
- Re-check: `bun run build && bun run typecheck && bun run test && repo-harness run check-task-workflow --strict && git diff --check`

## Summary

- PASS: GitHub #110 behavior and acceptance criteria are complete on the frozen candidate; receipt projection is recorded separately by the parent gate.
