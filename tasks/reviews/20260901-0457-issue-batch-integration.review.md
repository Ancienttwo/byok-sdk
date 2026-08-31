# Task Review: issue-batch-integration

> **Status**: Accepted
> **Plan**: plans/plan-20260901-0457-issue-batch-integration.md
> **Contract**: tasks/contracts/20260901-0457-issue-batch-integration.contract.md
> **Notes File**: tasks/notes/20260901-0457-issue-batch-integration.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-01 05:25
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:c6c4747964f561df9bbb63b876f685e1def241e08d52cf3f7424af33614df360
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: accepted issue 105-111 product/test paths plus their workflow artifacts and this integration work package.
- Actual files changed: 54 files; zero paths outside the contract Allowed Paths.
- Commands passed: focused Cloud/Client suites, root build/typecheck/test, strict workflow, and `git diff --check`.
- Residual risks: tenant quota remains process-local by contract; OS socket buffering remains outside the JavaScript queue cap; auth deadlines remain per HTTP/body operation.
- Reviewer action required: none before the SHA-bound AcceptanceReceipt and merge seal.
- Rollback: revert the six issue merge commits and integration composition commit in reverse order; do not rewrite remote history.

## Mode Evidence

- Selected route: dependency-aware merge in an isolated worktree over frozen `origin/main`.
- P1/P2/P3 evidence: the plan maps each issue surface, traces accepted heads through merge/verification/push, and preserves accepted ancestry plus one authority per concurrency invariant.
- Root cause or plan evidence: the first combined egress test showed that placing open initiation inside the tenant tail broke #106 sharing; the first independent review then showed that awaiting/binding outside the tail hid preloaded records from #107 quota authority. The final split starts/reuses the home-bound promise before queueing, then awaits, binds, observes quota, and appends inside one tenant critical section.

## Verification Evidence

- Waza `/check` run: repository-native equivalent completed through focused tests, root required checks, and strict workflow.
- Commands run: `bun run --cwd packages/cloud test -- src/__tests__/request-body-limits.test.ts`; Client five-file focused command; `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`; `git diff --check`.
- Manual checks: all seven accepted heads are ancestors of the integration head; #108 is an ancestor of #109; changed-path allowlist comparison returned zero outside paths.
- Supporting artifacts: this review, integration notes, per-issue reviews/receipts, and `.ai/harness/checks/latest.json` after prepare verification.
- Implementation notes reviewed: yes.
- Run snapshot: final root suite passed with 3,372 tests passed and 109 skipped across package reports.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` requirements are declared by the contract.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-plugin
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:c6c4747964f561df9bbb63b876f685e1def241e08d52cf3f7424af33614df360
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576
> **Verification Evidence SHA256**: sha256:c0b0a86849e88a597b23eec5b80d5430a5e8cef75865e5df1ff4465ad1caf3bb
> **Issued At**: 2026-08-31T21:28:58.096Z

- Summary: Accepted issues 105-111 compose on frozen origin/main; combined focused and root verification passed with no remaining P0-P2 findings.
- Findings: none

## Behavior Diff Notes

- Issues 105-111 retain their accepted histories. The only new product composition is the Agent egress open/bind ordering needed to satisfy #106 and #107 simultaneously.
- The slow preloaded-open regression guard proves durable records enter aggregate authority before a cached peer append can observe tenant quota.

## Residual Risks / Follow-ups

- Process-local quota does not coordinate multiple daemon processes; this is explicitly outside #107's accepted contract.
- The first final-suite attempt timed out the unrelated Wrangler packaging dry-run while typecheck ran concurrently. The exact file passed 6/6 without parallel load, and the subsequent sequential root suite passed.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | All accepted focused guards and the full suite pass. |
| Product depth | 10/10 | Shared concurrency authorities are composed rather than replaced. |
| Design quality | 10/10 | Open identity and quota mutation remain distinct with one owner each. |
| Code quality | 10/10 | Narrow change, deterministic regression guard, clean typecheck/build. |

## Failing Items

- None.

## Retest Steps

- Re-run: the contract commands in order after workspace build artifacts exist.
- Re-check: accepted-head ancestry, Allowed Paths, AcceptanceReceipt, merge seal, and remote SHA readback.

## Summary

- Pass. No P0-P2 findings remain after the second independent integration review and parent verification.
