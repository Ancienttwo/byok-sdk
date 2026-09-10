# Plan: Deliver Issue177 README correction and type-safe regression

> **Status**: Executing
> **Created**: 2026-09-10 20:29
> **Artifact Level**: work-package
> **Promotion Reason**: merge_boundary
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: https://github.com/Ancienttwo/byok-sdk/issues/177
> **Task Contract**: tasks/contracts/20260910-2029-brc177-readme-delivery.contract.md
> **Task Review**: tasks/reviews/20260910-2029-brc177-readme-delivery.review.md
> **Implementation Notes**: tasks/notes/20260910-2029-brc177-readme-delivery.notes.md
> **Verification Boundary**: Source repair and exact-head PR CI; campaign final remains separate
> **Rollback Surface**: Revert the bounded source repair commit

## Approved scope

User approved the #177 README patch delivery and the existing regression test type error on 2026-09-10. Parent implements this bounded source change. Preserve the earlier instruction not to rerun campaign workers/verifier; source delivery and campaign closeout are separate acceptance boundaries. The PR base is codex/brc1415-canary at ce48120507bb51360d48aa2ab3a2ffbe4be67951; no main merge, package release or campaign state mutation is included.

## P1 Map

The published umbrella package includes packages/sdk/README.md. Its existing packages/sdk/src/index.ts exports seven namespaces, including uiRuntime. The existing packages/sdk/src/readme.test.ts reads these two files and asserts exact namespace agreement, seven descriptions, and keys exclusion. The parent owns only the README and that regression test plus required task evidence. No runtime export, dependency, configuration or API changes.

## P2 Trace and root cause

README still describes six namespaces and omits uiRuntime, while the frozen source has seven. Existing regression gives two failures and one pass. The prior worker left an exact README patch (SHA256 7c65c87fa1817269a0937b21c6a539960ca7e25989839561d99ea6f3236cc8a2); reuse only those bytes, leaving its other WIP untouched.

Current canary CI34468443838 fails before tests: packages/sdk/src/readme.test.ts:12, TS2532. noUncheckedIndexedAccess makes RegExpMatchArray[1] potentially undefined. The regular expression has one required nonempty capture; the preceding expect(example).not.toBeNull() already rejects a missing match. A non-null assertion on that required capture records the proven regex invariant without adding a fallback or weakening the runtime assertions.

## P3 Decision

Apply the existing exact README patch and add the required-capture non-null assertion. Keep all three existing assertions and keys exclusion. Runtime regression must still fail against the old README after the type correction, then pass against the corrected README. Ten times more namespaces does not change this file-level operation; the regex continues to read the explicit export surface. No new abstraction or compatibility behavior.

## Verification and delivery

Freeze the two-file implementation, then run the target's required build, typecheck, complete workspace test script, API surface, version authority and strict workflow checks. The workspace test is explicit in target AGENTS.md. Execute final expensive criteria once through verify-sprint --prepare-acceptance and record results against the frozen subject. Review the complete owned diff with Waza check Quick. Commit the bounded repair and task evidence, push a branch and open a draft PR against codex/brc1415-canary, then read exact-head CI. Do not merge or label this parent source acceptance as a campaign completed passing final. Final BRC closeout remains separate.

## Task Breakdown
- [x] Preserve exact pre-fix README and typecheck evidence; freeze the bounded repair.
- [ ] Run required verification and review the final diff.
- [ ] Publish the repair PR against the canary base and read exact-head CI.
