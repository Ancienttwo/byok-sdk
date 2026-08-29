# Task Contract: agent-message-helper-startup-jitter

> **Status**: Active
> **Plan**: plans/plan-20260829-1926-agent-message-helper-startup-jitter.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-29 19:26
> **Review File**: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md`
> **Notes File**: `tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

An exact production Salesko Codex resume offer failed before claim because the SDK-reserved
Agent-message helper did not finish its pure startup handshake inside the hard-coded three-second
window. The same installed helper then passed twenty exact probes, so publishing the current RC
would preserve a transient false-negative on the terminal message path.

## Goal

Keep helper admission fail closed while allowing up to ten seconds for the exact SDK-reserved
message helper to expose `send_agent_message`, then prove the successor RC through the compiled
Salesko LaunchAgent before registry publication.

## Scope

- In scope:
  - the generic Agent-message helper preflight startup bound;
  - delayed-success, timeout, broken-helper and exact-tool regressions;
  - aligned successor RC manifests, pack/readback, Salesko packed-RC consumer acceptance and
    later exact registry publication/pin.
- Out of scope:
  - retries, cached helper authority, alternate helpers, Salesko shadow launchers, protocol or
    message-content changes, activity policy changes, cloud deployment and production migration.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if a helper that exposes the exact reserved tool after more than three but
less than ten seconds is still rejected, or if a broken/wrong-tool helper can cross admission. The
cheapest proof is the delayed-helper regression in the existing SDK helper-host test.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/daemon/agent-message-mcp-preflight.ts` treats any helper startup longer than the hard-coded 3000ms as a permanent pre-claim failure even when the exact helper/tool becomes available immediately afterward.
- repro: production conversation turn `ab228209-f959-4c42-a81d-14815db821f7` failed with `required Agent message helper preflight failed: helper handshake timed out after 3000ms`; the same installed binary then passed twenty probes in 167-321ms.
- regression_guard: packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
- pre_fix_failure_artifact: tasks/evidence/20260829-1926-agent-message-helper-startup-jitter-pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260829-1926-agent-message-helper-startup-jitter.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md`
- Notes file: `tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md
  - tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md
  - tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md
  - tasks/evidence/20260829-1926-agent-message-helper-startup-jitter-pre-fix.log
  - packages/client/src/daemon/agent-message-mcp-preflight.ts
  - packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
  - packages/client/package.json
  - packages/cloud-dataplane/package.json
  - packages/cloud/package.json
  - packages/core/package.json
  - packages/keys/package.json
  - packages/protocol/package.json
  - packages/sdk/package.json
  - packages/server/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - bun.lock
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
    - packages/client/src/daemon/agent-message-mcp-preflight.ts
    - packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/sdk-reserved-helper-host.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
  manual_checks:
    - The exact successor packed RC completes one real Salesko LaunchAgent Codex fresh turn and one exact-session resume turn before publication.
    - Registry readback matches the frozen successor manifest before Salesko replaces file pins with exact registry versions.
```

## Acceptance Notes (Human Review)

- Functional behavior: delayed exact helper startup succeeds within ten seconds; unresolved helpers still fail before claim.
- Edge cases: broken process, wrong tool identity and deadline exhaustion remain hard failures.
- Regression risks: a longer preflight wait delays visible failure for a genuinely broken helper but does not create runtime or message effects.

## Rollback Point

- Commit / checkpoint:
- Revert strategy: before publication discard the successor RC and revert the one timeout change; after publication leave immutable prerelease bytes historical and do not promote them.
