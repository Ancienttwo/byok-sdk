> **Archived**: 2026-08-07 17:08
> **Related Plan**: plans/archive/plan-20260807-1508-s0-runtime-hardening.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260807-1708

# Task Review: s0-runtime-hardening

> **Status**: Reviewed
> **Plan**: plans/plan-20260807-1508-s0-runtime-hardening.md
> **Contract**: tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md
> **Notes File**: tasks/notes/20260807-1508-s0-runtime-hardening.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-07 17:20
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass — two-round gatekeeper review; round 1 FAIL (5 long-poll E2E red) escalated to the D-4 design amendment, round 2 PASS on the amended scope
- Change type: code-change
- Intended files changed: per contract Scope (client capability truth, server claim-snapshot + steer gate, client steer classification, bounded protocol additive per D-4, docs closure)
- Actual files changed: 38 files, +1945 −146 (PR #18, merge `d2395d6`); all inside contract `allowed_paths`; `packages/keys/**` and `docs/security.md` untouched
- Commands passed: all six contract `commands_succeed` (typecheck / test 137 files 1586 tests / build / golden dir clean / `v1.envelopes.ndjson` byte-identical to base / `check-task-workflow --strict`), plus CI 28/28 on PR #18 incl. Node 20/22 matrix and the Ubuntu strace credential-isolation audit
- Residual risks: pre-S0/pre-D-4 claimed tasks are refused steer (fail-closed, release-note item); custom adapters must throw `SteerUnsupportedError` for non-retryable steer or the cursor stalls (ledgered in `tasks/todos.md` via the long-poll validation-asymmetry row's sibling note); mermaid render check has no repo tooling (diff verified to touch no mermaid content)
- Reviewer action required: none — receipt recorded via acceptance chain
- Rollback: revert PR #18 (merge commit `d2395d6`); D-4 group (`ac92acb`→`7fa92f9`) reverts as one unit; wire additive-only, no persisted-state residue

## Mode Evidence

- Selected route: parent-agent orchestration; execution via subagents (2× fast-worker, 2× deep-worker), design via deep-reasoner (Codex second track unavailable — usage limit), acceptance via gatekeeper ×2
- P1/P2/P3 evidence: plan Agentic Routing section; sprint D-4 record for the mid-slice design pivot
- Root cause or plan evidence: round-1 root cause (long-poll-only daemons never send `conn.hello`; sole sender `ws-transport.ts:192`) captured in contract Falsifier (FIRED) and sprint D-4

## Verification Evidence

- Waza `/check` run: not used; gatekeeper agent rounds instead
- Commands run: see Human Review Card; second-round gatekeeper independently re-ran all six exit-criteria commands and `verify-contract --read-only` (18/18)
- Manual checks: `v1.frozen.json` structural comparison (path-level walk: 0 removed / 0 retyped / 56 added collapsing to 4 `task.claim.../capabilities` roots; `oneOf[7]` discriminator independently confirmed as `task.claim`; added subtree byte-identical to the existing `RuntimeCapabilities` shape)
- Supporting artifacts: PR #18 (https://github.com/Ancienttwo/byok-sdk/pull/18), CI runs 31164042743 / 31164066557
- Implementation notes reviewed: yes — story→commit map and D-4 decision record
- Run snapshot: `.ai/harness/checks/latest.json` (materialized by the acceptance chain)

## Manual Check Evidence

- [x] `v1.frozen.json` regeneration diff limited to `task.claim` keys
  - Evidence: structural diff 4 ADDED roots / 0 REMOVED / 0 retyped; `task.claim.required` unchanged (`["deviceId"]`); `protocolVersion` stays 1; envelope variant count 17↔17
- [x] Zero-envelope proof for rejected steer is deterministic
  - Evidence: `expectNoSteerSent` asserts `stats().envelopesOut` +1 for a post-rejection cancel and the device's next frame is `task.cancel`

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:8a48a87d4183098e73ae4f89c74fed8f1767410bd1f5272e245d4ec977b74183
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: febc33cb813dcf0a5fed329aa806bc6b555605c8
> **Verification Evidence SHA256**: sha256:c8deed48f4bc61538a3f2699ca9b2491ceb6e3d83be92af517c513a0caead268
> **Issued At**: 2026-08-07T09:07:47.966Z

- Summary: Sprint S0 delivered and merged as PR #18 (d2395d6): GAP-001/002/003 closed; capability truth generated from adapters; task-level steer gate fail-closed on claim-carried capabilities per sprint amendment D-4; long-poll regression caught in review round 1 and resolved without weakening the gate; 1586 tests green, CI 28/28, credential-isolation audit pass, v1 NDJSON byte-frozen
- Findings: none

## Behavior Diff Notes

- Steer against a runtime whose claim did not report `steer: true` is now rejected server-side with typed `SteerRejectedError` (`steer_unsupported_runtime`) before any envelope is sent; previously the envelope reached the client, the adapter threw, and the cursor froze in a permanent replay loop.
- `RuntimeInfo.capabilities.approvalInteractive` on the wire is now adapter truth (pi false / claude true / codex false); previously hardcoded false for all.
- `task.claim` may carry `capabilities` (additive optional); old daemons omitting it get fail-closed steer, not a fallback.
- Client acks an inbound `SteerUnsupportedError`-classified steer (records, cursor advances); transient steer errors keep stall/redelivery semantics.

## Residual Risks / Follow-ups

- Long-poll vs WS protocol/product validation asymmetry — ledgered in `tasks/todos.md`, targeted at S1.
- Custom-adapter steer error contract (`SteerUnsupportedError`) documentation — follow-up docs line.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | All ten S0.3 criteria verified; H-010 long-poll E2E added |
| Product depth | 8/10 | D-4 turned a review failure into the structurally correct capability authority |
| Design quality | 9/10 | Single truth source machine-guarded by contradiction-driving tests |
| Code quality | 9/10 | Typed errors, fail-closed at the syntax level, commit boundaries preserve revertibility |

## Failing Items

- none

## Retest Steps

- Re-run: the six contract `commands_succeed` at repo root
- Re-check: `steer-runtime-capability-gate.test.ts` structural guard block; `real-server-longpoll-steer.test.ts`

## Summary

- Sprint S0 delivered: GAP-001/002/003 closed, capability truth unified behind the adapters, task-level steer gate fail-closed on claim-carried capabilities (sprint D-4), long-poll steer regression caught by review round 1 and resolved without weakening the gate. Shipped as PR #18, merge `d2395d6`, CI 28/28 green.
