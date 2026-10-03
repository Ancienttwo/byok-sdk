# Plan: T3b N1 append admission and external CLI env isolation

> **Status**: Complete
> **Created**: 20261002-1601
> **Slug**: t3b-n1-minimal-fix
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Focused custody/env/provenance tests and all workspace typecheck green; required repo checks recorded
> **Rollback Surface**: Revert only the local T3b commit; preserve other worktrees and branches
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261002-1601-t3b-n1-minimal-fix.contract.md`
> **Task Review**: `tasks/reviews/20261002-1601-t3b-n1-minimal-fix.review.md`
> **Implementation Notes**: `tasks/notes/20261002-1601-t3b-n1-minimal-fix.notes.md`

## Agentic Routing
- Selected route: execution
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261002-1601-t3b-n1-minimal-fix.md`
- Sprint contract: `tasks/contracts/20261002-1601-t3b-n1-minimal-fix.contract.md`
- Sprint review: `tasks/reviews/20261002-1601-t3b-n1-minimal-fix.review.md`
- Implementation notes: `tasks/notes/20261002-1601-t3b-n1-minimal-fix.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261002-1601-t3b-n1-minimal-fix.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261002-1601-t3b-n1-minimal-fix.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261002-1601-t3b-n1-minimal-fix.md`.

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
- Contract file: `tasks/contracts/20261002-1601-t3b-n1-minimal-fix.contract.md`
- Review file: `tasks/reviews/20261002-1601-t3b-n1-minimal-fix.review.md`
- Implementation notes file: `tasks/notes/20261002-1601-t3b-n1-minimal-fix.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261002-1601-t3b-n1-minimal-fix.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261002-1601-t3b-n1-minimal-fix.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert only the local T3b commit; preserve other worktrees and branches
- **Verification boundary**: Focused custody/env/provenance tests and all workspace typecheck green; required repo checks recorded
- **Review/acceptance boundary**: `tasks/reviews/20261002-1601-t3b-n1-minimal-fix.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20261002-1601-t3b-n1-minimal-fix.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261002-1601-t3b-n1-minimal-fix.contract.md`, `tasks/reviews/20261002-1601-t3b-n1-minimal-fix.review.md`, and `tasks/notes/20261002-1601-t3b-n1-minimal-fix.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261002-1601-t3b-n1-minimal-fix.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert only the local T3b commit; preserve other worktrees and branches

## Captured Planning Output

# T3b N1 minimal fix

Scope authority: `/tmp/byok-t3b-n1-minimal-fix.md`, explicitly approved by Aimpact in this session. Execute in the existing `/Users/chris/Projects/byok-sdk-wt-n1-custody`, branch `codex/n1-external-cli-custody`. Only local commit; no push, PR, merge, ready transition or cleanup.

## P1 map
Initial external-cli admission owns the recursive kind scanner/refusal text in `src/custody/external-cli-admission.ts`. Dispatcher owns the existing typed error. Vendored chain append and external-cli spawn are the two pressure points. SDK runtime environment owns the platform/proxy baseline; implementation-identity owns the frozen custody environment-name inventory.

## P2 trace
append request JSON -> consumeChainAppendRequests -> runner steps.push -> external-cli spawn. Current consumer bypasses initial admission. Bare/unknown adapter -> no adapter environment -> externalEnvironment copies process.env -> real child inherits custody transport and unrelated secrets.

Root cause and pre-fix evidence: the in-repo `custody-external-cli-append-environment.test.ts` on unchanged production source fails 12 of 14 cases, with two positive controls passing; `/tmp/byok-t3b-n1-pre-fix.log`, exit 1.

## P3 decision
Move the existing error class into the lightweight admission module and re-export it from the dispatcher, preserving type identity and error text. Validate the entire append batch with the same scanner before unlinking any request; throw the same typed refusal. Bare/unknown external launches rebuild a platform/proxy environment using buildRuntimeEnv. Hard deny BYOK and the existing custody-name vocabulary, including explicit allowlist/value attempts; preserve named adapter credential selection. Update only the two affected vendor provenance hashes/deltas. At 10x, safe requests must not disappear because a later request is refused; the whole-batch precheck is necessary.

## Allowed Paths
- packages/client/src/custody/external-cli-admission.ts
- packages/client/src/custody/custody-dispatcher.ts
- packages/client/src/__tests__/custody-external-cli-append-environment.test.ts
- packages/client/vendor/pi-subagents/0.60.0/src/runs/background/chain-append.ts
- packages/client/vendor/pi-subagents/0.60.0/src/runs/shared/external-cli-runner.ts
- packages/client/vendor/pi-subagents/0.60.0/source-manifest.json
- The plan/notes/review artifacts generated for this T3b task only.

## Non-goals
No sixth edge, no top-level Codex credential stripping, no spec edits, no timeouts/assertion loosening, no unrelated refactoring, no change to runtime pins or other worktrees.

## Task Breakdown
- [x] Trace both defects and port the two red probes to in-repo regression tests; preserve pre-fix failure evidence.
- [x] Apply minimal append/env repairs and exact vendor provenance updates.
- [x] Run focused regression/custody/environment suites and provenance checks; all workspace typecheck must pass.
- [x] Run required build, workspace test, API/version authority and strict workflow checks; record any unrelated baseline failure honestly.
- [x] Review scope and final diff, record report and required local workflow evidence. Delivery is a local commit only.

## Verification
`bun run build`; `bun run typecheck`; relevant client vitest tests including the new regression and existing initial admission/five-edge/charge-once/runner-entry/environment/provenance; `BYOK_REQUIRE_BUN=1 BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun bun run test`; `bun run check:api-surface`; `bun run check:version-authority`; `repo-harness run check-task-workflow --strict`.

## Delivery
Report `/tmp/byok-t3b-n1-minimal-fix-report.md` with P1/P2/P3, pre-fix and post-fix evidence, local commit and remaining limits; final line RESULT: DONE or BLOCKED with reason. The sixth-edge design is explicitly out of this slice.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Execution Evidence

Effective State resolves this as Standard: one active plan, no separate contract/notes/todos scaffolding and no external acceptance requirement. Contract/review/notes paths in the capture template above are placeholders; the approved T3b user brief and this plan are the scope authority. Review and verification evidence stay inline here and in the requested `/tmp` report.

- root_cause: chain-append.ts returned newly appended external-cli steps without the initial gate, while external-cli-runner.ts copied process.env when no adapter allowlist existed.
- repro: from packages/client, `bun run test src/__tests__/custody-external-cli-append-environment.test.ts`.
- regression_guard: packages/client/src/__tests__/custody-external-cli-append-environment.test.ts.
- pre_fix_failure_artifact: /tmp/byok-t3b-n1-pre-fix.log, PRE_FIX_EXIT=1, 12 failed and 2 positive controls passed.
- post_fix: /tmp/byok-t3b-n1-related.log, 9 test files / 103 tests passed, including all 14 new cases and existing initial gate/five edges/runner entry/environment/provenance/closure.
- build: /tmp/byok-t3b-n1-build.log, exit 0.
- all workspace typecheck: /tmp/byok-t3b-n1-typecheck-after-build.log, exit 0. An earlier attempt ran during dist rebuild and failed on missing declarations; no source change was used to resolve that setup race.
- API surface and version authority: /tmp/byok-t3b-n1-api.log and /tmp/byok-t3b-n1-version.log, exits 0.
- strict workflow check: /tmp/byok-t3b-n1-workflow.log, exit 0.
- full workspace tests with the existing strict Bun configuration: /tmp/byok-t3b-n1-workspace-tests.log, exit 0; client 3410 passed / 27 existing skips. No tests/assertions/timeouts/skip conditions were loosened.

## Local Review

PASS (main-agent review; not an independent external acceptance claim). The error class has one definition and the old dispatcher import remains a re-export of that same class. Append reads/checks the whole batch before removing any file, so a later refusal loses neither earlier clean requests nor returns unchecked steps. The runner executes retained, checked objects rather than re-reading files after the check. Sequential/parallel/dynamic shapes reuse the initial scanner. Default external env is the existing filtered baseline; explicit allowlist values cannot re-add custody names. The named Codex vendor allowlist control still receives its selected credential. Only the two changed vendor manifest rows have new digests/deltas; upstream digests and file inventory are unchanged. The full build/closure/provenance suite and workspace tests passed. No sixth edge, top-level Codex change, runtime pin change or forbidden Claude file edit is present.

Requested delivery: `/tmp/byok-t3b-n1-minimal-fix-report.md`; no remote publication or branch/worktree cleanup.
