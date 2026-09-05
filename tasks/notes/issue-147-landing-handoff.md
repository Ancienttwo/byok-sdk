# #147 local landing — single handoff

Status: LANDED ON LOCAL MAIN. No push, remote merge, registry publication, tag, deployment or downstream exact-pin performed.

## Exact subject and evidence

- Prior local main:e542d210719a43fe1111b793bba1a76d37076cbf (PR149 + PR150 + accepted local relay changes).
- Original #147 source:fc404d7ce0599d6ab0e396af39e89a3c8b11ae0c.
- Landing combination:0941041b898345dcb9e2617c5a75a49c83a7fe46; workflow-complete candidate:f3d689330eff13921b67b8db2a3ca02c3398e8ea.
- Accepted local landing commit:6656b858d757622fc9d3935a35a047a2565efad2. This documentation follow-up adds no product changes; current main must contain this commit.
- Branch/worktree:codex/issue-147-landing at /Users/kito/Projects/byok-sdk-wt-issue-147-landing.
- Receipt:Claude/claude-review/external_pass; semantic subject sha256:9bc1da921931406ac4d4f26fb5c98d9d03432876533209e0d71779e42031bf5c; targete542d210719a43fe1111b793bba1a76d37076cbf. Verified immediately before landing. Audit copy:issue-147-landing-receipt.json. The receipt is historical acceptance of that exact pre-landing target, not a claim that a zero diff against advanced main has the same subject.
- Prepared source evidence:issue-147-landing-checks.json. Strict contract12/12; build/typecheck/full test/API/version/workflow/diff checks passed; real journal-family targeted test passed after the fresh protocol build. Node22.22.0 with Bun1.4.0 frozen install. Final verify-sprint reused prepared evidence.
- Raw Claude review:issue-147-landing-claude.md (exit0, actual result recovered from persisted review transcript because stdout ended with a Stop-hook message).

## P1/P2/P3

P1: protocol five-offer classification and daemon SQLite journal coexist with PR150 UI spill and relay control route.
P2: offer -> classification -> durable row before runner/cursor; sanitized terminal -> journal -> send; restart -> interrupted marker. Overlapping main addition is an independent team_notifications.snapshot route.
P3: merge exact commits in isolation, restore review_base main, validate actual local target, then compare-and-swap main only while unoccupied. No compatibility fallback, dependency or new product behavior beyond #147.

## Landing readback and WIP

Main had no checked-out worktree at publication. `git update-ref refs/heads/main <accepted-head> <expected-old-main>` atomically advanced only that branch after ancestry and receipt checks. Primary remained on claude/audit-spill-size@02792b3f156a0be8402a839c25dd904f58d20ff0; dirty packages/AGENTS.md and CLAUDE.md, status and binary-diff hash were byte-identical across landing. See issue-147-landing-readback.json. No checkout/reset/stash/clean or source write touched primary. Other agents may advance their branches independently afterward.

## Retained P2 advisories

1. Pre-existing observer.ts three-offer observation predicate remains outside journal scope.
2. Same-seq duplicate in the new fixture is filtered before journal; new test proves distinct-envelope/same-task dedup. Existing journal-sqlite suites provide receipt idempotency evidence.
3. Reviewer notes default vi.waitFor timeout as a possible CI-load flake margin; no such correctness failure observed, no landing change required.

No P1. Snapshot recovery is source integration evidence, not SIGKILL/compiled/released-binary acceptance. WP3 stays deferred; cloud settlement, doctor, Salesko workaround and downstream pin remain untouched.

## Next bounded release slice

Coordinate and freeze the actual next release subject, excluding concurrent audit-log work until separately accepted; prepare packed artifacts and registry/version evidence before requesting publication. This local landing does not authorize pushing existing relay changes or publishing the SDK. After real publication, downstream exact-pin and the Salesko acknowledged-interrupted positive recovery_marker rerun remain a separate slice; other WP1 PARTIAL gates stay classified.

Recheck local landing: `git merge-base --is-ancestor 6656b858d757622fc9d3935a35a047a2565efad2 main`. Remote/registry/tag state must be read live independently.
