# Notes: Issue177 source delivery

> **Plan**: plans/plan-20260910-2029-brc177-readme-delivery.md
> **Status**: Active

## Decisions

- Reuse only the previous worker's README bytes, SHA2567c65c87fa1817269a0937b21c6a539960ca7e25989839561d99ea6f3236cc8a2; its failed run remains failed.
- The regex capture is mandatory and nonempty. A capture-specific non-null assertion expresses that invariant after the existing missing-match assertion, without a default value or weaker namespace comparison.
- The user approved source delivery after the GitHub search. No campaign worker/verifier rerun or final receipt is implied. The draft PR targets only codex/brc1415-canary.

## Evidence

- Pre-fix CI: https://github.com/Ancienttwo/byok-sdk/actions/runs/34468443838/job/102842448215 at ce48120507bb51360d48aa2ab3a2ffbe4be67951.
- Existing README red/green and original patch provenance are retained in the primary canary's ignored .canary-scratch/brc177-recovery-evidence/.


## Source verification

Frozen implementation and contract: 33aab3f2bcb14948b09f6c63963d2bf2960a16e1. Canonical run: run-20260910T203750-64587. Source subject: sha256:b726b54774588b9e659dc01419b97d12ec9cf8794059f38d8d6b833fba4d5a84. Environment: Node22.22.0/Bun1.4.0, approved harness runtime9cc12bac, explicit canary diff base ce48120507bb51360d48aa2ab3a2ffbe4be67951.

| Check | Result | Execution |
|---|---|---|
| README regression | PASS,892ms | vx-4804fc46b0b643449866 |
| Workspace build | PASS,7687ms | vx-4efaed5b13e749ffb0aa |
| Workspace typecheck | PASS,6238ms | vx-f789c0a582614de3898c |
| Complete workspace tests | PASS,100698ms | vx-af28eea10b194f7fa4f7 |
| API surface | PASS,525ms | vx-3881dc9f346c4dbaae91 |
| Version authority | PASS,447ms | vx-e3d767b23b6441919d1d |

The canonical aggregate remained failed because strict workflow found missing Evidence Contract and Promotion Gate sections in this new plan. Those documentation sections were added; rerunning only `repo-harness run check-task-workflow --strict` produced `[workflow] OK`, exit0. The implementation, manifests, lockfile and test assertions did not change after the six passing source checks. The historical aggregate is not relabeled as passed. Final documentation updates retain this baseline plus the workflow delta; no second full local suite was run.

Parent Waza check Quick: no defect found in the bounded two-file diff. The required capture is nonempty by the regex, and the existing assertion rejects a missing match before dereference. A single same-shape site exists in packages/sdk/src and it is corrected. The regression still failed twice against the old README after this typing fix. Source semantic AcceptanceReceipt and campaign closeout remain pending.
