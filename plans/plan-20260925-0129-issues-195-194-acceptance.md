# Plan: Issues 195 then 194 SDK acceptance

> **Status**: Review
> **Created**: 20260925-0129
> **Slug**: issues-195-194-acceptance
> **Artifact Level**: work-package
> **Promotion Reason**: multi_boundary_verification
> **Verification Boundary**: SDK source conformance and repository required checks; Host and provider evidence remain separate.
> **Rollback Surface**: Revert this branch's commits; no persistent product migration.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260925-0129-issues-195-194-acceptance.contract.md`
> **Task Review**: `tasks/reviews/20260925-0129-issues-195-194-acceptance.review.md`
> **Implementation Notes**: `tasks/notes/20260925-0129-issues-195-194-acceptance.notes.md`

## Agentic Routing
- Selected route: parent implementation, delegated read-only issue research.
- P1 map: SDK recurring cloud/server admission and TaskRunner own immutable offers, same-home execution and result delivery. Salesko owns ContextPack, SummaryJob, authorization, CAS and semantic quality. Provider owns token semantics.
- P2 trace: Host fixture input -> recurring offer -> real HTTP -> TaskRunner fresh session -> internal result-document -> public durable read-back -> dependent fresh offer -> message disposition/device terminal. Existing tests begin at Summary and construct the dependent request from the fixture rather than the returned document.
- P3 decision: extend existing conformance seams and test rejection boundaries; do not create a second Host implementation or mark synthetic counters/provider output as native acceptance. No API changes. At 10x test scale socket/process/SQLite contention dominates, so keep the existing bounded worker configuration.

## Scope
Process #195 before #194. Add missing SDK-local evidence; explicitly retain externally owned acceptance as blocked. Read-only verification of one isolated Salesko candidate is included. No source changes to Salesko or changes to aiphabee, provider accounts, release state or other open PRs.

## Task Breakdown
- [x] T1 #195: extend existing recurring Summary conformance across a multi-turn boundary with exact frozen input read-back and recovered internal result consumption.
- [x] T2 #194: audit existing accounting/activation proof and add a targeted missing SDK regression if demonstrated; record external proof gaps.
- [x] T3: run required checks, review final diff, commit/push and create PR with exact limits.

## Verification Plan
Run build, typecheck, test, API surface, version authority and strict workflow checks. Run focused recurring/accounting tests first; no paid calls. Source evidence does not replace installed/native/Host gates.

## Promotion Gate
- **Merge/PR unit**: this branch, referencing #195 and #194 without auto-closing unproved acceptance.
- **Rollback surface**: revert branch commits.
- **Verification boundary**: required checks plus behavior-specific conformance.
- **Review/acceptance boundary**: final diff self-review and recorded test evidence; no merge or production activation.
- **High-risk surface**: verification only, no production contract changes.
- **Why not checklist row**: cross-boundary issue evidence requires explicit ownership.

## Evidence Contract
- **State/progress path**: this plan and associated contract/notes/review.
- **Verification evidence**: ignored `_ops/issues-195-194/` logs and notes summary.
- **Evaluator rubric**: actual assertions, exact subject and explicit synthetic/external boundaries.
- **Stop condition**: bounded SDK scope passes verification and is submitted as PR; externally blocked issue criteria remain open.
- **Rollback surface**: revert branch commits.

## Follow-up

- [x] T4: verify exact Salesko candidate accounting/prepared dispatch with installed registry SDK and disposable PostgreSQL.
- [x] T5: repair unavailable MinIO test image using the same release source; real dataplane (338), conformance (161) and exact-commit packed restart verification passed; update PR #228 with hosted check status.
- [ ] T6: local SummaryJob scope approved; blocked by the SDK 0.21.0 empty-toolset prerequisite explicitly deferred to official Pi migration. Migration scope decision pending; no production budget defaults.

The initial MinIO source-build repair was locally and remotely verified. Latest main now owns the merged SeaweedFS substrate through PR #230; this branch adopts it and removes the superseded local Dockerfile. The final PR contains the Summary/evidence slice plus the mainline merge, not a competing substrate implementation.

## Delivery

Draft PR: https://github.com/Ancienttwo/byok-sdk/pull/228. The SDK slice is verified and submitted; #195/#194 remain open for the Host/provider acceptance recorded in the evidence map.
