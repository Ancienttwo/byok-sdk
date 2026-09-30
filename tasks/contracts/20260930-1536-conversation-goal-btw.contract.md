# Task Contract: conversation-goal-btw

> **Status**: Active
> **Plan**: plans/plan-20260930-1536-conversation-goal-btw.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-09-30 15:36
> **Review File**: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md`
> **Notes File**: `tasks/notes/20260930-1536-conversation-goal-btw.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

A Bot must keep an explicit bounded goal and answer side questions without widening the main Agent home or racing SDK terminal/cancellation authority. A private copy-and-own Host composition demonstrates the existing execution primitives without creating a public scheduler.

## Goal

Deliver example-local goal/btw Host composition, independent SQLite CAS/outbox persistence, strict result extraction, and tests using only public client/server APIs with a stub adapter and real embedded HTTP coordinator. Codex implements; Claude w9:p1 independently reviews and accepts.

## Scope

- In scope: examples/basic goal/btw files, public-API stub tests, scripts/typecheck/dependency workspace row, a short README pointer, and this plan/research/notes/review. SQLite uses built-in node:sqlite; test databases live only under owned temporary directories.
- Out of scope: packages/**, API goldens, spec, wire, Pi pins, model/node/flow repartitioning, other dependency resolution, server.ts behavior, original plugin installation, release/deployment/commit/push/PR.
- Taste constraints: copy-and-own, private Host state, explicit identity/context, readonly independent btw, no background timers, no token-budget claims, no release flag.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is falsified if public fresh result-document execution cannot support the message-free goal/btw tests, or the default canonical-home gate prevents parallel different-Agent execution. Revisit the seam; do not change SDK exports or raise the home limit.

## Workflow Inventory

- Source plan: `plans/plan-20260930-1536-conversation-goal-btw.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260930-1536-conversation-goal-btw.review.md`
- Notes file: `tasks/notes/20260930-1536-conversation-goal-btw.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{
  "protocol": 1,
  "oracles": [
    {
      "id": "example-tests",
      "kind": "deterministic_test",
      "paths": [
        "examples/basic/goal-btw-store.ts",
        "examples/basic/goal-btw.ts"
      ]
    },
    {
      "id": "example-tests-sdk-readback",
      "kind": "runtime_readback",
      "paths": [
        "examples/basic/goal-btw-store.ts",
        "examples/basic/goal-btw.ts"
      ]
    }
  ]
}
```

- `example-tests` maps to the existing Verification Plan check `example-tests` (`examples/basic: bun run test`), the 31 deterministic HTTP/SQLite cases in `goal-btw.test.ts`; no additional execution is implied. It covers lifecycle/CAS, pause/wait/cancel, malformed verdict, exact-ID recovery and separate readonly Agent homes.
- `example-tests-sdk-readback` maps to that same actual check, limited to exact reserved taskId readback through public `byok.tasks.offer`, `byok.tasks.attempt` and `byok.tasks.deviceTerminal`; this is real embedded coordinator/daemon transport with a stub native adapter, not native provider acceptance. Corresponding case names:
  - `T2: reserved input -> real offer -> continue -> fresh step -> complete, no native followUp`
  - `SQLite restart after reserve recovers the exact taskId and cannot submit twice`
  - `recovery after SDK offer commit but lost acknowledgement reads the existing offer`
  - `cancel after SDK offer exists wins against a late complete result`
  - `cancel in sending-before-offer window is persisted and replayed to exactly that task`

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - examples/basic/
  - bun.lock
  - docs/researches/2026-09-30-goal-btw-host-integration.md
  - docs/architecture/modules/sdk/sdk-root.md
  - docs/architecture/.projection-manifest.json
  - plans/plan-20260930-1536-conversation-goal-btw.md
  - tasks/todos.md
  - tasks/contracts/20260930-1536-conversation-goal-btw.contract.md
  - tasks/reviews/20260930-1536-conversation-goal-btw.review.md
  - tasks/notes/20260930-1536-conversation-goal-btw.notes.md
  - tasks/notes/20260930-goal-btw-discussion.md
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
  files_exist:
    - examples/basic/goal-btw.ts
    - examples/basic/goal-btw-store.ts
    - examples/basic/goal-btw.test.ts
    - docs/researches/2026-09-30-goal-btw-host-integration.md
  - docs/architecture/modules/sdk/sdk-root.md
  - docs/architecture/.projection-manifest.json
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "example-tests",
      "kind": "command",
      "command": "bun run test",
      "cwd": "examples/basic",
      "phase": "preflight",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Public-API embedded server/stub acceptance and SQLite restart/concurrency coverage.",
      "inputs": {
        "env": [
          "BYOK_TEST_BUN_BIN",
          "BYOK_REQUIRE_BUN",
          "TMPDIR"
        ]
      }
    },
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required build.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required typecheck including example implementation/tests.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "test",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required aggregate suite including examples/basic; repeated after milestone changes.",
      "inputs": {
        "env": [
          "BYOK_TEST_BUN_BIN",
          "BYOK_REQUIRE_BUN",
          "TMPDIR"
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
      "necessity": "Prove SDK public surface unchanged.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "versions",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Prove no Pi/release version drift.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "workflow",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root workflow/scope gate.",
      "inputs": {
        "env": []
      }
    }
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

- H15 current provenance: the user-authorized official daemon upgrade aligned archctx 0.6.1 with its package, and the ignored worktree-local CodeGraph index was rebuilt with 1.6.1. The reviewed follow-up ChangeSet changes only docs/architecture/.projection-manifest.json metadata; sdk-root/model/flow/P3 stay unchanged, with the original c105ee12 flowProofDigest and proven 3/3 selectors. The manifest is evidence of local indexing of a dirty worktree on codex/conversation-goal-btw at base ede2db31, not a committed or published state.

- Architecture exception: clean base ede2db31 reproduced the pre-existing verified-flow-proof-changed gate on capability.sdk.sdk-root. The user authorized its treatment in this task, then explicitly authorized a local ignored CodeGraph 1.5.0 index. Missing index had degraded P2 proof; restoring it produced the exact original flowProofDigest and proven 3/3 selectors. Only the two named generated document paths are allowed; no model/capability boundary change, archive or unrelated cleanup. This metadata repair is unrelated to goal/btw and can be independently reverted. Manifest provenance is local dirty-worktree evidence on codex/conversation-goal-btw at base commit ede2db31, not a claim of committed or published state.

- Goal and btw are Host patterns; no SDK production surface changes. Models produce claims, not Host acceptance truth. Example tests validate JSON/protocol/lifecycle, not semantic goal quality.
- New tests cover race/restart/scope paths absent from the existing basic example. Real coordinator and daemon are used; only the native adapter is stubbed via public contracts.
- Required checks are recorded with exit codes. Formal test inputs explicitly select BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun and BYOK_REQUIRE_BUN=1, the same environment names used by CI; a fresh short TMPDIR avoids the existing test-temp accumulation problem. The absolute Bun path is this local machine's verified installation, not a package/runtime pin. Native/provider/production and downstream adoption remain outside this acceptance.
- Frozen reviewer remains Claude w9:p1 under acceptance policy protocol 1; Codex does not self-accept. The user explicitly authorized user_waiver=allowed in this turn because clean base ede2db31 already has the unrelated architecture gate verified-flow-proof-changed / capability.sdk.sdk-root. This policy permission is not an architecture approval or proof that prepare-acceptance can pass; no waiver receipt is presumed.

## Rollback Point

- Base: ede2db31ad33072965434b04743cfd7e52b93e85.
- Revert only the isolated example/documentation patch; preserve main checkout research and Pi-upgrade worktree.
