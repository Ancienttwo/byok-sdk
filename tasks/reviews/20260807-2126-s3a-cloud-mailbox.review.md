# Task Review: s3a-cloud-mailbox

> **Status**: Reviewed
> **Plan**: plans/plan-20260807-2126-s3a-cloud-mailbox.md
> **Contract**: tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md
> **Notes File**: tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-08 00:40
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass — single-round gatekeeper PASS, zero P0/P1 (six P2 suggestions deferred to S3b)
- Change type: code-change (additive new package + client test fixture)
- Intended files changed: per contract Scope (`packages/cloud/**`, client E2E fixture/test, lockfile, architecture docs, sprint D-5 + S3.5 marks)
- Actual files changed: 52 files (+4769 −32) via PR #21, merge `714f61d`; client production code byte-identical to main (machine-checked incl. the gatekeeper's stricter full-src sweep); protocol/keys/server/examples zero-diff
- Commands passed: typecheck 8/8; tests 1851 (cloud 77 new, client 874); build 6/6; protocol golden clean; zero-touch machine check; `check-task-workflow --strict`; `verify-contract --read-only` 19/19; CI 28/28 incl. Node 20 (WebCrypto Ed25519 face closed by CI)
- Residual risks: six P2s deferred to S3b — verbatim-bytes comment overstatement at the receipt seam (P2-1), const-wrapped mutable scan gap (P2-2), unwrapped-fetch guard (P2-3), GAP-015 S3b label drift (P2-4), wall-clock hold assertion (P2-5), Node 20 Ed25519 now CI-closed (P2-6)
- Reviewer action required: none — receipt recorded via acceptance chain
- Rollback: revert PR #21 — deletes the package and the client test fixture; zero inbound edges

## Mode Evidence

- Selected route: parent-agent orchestration; explorer pre-mapped the HTTP surface; deep-worker built the package; fast-worker closed docs; gatekeeper single acceptance round
- P1/P2/P3 evidence: plan Agentic Routing; sprint D-5 records the S3 split rationale (loud-vs-silent failure modes)
- Root cause or plan evidence: two open design points ruled before dispatch — `/byok/capabilities` is a new hosted-only route (ADR-002), and ownership/dedup live in cloud-local tenant-first ports matching the S4A schema minimum

## Verification Evidence

- Waza `/check` run: not used; gatekeeper agent round instead
- Commands run: see Human Review Card
- Manual checks: Falsifier confirmed (E2E reuses the server-test assertion shape; only host-side entry differs by design); I1 bidirectional closure against Hono's own route table (private `#app`, no bypass path); statelessness scans; S1-parity incl. three-way `byok-nonce-v1` literal identity across server/client/cloud; fixture relative-import hazards (typecheck resolution, vitest, dist pollution) all empirically excluded
- Supporting artifacts: PR #21 (https://github.com/Ancienttwo/byok-sdk/pull/21)
- Implementation notes reviewed: yes
- Run snapshot: `.ai/harness/checks/latest.json` (materialized by the acceptance chain)

## Manual Check Evidence

- [x] Daemon cannot tell cloud from server
  - Evidence: `real-cloud-longpoll.test.ts` mirrors `real-server-longpoll-only.test.ts` assertions; client production zero-diff machine-checked
- [x] Route registry is the only mount path
  - Evidence: `registry.ts` holds the private Hono app; `mountedRoutes` compares Hono's own table bidirectionally with the classified inventory

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

- New hosted surface only; the self-hosted server path is untouched and the daemon requires no knowledge of which backend it speaks to.
- Deliberate divergence: pairing failures collapse to one message (stricter anti-enumeration than the server; status code and shape unchanged).
- Hosted-only `GET /byok/capabilities` added (nothing existed to mirror); declaration drives route mounting.

## Residual Risks / Follow-ups

- P2-1/P2-3/P2-4 ledgered in `tasks/todos.md` for S3b's first commit; P2-2/P2-5 noted for S3b test work.
- S3b owns S3.5 boxes 3-9 (journal, crash/disk matrices); alpha gate closes only after S3b (sprint D-5).

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | Nine S3a boxes green; daemon E2E first-run pass |
| Product depth | 9/10 | First hosted vertical slice with structural I1 |
| Design quality | 9/10 | Statelessness machine-checked; ports match the S4A schema minimum |
| Code quality | 9/10 | Zero new transitive deps; platform-neutral; no server import |

## Failing Items

- none

## Retest Steps

- Re-run: the six contract `commands_succeed` at repo root
- Re-check: `route-inventory.test.ts`; `real-cloud-longpoll.test.ts`; `constraints.test.ts`

## Summary

- Sprint S3a delivered: stateless `@byok/cloud` with tenant-first ports, `TenantStores` facade, I1 structural closure, and the unchanged daemon completing a full lifecycle over long-poll. Shipped as PR #21, merge `714f61d`, CI 28/28 green incl. Node 20. S3b (SQLite journal + crash/disk matrices) is the remaining half of Sprint S3.
