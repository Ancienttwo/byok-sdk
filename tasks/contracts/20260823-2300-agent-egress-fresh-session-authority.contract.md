# Task Contract: agent-egress-fresh-session-authority

> **Status**: Active
> **Plan**: plans/plan-20260823-2300-agent-egress-fresh-session-authority.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-24 00:20
> **Review File**: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md`
> **Notes File**: `tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The published 0.7.0 strict egress message requires a runtime `sessionRef`
before dispatch, while the client correctly accepts that field only as an
exact resume reference already present in the SDK-owned Agent-home handoff.
A fresh runtime cannot mint its real session id until after `start()`.  The
result is a closed loop: downstreams either fail before runtime start or forge
a second session authority.  The repair must preserve frozen protocol v1 and
keep old daemons from receiving a message they cannot consume.

## Goal

Add one capability-gated fresh-only Agent egress message, keep the existing
message exact-resume-only, and require the public reliable egress seam to prove
the runtime-issued session against the durable canonical-home handoff.

## Scope

- In scope: protocol capability/message and golden contracts; client fresh
  admission plus exact handoff-backed reliable publishing; cloud/server
  durable capability admission and distinct enqueue/dispatch APIs; architecture
  docs; focused/full tests; aligned prerelease package train; fail-closed SemVer
  prerelease/dist-tag tooling; beta publication/readback; exact downstream
  Salesko artifact acceptance.
- Out of scope: changing the frozen v1 resume message; protocol v2; session
  reservation state; downstream shadow handoffs; contentful egress; stable/latest
  publication, merge, push, deploy, production migration, secrets, or Agent-home
  deletion.
- Taste constraints: fresh and resume are distinct wire facts; runtime owns the
  native session id; no missing/mismatched resume may become fresh execution.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the implementation requires a cloud session table or data migration;
  revise P3 and this contract before expanding authority.
- Stop before any stable npm publish or `latest` mutation. Beta publication is
  limited to the complete exact `0.8.0-beta.0` train plus keys `0.3.1-beta.0`
  under dist-tag `beta`, after dry-run pack/install closure.
- Stop if any beta package is partial, internal dependency edges skew, registry
  integrity differs from the frozen manifest, or `latest` moves from 0.7.0.
- Stop before downstream production dependency promotion, deployment,
  production mutation, secret change, or Agent-home deletion.

## Falsifier

The direction is wrong if a fresh strict egress offer can already traverse the
published 0.7.0 API without a pre-existing handoff, or if the new path cannot
reuse the existing task attempt, Agent home, native runtime session, spool and
ack authorities.  Cheapest proof: protocol/client regression tests must show
the old message still rejects missing `sessionRef`, the additive fresh message
starts without `requireMatch`, and the real runtime-issued session is fsynced
before started/reliable facts.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md`
- Notes file: `tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"fresh-session-contract-suite","kind":"deterministic_test","paths":["*"]},{"id":"fresh-session-real-daemon-readback","kind":"runtime_readback","paths":["packages/client/src/__tests__/agent-egress-fresh-session.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - docs/architecture/sdk-architecture.md
  - docs/researches/agent-local-cloud-projection-contract.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260823-2300-agent-egress-fresh-session-authority.contract.md
  - tasks/reviews/20260823-2300-agent-egress-fresh-session-authority.review.md
  - tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md
  - package.json
  - bun.lock
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/protocol/src/
  - packages/client/package.json
  - packages/client/src/
  - packages/server/package.json
  - packages/server/src/
  - packages/cloud/package.json
  - packages/cloud/src/
  - packages/cloud-dataplane/package.json
  - packages/cloud-dataplane/src/__tests__/
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - packages/sdk/package.json
  - packages/keys/package.json
  - scripts/release/check-package-graph.mjs
  - scripts/release/pack-and-smoke.mjs
  - scripts/release/pack-and-smoke.test.mjs
  - scripts/release/publish.mjs
  - scripts/release/beta-release.test.mjs
  - scripts/release/registry-readback.mjs
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
    - packages/client/src/__tests__/agent-egress-fresh-session.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260823-2300-agent-egress-fresh-session-authority.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/agent-egress-contract.test.ts
    - path: packages/client/src/__tests__/agent-egress-fresh-session.test.ts
    - path: packages/cloud/src/__tests__/agent-egress-contract.test.ts
    - path: packages/server/src/__tests__/agent-egress-contract.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - bun run check:release-pack
    - npm view @byok-sdk/core@0.8.0-beta.0 version dist.integrity --json
    - npm view @byok-sdk/keys@0.3.1-beta.0 version dist.integrity --json
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: fresh offer starts without a session, runtime mints the
  session, SDK persists it before started, exact resume and reliable egress use
  that same evidence.
- Edge cases: old capability, missing/corrupt handoff, cross Agent/profile,
  wrong runtime/cwd/session/task, handoff fsync failure, redelivery/cancel,
  sanitizer failure, restart and non-exact ack.
- Regression risks: changing frozen resume bytes, sending fresh message to an
  old daemon, accepting invented reliable sessions, changing legacy tasks.

## Rollback Point

- Commit / checkpoint: isolated branch `codex/agent-egress-fresh-session` from
  `3ff409337e6f8263934c45756ec28eebb1d66f73`.
- Revert strategy: before beta publication, revert/delete only this isolated
  branch. After beta publication, do not promote the immutable prerelease and
  leave `latest` unchanged; any correction uses a new beta version from a new
  frozen subject.
