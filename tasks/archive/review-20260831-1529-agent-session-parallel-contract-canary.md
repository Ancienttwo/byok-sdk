> **Archived**: 2026-08-31 15:29
> **Related Plan**: plans/archive/plan-20260831-1248-agent-session-parallel-contract-canary.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260831-1529

# Task Review: agent-session-parallel-contract-canary

> **Status**: Accepted
> **Plan**: plans/plan-20260831-1248-agent-session-parallel-contract-canary.md
> **Contract**: tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md
> **Notes File**: tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-31 14:50
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:fe0863c72c5783bc3908bda3e3f042920b6fb89a15d71b3e037dc953f12ca755
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 7a937e5ed8eb5aef102eacb0df9183f296da7e1f
> **Current Candidate Subject SHA256**: sha256:fe0863c72c5783bc3908bda3e3f042920b6fb89a15d71b3e037dc953f12ca755
> **Current Candidate Claude Review**: skipped-no-output

## Human Review Card

- Verdict: the exact-subject independent gate failed on two confirmed P1s;
  the repaired source and installed artifact pass locally, but the changed
  candidate's approved Claude attempt was `SKIPPED` without review output and
  therefore provides no fresh external acceptance.
- Change type: code-change plus release-artifact falsifier.
- Intended files changed: Agent execution lease/TaskRunner/shared stores, source regression, product docs, public type export, and existing pack/install smoke.
- Actual files changed: the ten intended source/contract paths plus workflow plan/contract/notes/review.
- Commands passed on the repaired source: targeted 28-test concurrency boundary, root build/typecheck/full test, and exact ten-tarball pack/install smoke. Strict workflow and final diff check are rerun after evidence projection.
- Residual risks: the host projection callback still runs under a non-reentrant per-home mutation gate; opaque Agent-owned files are not serialized; publish/downstream/live runtime remain separate gates.
- Reviewer action required: do not retry or narrow the exhausted Claude-review flow. The current candidate still needs a policy-compliant AcceptanceReceipt or an explicitly authorized user waiver before any local merge decision.
- Rollback: revert repaired source candidate `8042cee` together with the earlier session-parallel commits; no registry or production rollback exists.

## Mode Evidence

- Selected route: isolated standard worktree with one source review and exact installed-artifact canary.
- P1/P2/P3 evidence: approved plan and implementation notes map home marker, session lifecycle, shared stores, and release artifact authority.
- Root cause or plan evidence: the old `TaskRunner` acquired a `canonicalHome` lease before session handoff and retained it through terminal cleanup, so unrelated sessions were declined before runtime start.

## Verification Evidence

- Waza `/check` run: not invoked. Claude review was explicitly approved and exhausted its two bounded attempts without stdout; transcript recovery was empty, so the advisory result is `SKIPPED`.
- Commands run on repaired source: targeted contract test, root build/typecheck/full test, and `bun run check:release-pack`; strict workflow and final diff check follow the evidence update.
- Manual checks: confirmed both P1 paths against the reviewed code, verified rejected resume rebind retains the original admission key, and ran the parallel-close projection guard red then green.
- Supporting artifacts: pack manifest stdout bound to repaired source `8042cee029828451d86fddd868500c403a0bbe23` and client tarball SHA-256 `bca8ae94fd7db5e43b146aca83c3fb9cc6be4b975788262056f7018c1c494567`.
- Implementation notes reviewed: `tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md`.
- Run snapshot: `.ai/harness/checks/latest.json` remains stale for the repaired
  subject. The old subject's two-P1 failure remains authoritative only for that
  subject; the repaired subject has no semantic verdict or AcceptanceReceipt.

## Fresh Claude Review Attempt — 2026-08-31

- Subject: `sha256:fe0863c72c5783bc3908bda3e3f042920b6fb89a15d71b3e037dc953f12ca755` against `main@7a937e5ed8eb5aef102eacb0df9183f296da7e1f`.
- Scope: the ten paths selected by `.ai/harness/checks/change-assessment.latest.json`; the worktree was clean.
- Mode: read-only `Read,Grep,Glob`; no Bash/Edit/Write tools.
- Outcome: `SKIPPED`. `fable` and the sole `opus` fallback returned no stdout; transcript recovery found no assistant text.
- Diagnostic: Claude Code reported that local model `glm-5.3-flash` was unrecognized by this client version. This is tooling evidence, not a code finding.
- Authority effect: none. No finding, pass, AcceptanceReceipt, waiver, or merge authority was created.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` requirements.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:fe0863c72c5783bc3908bda3e3f042920b6fb89a15d71b3e037dc953f12ca755
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 7a937e5ed8eb5aef102eacb0df9183f296da7e1f
> **Verification Evidence SHA256**: sha256:7bfb112bef9d3bde242c24f060fe8d304ef6c2f8dba685095feb93cf6b11dceb
> **Issued At**: 2026-08-31T06:49:35.854Z

- Summary: User explicitly chose to skip the unavailable external Claude verdict for the repaired frozen subject after the bounded review attempts produced no verdict; this waiver is acceptance-only and does not authorize merge, push, publish, deployment, downstream upgrade, or production unpause.
- Findings: none

## Behavior Diff Notes

- Different sessions under one Agent share the canonical home and process-owned
  activity marker without sharing an execution key. A duplicate session cannot
  acquire a second lease. SDK-reserved mutations remain serialized; relocation
  becomes available only after the final execution lease exits.
- An exact-resume lease is immutable with respect to `sessionRef`. A mismatched
  runtime bind fails closed and the original session key remains busy until
  release.
- Same-home session closes serialize the complete Agent-memory projection
  transaction, so each outbox open observes the prior durable high-water and
  both snapshots publish in source-sequence order.

## Residual Risks / Follow-ups

- Task-free Profile projection still requires a quiescent home in this slice;
  changing that control-plane lifecycle was not required to prove parallel
  session execution.
- Projection preparation currently executes under the per-home non-reentrant
  mutation gate. Re-entry can deadlock and a slow callback can head-of-line
  block sibling sessions; this remains an explicit P2 for fresh review.
- Registry publication, Salesko pinning, compiled-host canary, device rollout,
  and production unpause remain unperformed.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | accepted by user waiver | Repaired source and installed artifact pass; the typed receipt binds the exact repaired subject. |
| Product depth | accepted by user waiver | Core session behavior is implemented; projection-gate re-entry remains a documented P2 residual risk. |
| Design quality | accepted by user waiver | One Agent identity and home authority are preserved; the external Claude verdict was unavailable and explicitly waived. |
| Code quality | accepted by user waiver | Full local verification and the exact installed-tarball canary pass on the frozen subject. |

## Failing Items

- External gate: FAIL for reviewed subject
  `sha256:888be6be7109855511d3d3c9d479adbd4fcf182199e347b4e7ba5bd5aa9fa9d6`
  because exact-resume `bindSession` could re-key and admit duplicate execution,
  and parallel close could lose one Agent-memory projection to CAS conflict.
- Current repaired subject: the Claude attempt remained `SKIPPED`, but the user
  explicitly exercised the contract-permitted waiver. The typed receipt is
  valid and exact-subject acceptance is satisfied; local merge remains a
  separate authorization boundary.

## Retest Steps

- Do not rerun or narrow the exhausted `claude-review` flow for this subject.
- Verify the existing typed `user_waiver` receipt before any separately
  authorized local merge; do not reinterpret it as push, publish, deployment,
  downstream-upgrade, or production-unpause authority.
- Re-check: same Agent/different session overlap, duplicate session rejection,
  rejected mismatched resume rebind retaining the original key, final lease
  release, parallel-close projections at source sequences 1 and 2, and manifest
  `sourceGitSha`.

## Summary

- Both P1 findings are locally remediated, the repaired packed artifact passes,
  and the exact repaired subject is accepted through the contract-permitted
  user waiver. No local merge, push, publish, downstream upgrade, or production
  unpause was performed.
