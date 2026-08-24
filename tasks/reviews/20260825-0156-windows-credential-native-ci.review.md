# Task Review: windows-credential-native-ci

> **Status**: Pending
> **Plan**: plans/plan-20260825-0156-windows-credential-native-ci.md
> **Contract**: tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md
> **Notes File**: tasks/notes/20260825-0156-windows-credential-native-ci.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-25 03:55
> **Recommendation**: fail
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: fail
- Change type: code-change
- Intended files changed: Windows credential bridge, native falsifier, CI wiring and task artifacts only
- Actual files changed: intended files only; no manifest, lockfile, Salesko or release files
- Commands passed: focused client tests, client typecheck, workflow YAML parse, strict task workflow, `git diff --check`
- Residual risks: hosted Windows still reports only an outer PowerShell `COR_E_SYSTEM`; the deepest exception kind is not yet observed
- Reviewer action required: require a new bounded deepest-inner classifier before any further production correction
- Rollback: revert this slice to `d0940f131cac4df44be506dc9d05153f1fb58e2f`

## Mode Evidence

- Selected route: strict code-change work package
- P1/P2/P3 evidence: plan and implementation notes
- Root cause or plan evidence: remote phase-bounded native probe at exact PR head

## Verification Evidence

- Waza `/check` run:
- Commands run: focused tests, typecheck, YAML parse, strict workflow, diff check, exact GitHub job log readback
- Manual checks: exact Windows IPC and WinSW jobs remain red
- Supporting artifacts: task notes and GitHub Actions job logs
- Implementation notes reviewed: yes
- Run snapshot:

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [ ] Exact manual_checks requirement
  - Evidence: concrete observation, command output, screenshot path, or reviewer note

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

- ...

## Residual Risks / Follow-ups

- ...

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 0/10 | |
| Product depth | 0/10 | |
| Design quality | 0/10 | |
| Code quality | 0/10 | |

## Failing Items

- Native Windows absent-target read still fails at static bridge stage 4 with
  outer `kind=4,hresult=-2146233087`; primitive return, C# internal catches and
  moving process exit outside the outer catch did not expose the deepest cause.
  No round trip, IPC smoke or WinSW control-socket acceptance exists.

## Retest Steps

- Re-run: only after a bounded deepest-inner/FullyQualifiedErrorId classifier is frozen
- Re-check: native round trip, then exact Windows IPC and WinSW jobs

## Summary

- Merge recommendation: FAIL. Local static checks pass, but the only authoritative
  Windows provider acceptance remains red and the three repair iterations are exhausted.
