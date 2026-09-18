# Task Review: n1-external-cli-gate

> **Status**: Accepted
> **Plan**: plans/plan-20260918-2052-n1-external-cli-gate.md
> **Contract**: tasks/contracts/20260918-2052-n1-external-cli-gate.contract.md
> **Notes File**: tasks/notes/20260918-2052-n1-external-cli-gate.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-18 22:30
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 3f709901

## Human Review Card

- Verdict: PASS (independent gatekeeper, protocol 2)
- Change type: code-change
- Intended files changed: custody scanner + dispatcher admission + runner payload boundary + dedicated test file + tasks/todos.md + quartet
- Actual files changed: 10 files, all within contract allowed_paths (`git diff --name-only origin/main..HEAD` enumerated by gate): `packages/client/src/custody/external-cli-admission.ts` (new), `custody-dispatcher.ts`, `custody/pi-subagent-runner-payload.ts`, `__tests__/custody-external-cli-admission.test.ts`, `__tests__/fixtures/*`, `tasks/todos.md`, plan/contract/notes/review quartet
- Check IDs and evidence disposition: strict verify-contract total=11 failed=1 status=Partial; sole failure = pre-declared K1 (`pi-s2-bundle-resolution.test.ts:327` local registry tripwire, local-only, CI authoritative); vendored zero-touch machine check `git diff --name-only origin/main..HEAD | grep -c '^packages/client/vendor/'` = 0 (gate re-ran it)
- Residual risks: vendored append chain (chain-append.ts consumed by an already-running runner) still reaches external-cli with no SDK-side interception — B-terminal face, disclosed in notes:22 and todos B-terminal row
- Reviewer action required: none (independent gate completed)
- Rollback: revert commits 2c6f3382 + receipt commit on this branch; no data/layout migration, no vendored state to restore

## Mode Evidence

- Selected route: Owner ruling 2026-09-18 (B as terminal state; first knife = admission gate with A's semantics, no vendored-closure surgery)
- P1/P2/P3 evidence: P2 trace in notes — vendored `subagent-runner.ts` is sole importer of `external-cli-runner.ts` + three adapters; `external-cli-runner.ts:330` spawn is the only out-of-chain agent-delegation spawn; gate sits at dispatcher admission, upstream of the entire lane
- Root cause or plan evidence: deep-reasoner consult HIGH confidence; three falsification points verified pre-implementation (zero active consumers, admission did not filter, unique spawn site)

## Verification Evidence

Follow [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
Consume canonical evidence; do not rerun checks to populate this review or
copy the executable plan. Return missing/stale evidence to its execution owner.

- Waza `/check` review reference, when required: n/a (gatekeeper protocol 2)
- Check IDs and disposition (executed / exact reuse / baseline with delta / failed / missing / not run):
  - `bun run typecheck` — executed by gate: 15 packages Done, no errors
  - `bun test packages/client/src/__tests__/custody-external-cli-admission.test.ts` — executed by gate: 15 pass / 0 fail (63 expect calls)
  - `bun test` custody-five-edge-dispatch + custody-charge-once-double-charge + custody-pi-subagent-runner-entry — executed by gate: 26 pass / 0 fail (refuse-edge cases unchanged; five frozen edges zero regression)
  - Full matrix via executor strict run — 1 failed | 2872 passed | 11 skipped; sole failure = declared K1
- Verified subject, relevant environment and immutable execution references: branch `n1-external-cli-gate` @ `3f709901`, base origin/main e0423d84; gate verified worktree stable for the entire review (no HEAD movement, no modified/staged files beyond pre-declared untracked draft)
- Historical baseline and current delta references, if applicable: n/a
- Manual observations, failures and coverage limitations: gate read the 443-line test file section by section — scanner unit (passthrough pins for pi and external-job, sequential/`parallel[]`/dynamic `parallel{}` location, file→verdict four states), dispatcher admission (bare + codex-exec/claude-code/cursor-agent/claude-code-writer five faces + nested parallel + dynamic + missing/invalid JSON + clean-config control, zero-state assertion per refusal), vendored `executeAsyncSingle` end-to-end, bun subprocess payload gate with real `runPiSubagentRunnerPayload` (exit≠0 + stderr prefix, vendored closure never loaded for refused config)
- Implementation notes reviewed, if present: yes — notes:13 records seam-2 ordering rationale (gate before mint but after edge vocabulary check, preserving five-edge refuse-edge texts); notes:22 records append-chain residual
- Run snapshot: diagnostics log `.ai/harness/runs/verification-vx-7bad60e5fb8d42c785d9.log`

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [x] Vendored closure untouched: `git diff --name-only origin/main..HEAD | grep -c '^packages/client/vendor/'` → `0` (re-run by gate)
- [x] No second path into the vendored external-cli lane: gate verified by grep + read — `external-cli-runner.ts` and the three adapters are imported only by `subagent-runner.ts`; SDK-side chain is dispatcher mint → `sdk-reserved-helper-host.ts:93` (the only way in) → attested entry `pi-subagent-runner-entry.ts:190` (unique dynamic import of the gated payload) → `runCustodyRunnerPayload` (unique consumer of the gated payload)
- [x] Single refusal authority: both custody faces (dispatcher + payload) import scanner text/`findExternalCliRunnerStep` from `external-cli-admission.ts`; no duplicate authority

## Acceptance Receipt Projection

> **Disposition**: gatekeeper-pass
> **Reviewer**: gatekeeper agent (Opus, read-only acceptance)
> **Source**: independent gate dispatch 2026-09-18 (evidence-only packet; executor self-argument excluded)
> **Actor**: orchestrator (Fable main loop)
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 3f709901
> **Verification Evidence SHA256**: pending
> **Issued At**: 2026-09-18 22:30

- Summary: VERDICT PASS — all acceptance-contract items held. Three seams verified at code level; vendored zero-touch machine check re-run by gate; five frozen edges zero regression (26/26); no-second-path verified by import graph; residual honestly disclosed in notes + todos; commit hygiene clean (author Ancienttwo, no attribution trailers).
- Findings: none blocking. Report-only: (1) dispatch-packet path typo for seam 3 (actual `custody/pi-subagent-runner-payload.ts`, pre-existing location since 4de4dcb0) — packet error, not code; (2) review card was pending template awaiting this receipt (expected lifecycle); (3) `acceptance.ts:1198` shell:true sibling correctly parked as report-only todos row.

## Behavior Diff Notes

- External-CLI subagent jobs (sequential / `parallel[]` / dynamic `parallel{}` shapes, all four adapter variants incl. claude-code-writer) are now refused at custody dispatch with a stable typed `CustodyDispatchRefusalError` citing the 2026-09-18 ruling; zero custody state minted.
- Unreadable / non-JSON runner configs fail closed with the same typed refusal (previously would have surfaced later as a different error).
- Non-external jobs (pi, external-job passthrough pinned by test) are unaffected; five frozen custody edges unchanged (refuse-edge texts preserved by admission ordering).
- Direct payload invocation (`runPiSubagentRunnerPayload` outside dispatcher, e.g. bun subprocess) refuses external-cli input before importing `#byok-pi-runtime-host`.

## Residual Risks / Follow-ups

- Vendored append chain: an already-running runner's append-step (chain-append.ts) can still reach external-cli with no SDK-side interception point; closure requires a vendored change — B-terminal design package (sixth edge: charge pricing, per-root cap, DescendantLaunchV1 extension, preflight injection seam) deferred in todos.
- `acceptance.ts:1198 runVerifyCommand` `shell:true` lane: independent sibling surface, awaiting Owner characterization (todos row, report-only).
- K1 tripwire remains local-only red (CI authoritative); verify-sprint prepare-acceptance environmental gap (projection defect) unchanged.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | Contract = three seams + 15 targeted tests + zero five-edge regression; all verified by independent gate re-runs; -1 for append-chain residual inherent to first-knife scope |
| Product depth | 8/10 | Contract = ruling B semantics without closure surgery; stable refusal text as single authority, fail-closed on unreadable config; append-chain deferral explicitly ruled into B-terminal package |
| Design quality | 9/10 | Contract = no dual-path, single live behavior; admission ordering preserves five-edge refuse-edge texts (notes:13 rationale); no new abstraction beyond one scanner module serving both custody faces |
| Code quality | 8/10 | Contract = allowed_paths containment (10/10 files) + vendored zero-diff (machine-checked) + commit hygiene clean; scorecard notes name their contracts per rubric |

## Failing Items

- K1 `pi-s2-bundle-resolution.test.ts:327` — pre-declared known item, local-only (bun registry tripwire on this machine), CI authoritative and green for this face; not introduced by this diff.

## Retest Steps

- Re-run: `bun test packages/client/src/__tests__/custody-external-cli-admission.test.ts` (expect 15 pass); `bun test packages/client/src/__tests__/custody-five-edge-dispatch.test.ts packages/client/src/__tests__/custody-charge-once-double-charge.test.ts packages/client/src/__tests__/custody-pi-subagent-runner-entry.test.ts` (expect 26 pass)
- Re-check: `git diff --name-only origin/main..HEAD | grep -c '^packages/client/vendor/'` → 0

## Summary

- N1 first knife (admission gate) delivered and independently accepted: external-CLI jobs cannot enter the vendored external-cli lane through any SDK path; refusal is typed, fail-closed, zero-state, and cites the ruling. Vendored closure untouched. Residual append-chain gap and sibling `acceptance.ts` lane are honestly ledgered for the B-terminal package and Owner characterization. Merge into main awaits Owner instruction; CI to confirm on the pushed branch.
