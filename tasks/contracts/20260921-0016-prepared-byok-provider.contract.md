# Task Contract: prepared-byok-provider

> **Status**: Active
> **Plan**: plans/plan-20260921-0016-prepared-byok-provider.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-21 00:17
> **Review File**: `tasks/reviews/20260921-0016-prepared-byok-provider.review.md`
> **Notes File**: `tasks/notes/20260921-0016-prepared-byok-provider.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The prepared input lane exists so a Host can obtain a device-compiled, provider-counted request before it creates an Execution. Today it can serve only the built-in `zai` provider: the fork's prepared validator compares `model.provider` to the literal `"zai"`, and the SDK wire model cannot carry `thinkingLevelMap`/`compat`, which the live session model always has for a BYOK profile. Every BYOK profile therefore fails at compile (`unsupported_input`) and, were that fixed alone, at consume (`prepared_model_drift`). Downstream (Salesko C07) is blocked end to end. Shipping it wrong means a silently widened support set or a prepared model that no longer equals the session model.

## Goal

A model built from `buildPiProviderProjection(profile)` (provider id `byok-sdk-<profile_ref>`, with `thinkingLevelMap` and `compat`) travels the SDK wire unchanged, compiles through the pinned fork build, is accepted at consume, and equals the model entry the launcher projects into `models.json` — while the support set stays exactly what it was (openai-completions, zai thinking format, body shape enforced by the projection classifier) and every existing built-in-`zai` test is untouched and green.

## Scope

- In scope: `InputPreparationModelSchema` optional `thinkingLevelMap`/`compat` (closed shapes mirroring `packages/keys/src/pi-model-config.ts`); `InputPreparationModelV1`; the two hand parsers (`daemon/control-protocol.ts`, `bin/pi-prepared-host.ts`); store round-trip; compiler pass-through; fork pin to build 7 with the release identity pins/gates that assert it; BYOK-provider regression + parser-parity tests; a dated section in `docs/researches/runtime-input-preparation-contract.md`; deferred-goal ledger entries.
- Out of scope: the fork repository itself (its own branch, gate and Owner-run publish); widening `thinkingFormat` or `api`; defaults or inference for absent fields; counter, authority resolver, readiness reasons, remote-lane transport; MCP tool `inputSchema` admission (ledger entry only); any package version bump (stop and ask the Owner if `check:version-authority` demands one); re-freezing the P2 composite manifest.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Direction is wrong if, with both fields carried and the structural provider check in place, the native session still reports `prepared_model_drift` for a projection-built model — that would mean the session model holds further fields the wire cannot express. Cheapest proof point: deep-compare the prepared expected model against the model `provider-composer` builds from a `buildPiProviderProjection` models.json entry, before touching the parsers.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260921-0016-prepared-byok-provider.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260921-0016-prepared-byok-provider.review.md`
- Notes file: `tasks/notes/20260921-0016-prepared-byok-provider.notes.md`
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
{"protocol":2,"reviewer":"gatekeeper","source":"independent-gate","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/protocol/src/input-preparation.ts
  - packages/protocol/src/__tests__/
  - packages/client/src/input-preparation.ts
  - packages/client/src/types.ts
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/daemon/input-preparation-store.ts
  - packages/client/src/daemon/input-preparation-service.ts
  - packages/client/src/bin/pi-prepared-host.ts
  - packages/client/src/adapters/pi/
  - packages/client/src/__tests__/
  - packages/client/package.json
  - package.json
  - bun.lock
  - scripts/release/
  - docs/researches/runtime-input-preparation-contract.md
  - docs/api-surface/
  - plans/plan-20260921-0016-prepared-byok-provider.md
  - tasks/todos.md
  - tasks/contracts/20260921-0016-prepared-byok-provider.contract.md
  - tasks/reviews/20260921-0016-prepared-byok-provider.review.md
  - tasks/notes/20260921-0016-prepared-byok-provider.notes.md
  - tasks/runs/
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

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist: []
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {"id":"build","kind":"command","command":"bun run build","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree builds with the new fork pin","inputs":{"env":[]}},
    {"id":"typecheck","kind":"command","command":"bun run typecheck","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"model type reaches every carrier","inputs":{"env":[]}},
    {"id":"tests","kind":"command","command":"bun run test","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"full suite incl. the BYOK-provider regression and parser parity; zero new failures","inputs":{"env":[]}},
    {"id":"api-surface","kind":"command","command":"bun run check:api-surface","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"public surface change is the two optional model fields and nothing else","inputs":{"env":[]}},
    {"id":"version-authority","kind":"command","command":"bun run check:version-authority","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"version authority","inputs":{"env":[]}},
    {"id":"task-workflow","kind":"command","command":"repo-harness run check-task-workflow --strict","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"workflow gate","inputs":{"env":[]}}
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
The empty array is not permission to omit required repository checks: retain it
only when no executable criterion applies and explain why in Acceptance Notes.
Prefer existing covering tests; creating a task-named test or adding typecheck
is not a template requirement. For each selected check declare `id`, `kind`,
`cwd`, `phase`, `cost`, `evidence_policy`, `necessity`, `inputs.env`, and its
`command` or `path`. Declare the same execution once, including checks nested
inside aggregate scripts. Use `baseline_with_delta` only with an immutable
baseline and named current delta checks; never infer it from paths or command text.

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap:
- New test case/file rationale, or why existing coverage is sufficient:
- Selected check IDs and why their coverage is sufficient; omitted coverage:
- Full/expensive check justification and expected cost, if applicable:
- Execution/baseline references, subject, current delta and disposition:
- Residual risks and incomplete observations:

## Rollback Point

- Commit / checkpoint: `origin/main` @ 79f6a0d3
- Revert strategy: revert the single SDK PR; both new fields are optional, so no stored-record migration in either direction; the pin returns to `pi-coding-agent@0.85.1006` / `pi-ai@0.85.1005`.
