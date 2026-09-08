# Task Contract: Explicit device metadata repair and embedded diagnostics

> **Status**: Ready for Integration
> **Plan**: plans/plan-20260908-doctor-repair.md
> **Task Profile**: code-change
> **Owner**: Codex
> **Capability ID**: root
> **Review File**: tasks/reviews/20260908-doctor-repair.review.md
> **Notes File**: tasks/notes/20260908-doctor-repair.notes.md

## Goal

Expose safe embedded diagnostics and an explicit metadata projection repair from existing OS enrollment authority. SDK owns the implementation and downstream guide; consumers do not recreate recovery logic.

## Scope

Only missing/valid-stale device metadata is restored. Preserve malformed/legacy fail-closed handling, credential custody, startup semantics, health-only --fix and exact task identities. No auto Agent repair, AgentRef readiness claim, remote control API, journal rebuild, provider mutation, retry policy, release or deployment.

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/
  - packages/client/README.md
  - README.md
  - docs/agent-diagnostics-integration.md
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - docs/researches/2026-09-08-doctor-repair-plan.md
  - docs/researches/2026-09-08-doctor-failure-classification.md
  - docs/researches/evidence/doctor-failure-classification-20260908/
  - deploy/runbooks/self-hosted-operations.md
  - api-surface/client.d.ts
  - CHANGELOG.md
  - plans/plan-20260908-doctor-repair.md
  - tasks/contracts/20260908-doctor-repair.contract.md
  - tasks/notes/20260908-doctor-repair.notes.md
  - tasks/reviews/20260908-doctor-repair.review.md
  - tasks/current.md
```

## Exit Criteria

- Public diagnostics preserves existing redacted snapshot and actual custom-adapter outcomes, with no credential read or mutation.
- Repair requires explicit confirmation and expected tenant/device before side effects; control-online or busy store refuses; missing/mismatched authority and malformed/legacy metadata refuse without replacing the projection.
- Only non-secret metadata is written, startup and repair share reconciliation, repeated repair is no-op, result is read back; no auth renewal, network request, task rerun or credential writes.
- CLI supports the exact named action, rejects conflicting/invalid action input, leaves existing --fix health-only, and emits structured results without secret/error-detail leakage.
- Required checks and artifact/version limits recorded honestly; original root WIP preserved.

## Approved diagnostic continuation

User approved the bounded baseline/candidate classification of seven test failures. No product/test repair, new whole-suite rerun, merge or publication is authorized by this continuation. Classification is complete; evidence lives in `docs/researches/2026-09-08-doctor-failure-classification.md`. Acceptance remains blocked on the original full-suite failure and separate review boundary.

## Approved test acceptance continuation

User approved test-only corrections to agent-egress-spool, agent-message-outbox, durable-egress-faults and agent-home-projection tests. Natural compaction receives a local 60s budget with real threshold and sync assertions intact. A fetch barrier delivers the first projection page, parks the next poll until daemon stop, and preserves exact completion/cursor/restart assertions. No product behavior or package-wide timeout changes.

Outcome: approved test correction and local full-suite acceptance complete; prior classification-only restrictions were superseded only for these four tests and validation. No independent acceptance, merge, push, publication or live repair claim.

## Approved independent semantic acceptance

The user approved the bounded independent gatekeeper review. No semantic findings; sole safe_auto EOF whitespace finding was removed by the main agent per reviewer instructions, with cumulative-diff verification on the new candidate. Focused doctor tests 23/23 pass; exact retained full-suite evidence remains valid. Report: linked review file. This does not authorize merge, push, publish or live repair and does not claim a generated harness AcceptanceReceipt.

## Acceptance Policy

```json
{"protocol": 1, "reviewer": "Codex", "user_waiver": "forbidden"}
```

## Change Assessment

```json
{"protocol": 1, "oracles": [{"id": "doctor-contract-tests", "kind": "deterministic_test", "paths": ["*"]}]}
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Bind built SDK artifacts to the formal candidate.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Check public and internal TypeScript contracts.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "tests",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Record required whole-workspace tests in the harness execution ledger.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "api",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Verify public declaration goldens.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "version",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Verify version authority.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "whitespace",
      "kind": "command",
      "command": "git diff --check 62e83ae",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Check the full candidate diff including the corrected EOF.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    }
  ]
}
```

## Machine Exit Criteria

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/diagnostics/device-doctor.ts
    - packages/client/src/__tests__/device-doctor.test.ts
    - docs/agent-diagnostics-integration.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```
