# Plan: Issues 105-111 accepted batch integration

> **Status**: Review
> **Created**: 20260901-0457
> **Slug**: issue-batch-integration
> **Artifact Level**: work-package
> **Promotion Reason**: Integrate seven independently accepted issue subjects into one tested non-force `main` update while the primary worktree contains unrelated WIP.
> **Verification Boundary**: Exact accepted heads and receipts, dependency-aware merge, conflict-focused tests, root build/typecheck/test, strict workflow, merge-gate, non-force push, and remote SHA readback.
> **Rollback Surface**: Revert the batch merge commits in reverse order; no publish, tag, deploy, migration, issue close, or branch cleanup is included.
> **Spec**: `docs/spec.md`

## Agentic Routing

- Selected route: isolated integration worktree with normalized final-content verification.
- Routing reason: the primary `main` worktree has overlapping uncommitted WIP, while two accepted branch pairs share product files and require semantic composition.
- P1 map: `origin/main` already contains issues 102-104. Issue 105 changes Cloud ingress; 106 and 107 independently change Agent egress; 109 contains 108 and changes the control server; 110 changes AuthManager/config composition; 111 changes URL validation diagnostics. The dirty primary worktree is explicitly out of scope.
- P2 trace: freeze `origin/main` and accepted heads -> merge 105 -> merge 106 -> merge 107 while preserving both spool initialization and tenant quota invariants -> merge 109 (including 108) -> merge 110 -> merge 111 -> combined verification -> merge seal -> `git push origin HEAD:main` -> `ls-remote` readback.
- P3 decision rationale: retain accepted branch ancestry with non-fast-forward merge commits. Resolve only observed conflicts from independently accepted authorities, then validate their shared public behavior together. Do not snapshot, reset, stash, or commit the primary worktree's unrelated WIP.

## Accepted Inputs

| Subject | Frozen branch | Composition rule |
|---|---|---|
| #105 | `codex/issue-105-json-body-limits` | Independent Cloud surface. |
| #106 | `codex/issue-106-spool-initialization` | Merge before #107. |
| #107 | `codex/issue-107-tenant-quota` | Preserve #106 initialization authority while adding tenant serialization. |
| #108 + #109 | `codex/issue-109-control-backpressure` | #109 already contains accepted #108. |
| #110 | `codex/issue-110-auth-request-deadline` | Independent auth/config surface. |
| #111 | `codex/issue-111-url-redaction` | Independent URL error surface. |

## Risk Assessment

| Risk | Mitigation |
|---|---|
| #106/#107 shared-file conflict drops one concurrency invariant | Review the three-way conflict, preserve both authorities, and run the complete Agent egress suite. |
| #108/#109 is integrated twice | Merge only the #109 head and prove #108 is its ancestor. |
| Dirty primary WIP contaminates the batch | Work only in the isolated integration worktree and compare final changed paths to accepted subjects plus this plan. |
| Remote advanced after verification | Fetch immediately before push and require `origin/main` to remain the frozen target ancestor; push without force. |

## Promotion Gate

- **Merge/PR unit**: one dependency-aware integration of accepted issues 105-111 onto the frozen `origin/main` target.
- **Rollback surface**: the six branch merge commits, reverted in reverse order.
- **Verification boundary**: accepted receipt readback, shared-surface focused tests, root required checks, strict workflow, exact diff, and merge seal.
- **Review/acceptance boundary**: accepted issue receipts remain semantic authorities; an independent exact integration diff verifies conflict composition before push.
- **High-risk surface**: shared Agent egress concurrency, control-socket request/backpressure composition, AuthManager shutdown, and remote `main` mutation.
- **Why not checklist row**: this combines several independently accepted histories, including a real shared-file concurrency conflict, and performs a non-force remote update.

## Evidence Contract

- State/progress path: this plan and the accepted per-issue contracts/reviews already present on their branches.
- Verification evidence: shared-surface focused tests, root required checks, strict workflow, exact diff, merge-gate seal, push result, and remote SHA readback.
- Evaluator rubric: final content preserves every accepted issue invariant; no unaccepted primary-WIP path enters the subject; remote `main` advances by non-force push only.
- Stop condition: any unresolved semantic conflict, stale/rejected receipt, failing required check, or remote target drift.
- Rollback surface: revert the six branch merge commits in reverse order; the primary dirty worktree and remote history before this batch remain untouched.

## Task Breakdown

- [x] Freeze target and verify all accepted input heads/receipts.
- [x] Merge accepted subjects in dependency order and resolve the #106/#107 shared authority.
- [x] Run shared-surface and root verification on the frozen integration head.
- [ ] Record merge-gate evidence and non-force push to `origin/main`.
- [ ] Read back remote SHA and preserve the dirty primary worktree unchanged.
