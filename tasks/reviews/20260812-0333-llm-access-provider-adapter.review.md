# Task Review: llm-access-provider-adapter

> **Status**: Passed
> **Plan**: plans/plan-20260812-0333-llm-access-provider-adapter.md
> **Contract**: tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md
> **Notes File**: tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-12 04:23
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:8e403cbb8648735b2d09b7482e93278fc712011a8954d57dd2aad89c2cb710bb
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 3d66543c504f2aa3c6517e34e57c4c2a745232dd

## Human Review Card

- Verdict: pass; no P0/P1/P2 findings.
- Change type: code-change.
- Intended files changed: protocol/server/client/keys dispatch surfaces plus canonical docs and workflow evidence.
- Actual files changed: 51 paths, all covered by the contract allowed-path set.
- Commands passed: contract 23/23; recursive build, typecheck, test; strict workflow; package pack/install smoke.
- Residual risks: hosted direct-mailbox callers must supply the daemon capability fact; web-to-device secret provisioning remains out of scope; keychain command availability has no launcher-owned timeout.
- Reviewer action required: record the frozen contract's semantic AcceptanceReceipt before merge.
- Rollback: revert the provider-adapter PR; no database migration or mandatory wire field was added.

## Mode Evidence

- Selected route: local frozen-diff architecture, security, and adversarial review; no external reviewer was invoked.
- P1/P2/P3 evidence: plan sections `P1 — Architecture map`, `P2 — Concrete trace`, and `P3 — Design decision`, confirmed against the integrated source after merging `origin/main`.
- Root cause or plan evidence: pinned Pi 0.84.1 positive/negative probe in `docs/researches/pi-provider-baseurl-probe.md`.

## Verification Evidence

- Waza `/check` run: not invoked; the equivalent rubric was applied locally because the repository's review trigger requires explicit user invocation for external review.
- Commands run: `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm -r run test`, `repo-harness run check-task-workflow --strict`, and `repo-harness run verify-sprint --prepare-acceptance`.
- Manual checks: inspected exact argv, child environment, dependency edges, projection bytes, package bin mode, SQLite read-only lifecycle, and capability gating.
- Supporting artifacts: `.ai/harness/checks/latest.json`; `.ai/harness/runs/run-20260812T042141-37663-20260812-0333-llm-access-provider-adapter.json`; `/tmp/byok-sdk-pack-check/byok-sdk-keys-0.1.0.tgz`.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/run-20260812T042141-37663-20260812-0333-llm-access-provider-adapter.json`.

## Manual Check Evidence

- [x] No contract-specific `manual_checks` entries were declared.
  - Evidence: the contract contains only files, artifacts, tests, and command exit criteria.

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:8e403cbb8648735b2d09b7482e93278fc712011a8954d57dd2aad89c2cb710bb
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 3d66543c504f2aa3c6517e34e57c4c2a745232dd
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: verification evidence is frozen and ready for the contract's semantic acceptance step.
- Findings: none.

## Behavior Diff Notes

- `task.offer` gains one optional strict `dispatchSelection`; a server sends it only to a daemon advertising `dispatch-selection`, preventing an older v1 peer from stripping it into legacy semantics.
- Subscription selections pin the exact Claude/Codex model while stripping ambient provider credentials.
- BYOK selections invoke a keys-owned launcher that validates one configured profile/model, reads OS custody only when auth is required, writes a private credential-blind Pi projection, and delegates transport/agent execution to Pi.
- Missing/mismatched capability, runtime, provider, model, launcher, profile, keychain, or secret fails closed without provider fallback.

## Residual Risks / Follow-ups

- P3: the hosted `@byok-sdk/cloud` direct mailbox API does not itself own connection capability state; an integrating capability producer/caller must gate `dispatchSelection` before using that transport.
- P3: web-to-device encrypted secret provisioning is not implemented; this slice assumes the provider profile/key already exists locally.
- P3: macOS/Windows keychain subprocesses use their current store behavior and have no new launcher-specific timeout. This affects availability, not target integrity or secret routing.
- Two unrelated timing-sensitive tests each failed once across repeated full runs and passed immediate isolated reruns; the final frozen `verify-sprint` run passed all 23 criteria.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | Exact target contract is end-to-end and negative paths are covered; hosted UI provisioning is intentionally outside scope. |
| Product depth | 9/10 | Dual subscription/BYOK lanes preserve local-runtime authority without adopting Hermes. |
| Design quality | 9/10 | One wire authority, separate credential custody, private per-process projection, no listener or dispatch dependency edge. |
| Code quality | 9/10 | Strict schemas, fail-closed errors, package smoke, and integrated regression coverage; residual availability risks are documented. |

## Failing Items

- None in the reviewed subject.
- Shipping remains procedurally blocked until a valid AcceptanceReceipt is recorded; this is not a code-review failure.

## Retest Steps

- Re-run: `repo-harness run verify-sprint --prepare-acceptance` after any semantic change.
- Re-check: exact `dispatchSelection` propagation, adapter argv/env, launcher projection/cleanup, dependency scan, and required recursive checks.

## Summary

- Pass. The implementation reuses Pi as the agent-dispatch provider/transport authority, adds no Hermes component or second dispatch transport, and keeps BYOK secret custody out of the daemon/runtime-adapter process boundary. The frozen semantic acceptance gate remains to be supplied by the contract owner or named external reviewer.
