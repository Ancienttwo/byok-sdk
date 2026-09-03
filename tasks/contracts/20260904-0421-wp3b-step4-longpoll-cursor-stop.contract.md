# Task Contract: wp3b-step4-longpoll-cursor-stop

> **Status**: Fulfilled
> **Plan**: plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md
> **Task Profile**: bugfix
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-04 04:33
> **Review File**: `tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md`
> **Notes File**: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The long-poll GET reports an eager delivered watermark as the kernel acknowledgement, so a handler failure cannot be redelivered after the kernel irreversibly retires that row. Shutdown also leaves an in-flight held GET alive until the hold expires.

## Goal

Make the long-poll query cursor reflect only successfully processed delivery, keep repeated reads bounded and locally deduplicated, actively abort the held GET on stop, restore all five deferred end-to-end guards, and add a stop lifecycle guard.

## Scope

- In scope: client daemon long-poll/cursor internals; the four named client regression files; workflow artifacts and deferred ledger.
- Out of scope: protocol/wire schema, cloud/server kernel routes, WS removal, public API narrowing, deployment, release, push, PR, merge.
- Taste constraints: no compatibility path or second cursor authority; outbound POST drain behavior is unchanged.

## Stop Conditions

- Stop if correctness requires a cloud/server/protocol wire change rather than the approved client-side split.
- Stop if a second out-of-scope failure blocks this deliverable.
- Stop after three fix/reverify rounds for the same issue.

## Falsifier

Any restored guard remains skipped, a failed handler is not redelivered from the real kernel, a repeated in-flight seq executes twice, or stop remains coupled to the configured server hold duration.

## Root Cause Evidence

- root_cause: `packages/client/src/daemon/connection-manager.ts:248-258` supplied eager `dedupWatermark()` to the acknowledgement-bearing long-poll query, while `packages/client/src/daemon/long-poll-transport.ts:312-321` left the active GET unabortable on stop.
- repro: `bun run --cwd packages/client test -- real-server-longpoll-redelivery real-server-longpoll-stall-dedup agent-home-projection real-server-longpoll-only`
- regression_guard: packages/client/src/__tests__/real-server-longpoll-redelivery.test.ts
- pre_fix_failure_artifact: tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md`
- Notes file: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"longpoll-real-kernel-regressions","kind":"deterministic_test","paths":["packages/client/src/__tests__/real-server-longpoll-redelivery.test.ts","packages/client/src/__tests__/real-server-longpoll-stall-dedup.test.ts","packages/client/src/__tests__/agent-home-projection.test.ts","packages/client/src/__tests__/real-server-longpoll-only.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md
  - tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md
  - tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md
  - tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md
  - tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.pre-fix.txt
  - tasks/todos.md
  - tasks/current.md
  - packages/client/src/daemon/connection-manager.ts
  - packages/client/src/daemon/long-poll-transport.ts
  - packages/client/src/__tests__/real-server-longpoll-redelivery.test.ts
  - packages/client/src/__tests__/real-server-longpoll-stall-dedup.test.ts
  - packages/client/src/__tests__/agent-home-projection.test.ts
  - packages/client/src/__tests__/real-server-longpoll-only.test.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
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
    - packages/client/src/daemon/connection-manager.ts
    - packages/client/src/daemon/long-poll-transport.ts
  artifacts_exist:
    - tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.pre-fix.txt
    - tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/real-server-longpoll-redelivery.test.ts
    - path: packages/client/src/__tests__/real-server-longpoll-stall-dedup.test.ts
    - path: packages/client/src/__tests__/agent-home-projection.test.ts
    - path: packages/client/src/__tests__/real-server-longpoll-only.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- real-server-longpoll-redelivery real-server-longpoll-stall-dedup agent-home-projection real-server-longpoll-only
    - bun run --cwd packages/client test
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: query acknowledgement uses only successfully processed cursor state; held GET and retry delays are cancellable.
- Edge cases: duplicate-only re-reads back off; in-flight and already-processed seqs stay locally deduplicated; device revocation aborts the loop too.
- Regression risks: altered long-poll cadence and start/stop generation races; covered by real-kernel tests plus the full client and root suites.

## Rollback Point

- Commit / checkpoint: `10bb9fc76b0a1ee3a533f50a42e869235c5c7bd1`
- Revert strategy: revert the single Step 4a commit; no wire or kernel migration exists.
