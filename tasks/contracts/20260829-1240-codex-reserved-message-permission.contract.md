# Task Contract: codex-reserved-message-permission

> **Status**: Active
> **Plan**: plans/plan-20260829-1240-codex-reserved-message-permission.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-29 12:44
> **Review File**: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md`
> **Notes File**: `tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Codex 0.149 discovers and calls the SDK-reserved Agent message MCP tool, but the adapter's global `approval_policy=never` rejects that required terminal protocol action before the helper receives it.

## Goal

Produce an unpublished packed RC where required Agent-message Codex tasks keep global `approval_policy=never` while the exact SDK-owned one-tool MCP server uses native per-server approval mode `approve`; prove real Codex invocation and preserve all other approval, message, and activity invariants.

## Scope

- In scope: Codex adapter MCP config composition, exact native preflight, regression/native probes, aligned packed-RC manifests, and documentation.
- Out of scope: Salesko schema/routes, stdout parsing, arbitrary MCP trust, global approval relaxation, publish/tag/merge/push/deploy.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if Codex 0.149 rejects the per-server field, still asks for approval, or generated argv grants another MCP server/tool. The cheapest proof is a real `codex exec` call against a one-tool stdio fixture plus argv negative assertions.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/adapters/codex/codex-adapter.ts` projects reserved MCP transport but omits Codex's server-local approval mode while `permission-mapping.ts` pins global `approval_policy=never`, so Codex rejects `send_agent_message` before MCP dispatch.
- repro: real Codex 0.149 required-message task calls `mcp__byokagentmessage__send_agent_message` and emits `MCP tool call requires approval, but approval policy is never`.
- regression_guard: packages/client/src/__tests__/codex-agent-message-permission.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/20260829-codex-agent-message-permission/pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260829-1240-codex-reserved-message-permission.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md`
- Notes file: `tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md`
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
  - bun.lock
  - package.json
  - packages/client/
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/server/package.json
  - packages/cloud/package.json
  - packages/cloud-dataplane/package.json
  - packages/ui-runtime/package.json
  - packages/testkit/package.json
  - packages/sdk/package.json
  - packages/keys/package.json
  - plans/plan-20260829-1240-codex-reserved-message-permission.md
  - tasks/todos.md
  - tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md
  - tasks/reviews/20260829-1240-codex-reserved-message-permission.review.md
  - tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md
  - .ai/harness/
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
    - packages/client/src/__tests__/codex-agent-message-permission.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/codex-agent-message-permission.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: exact reserved Agent message server/tool is natively approved; global policy remains never.
- Edge cases: fresh/resume argv parity, absent/unrelated MCP server, invalid native support, and required-message fail closed.
- Regression risks: Codex config-key drift; guarded by native 0.149 probe and packed downstream canary.

## Rollback Point

- Commit / checkpoint: local isolated branch only.
- Revert strategy: revert the slice commits and discard ignored packed artifacts.
