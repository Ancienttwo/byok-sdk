> **Archived**: 2026-08-07 19:40
> **Related Plan**: plans/archive/plan-20260807-1829-s2-byok-core-contracts.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260807-1940

# Task Review: s2-byok-core-contracts

> **Status**: Reviewed
> **Plan**: plans/plan-20260807-1829-s2-byok-core-contracts.md
> **Contract**: tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md
> **Notes File**: tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-07 21:05
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass — gatekeeper round 1 PASS with one P1 (canonical-timestamp contract gap); fix landed with revert-guard-proven negatives; shipped
- Change type: code-change (purely additive new package)
- Intended files changed: per contract Scope (`packages/core/**`, lockfile, architecture docs, todos ruling, sprint marks)
- Actual files changed: 52 files vs main (+6039 base + timestamp fix) via PR #20, merge `2b8e13e`; existing four packages and `examples/` byte-identical to main (machine-checked)
- Commands passed: typecheck 7/7; tests core 167 / keys 328 / protocol 189 / server 216 / client 873; build 5/5; protocol golden clean; existing-packages zero-diff; `check-task-workflow --strict`; `verify-contract --read-only` 20/20; CI 28/28 incl. the Node 20 leg (S2.4 #1's only locally-unverified face) and the strace credential-isolation audit
- Residual risks: `packages/core` lacks README/LICENSE while `package.json` carries license/publishConfig (ledgered in `tasks/todos.md` for the publish slice); conformance-suite packaging for out-of-repo consumers owned by S4A story O-005; `TenantScopedStores` facade deliberately deferred to S3
- Reviewer action required: none — receipt recorded via acceptance chain
- Rollback: revert PR #20 — pure package deletion plus lockfile regeneration; zero inbound dependencies by construction

## Mode Evidence

- Selected route: parent-agent orchestration; execution via deep-worker (whole package) + fast-worker ×2 (docs closure; P1/P2 fixes), acceptance via gatekeeper
- P1/P2/P3 evidence: plan Agentic Routing section
- Root cause or plan evidence: P1 root cause — lexicographic comparison of caller-supplied `string` timestamps only coincides with temporal order for canonical ISO-8601 UTC; fix pins the format at the contract layer (`timestamp_not_canonical`, `assertCanonicalTimestamp` exported for future SQL compositions) with conformance negatives that revert-guard red on unfixed code

## Verification Evidence

- Waza `/check` run: not used; gatekeeper agent rounds instead
- Commands run: see Human Review Card; gatekeeper independently re-ran all gates
- Manual checks: contract shapes verified verbatim against the architecture doc (quota fields §12.7.6, five `storage_*` codes §12.7.7, board transition table §12.3 — seven edges exactly, proof claims §S6.2 — 14 fields with method/path xor operationId, domain prefix bytes decoded from golden hex); conformance composition-neutrality (zero `InMemory` references in assertion modules); canonicalizer determinism (key-order shuffles) and fail-closed negatives (12 + circular); mermaid rendered with mmdc (5 dotted + 4 solid edges as intended)
- Supporting artifacts: PR #20 (https://github.com/Ancienttwo/byok-sdk/pull/20)
- Implementation notes reviewed: yes
- Run snapshot: `.ai/harness/checks/latest.json` (materialized by the acceptance chain)

## Manual Check Evidence

- [x] Proof canonicalization golden lives outside the protocol golden
  - Evidence: `packages/core/src/__tests__/golden/device-proof-v1.canonical.json`; protocol golden dir zero-diff
- [x] Conformance suite is composition-neutral
  - Evidence: assertion modules contain no `InMemory` token and no `instanceof`; in-memory integration is a factory with zero assertions

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:8a48a87d4183098e73ae4f89c74fed8f1767410bd1f5272e245d4ec977b74183
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 8a3a14d6fe9e0c0c0601e6d688fd464b24688549
> **Verification Evidence SHA256**: sha256:ad8e6958c0e876d3aa554e48541fc43df8c99cc3d574181ebf599f0ad40a5980
> **Issued At**: 2026-08-07T11:40:57.211Z

- Summary: Sprint S2 delivered and merged as PR #20 (2b8e13e): @byok/core contracts plus InMemory reference plus composition-parameterized conformance harness, purely additive with existing packages byte-identical to main; canonical-timestamp contract gap (gatekeeper P1) fixed with revert-guard-proven negatives; core 167 tests, repo 1773 green, CI 28/28 incl. Node 20 leg
- Findings: none

## Behavior Diff Notes

- New package only; no existing package behavior changes (machine-checked zero diff).
- Caller-supplied instants across core ports are now contractually canonical ISO-8601 UTC (fail-closed `timestamp_not_canonical`) — a deliberate cross-composition divergence guard.
- Board idempotent re-claims validate an explicitly supplied `expectedStatus` (full CAS), with the no-default nuance documented.

## Residual Risks / Follow-ups

- `packages/core` README/LICENSE vs publish metadata — `tasks/todos.md`, revisit at first publish or S7.
- S3 defines the `TenantScopedStores` handler facade; S4A O-005 owns conformance-suite packaging.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | S2.4 eleven criteria met; conformance 55 cases incl. canonical-instant negatives |
| Product depth | 9/10 | The P1 fix turned a latent cross-composition divergence into a contract |
| Design quality | 9/10 | Composition-neutral suite; frozen public surface; vocabulary isolation machine-checked |
| Code quality | 9/10 | Node-free/protocol-free enforced by tests, not convention |

## Failing Items

- none

## Retest Steps

- Re-run: the six contract `commands_succeed` at repo root
- Re-check: `packages/core/src/__tests__/constraints.test.ts`; conformance suite via the in-memory factory

## Summary

- Sprint S2 delivered: `@byok/core` contracts + InMemory reference + composition-parameterized conformance harness, purely additive, existing packages untouched. Gatekeeper's P1 (canonical timestamps) fixed and proven with revert-guard negatives. Shipped as PR #20, merge `2b8e13e`, CI 28/28 green.
