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
