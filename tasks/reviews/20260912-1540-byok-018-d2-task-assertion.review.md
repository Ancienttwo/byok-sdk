# Task Review: byok-018-d2-task-assertion

> **Status**: Accepted
> **Plan**: plans/plan-20260912-1540-byok-018-d2-task-assertion.md
> **Contract**: tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md
> **Notes File**: tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-13
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:87593a52cbebc61b0eacf131e56914558c0cb71017018b2d18405fcb028a8989
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: fd1ae215ce654c93798be3c45d04bd2bcfeec4c0

## Human Review Card

- Verdict: PASS for the C05 SDK candidate; no merge/release/Host integration claim.
- Change type: code-change; task-scoped assertion/replay/capability, with bounded discovery admission.
- Intended/actual files: exact final Change Assessment packet; all paths passed Allowed Paths. Prior slices 1–4 reused their accepted boundary evidence; new source delta 5b351af4..44fd3661 inspected independently, then 44fd3661..90cf5de6 metadata inspected on the final clean head.
- Commands passed: build, typecheck, test, check:api-surface, check:version-authority, check-task-workflow --strict, retained check:release-pack; check:deploy-sql and git diff --check also pass.
- Rollback: unpublished source branch; no package version/lock changes or production side effects.

## Mode Evidence

P1: daemon owns declaration discovery; TaskRunner owns one-time child env and nonce creation. Core/cloud own strict signed-envelope validation, replay authority owns schema-separated one-use consumption.

P2: real HTTP declaration held by a fixture barrier -> first task offer -> adapter selection -> nonce freeze. Pre-fix runtime started while declaration was pending. Fixed path waits before env freeze and obtains distinct server nonces after the declaration lands.

P3: one bounded read per connection generation, 5000ms per read and per offer; reconnect does not reset an offer deadline. Cancel/shutdown interrupt admission, stale reads cannot republish, tasks without host toolsets do not wait. Missing/invalid declaration remains fail-closed with explicit task-lane observer reasons. No device-only fallback or nonce reissuance.

## Verification Evidence

- Independent gate: c05_delta_gate PASS on clean 90cf5de6, reusing its 44fd3661 product review; no blocking findings.
- Root evidence: .ai/harness/runs/run-20260913T043139-17673-20260912-1540-byok-018-d2-task-assertion.json — 12/12 criteria pass, all seven executable commands exit 0.
- Root tests: 109752ms, exit 0. Focused task broker/presence 42/42 plus cancellation regression 1/1 passed.
- Pre-fix guard: _ops/byok-018-d2/discovery-prefx.log, PRE_FIX_EXIT=1. Fixed guard: discovery-postfix.log.
- Artifact: _ops/byok-018-d2/artifacts-c05-final/release-manifest.json, sourceGitSha 90cf5de6a8f31154dfaa046491b4d7f9e9e54f64; all 10 SHA256 values independently matched retained tarballs.
- Packed client SHA256: 64c66b0c048a20b60f6b983b6016f378db2f6cab0feb2172c68351384c0b1bef. Other nine tarballs match the previous accepted candidate. Nominal versions remain 0.18.0 / keys 0.5.0.
- Existing PostgreSQL evidence remains applicable: migration 0022, replay store and replay regression test have no diff against accepted slice 1 c6dc5b5c.

## Manual Check Evidence

No additional contract manual_checks requirements. Hash/readback and independent review evidence are recorded above.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:87593a52cbebc61b0eacf131e56914558c0cb71017018b2d18405fcb028a8989
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: fd1ae215ce654c93798be3c45d04bd2bcfeec4c0
> **Verification Evidence SHA256**: sha256:1afe8e4e86218d595808cb684d71a53821c30a79278b9e6532a2df8120d35310
> **Issued At**: 2026-09-13T04:54:03.041Z

- Summary: C05 product acceptance reused; Owner-approved historical workstream ownership delta reviewed PASS; 15 criteria fulfilled with immutable baselines and four current delta checks; main WIP preserved
- Findings: none

## Residual Risks / Follow-ups

- C05 SDK scope only: Host cancellation/admission linearization and installed Salesko integration remain C06/C09, not a completed AC11/AC12/AC13 end-to-end claim.
- Candidate artifacts are local and unpublished. Registry, native device and production deployment remain unverified/unperformed.
- Migration 0022 has an ACCESS EXCLUSIVE scheduling requirement at release. S3/workerd limitations and the historical core no-import guard remain report-only as documented in prior notes.
- Prior approved blocking repairs restore the review base and retire an unowned seed. The separately Owner-approved closeout slice moves two historical SDK workstreams to the actual capability directory; source ownership itself is unchanged.

## Summary

C05 candidate is accepted for typed receipt finalization and a Draft PR. Product and metadata gates report no blocking findings at the frozen source; source/packed/Host/release evidence remain explicitly separated.


## Approved workflow delta review — 2026-09-13

Codex inspected fb83517b..c156b6df: exactly two workstream moves and one Capability ID replacement per file; their status, TODOs and historical content are byte-preserved. Contract/plan/notes declare the Owner-approved scope and original rename deletion, with explicit immutable baseline references and four current delta checks. No non-workflow tracked input differs from candidate 90cf5de6. Main checkout status and full WIP diff remain byte-identical. PASS; no new product review requested or repeated.

Current prepare evidence: `.ai/harness/runs/run-20260913T125325-19608-20260912-1540-byok-018-d2-task-assertion.json`, 15/15 fulfilled, six historical checks retained with current source equality, strict workflow, capability validation and all ten artifact hash readbacks. This replaces the old contract-bound receipt without reproducing candidate artifacts.
