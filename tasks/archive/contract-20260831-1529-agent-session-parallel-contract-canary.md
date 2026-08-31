> **Archived**: 2026-08-31 15:29
> **Related Plan**: plans/archive/plan-20260831-1248-agent-session-parallel-contract-canary.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260831-1529

# Task Contract: agent-session-parallel-contract-canary

> **Status**: Fulfilled
> **Plan**: plans/plan-20260831-1248-agent-session-parallel-contract-canary.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-31 13:16
> **Review File**: `tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md`
> **Notes File**: `tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The daemon currently treats a canonical Agent home as a full-turn execution
lock. That serializes unrelated conversations for one durable Agent and makes
parallel Agent work impossible. Changing the lock incorrectly could instead
admit duplicate execution of one session, corrupt SDK-reserved shared state, or
allow relocation while a session is still active.

## Goal

Ship one coherent source candidate where different sessions for the same
`agentId` execute concurrently, the same `(agentId, sessionRef)` remains
serialized, SDK-reserved home mutations remain race-free, product documentation
states the exact contract, and an exact installed client tarball proves the
concurrency invariant before any publication.

## Scope

- In scope: Agent-home execution leases, TaskRunner binding and terminal paths,
  same-home message/spool single-flight, Agent-memory projection outbox
  transactions, public type projection, source tests, `docs/spec.md`, client
  README, and the release pack/install smoke.
- Out of scope: npm publish, Git push/PR, Salesko dependency upgrade, production
  unpause, profile migration, shadow locks, or one Agent id per conversation.
- Taste constraints: preserve exact Agent/session authority and fail closed;
  do not add compatibility paths or duplicate home/session stores.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if two different sessions of one Agent cannot both stay
active, if a duplicate session can acquire a second execution lease, if the
home becomes relocatable before the final session exits, if concurrent shared
spool/handoff writes lose or duplicate records, or if concurrent same-home
session close loses an Agent-memory projection to an outbox revision conflict.
The cheapest proofs are `packages/client/src/__tests__/agent-home-contract.test.ts`
and `packages/client/src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts`;
the artifact proof is the installed-tarball canary in
`scripts/release/pack-and-smoke.mjs`.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260831-1248-agent-session-parallel-contract-canary.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md`
- Notes file: `tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-session-parallel-contract-tests","kind":"deterministic_test","paths":["*"]},{"id":"installed-tarball-agent-session-canary","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - packages/client/README.md
  - packages/client/src/agent-home.ts
  - packages/client/src/index.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/agent-egress-controller.ts
  - packages/client/src/daemon/agent-memory.ts
  - packages/client/src/__tests__/agent-home-contract.test.ts
  - packages/client/src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts
  - scripts/release/pack-and-smoke.mjs
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md
  - tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md
  - tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - .ai/context/capabilities.json
  - .claude/templates/
  - src/
  - tests/
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
    - docs/spec.md
    - packages/client/src/agent-home.ts
    - packages/client/src/daemon/task-runner.ts
    - packages/client/src/__tests__/agent-home-contract.test.ts
    - scripts/release/pack-and-smoke.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/agent-home-contract.test.ts
    - path: packages/client/src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/agent-home-contract.test.ts
    - bun run --cwd packages/client test -- src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-pack
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: different same-Agent sessions overlap; duplicate session
  admission is busy; home relocation remains busy until the final release.
- Edge cases: fresh task-to-session rekey, exact resume key, concurrent first
  open of handoff/outbox/spool state, and final release ordering.
- External-review correction: a resume lease that is already session-keyed may
  never rekey to a different runtime `sessionRef`; the original admission key
  must remain owned until release.
- Concurrent close correction: Agent-memory hosted projection must serialize
  the complete outbox transaction per canonical home so separately opened
  instances cannot race the same CAS revision; different homes remain
  independent.
- Regression risks: long-lived opaque runtime writes are not serialized by the
  SDK mutation gate; consumers needing application-level file coordination must
  provide it inside the Agent home.

## Rollback Point

- Commit / checkpoint: repaired clean source candidate `16235cd` before
  pack/install smoke.
- Revert strategy: revert the candidate as one unit; do not retain dual lease
  semantics or documentation that diverges from runtime behavior.
