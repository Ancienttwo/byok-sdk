# Task Review: agent-first-home-contract

> **Status**: Passed
> **Plan**: plans/plan-20260823-1214-agent-first-home-contract.md
> **Contract**: tasks/contracts/20260823-1214-agent-first-home-contract.contract.md
> **Notes File**: tasks/notes/20260823-1214-agent-first-home-contract.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-23 16:12
> **Recommendation**: pass-with-user-waiver
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:cba6fdd9e422ef460354a045f7e5494792c6a3086cce16e49195788987924240
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 263df0234d709ef59090986f133a9640e5e290fd

## Human Review Card

- Verdict: pass under the contract-allowed typed user waiver.
- Change type: code-change
- Intended files changed: protocol, reference server, hosted cloud/dataplane,
  client Agent-home/runtime/session surfaces, SQL migration, tests, and
  architecture/integration docs listed by the contract.
- Actual files changed: the normalized subject paths frozen in
  `.ai/harness/checks/latest.json`; allowed-path status passed with no outside
  paths.
- Commands passed: all 22 contract checks, including build, typecheck, full
  test, strict workflow, and disposable-Postgres runtime readback.
- Residual risks: the separate typed local/cloud egress contract is design-only;
  the exact final subject was accepted by user waiver rather than a fresh
  Claude `external_pass`; no downstream cutover or publication occurred.
- Reviewer action required: none for this local work-package acceptance.
- Rollback: revert the Agent-first commit series before downstream cutover; do
  not delete any downstream Agent home.

## Mode Evidence

- Selected route: parent-agent P1/P2/P3 with contract-scoped implementation and
  frozen repo-harness evidence.
- P1/P2/P3 evidence: architecture map, concrete dispatch-to-runtime trace, and
  design decision are frozen in
  `plans/plan-20260823-1214-agent-first-home-contract.md`.
- Root cause or plan evidence: Agent-first planning output plus the end-to-end
  behavior tests named by the contract; this is a code-change work-package,
  not a bugfix-profile claim.

## Verification Evidence

- Waza `/check` run: external Claude reviews were run on earlier frozen
  candidates. The final review found target-device concerns on `6304744`; the
  wire trace showed an existing central ownership drop, and final code added
  handler defense plus a two-device regression. No further external rerun was
  performed after the declared review-loop stop boundary.
- Commands run: `bun run build`; `bun run typecheck`; `bun run test`;
  `BYOK_REQUIRE_DATAPLANE=1 bun run --cwd packages/cloud-dataplane test --
  src/__tests__/agent-home-contract.test.ts`; `repo-harness run
  check-task-workflow --strict`; strict contract verification and
  `verify-sprint --prepare-acceptance`.
- Manual checks: SDK/downstream authority matrix and migration boundary were
  checked against the contract and docs; no runtime deployment was claimed.
- Supporting artifacts: `.ai/harness/checks/latest.json` and the run snapshot
  below.
- Implementation notes reviewed:
  `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`.
- Run snapshot:
  `.ai/harness/runs/run-20260823T161005-24241-20260823-1214-agent-first-home-contract.json`.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- None. The contract declares no non-built-in `manual_checks` requirement.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:cba6fdd9e422ef460354a045f7e5494792c6a3086cce16e49195788987924240
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 263df0234d709ef59090986f133a9640e5e290fd
> **Verification Evidence SHA256**: sha256:8e3ee3ae549f69bc7044d15207b8d3cedf0402e57af492a9fdf56e05ad5753f3
> **Issued At**: 2026-08-23T08:11:31.234Z

- Summary: User approved the Agent-first upstream work-package; frozen verification closes the implementation gate without authorizing merge, push, publish, or deploy.
- Findings: none

## Behavior Diff Notes

- Agent-bound dispatch now uses a distinct strict offer plus additive
  `agent-home-contract` admission; old daemons fail before task creation or
  enqueue.
- SDK code alone composes `<hostStorageRoot>/agents/<agentId>`, initializes and
  preserves Agent memory/notes, acquires one writer lease, and seals exact
  AgentRef/session/runtime/cwd evidence through adapter execution and terminal
  persistence.
- Reference server and hosted cloud enforce target-device and exact AgentRef
  identity, including durable restart readback; Agent files outside `.byok`
  remain opaque.

## Residual Risks / Follow-ups

- Typed Agent-local/cloud egress (metadata-default, content opt-in, durable
  cursor/ack/retry, quota/backpressure/redaction, explicit content-read
  capabilities) remains the separate work-package recorded in
  `docs/researches/agent-local-cloud-projection-contract.md` and
  `tasks/todos.md`.
- This receipt is local acceptance only. The branch has not been merged,
  pushed, published, deployed, or used for a Salesko migration.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | Required Agent-home behavior and negative paths pass; egress is intentionally separate. |
| Product depth | 9/10 | Long-lived Agent authority is carried across local and cloud boundaries without importing Salesko semantics. |
| Design quality | 9/10 | One path authority, exact identity, fail-closed capability and session rules, no compatibility fallback. |
| Code quality | 9/10 | Frozen protocol, disposable persistence oracle, full-suite and cross-device regression coverage pass. |

## Failing Items

- None inside the accepted Agent-first work-package.

## Retest Steps

- Re-run: `repo-harness run verify-sprint` against the frozen receipt.
- Re-check: verify the receipt projection remains valid and the worktree is
  clean; do not infer downstream deployment from local acceptance.

## Summary

- Agent-first upstream contract passes its frozen verification and is accepted
  through the contract-allowed typed user waiver. External review provenance,
  deferred egress scope, and non-publication state remain explicit.
