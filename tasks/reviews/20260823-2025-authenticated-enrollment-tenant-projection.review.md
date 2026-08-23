# Task Review: authenticated-enrollment-tenant-projection

> **Status**: Passed
> **Plan**: plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md
> **Contract**: tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md
> **Notes File**: tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-23 21:15
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:cc881b8d2a935dbe4f338d85581e5a4a4ca0ee6af93aad08105c7626c2281fea
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 70002fb1bd57afec0ded19c05f7c649e4137ee0d

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: protocol, cloud/reference pairing, client enrollment persistence/daemon composition, focused dataplane evidence, aligned package manifests, README/docs, and workflow artifacts allowed by the contract.
- Actual files changed: 52 normalized subject files, all within Allowed Paths.
- Commands passed: contract 25/25; full build/typecheck/test; release graph and pack smoke; strict workflow; real disposable Postgres/MinIO oracle; packed empty-database migration smoke.
- Residual risks: source/RC acceptance only; 0.6.x records require re-pair after cloud accepts the new response. Merge, push, publication, deployment and downstream enablement remain separate authority.
- Reviewer action required: none for source acceptance.
- Rollback: revert the complete unreleased 0.7.0/keys 0.3.0 candidate to `70002fb`; do not synthesize a legacy tenant fallback.

## Mode Evidence

- Selected route: strict isolated contract worktree, hosted/reference/client/dataplane traces, packed RC proof, and independent frozen-subject gate.
- P1/P2/P3 evidence: active plan and implementation notes record the cloud pairing authority, exact pairing-to-daemon trace, and no-compatibility migration decision.
- Root cause or plan evidence: `PairResponse` dropped the already-authenticated tenant while daemon config authored a second tenant source; Stage A carries the binding into the sole local enrollment record.

## Verification Evidence

- Waza `/check` run: not used; repository-native strict contract workflow was authoritative.
- Commands run: `verify-contract --strict`, `verify-sprint --prepare-acceptance`, `acceptance-receipt verify`, full package gates, pack-and-smoke, and disposable dataplane/migration probes.
- Manual checks: independent gatekeeper PASS on exact source `1dfc34d323948438499a21262ab92235df33c698`; source search found no host-authored/JWT/deviceId/shadow tenant authority.
- Supporting artifacts: `.ai/harness/checks/latest.json`, frozen local release manifest, and the run snapshot below.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/run-20260823T210735-54566-20260823-2025-authenticated-enrollment-tenant-projection.json`.

## Manual Check Evidence

- No contract-specific `manual_checks` entries were declared.
- Independent semantic evidence: first gate blocked on stale README and moving SHA; README was corrected, the subject re-frozen, and the final gate passed that exact SHA.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:cc881b8d2a935dbe4f338d85581e5a4a4ca0ee6af93aad08105c7626c2281fea
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 70002fb1bd57afec0ded19c05f7c649e4137ee0d
> **Verification Evidence SHA256**: sha256:2f4419006c4a621233bbf3ffb72ac40b0f700c6e1761b47734af9287512cd9b5
> **Issued At**: 2026-08-23T13:08:34.780Z

- Summary: User approved Stage A source and RC preparation only; independent frozen-subject gate passed on 1dfc34d. No merge, push, publish, deploy, production or secret authority.
- Findings: none

## Behavior Diff Notes

- Projects required opaque tenant identity from authenticated pairing/device authority into `PairResponse` and the atomic local `DeviceRecord`.
- Preserves the exact binding on renewal, atomically replaces it on explicit re-pair, and refuses legacy/tampered records without fallback.
- Removes host-authored Agent egress/journal tenant configuration; daemon egress, content, ack and journal identity consume the loaded enrollment record.
- Keeps Salesko Profile, Agent artifacts and product semantics downstream; SDK retains canonical Agent-home, containment, lifecycle and transport fidelity.

## Residual Risks / Follow-ups

- Upgrade order is cloud/control first, then Local Agent re-pair, then Agent dispatch enablement; reversing it fails closed on missing tenant projection.
- Two unrelated timing flakes were observed across repeated full gates: Wrangler dry-run timeout and live SQLite WAL snapshot drift. Unchanged focused/full reruns passed.
- No branch integration, push, publish, registry mutation, deployment or downstream cutover is implied by this review.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Authenticated binding survives wire, disk, restart, renewal and daemon composition. |
| Product depth | 9/10 | Generic SDK authority is complete; product Profile/artifact semantics remain intentionally downstream. |
| Design quality | 10/10 | One cloud authority, one local projection, fail-closed migration, no steady-state fallback. |
| Code quality | 9/10 | Full gates, packed proof and independent gate passed; unrelated timing flakes remain observable. |

## Failing Items

- None on the accepted frozen subject.

## Retest Steps

- Re-run: contract verification plus disposable Postgres/MinIO tenant readback and packed empty-database migration smoke.
- Re-check: request-authored tenant rejection, legacy record refusal, re-pair replacement, renewal preservation, daemon egress/journal binding, and registry exact-version closure.

## Summary

- Pass. Stage A closes the authenticated enrollment tenant projection without a downstream workaround; the typed source acceptance remains limited to the unreleased RC boundary.
