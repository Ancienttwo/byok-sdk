# Task Review: device-assertion-broker

> **Status**: Pending
> **Plan**: plans/plan-20260812-0445-device-assertion-broker.md
> **Contract**: tasks/contracts/20260812-0445-device-assertion-broker.contract.md
> **Notes File**: tasks/notes/20260812-0445-device-assertion-broker.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-12 04:46
> **Recommendation**: fail
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pending
- Change type: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | frontend
- Intended files changed:
- Actual files changed:
- Commands passed:
- Residual risks:
- Reviewer action required: inspect diff and card
- Rollback:

## Mode Evidence

- Selected route:
- P1/P2/P3 evidence:
- Root cause or plan evidence:

## Verification Evidence

- Waza `/check` run:
- Commands run:
- Manual checks:
- Supporting artifacts:
- Implementation notes reviewed:
- Run snapshot:

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [ ] Exact manual_checks requirement
  - Evidence: concrete observation, command output, screenshot path, or reviewer note

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:e4263c1ba22d9b41fd26c012cea35f32a24223cb2b6dc34e3c5c7e2159abba91
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 3d66543c504f2aa3c6517e34e57c4c2a745232dd
> **Verification Evidence SHA256**: sha256:2746e8007b2801f8421d3b8b0cffef0d6ae34fb2a2edb6ddc2256bba7ae53a23
> **Issued At**: 2026-08-11T23:11:17.706Z

- Summary: Security dual-track converged over 2 codex rounds (round1 6 findings incl 2xP1, round2 5 findings incl 2 fix-introduced holes — all fixed; round3 filter-refused, redaction self-verified) + gatekeeper PASS. Six fail-closed gates, mint latch at every teardown entrance, signing-point recheck, verifier lookup-port forces revocation provenance, denied audience structurally reduced to size, TTL<=5min, public export only requestDeviceAssertion. Row-5-introduced daemon-owner port-collision flake root-fixed via env-gated test-only mutex-port seam (production byte-identical, not on public surface); 10/10 then 5/5 consecutive full-suite green (prior ~1/4). core 150 / client 1112, zero-diff on frozen surfaces.
- Findings: P3: [unverified] Row 5 assumes salesko apps/api is TS/Node able to depend on @byok-sdk/core for verifyDeviceAssertion; if Go/Python the JWS approach reopens — confirm with salesko; P3: final freeze/claim of the broker awaits salesko Phase C consumption per dogfood order; P3: revoke synchronous-invalidation is split: daemon owns local half (gates), host exchange must recheck the device revocation row — documented, not daemon-alone

## Behavior Diff Notes

- ...

## Residual Risks / Follow-ups

- ...

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 0/10 | |
| Product depth | 0/10 | |
| Design quality | 0/10 | |
| Code quality | 0/10 | |

## Failing Items

- ...

## Retest Steps

- Re-run:
- Re-check:

## Summary

- ...
