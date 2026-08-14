> **Archived**: 2026-08-14 14:45
> **Related Plan**: plans/archive/plan-20260814-0947-quiescent-runtime-disposal.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260814-1445

# Task Review: quiescent-runtime-disposal

> **Status**: Complete
> **Plan**: plans/plan-20260814-0947-quiescent-runtime-disposal.md
> **Contract**: tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md
> **Notes File**: tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-14 10:49
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:af8f5889189e9b9b38824fd5cf63bf347cbbec608e53c12e597da4063ff778b5
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: aa15f85ac834421efb8d125f18f7a7b77cd718c7

## Human Review Card

- Verdict: pass (host semantic review); external Claude opinion unavailable
- Change type: code-change
- Intended files changed: client runtime ownership, TaskRunner finalization, observer/audit, built smoke/CI, 0.4.0 docs, workflow evidence
- Actual files changed: 42 files, 1744 insertions, 181 deletions against `main`
- Commands passed: strict Sprint verification 20/20 at run snapshot below
- Residual risks: Windows `taskkill /T /F` behavior is covered by CI but was not executed on this macOS host
- Reviewer action required: record the contract's Claude AcceptanceReceipt or exercise the explicit user-waiver path
- Rollback: revert implementation commit as one unit; do not retain detached spawn without group disposal

## Mode Evidence

- Selected route: strict code-change contract, host semantic review after frozen verification
- P1/P2/P3 evidence: architecture/process trace and decision rationale are recorded in the plan and implementation notes
- Root cause or plan evidence: pre-fix child-plus-descendant RED artifact plus real built smoke

## Verification Evidence

- Waza `/check` run: equivalent strict contract gate passed 20/20
- Commands run: contract `tests_pass`; targeted TaskRunner/Git/Codex Vitest; client typecheck/test/build/smoke; workspace typecheck/test/build; strict workflow
- Manual checks: real built smoke proved Pi/Claude/Codex root and descendant absence before active ownership reached zero
- Supporting artifacts: `.ai/harness/checks/latest.json`; pre-fix artifact; bounded smoke probe receipt
- Implementation notes reviewed: `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`
- Run snapshot: `.ai/harness/runs/run-20260814T104709-92580-20260814-0947-quiescent-runtime-disposal.json`

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` requirements were declared.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:af8f5889189e9b9b38824fd5cf63bf347cbbec608e53c12e597da4063ff778b5
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 069f3fc781f7cfc20dd935a38e7343493ae31722
> **Verification Evidence SHA256**: sha256:8ebac33ce95c9248b85f6e41f38f5633de2276b9826a311b7a1e7ce7936ef670
> **Issued At**: 2026-08-14T06:40:37.029Z

- Summary: kito approved the contract-bound user waiver after the bounded Claude exact-SHA review returned only Execution error; accept the frozen host review and passing strict verification evidence.
- Findings: none

## Behavior Diff Notes

- POSIX runtime roots are detached group leaders; close performs TERM, bounded group proof, KILL escalation, and root-close proof.
- TaskRunner reserves one semantic terminal, retains active/Git ownership on typed disposal failure, and retries disposal without a second terminal.
- Codex registers follow-up runners at spawn time so concurrent close cannot miss a child.
- Claude cleanup runs only after process quiescence and rejects with typed cleanup failure.

## Residual Risks / Follow-ups

- Windows behavior remains CI-only evidence on this host.
- External Claude acceptance is unresolved because the one bounded invocation returned `Execution error`; it is not represented as a pass.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Real process-tree, retry, lease, terminal-race, and built composition evidence pass. |
| Product depth | 9/10 | Contract covers all bundled runtimes, shutdown, observer/audit, and supported CI OSes. |
| Design quality | 9/10 | One disposal primitive and typed failure authority; no compatibility path. |
| Code quality | 9/10 | Full workspace gate passes; final host review races have regression coverage. |

## Failing Items

- External AcceptanceReceipt is missing; no code finding remains open.

## Retest Steps

- Re-run: `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md`
- Re-check: exact target `aa15f85ac834421efb8d125f18f7a7b77cd718c7`, checks subject hash, and AcceptanceReceipt policy

## Summary

- Host recommendation: PASS. Do not merge/close the Sprint row until the required external acceptance authority is recorded or the user explicitly exercises the allowed waiver.
