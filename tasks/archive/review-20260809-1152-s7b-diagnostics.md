> **Archived**: 2026-08-09 11:52
> **Related Plan**: plans/archive/plan-20260809-0638-s7b-diagnostics.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260809-1152

# Task Review: s7b-diagnostics

> **Status**: Accepted; awaiting PR merge/readback
> **Plan**: plans/plan-20260809-0638-s7b-diagnostics.md
> **Contract**: tasks/contracts/20260809-0638-s7b-diagnostics.contract.md
> **Notes File**: tasks/notes/20260809-0638-s7b-diagnostics.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-09 11:43
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 96dcbab9a43a6a2548e13e4829aecaf493252eff

## Human Review Card

- Verdict: pass；Codex exact-SHA `019fe498-37be-7592-b499-7a2af21b2953` accepted target `96dcbab9a43a6a2548e13e4829aecaf493252eff` and independently recomputed normalized subject `sha256:2dd7a3b1aee322318384f9dd78a20c6fbd5599930d383e215dc9dae99ec96f0b`；zero HIGH/MEDIUM findings。Claude review paused/not invoked。
- Change type: code-change
- Intended files changed: contract allowed paths
- Actual files changed: 34 files，runtime diff constrained to `packages/client/` plus Windows CI；protocol/core/keys/cloud/cloud-postgres/server/deploy SQL frozen surfaces zero diff。
- Commands passed: contract 19/19，including targeted diagnostics、client/full workspace typecheck/test/build、hard dataplane suite、frozen-surface check and strict workflow。
- Residual risks: none within S7-b acceptance boundary；PR #39 ran the diagnostics/security/packageability matrix on Windows Node 20/22 and all 34 checks passed。
- Reviewer action required: none；record exact-subject receipt, merge PR #39 and read back `main`。Claude remains paused/not invoked。
- Rollback: revert S7-b files；preserve any operator-created quarantine

## Mode Evidence

- Selected route: main-thread implementation + independent Codex exact-SHA acceptance
- P1/P2/P3 evidence: plan due-diligence section
- Root cause or plan evidence: sprint S7.3/S7.4 and architecture §14.3.3/§15.3

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:2dd7a3b1aee322318384f9dd78a20c6fbd5599930d383e215dc9dae99ec96f0b
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 489255baab10a51173302984fac0ef524734fa42
> **Verification Evidence SHA256**: sha256:f04fe2bff0a7dd8a135c4274194ee8f11ff48844db5f9b73f3a23526fcfe392a
> **Issued At**: 2026-08-09T03:45:47.799Z

- Summary: Independent exact-SHA review 019fe498-37be-7592-b499-7a2af21b2953 accepted implementation 96dcbab9a43a6a2548e13e4829aecaf493252eff and normalized subject sha256:2dd7a3b1aee322318384f9dd78a20c6fbd5599930d383e215dc9dae99ec96f0b with zero HIGH/MEDIUM findings; reviewer reran 8 files / 121 tests and PR #39 completed 34/34 checks including Windows Node 20/22. Claude was paused and not invoked.
- Findings: none

## Summary

- Exact-SHA review `019fe394-9015-7b23-a295-912b8c944bda` rejected target `ed75e86dd4bbb99dfdfa1750f7f656fbcf2ed4d0` for report-only SQLite sidecar risk、symlink/TOCTOU and missing daemon mutation authority、non-closed bundle projection、unbounded runtime/device input、Windows DACL mismatch and missing argv value validation.
- Exact-SHA review `019fe3ad-66af-7ca3-9e5a-cc5e595125f6` rejected target `0f64fc85aba7ad01a3cd0875d4a94d13da79679b` for failed-start residual writer after lease release、unavailable health mislabeled as corrupt、Windows bytes-before-DACL exposure、special-file blocking and incomplete stop/reclaim availability.
- Exact-SHA review `019fe3bf-e4bf-7c41-bee4-8b51b0595c9c` rejected target `38cbc14a05188945954425c76e30edb1180fdb29` because auth renewal could write outside the lease、concurrent stop was not single-flight、health rename could move a raced inode、SQLite snapshot reopened paths、and reclaim/PID reuse could cause permanent outage.
- Exact-SHA review `019fe3d8-70d2-7840-bf21-d52e74dc3de0` rejected target `7394926e6e9afe960d422222e36e658472363629` because oversized health could be misclassified then read unbounded、pair could race an in-flight renewal、owner/reclaim recovery still had blocking/legacy identity paths、the quarantine parent could be swapped to a symlink、and unpair chose cursor identity outside the cleanup lease.
- Exact-SHA review `019fe3f0-bce6-7473-b2f4-71f31c7afeed` rejected target `edf434c13acbd9f4418e77cdbc0a1eb87c0e7b6d` because a queued second pair could outlive the first caller's shared lease、same-inode drift could make manifest digest stale、unpair held the lease around an unbounded/symlink-following device read，and acquisition required undeclared `ps`/PowerShell commands.
- Exact-SHA review `019fe406-7527-7212-a800-abb98fa31ab7` rejected target `1790a537129df7cc5b7f061c1c60fc8052f164d5` because pair/start/stop could overlap around one shared lease、quarantine reporting followed directory/path races and did not validate manifests、foreign PID reuse still wedged recovery，and one runbook described the old hard-link design.
- Exact-SHA review `019fe419-6965-7711-b7d5-1a95fe417b9e` rejected target `1a3189161f50bc03cf2837ccffbe10d4a545a60c` because Windows silently dropped no-follow/non-blocking flags、source removal preceded a risky descriptor chmod and manifest publication、quarantine validation allowed ~10.38 GiB synchronous reads，and the unpair lease test spied on an obsolete method.
- Exact-SHA review `019fe42c-138f-7492-955d-f50b8f1c5890` rejected target `fe4e01d6f81cd4454e13704ed4e6199a573d9db1` because stale-owner reclaim had a two-lease TOCTOU、Windows device/audit inputs lacked pathname binding、source unlink outran durable directory publication，and Windows CI omitted support-bundle/late-writer coverage.
- Exact-SHA review `019fe482-c185-7870-8fb7-f20215015beb` rejected target `28edf774836f8e868e765f35b4ef248b61d6c508` because a PRAGMA/header-read exception inside `openJournalDatabase()` occurred after `DatabaseSync` construction but before the handle was returned to the caller；the caller therefore could not close it and could release the daemon lease after relabeling the failure as ordinary corruption. The local remediation makes the helper itself exception-safe, preserves a typed cleanup-barrier failure, exercises every post-open step, and adds a real child-process retained-lease guard. Claude was not invoked.
- Final exact-SHA review `019fe498-37be-7592-b499-7a2af21b2953` accepted target `96dcbab9a43a6a2548e13e4829aecaf493252eff` with normalized subject `sha256:2dd7a3b1aee322318384f9dd78a20c6fbd5599930d383e215dc9dae99ec96f0b`；it re-ran 8 targeted files / 121 tests，verified the typed SQLite cleanup barrier and real child-process lease guard，and found no HIGH/MEDIUM issues。PR #39 is 34/34 green including Windows Node 20/22。Claude was not invoked。
- Exact-SHA review attempt `019fe43f-c65a-71a2-be01-313b4debdc4b` inspected target `9f350b000f8c14ec10b39eb1e5c249183ba12836` but its Codex runtime exhausted the skills-context budget before returning a verdict；it is infrastructure-inconclusive and is not acceptance evidence.
- Acceptance preparation after canonicalization exposed unrelated-store birthday collisions in the original 10,000-port mapping；the current listener authenticates its canonical hash，rejects the same store，routes a different valid BYOK store through deterministic candidates，fails closed on no-identity timeout，and skips an explicitly closed/reset foreign listener only before the mandatory owner/reclaim record check。It also retains pre/post-open/read device/audit binding、POSIX quarantine-directory-before-unlink and source-parent-after-unlink fsync ordering、all-platform falsifiers，and the complete diagnostics/lifecycle Windows suite.
- Final independent exact-SHA review `019fe45a-bfa8-7613-9520-6e2c832d9000` accepted target `7f89f4365c09eb3615a96f34f71fd1c7ed5f7be9` and independently recomputed subject `sha256:f1155b9b0439f89ecfbac00fbfc38bb9f81d9b0b33df4745198d9777d0ec4e17`；no HIGH/MEDIUM findings，one LOW notes that actual Windows execution awaits PR CI。Claude was not invoked。
