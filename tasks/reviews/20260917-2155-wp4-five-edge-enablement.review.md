# Task Review: wp4-five-edge-enablement

> **Status**: Pass
> **Plan**: plans/plan-20260917-2155-wp4-five-edge-enablement.md
> **Contract**: tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md
> **Notes File**: tasks/notes/20260917-2155-wp4-five-edge-enablement.notes.md
> **Last Updated**: 2026-09-18 04:1x
> **Recommendation**: pass — fit to ship; push awaits Owner instruction
> **Review Rubric Version**: 2
> **Reviewed Subject**: commits 4de4dcb0 (implementation) + 67afe3b3 (fix slice) on claude/wp3-custody-wiring
> **Reviewed Subject Scope**: diff 07b8798d..67afe3b3

## Gatekeeper verdicts

Round 1 (against 4de4dcb0): FAIL — A1/A2/A3/A5/A6/A7/A8 verified clean; two blocking test-only gaps (F1 cap enforcement untested, F2 crash stages untested). Findings re-dispatched as one bounded test slice.

Round 2 (against 67afe3b3): PASS — F1 closed (cap-session/cap-parallel: byte-faithful claimCapSlot forge, real dispatcher child-process drive, exact refusal strings, zero-state after refusal); F2 closed (stale-reclaim: real dead pid + on-disk backdate past CUSTODY_STALE_MS=60s, wx-slot re-claim proves unlink; refuse-edge/refuse-no-budget: 未准入 zero-state); fix commit comment-only in production files, no cap/maxDepth raised, attribution clean; targeted 30/30.

## Acceptance criteria ledger

- Legacy discovery unreachable (four vendored spawn sites + profiles probe rerouted/fail-closed) — PASS r1
- Five edges one-cut enabled, real-primitive evidence, charge table frozen (only runner→print=0) — PASS r1
- Charge-once regression untouched and green — PASS r1/r2
- ①②④⑤ on existing primitives, no second scheduler — wiring PASS r1, ②⑤ test closure PASS r2
- Vendor accounting: 5 modified + 7 un-pruned, manifest 229→236, closure golden green — PASS r1
- Scope/hygiene: packages/ only, zero CI files, no codex surfaces, no AI attribution — PASS r1/r2
- Strict matrix: 13 checks 12 PASS; sole FAIL = pi-s2-bundle-resolution.test.ts:327 local registry tripwire (pre-declared local-env item; CI ubuntu green at baseline 35225498896; sha unpushed so CI pending Owner-authorized push)

## Non-blocking findings (deferred)

- R1-N1 [Owner decision]: un-pruned closure makes the external-CLI step lane (claude-code/codex-exec/cursor adapters) executable in-bundle, outside the custody chain by frozen design — needs an Owner ruling on product reachability and future custody treatment.
- R2-1 [LOW]: five-edge driver claims listing reads <budget>/claims while the fanout claim lives under custody/<rootKey>/<launchId> — that one listing is vacuous; fix path if tests extended.
- R1-N3 [LOW]: closure test iterates manifest rows only (no existence-direction assertion); harden later.

## Ship recommendation

Push claude/wp3-custody-wiring (67afe3b3) once the Owner authorizes; CI (incl. the two known-red Windows jobs = WP1 face) becomes authoritative post-push.
