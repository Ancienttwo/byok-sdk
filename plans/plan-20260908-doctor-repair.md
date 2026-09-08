# Plan: Explicit device metadata repair and embedded diagnostics

> **Status**: Executing
> **Artifact Level**: work-package
> **Promotion Reason**: New public diagnostics and operator repair API.
> **Verification Boundary**: Frozen local source and required checks; no release or deployment.
> **Rollback Surface**: This isolated candidate diff.
> **Spec**: docs/spec.md
> **Task Contract**: tasks/contracts/20260908-doctor-repair.contract.md
> **Implementation Notes**: tasks/notes/20260908-doctor-repair.notes.md
> **Task Review**: tasks/reviews/20260908-doctor-repair.review.md

## Authority and planning

User authorized plan and implementation on 2026-09-08 after the SDK-owned downstream diagnostics guide. Initial planning was attempted in a read-only Claude session; it timed out after 330 seconds with no final plan. This is not an external planning pass. The main-agent file plan below records the bounded decision and implementation authority. Evidence is in docs/researches/2026-09-08-doctor-repair-plan.md. Execution worktree is `/Users/kito/Projects/byok-sdk-wt-doctor-repair`, frozen base `62e83ae` from freshly fetched origin/main. Original root WIP remains untouched; only the preceding guide/navigation edits are included here.

## P1 / P2 / P3

- P1: CLI/diagnostics own local observation. DeviceCredentialStore owns the complete OS enrollment; DeviceStore owns its non-secret projection. AuthManager reconciles projection on startup, then may arm renewal. Public package root now exposes diagnoseDevice and repairDeviceEnrollmentMetadata. Cloud, Agent profile, credentials replacement, task execution and supervisor policy are outside this slice.
- P2: startup -> store lease -> AuthManager.loadExisting -> loadRecord -> OS credentials.read -> DeviceStore.load/save. New explicit repair -> confirmation and expected tenant/device validation -> offline control check -> same store lease -> existing OS authority read -> exact target match -> shared projection reconciliation -> readback -> release. No AuthManager creation, renewal, network, runtime execution or secret output.
- P3: extract one internal reconciliation primitive for startup and explicit repair. Public `diagnoseDevice` wraps the current collector with configured adapters, while private clock/control test seams remain private. Public `repairDeviceEnrollmentMetadata` restores missing/valid-stale metadata only. Existing doctor --fix remains health-only; a named --repair action selects metadata repair. No generic action registry, fallback credential files, journal rebuild, or runtime installation. At 10x, OS credential access and diagnostics dominate; explicit on-demand work stays bounded by existing platform operations and probe deadlines.

## Task Breakdown

- [x] Complete read-only trace and record Claude planning timeout; finalize the bounded main-agent contract.
- [x] Implement shared metadata reconciliation and public diagnosis/explicit repair APIs.
- [x] Wire named CLI action with confirmation and expected tenant/device, preserving --fix semantics.
- [x] Cover success, unchanged, missing authority, invalid projection, identity mismatch, concurrent owner, redaction, and public custom-adapter diagnostic paths.
- [x] Update spec, integration guide, runbook, changelog and API golden.
- [x] Freeze code, run required checks once, record results and residuals.
- [x] Classify the seven failures against pinned base and candidate under the user-approved diagnostic continuation.
- [x] Under subsequent user approval, correct local natural-compaction budgets and projection delivery/stop event ordering in the four named test files.
- [x] Verify slow-sync controls and close whole-repo test acceptance on the frozen test-only correction.
- [x] Obtain independent semantic acceptance of the public repair contract; resolve the sole EOF whitespace finding exactly as the reviewer prescribed.

- [x] Bind formal AcceptanceReceipt to the frozen candidate and evaluate the merge-seal policy on the exact target.

## Verification

Targeted new repair/API tests plus existing auth/store/diagnostics tests during implementation. Final frozen source: bun run build; bun run typecheck; bun run test; bun run check:api-surface; bun run check:version-authority; repo-harness run check-task-workflow --strict; git diff --check. Use Node 22.22.3 for Node-based commands. No live credentials, daemon changes, publish, push, merge or deployment. Public API additions require a future MINOR release; no version bump in this slice.

## Evidence Contract

- **State/progress path**: tasks/notes/20260908-doctor-repair.notes.md
- **Verification evidence**: targeted Vitest and required root check logs, summarized in implementation notes.
- **Evaluator rubric**: exact target and lease gates, no credential mutation or exposure, projection readback, old --fix scope retained.
- **Stop condition**: unavailable authority, invalid projection, unexpected identity, concurrent owner, or three failing fix rounds; report unrelated faults without repairing them.
- **Rollback surface**: revert this bounded client/API/docs candidate; no live data migration or external operation is performed.

## Promotion Gate

- **Merge/PR unit**: explicit metadata repair plus public diagnostics and integration contract.
- **Rollback surface**: this candidate diff only.
- **Verification boundary**: local source, targeted tests and required root checks; no registry or deployment claim.
- **Review/acceptance boundary**: independent gatekeeper review plus target-bound harness AcceptanceReceipt; both complete.
- **High-risk surface**: OS enrollment read and non-secret projection write under store lease.
- **Why not checklist row**: new public API and operator mutation require a dedicated plan/contract.

## Result

Implementation and local required-check acceptance complete. The separately approved four-file test correction closes all seven failures: full `bun run test` exits 0 across 13 packages (3905 passed, 135 skipped), including client 1860 passed / 11 skipped. Root typecheck/API/version checks pass; prior passing build applies to unchanged production source. Independent semantic acceptance and formal target-bound AcceptanceReceipt are complete; live credential-provider qualification and release remain outside this slice.

## Failure classification continuation

Raw targeted seven: base 7/7 and candidate 7/7 passed. Controlled slow-file-sync: both sides completed six original assertions beyond the original 10s budget. Controlled projection redelivery: both sides reproduced expected 2 / observed 3 with completion and cursor assertions satisfied. Report: `docs/researches/2026-09-08-doctor-failure-classification.md`. No original test or production source edits; no full-suite success claim.

## Test correction closeout

The user subsequently approved the four-file correction. All 12 natural-compaction slow-sync controls pass under local 60s budgets with package default 10s; the projection barrier test preserves exact completion/cursor/hook assertions and verifies stop abortion. Full-suite success supersedes the earlier local test blocker. Details: implementation notes and `test-repair-checks.json` in the classification evidence directory.

## Independent review closeout

Independent gatekeeper reviewed frozen `30743c8`: no semantic findings, 23/23 focused tests pass, retained full-suite evidence matches. Sole finding was cumulative-diff EOF whitespace; main agent removes exactly that line and verifies the new frozen cumulative diff. See the review report. Implementation, independent semantic acceptance and formal integration acceptance are complete. AcceptanceReceipt external_pass binds target 62e83ae; verify-sprint finalized PASS. The target policy returns mergeGateRequired=false, so no merge seal is created. This plan is ready for Completed archival; release remains separate.
