# Task Contract: wp3b-step1-kernel-increments

> **Status**: Active
> **Plan**: plans/plan-20260903-1330-wp3b-step1-kernel-increments.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-03 13:35
> **Review File**: `tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md`
> **Notes File**: `tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

WP3B Step 2 reimplements `createByokServer` over the `@byok-sdk/cloud` kernel. The kernel lacks host approve/reject/steer, a `cursor_too_old` path (today's embedded/hosted behaviour fork, §8 R3), tenant-level attempt listing, an instance-product bearer check (without it Step 2 silently downgrades embedded auth, §8 R4), and a post-commit observer for the `TaskHandle` relay. Landing them first, each as one revertable commit, keeps Step 2 a pure façade rewrite.

## Goal

Add to `@byok-sdk/cloud` (and `@byok-sdk/core` for the mailbox port): `approveTask`/`rejectTask` with `StaleApprovalError` (1a); `TaskAttempt.claimedRuntime` written at `task.claim`, `deploy/sql/0018_*.sql`, and `steerTask` gated on that snapshot with `SteerRejectedError` (1b); `MailboxPage.recoverableFrom` and a 409 `{error:'cursor_too_old', recoverableFrom}` from `handlers/events.ts` (1c); `TaskAttemptStore.list(tenant, {limit, cursor?})` keyset-paged by `taskId` (1d); optional `instanceProductId` enforced in `authenticateBearer` (1e); `ByokCloudOptions.observer.onInboundCommitted` fired once per committed envelope, unable to alter outcomes (1f). Each sub-step is one commit with its own unit tests, conformance where a port changed, and `packages/server` at zero diff. Regenerate `api-surface/{cloud,core,cloud-dataplane}.d.ts` additively. Correct the design packet's §5.10 `rateLimitEvents` wording and GAP-3 file path.

## Scope

- In scope: the six sub-steps above under `packages/cloud/src/**`, `packages/core/src/**`, `packages/cloud-dataplane/src/**`, `deploy/sql/**` (plus the one-line migration claim in `tests/sql/control_plane_invariants.sql` that `check:deploy-sql` requires), `packages/conformance/src/**`; the three additive goldens; two packet corrections; notes.
- Out of scope: any change under `packages/server/**` or `packages/client/**` (Step 2/4); GAP-5 rate limiter (Step 2a); docs/CHANGELOG/README (Step 5); `api-surface/server.d.ts` and `client.d.ts`; release, publish.
- Taste constraints: no compatibility fallbacks (absent `instanceProductId` is a distinct explicit authority, not a fallback); observer is void and post-commit; one store authority per datum; sub-steps must not be merged into one commit.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop a sub-step (not the slice) if it needs a `packages/server` change or a second store authority; record it in the notes and continue the remaining sub-steps.

## Falsifier

If Step 0's `coordination-characterization.test.ts` or any `packages/server` test changes colour on this branch, the slice leaked into the façade; `git diff --stat origin/main..HEAD -- packages/server` must stay empty and `bun run --cwd packages/server test` must stay at 37 files / 289 tests green.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260903-1330-wp3b-step1-kernel-increments.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md`
- Notes file: `tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"kernel-increments-deterministic","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260903-1330-wp3b-step1-kernel-increments.md
  - tasks/contracts/20260903-1330-wp3b-step1-kernel-increments.contract.md
  - tasks/reviews/20260903-1330-wp3b-step1-kernel-increments.review.md
  - tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md
  - tasks/todos.md
  - tasks/current.md
  - packages/cloud/src/
  - packages/core/src/
  - packages/cloud-dataplane/src/
  - packages/conformance/src/
  - deploy/sql/
  - tests/sql/control_plane_invariants.sql
  - api-surface/cloud.d.ts
  - api-surface/core.d.ts
  - api-surface/cloud-dataplane.d.ts
  - docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - deploy/sql/0018_task_attempt_claimed_runtime.sql
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260903-1330-wp3b-step1-kernel-increments.notes.md
  tests_pass:
    - path: packages/server/src/__tests__/coordination-characterization.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:deploy-sql
    - bun run check:api-surface
    - bun run check:version-authority
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: six sub-steps, six commits, each green alone; server zero diff; goldens additive only.
- Edge cases: 1e absent option byte-identical to today; 1f observer throw swallowed and outcome unchanged; 1c floor rule `cursor < recoverableFrom - 1` matches `hub.ts:2519`; 1b idempotent re-claim keeps the first `claimedRuntime`.
- Regression risks: core port shape change (1c) touches every MailboxStore impl; migration 0018 must be nullable, no backfill.

## Rollback Point

- Commit / checkpoint: origin/main 5cfc8c7
- Revert strategy: `git revert` any single sub-step commit (PR is rebase-merged, not squashed); 0018 migration delete-before-apply or forward `0019` reverse.
