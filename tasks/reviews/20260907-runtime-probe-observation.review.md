# Runtime probe observation verification review

> **Status**: Local checks passed
> **Reviewer**: Codex implementation self-check (not independent acceptance)

The source trace and matching regressions cover all five outcomes, OS refusal, resolver errors, output-limit failure, owned child timeout/termination, old/malformed adapter results, local text/JSON projection, and unchanged registration/admission availability predicates. Build, types, golden and version checks passed.

Two initial full-suite failures were reproduced on the base using explicit timing controls. Atomic finish-file publication and waiting on actual local durable confirmation eliminated both under the same controls. Final root tests passed across all 13 test-bearing workspaces: 3786 passed, 134 existing skips. Recovery product source was not altered.

See `tasks/notes/20260907-runtime-probe-observation.notes.md` for exact cases, negative/positive controls and logs. No unresolved implementation finding was identified in this self-check. This document is not a harness external acceptance receipt or ship approval.

## Independent review round 1

Gatekeeper reviewed f7ff9d4625b850a36dc9d84e5250c3a9023c28e4 against 0f8fdb4a43774b9d21ccfec0ba7d49fa06fec009: FAIL. Both Bun and SEA packaging smoke scripts still read removed piDetect.present, while the launcher directly emits the new kind result. Independent focused verification passed 177 tests but did not cover this shell/launcher boundary.

Correction: both scripts now assert exact piDetect.kind values (probe-failed for unresolved bundled Pi package; available for injected stub), without translating the old shape. Bun smoke is explicitly within the contract allowlist. Actual packaging smokes and the exact CI Node 22.22.3 checks must pass before a narrow independent re-review. The existing default-adapter construction duplication predates this diff and is report-only, not an introduced regression.
