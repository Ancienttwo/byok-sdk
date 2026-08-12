> **Archived**: 2026-08-13 00:18
> **Related Plan**: plans/archive/plan-20260812-0333-llm-access-provider-adapter.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260813-0018

# Task Contract: llm-access-provider-adapter

> **Status**: Fulfilled
> **Plan**: plans/plan-20260812-0333-llm-access-provider-adapter.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-12 03:33
> **Review File**: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md`
> **Notes File**: `tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

LLM dispatch currently has no end-to-end authority for the selected lane,
provider, and model. If the selection is inferred independently by the server,
client, credential store, or runtime, a task can silently reach a different
provider or leak a BYOK credential into the dispatch process. The target model
keeps the user's local runtime as the sole provider/transport authority and
uses an isolated credential launcher only to project exact local custody into
Pi.

## Goal

Deliver one fail-closed dual-lane dispatch contract: subscription selections
reach Claude/Codex as an exact model argument without credential handling;
BYOK selections reach pinned Pi through a separate `@byok-sdk/keys` launcher
that alone reads the OS keychain, writes a private process-scoped projection,
and injects the exact key into the Pi child environment.

## Scope

- In scope:
  - strict protocol selection and server-to-client propagation;
  - Claude/Codex model pass-through and session consistency;
  - Pi launcher configuration, ambient-provider-env sanitization, and
    fail-closed selection handling;
  - keys-owned projection/launcher implementation and package binary export;
  - tests and canonical security/architecture/product documentation.
- Out of scope:
  - hosted web UI、vendor-internal OAuth、Hermes、model capability producer（另一个隔离 worktree 正在处理）、web-to-device secret provisioning protocol。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if implementation would require a second provider registry, LLM
  transport, OAuth authority, listener-based credential broker, or web-to-device
  secret provisioning protocol.

## Falsifier

The direction is wrong if pinned Pi 0.84.1 ignores an isolated
`PI_CODING_AGENT_DIR/models.json`, cannot bind `--provider` and `--model` to the
projected base URL, or cannot fail before network activity for an unknown
provider. The cheapest proof point is
`docs/researches/pi-provider-baseurl-probe.md`; it confirms the positive route
and negative control, so the falsifier is not triggered.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260812-0333-llm-access-provider-adapter.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md`
- Notes file: `tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - docs/security.md
  - docs/architecture/sdk-architecture.md
  - docs/researches/pi-provider-baseurl-probe.md
  - packages/protocol/README.md
  - packages/protocol/src/
  - packages/server/src/
  - packages/client/README.md
  - packages/client/src/
  - packages/keys/
  - plans/plan-20260812-0333-llm-access-provider-adapter.md
  - plans/prds/20260812-0258-llm-access-provider-adapter.prd.md
  - tasks/contracts/20260812-0333-llm-access-provider-adapter.contract.md
  - tasks/reviews/20260812-0333-llm-access-provider-adapter.review.md
  - tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md
  - tasks/current.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - .ai/harness/handoff/
  - .ai/harness/active-plan
  - .ai/harness/active-worktree
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - docs/protocol.md
    - docs/security.md
    - docs/architecture/sdk-architecture.md
    - docs/researches/pi-provider-baseurl-probe.md
    - packages/keys/src/bin/pi-provider-launcher.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260812-0333-llm-access-provider-adapter.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/dispatch-selection.test.ts
    - path: packages/server/src/__tests__/dispatch-selection.test.ts
    - path: packages/client/src/__tests__/pi-adapter.test.ts
    - path: packages/client/src/__tests__/claude-adapter.test.ts
    - path: packages/client/src/__tests__/codex-adapter.test.ts
    - path: packages/client/src/__tests__/task-runner-runtime-selection.test.ts
    - path: packages/client/src/__tests__/create-daemon-pi-byok-launcher.test.ts
    - path: packages/keys/src/pi-provider-projection.test.ts
    - path: packages/keys/src/pi-provider-launcher-core.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: selected lane/runtime/provider/model is preserved end to
  end; missing or contradictory authority fails closed.
- Edge cases: persistent subscription sessions reject model changes; launcher
  rejects absent profiles, models, keychain services, and keys before Pi spawn.
- Regression risks: protocol golden drift, provider credentials inherited from
  the daemon environment, and session/projection lifetime mismatch.

## Rollback Point

- Commit / checkpoint: the final PR merge commit.
- Revert strategy: revert the single PR; no database or wire migration is
  persisted by this slice.
