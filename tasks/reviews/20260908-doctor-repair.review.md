# Doctor repair review

Status: Independent semantic review complete; sole nonsemantic finding resolved by the exact one-line correction below. Main-agent inspection covered exact target/confirmation, store ownership, shared reconciliation, secret-blind results, typed CLI failures, public type reachability and guide consistency. It prompted separating public data types from internal collector declarations. This is not an independent semantic acceptance receipt.

Build/type/API/version/workflow checks pass. Final client run: 1853 passed, 7 failed, 11 skipped; all 23 new doctor tests passed. Full-suite failures remain unclassified against base. Details and hashes: `tasks/notes/20260908-doctor-repair.notes.md`. Do not claim ship readiness.

Follow-up classification completed: both pinned subjects pass all seven unmodified targeted cases; slow-sync controls expose the same budget boundary, and delayed observer controls reproduce the same projection count assertion. See the classification report. These findings do not replace a passing full suite or independent acceptance receipt. No production/test fixes were made.

Approved test-only correction closed the local blocker: full root test command exits 0 (client 1860 pass / 11 skip; all 13 packages complete), slow-sync natural-compaction controls 12/12 and projection tests 5/5 pass. Main-agent diff inspection confirms only local budgets and controlled polling/stop ordering changed; production source is identical to 06991fb. This update supersedes the earlier BLOCKED local-check status, not an independent review receipt. Exact evidence: implementation notes and classification evidence `test-repair-*`.

## Independent semantic acceptance — 2026-09-08

Reviewer: read-only `gatekeeper`, task `/root/doctor_acceptance`, separate from the implementation agent. Reviewed base `62e83ae` through frozen candidate `30743c84543625a37223796485d9372bb17c846c`. No reviewer edits or live operations.

P1: public package/CLI observation and repair sit above DeviceStore metadata, OS enrollment authority and the existing daemon owner lease. Public API, spec, guide and runbook agree on device metadata scope rather than Agent readiness.

P2: confirmation and exact expected tenant/device -> control observation -> same store owner lease -> safe metadata load -> OS authority read/exact match -> shared reconciliation -> metadata readback -> release. Startup AuthManager uses the same reconciliation. Typed public/CLI failures expose no OS stderr, credentials or nested causes; --fix remains health-only.

P3: no semantic findings. The change preserves authority custody, malformed/legacy fail-closed behavior, no credential replacement/renewal, no runtime/task/remote execution, and one reconciliation implementation. Actual OS-provider execution remains a separate live qualification, not claimed here.

Original gate verdict: FAIL solely for `packages/client/src/diagnostics/types.ts:66`, `new blank line at EOF`, from cumulative `git diff --check 62e83ae..30743c8`. Reviewer classified it safe_auto and explicitly stated that deleting only this line, freezing a new HEAD and repeating the cumulative check is sufficient; no new semantic review is required. Main agent applied precisely that deletion. Earlier uncommitted-diff PASS was a narrower check, not cumulative candidate evidence.

Independent verification: Node 22.22.3, client `bun run test -- src/__tests__/device-doctor.test.ts`, 23/23 PASS. Reviewer verified the full-suite log SHA and all four test subject hashes against retained manifests; production/API/CLI source was unchanged between `06991fb` and the reviewed candidate. Full-suite evidence remains 3905 passed / 135 skipped, with unchanged-code build evidence reused.

This is an independent reviewer report plus an explicitly authorized mechanical finding resolution. It is not a generated repo-harness AcceptanceReceipt, merge seal, published artifact or live provider qualification.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:c24db8e5a77ccd286a7aa46b371e18a1e7d9eb2a985dc92dd2946709134c8551
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 62e83ae9ac76e38b5448307fec02850f780d7347
> **Verification Evidence SHA256**: sha256:bb5de6626065bfbc2606645de704aced23f9ff3b1a1dacff0c25be2abbdbc807
> **Issued At**: 2026-09-08T10:18:50.608Z

- Summary: Supersedes the receipt for stale local main. Independent gatekeeper /root/doctor_acceptance found no semantic findings on 30743c8; sole EOF finding resolved at beb0b71. Current candidate adds formal verification declarations and only changes review_base from main to origin/main, verified by exact policy-delta assertion. Source/config equality, doctor filesystem readback and ledger baseline checks pass against target 62e83ae.
- Findings: none
