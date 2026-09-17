# Plan: WP4 first cut: custody enumeration debt + same-bundle runner preset entry

> **Status**: Executing
> **Created**: 20260917-2002
> **Slug**: wp4-runner-groundwork
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260917-2002-wp4-runner-groundwork.md`; after execution revert branch `codex/wp4-runner-groundwork` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md`
> **Task Review**: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md`
> **Implementation Notes**: `tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260917-2002-wp4-runner-groundwork.md`
- Sprint contract: `tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md`
- Sprint review: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md`
- Implementation notes: `tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-2002-wp4-runner-groundwork.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-2002-wp4-runner-groundwork.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md`
- Review file: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md`
- Implementation notes file: `tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-2002-wp4-runner-groundwork.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260917-2002-wp4-runner-groundwork.md`; after execution revert branch `codex/wp4-runner-groundwork` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-2002-wp4-runner-groundwork.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md`, `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md`, and `tasks/notes/20260917-2002-wp4-runner-groundwork.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260917-2002-wp4-runner-groundwork.md`; after execution revert branch `codex/wp4-runner-groundwork` or the explicitly reviewed diff.

## Captured Planning Output

# WP4 first cut: custody enumeration debt + same-bundle runner preset entry

## Why
WP3 (contract 20260917-1628, gate PASS @ 772c08e1) left two registered debts and the S2 five-edge enablement open. Debt 1: BYOK_SDK_CUSTODY_PARENT_DEPTH / BYOK_SDK_CUSTODY_LAUNCH_RECORD are SDK-minted launch lifecycle names but unregistered in TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES, so any future attested-spawn env re-verification (the runner lane) fails closed on them as unknown BYOK_* names. Debt 2: the runner lane has no same-bundle preset entry (the helper host's pi-subagent-runner branch throws 'not enabled'), while the plan (1459 line 43) stages WP4 as print entry [done WP3] -> same-bundle runner -> five-edge one-shot enablement.

## Boundary (explicit)
This cut does NOT claim five-edge production enablement. Delivered: the enumeration registration (debt 1) and the runner preset entry reachable ONLY via the direct `__byok_sdk_helper pi-subagent-runner` argv shape with unit-test coverage, mirroring the accepted WP3 print-branch pattern. No vendor spawn reroute (execution.ts:588 / async-execution.ts:564 / pi-spawn.ts legacy discovery stay untouched), no seam presetting, no maxDepth/assertion changes. Next-cut entrypoint: sdk-reserved-helper-host.test.ts runner pin family + vendor reroute per plan 1459.

## Task Breakdown
- [ ] A1: identity.ts TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES gains 'BYOK_SDK_CUSTODY_LAUNCH_RECORD' and 'BYOK_SDK_CUSTODY_PARENT_DEPTH' (sorted position), with a doc-block entry stating what mints them and why they are lifecycle-only (entry inputs consumed by the custody preset entries; never on the attested exec env).
- [ ] A2: packages/client/src/__tests__/tool-implementation-identity.test.ts:807-814 pin updated to the five-name exact enumeration (comment updated to cover the custody pair).
- [ ] B1: packages/client/src/custody/pi-subagent-runner-entry.ts — runner preset entry mirroring pi-subagent-print-entry.ts: same commitment parsing (parent depth, launch record), argv handling for the direct-connect helper shape, bootstrap charge +1 per the frozen table (rpc->runner=1, print->runner=1), exactNames env projection, validateDescendantSpawn + assertDescendantSpawn, single attested exec point launchAttestedPiSubagentRunner. Fail-closed throughout; no fallback.
- [ ] B2: sdk-reserved-helper-host.ts pi-subagent-runner branch routes to runAttestedPiSubagentRunnerFromEnvironment (mirrors print branch comment discipline).
- [ ] B3: sdk-reserved-helper-host.test.ts :269 pin flips from 'refuses inactive' to 'routes to attested runner exec point, refuses without custody commitments'.
- [ ] B4: packages/client/src/__tests__/custody-pi-subagent-runner-entry.test.ts — direct-invocation coverage: charge (+1 vs parent commitment), commitment refusals (missing/non-integer/record unreadable), argv/env projection, cross-platform spawn shape (process.execPath direct connect; no script association -> runs on win32), plus a probe observing PI_SUBAGENT_DEPTH === parent+1 through the real entry.

## Constraints
- Frozen charge-once table unchanged; no maxDepth/root/assertion loosening.
- Vendored tree and node_modules zero bytes.
- No CI/workflow files (WP1 surface); no push.

## Stop Conditions
- Stop if the runner entry cannot reuse the print entry's validation core without duplicating authority (then extract shared custody-entry helpers in the same slice under packages/client/src/custody/).
- Stop if B requires touching vendor spawn sites or dispatcher routing beyond the helper runner branch (that is the five-edge cut, not this one).

## Falsifier
If enabling the helper runner branch changes any behavior beyond `__byok_sdk_helper pi-subagent-runner` direct invocations (e.g. a vendor lane starts reaching it), the no-half-enablement claim is false and the branch must return to fail-closed.

## Evidence Contract
- WP3 regression guard custody-charge-once-double-charge.test.ts stays green (print lane unaffected).
- vendored-zero-byte vs 772c08e1.

## Annotations
tasks/notes/20260917-2045-wp4-runner-groundwork.notes.md
tasks/reviews/20260917-2045-wp4-runner-groundwork.review.md

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] A1: identity.ts TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES gains 'BYOK_SDK_CUSTODY_LAUNCH_RECORD' and 'BYOK_SDK_CUSTODY_PARENT_DEPTH' (sorted position), with a doc-block entry stating what mints them and why they are lifecycle-only (entry inputs consumed by the custody preset entries; never on the attested exec env).
- [ ] A2: packages/client/src/__tests__/tool-implementation-identity.test.ts:807-814 pin updated to the five-name exact enumeration (comment updated to cover the custody pair).
- [ ] B1: packages/client/src/custody/pi-subagent-runner-entry.ts — runner preset entry mirroring pi-subagent-print-entry.ts: same commitment parsing (parent depth, launch record), argv handling for the direct-connect helper shape, bootstrap charge +1 per the frozen table (rpc->runner=1, print->runner=1), exactNames env projection, validateDescendantSpawn + assertDescendantSpawn, single attested exec point launchAttestedPiSubagentRunner. Fail-closed throughout; no fallback.
- [ ] B2: sdk-reserved-helper-host.ts pi-subagent-runner branch routes to runAttestedPiSubagentRunnerFromEnvironment (mirrors print branch comment discipline).
- [ ] B3: sdk-reserved-helper-host.test.ts :269 pin flips from 'refuses inactive' to 'routes to attested runner exec point, refuses without custody commitments'.
- [ ] B4: packages/client/src/__tests__/custody-pi-subagent-runner-entry.test.ts — direct-invocation coverage: charge (+1 vs parent commitment), commitment refusals (missing/non-integer/record unreadable), argv/env projection, cross-platform spawn shape (process.execPath direct connect; no script association -> runs on win32), plus a probe observing PI_SUBAGENT_DEPTH === parent+1 through the real entry.
