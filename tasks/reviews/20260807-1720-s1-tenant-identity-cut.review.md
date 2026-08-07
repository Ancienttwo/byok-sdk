# Task Review: s1-tenant-identity-cut

> **Status**: Reviewed
> **Plan**: plans/plan-20260807-1720-s1-tenant-identity-cut.md
> **Contract**: tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md
> **Notes File**: tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-07 19:35
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass — single-round gatekeeper PASS; no P0/P1 findings
- Change type: code-change (breaking pair/auth cut, wire-silent)
- Intended files changed: per contract Scope (pairing claims, device row tenant/product, token principal, hello row-equality gate, dual-end nonce domain separation, examples, smoke scripts per decc49a amendment, docs)
- Actual files changed: 50 files, +1484 −232 (PR #19, merge `50819a3`); all inside contract `allowed_paths`; `packages/protocol/` zero diff vs main (machine-checked), `packages/keys/` zero change
- Commands passed: typecheck 6/6; test keys 328 / protocol 189 / server 216 (25 files) / client 873 (89 files); build; golden byte-identical; `check-task-workflow --strict`; `ipc-smoke` live PASS; `verify-contract --read-only` 19/19; CI 28/28 on PR #19 incl. Node 20/22 matrix and the strace credential-isolation audit
- Residual risks: `machines.list()` operator surface not tenant-scoped (MEDIUM, no wire exposure, ledgered in `tasks/todos.md` for S2); `/byok/challenge` deviceId existence oracle (LOW, pinned pre-tenant DTO, unguessable ids, unknown≡revoked holds); `byDeviceId` secondary index last-write-wins invariant implicit (LOW)
- Reviewer action required: none — receipt recorded via acceptance chain
- Rollback: revert PR #19 as one batch (tenant cut + nonce format together, sprint S1.5); forced re-pair is the alpha recovery path

## Mode Evidence

- Selected route: parent-agent orchestration; execution via deep-worker (auth-plane batch) + fast-worker (smoke scripts + docs); explorer pre-mapped anchors and the 28-file fixture blast radius; acceptance via gatekeeper (single round)
- P1/P2/P3 evidence: plan Agentic Routing section
- Root cause or plan evidence: GAP-004/GAP-005 anchors verified against source before projection (`auth.ts:76-82,155`, `http.ts:125`, `device-keys.ts:44-47`)

## Verification Evidence

- Waza `/check` run: not used; gatekeeper agent round instead
- Commands run: see Human Review Card; gatekeeper independently re-ran all gates in the worktree
- Manual checks: DeviceRegistry public-surface ruling (class removed from index exports; internal `resolveByDeviceId` confined to the two pinned pre-tenant endpoints; four-point justification in the gate report); no-dual-mode grep (single verify exit `verifyNonceSignature`, prefix applied internally)
- Supporting artifacts: PR #19 (https://github.com/Ancienttwo/byok-sdk/pull/19)
- Implementation notes reviewed: yes — story→commit map, deviations (registry export removal, `isRevokedOrUnknown` deletion, commit 1/2 merge)
- Run snapshot: `.ai/harness/checks/latest.json` (materialized by the acceptance chain)

## Manual Check Evidence

- [x] No dual-mode nonce path exists
  - Evidence: `verifyEd25519Signature` module-private (`auth.ts:272`); sole caller `verifyNonceSignature` (`auth.ts:291`) applies `byok-nonce-v1\n` internally; single route call site `http.ts:154`; raw-signature negative test green
- [x] No tenant-existence oracle
  - Evidence: four failure classes collapse to one `undefined` in `authenticateBearer`; uniform 401 body byte-compared in `tenant-pairing-isolation.test.ts:232,:273`

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded.
- Findings: none

## Behavior Diff Notes

- Breaking: `createPairingCode` requires `{tenantId, productId}`; all existing pairings invalidate (forced re-pair); nonce signatures switch to the `byok-nonce-v1\n` domain prefix in the same batch, raw signatures 401.
- `DeviceRecord` carries required tenant/product written atomically at redeem; tokens carry the identity triple; `authenticateBearer` returns an `AuthenticatedDevice` via tenant-scoped composite-key lookup.
- WS hello now also requires `productId` equality with the device row before registration.
- `DeviceRegistry` no longer exported; the public device surface is tenant-first `devices.revoke(tenantId, deviceId)`.

## Residual Risks / Follow-ups

- `machines.list()` tenant scoping — `tasks/todos.md`, revisit at S2 store contracts.
- Long-poll protocol-version validation asymmetry — already ledgered (S0), unchanged by S1 (product identity now covered via token claims).

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | S1.4 ten criteria met; S1.3 negative matrix fully covered |
| Product depth | 9/10 | T0 lands before any hosted durable data, exactly as sequenced |
| Design quality | 9/10 | Claims-as-lookup-key structural; dual mode unwritable, not just untested |
| Code quality | 9/10 | Public surface shrank instead of annotating the naked path |

## Failing Items

- none

## Retest Steps

- Re-run: the six contract `commands_succeed` at repo root
- Re-check: `tenant-pairing-isolation.test.ts`; `pairing.test.ts`

## Summary

- Sprint S1 delivered: structural tenant identity (T0) + nonce domain separation (D-1) as one breaking batch, wire-silent, keys-plane untouched. Shipped as PR #19, merge `50819a3`, CI 28/28 green, gatekeeper PASS with no blocking findings.
