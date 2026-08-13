# Task Review: typed-runtime-failure-taxonomy

> **Status**: Pass
> **Plan**: plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md
> **Contract**: tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md
> **Notes File**: tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-14 04:22
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:b7eebc7ce2b1c722ce92567fa2c09a6bd13e6ae3cfb94c98bb7db9ca212e52d6
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 8573a18a86d966d1a2eb9709404c859faf73249d

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: shared client failure contract, TaskRunner projection, three bundled adapters, fixtures/tests, and spec/security/architecture truth.
- Actual files changed: exactly the allowed Row 2 client/docs/workflow surfaces recorded in `.ai/harness/checks/latest.json`.
- Commands passed: all 16 contract checks, including client/full workspace typecheck-test-build, built adapter smoke, Bun contract tests, and strict workflow.
- Residual risks: four Claude `[P2]` advisories are recorded in the AcceptanceReceipt projection below; none changes current wire correctness.
- Reviewer action required: none; exact-SHA external acceptance is recorded.
- Rollback: revert `ff8a72a`, `b39c359`, and `cfdaef3` together; do not retain typed and generic/text-derived authority in parallel.

## Mode Evidence

- Selected route: approved sprint work-package with exact-SHA Claude semantic acceptance.
- P1/P2/P3 evidence: `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md` records the public seam, concrete start/run trace, and explicit no-inference decision.
- Root cause or plan evidence: plan §Captured Planning Output and tests show previous generic start/run catches projected nearly all failures retryable.

## Verification Evidence

- Waza `/check` run: represented by strict `verify-sprint` contract + workflow gates; all passed.
- Commands run: the 16 machine-verifiable exit criteria in the contract, all pass.
- Manual checks: none required by the contract.
- Supporting artifacts: `.ai/harness/checks/latest.json` and exact-SHA Claude review of `cfdaef3` against local `main@8573a18`.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/run-20260814T041428-18403-20260814-0010-typed-runtime-failure-taxonomy.json`.

## Manual Check Evidence

- None required.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:b7eebc7ce2b1c722ce92567fa2c09a6bd13e6ae3cfb94c98bb7db9ca212e52d6
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 8573a18a86d966d1a2eb9709404c859faf73249d
> **Verification Evidence SHA256**: sha256:0d6a657ff78d41956a394c736b65e438e78ca5326a40048a1bed517d9cc44590
> **Issued At**: 2026-08-13T20:21:11.278Z

- Summary: Exact-SHA review of cfdaef3 found no P0/P1; typed failure authority is mergeable with four advisory residuals.
- Findings: P2: Pi resume now verifies get_state session identity, but only the fake fixture proves the resumed-id invariant; live Pi evidence and clearer requested/got diagnostics remain.; P2: Claude manifest-authority failures after task-scoped MCP config creation can leave the temporary config directory behind.; P2: Synchronous spawn constructor catches are not the normal Node ENOENT path; real missing binaries use the asynchronous typed exit path, so the injected test proves only the sync seam.; P2: PolicyUnsupportedError remains exported for other policy/follow-up surfaces, but start/run now intentionally treat it as an untyped contract violation and replace its wire reason.

## Behavior Diff Notes

- Expected adapter start/run failures now carry frozen, runtime-validated
  phase/category/retry authority. TaskRunner performs one projection to the
  unchanged `task.fail.reason/retryable` wire.
- Pi/Claude/Codex translate native semantic failure, transport/process loss,
  malformed terminal evidence, and session/manifest mismatch at their own
  boundaries. Diagnostic `AgentEvent.error` is not terminal authority.
- Bare throws, wrong-phase values, and clean Session iterator end fail closed
  as stable non-retryable adapter-contract violations.
- Root and adapter-only bundles recognize the same public failure via a
  versioned global-symbol brand plus closed-field validation.

## Residual Risks / Follow-ups

- `[P2]` Live Pi resume still needs empirical confirmation that `get_state`
  reports the requested resumed id; current coverage uses the version-matched
  fake fixture.
- `[P2]` Two Claude manifest-authority paths can leave a task-scoped MCP temp
  config directory behind.
- `[P2]` Synchronous spawn-constructor catches are a test seam; ordinary Node
  ENOENT flows through the asynchronous typed exit path.
- `[P2]` `PolicyUnsupportedError` remains public for policy/follow-up uses, but
  intentionally no longer preserves its reason when thrown at start/run.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | Full negative/positive matrix and built smoke pass; live Pi resume remains advisory. |
| Product depth | 9/10 | Public custom-adapter contract and all bundled adapters migrate atomically without wire change. |
| Design quality | 9/10 | One typed authority, explicit retry disposition, no message parser, teardown kept separate. |
| Code quality | 9/10 | Full workspace gates pass; four bounded P2 cleanup/evidence/docs issues remain. |

## Failing Items

- None.

## Retest Steps

- Re-run: `repo-harness run verify-sprint`.
- Re-check: AcceptanceReceipt subject/target freshness and allowed-path scope.

## Summary

- PASS. Exact-SHA Claude review found no P0/P1, the external-pass receipt is
  valid, and all machine gates are green.
