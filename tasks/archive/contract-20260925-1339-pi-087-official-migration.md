> **Archived**: 2026-09-25 13:39
> **Related Plan**: plans/archive/plan-20260925-0331-pi-087-official-migration.md
> **Outcome**: Superseded
> **Lifecycle**: contract
> **Parent Run ID**: run-20260925-1339
> **Archive Projection V1**: `plans/plan-20260925-0331-pi-087-official-migration.md` => `plans/archive/plan-20260925-0331-pi-087-official-migration.md`
> **Archive Projection V1**: `tasks/notes/20260925-0331-pi-087-official-migration.notes.md` => `tasks/archive/notes-20260925-1339-pi-087-official-migration.md`
> **Archive Projection V1**: `tasks/contracts/20260925-0331-pi-087-official-migration.contract.md` => `tasks/archive/contract-20260925-1339-pi-087-official-migration.md`
> **Archive Projection V1**: `tasks/reviews/20260925-0331-pi-087-official-migration.review.md` => `tasks/archive/review-20260925-1339-pi-087-official-migration.md`

# Task Contract: pi-087-official-migration

> **Status**: Superseded
> **Plan**: plans/archive/plan-20260925-0331-pi-087-official-migration.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-25 03:35
> **Review File**: `tasks/archive/review-20260925-1339-pi-087-official-migration.md`
> **Notes File**: `tasks/archive/notes-20260925-1339-pi-087-official-migration.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The prepared lane depends on a frozen, self-published Pi fork (`@byok-sdk/pi-*` 0.86.1001). Each fork change is a full three-package republish with interactive EOTP; upstream 0.87 removed the fork's injection point; 0.21.0 already deferred a capability to this migration. OP0 (2026-09-24, three independent tracks) showed official `@earendil-works/pi-coding-agent@0.87.1` covers the lane through public APIs given two narrowed workarounds, which the Owner approved on 2026-09-25 (A1' sink-transport compile, A2' request-scoped sentinel provenance). If this ships wrong, either the byte gate lets a request out that differs from the frozen D (budget/authorization broken), or the identity gate accepts an unpinned runtime; if skipped, the fork keeps costing a republish per fix while its seam is already incompatible with upstream.

## Goal

Retire `@byok-sdk/pi-*` from the SDK's active dependency graph: `packages/client` pins exact official `@earendil-works/pi-coding-agent@0.87.1`, `pi-ai@0.87.1`, `pi-agent-core@0.87.1` (plus exact sibling versions with integrity); the Pi adapter compiles D via A1', injects Host history via `context_with_system` with A2' sentinels, and enforces via `registerProvider` + scoped `fetch`; no fork-only subpath is imported anywhere; the identity gate checks official exact artifacts; the input-preparation wire is cut once to a new version; the conformance suite (plan WP1 (a)–(f)) is green; a U1 upstream candidate branch exists in the Pi repo. The seven root checks pass.

## Scope

- In scope: plan WP0–WP7 as written in the plan's Task Breakdown; SDK packages `client`, `protocol`, `cloud`, `keys`; release scripts and api-surface; `docs/protocol.md`, a `docs/spec.md` amendment for the runtime-identity wording (§3.2 of the 2026-09-19 draft: official source + exact closure + adapter identity replaces "must be BYOK fork alias"); CHANGELOG; the U1 candidate branch in `/Users/kito/Projects/pi-wt-087-u1` (WP6, separate repo, local only).
- Out of scope: SummaryJob; Salesko Host changes; P0b/P0c; product semantics of empty `requiredToolsets`; any edit to the frozen fork line or published fork packages; opening the upstream PR; publishing any package.
- Taste constraints: match surrounding code; no compatibility shims, no dual read/write; typed refusals over emulation; no AI attribution trailers in commits.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any capability turns out to need a private deep import, patch-package, a copied serializer, a global fetch patch, a relaxed budget/S2 gate, or a fork change.
- Stop after three repair rounds on one issue; report.

## Falsifier

The direction is wrong if WP1 (a) fails on real 0.87.1: A1' sink-compile bytes differ from the live `registerProvider`-gated body for the same Host transcript (first or tool-result request), or if (b) shows sentinel provenance changes wire bytes for text-only assistant history. Cheapest proof point: run WP1 (a) and (b) before any adapter code is touched.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/archive/plan-20260925-0331-pi-087-official-migration.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/archive/review-20260925-1339-pi-087-official-migration.md`
- Notes file: `tasks/archive/notes-20260925-1339-pi-087-official-migration.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"kind":"deterministic_test","paths":["packages/client/src/adapters/pi/**","packages/client/src/bin/**","packages/protocol/src/**","scripts/release/**"]},{"kind":"runtime_readback","paths":["packages/client/src/adapters/pi/**"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/
  - packages/protocol/
  - packages/cloud/
  - packages/keys/
  - scripts/release/
  - scripts/api-surface/
  - api-surface/
  - docs/protocol.md
  - docs/spec.md
  - docs/researches/
  - CHANGELOG.md
  - package.json
  - bun.lock
  - plans/archive/plan-20260925-0331-pi-087-official-migration.md
  - tasks/archive/contract-20260925-1339-pi-087-official-migration.md
  - tasks/archive/review-20260925-1339-pi-087-official-migration.md
  - tasks/archive/notes-20260925-1339-pi-087-official-migration.md
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
    - packages/client/package.json
    - plans/archive/plan-20260925-0331-pi-087-official-migration.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/archive/notes-20260925-1339-pi-087-official-migration.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "no-fork-in-active-graph",
      "kind": "command",
      "command": "! grep -rn 'npm:@byok-sdk/pi-' packages/*/package.json package.json && ! grep -rEn \"from ['\\\"]@earendil-works/pi-coding-agent/(prepared-session-input|input-preparation|rpc-types)['\\\"]\" packages/*/src --include='*.ts' && echo NO_FORK_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "The goal of the package: no fork alias and no fork-only subpath import remains.",
      "inputs": { "env": [] }
    },
    {
      "id": "conformance-official-pi",
      "kind": "command",
      "command": "bun test packages/client/src/adapters/pi/__tests__/official-pi-conformance",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "OP0 required verifications (a)-(f) on the real official 0.87.1 packages, synthetic SSE, zero network.",
      "inputs": { "env": [] }
    },
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required check.",
      "inputs": { "env": [] }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required check; the dependency switch must leave zero type errors.",
      "inputs": { "env": [] }
    },
    {
      "id": "test",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Root required check.",
      "inputs": { "env": [] }
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required check; public surface changes are declared.",
      "inputs": { "env": [] }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Root required check; single version authority across the wire cut.",
      "inputs": { "env": [] }
    },
    {
      "id": "release-pack",
      "kind": "command",
      "command": "bun run check:release-pack",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Launcher/identity/install closure is only exercised by the real bin here (lesson from PR #215).",
      "inputs": { "env": [] }
    },
    {
      "id": "no-ai-attribution",
      "kind": "command",
      "command": "! git log origin/main..HEAD --format=%B | grep -Ei 'co-authored-by: (claude|cursor)|claude-session:|noreply@anthropic.com' && echo NO_ATTRIBUTION_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Commits on this branch carry no AI attribution trailers.",
      "inputs": { "env": [] }
    },
    {
      "id": "workflow-strict",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Repository workflow gate required by root CLAUDE.md.",
      "inputs": { "env": [] }
    }
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: filled per WP in the notes file.
- New test case/file rationale, or why existing coverage is sufficient: `official-pi-conformance*.test.ts` is new because no existing test runs against the official packages.
- Selected check IDs and why their coverage is sufficient; omitted coverage: all ten checks; S2 tripwire on darwin-with-display is recorded manually in notes when run.
- Full/expensive check justification and expected cost, if applicable: `test` and `release-pack` are expensive but are the root required checks for any launcher/identity change.
- Execution/baseline references, subject, current delta and disposition: origin/main @ 3dd7ba6f.
- Residual risks and incomplete observations: filled at closeout.

## Rollback Point

- Commit / checkpoint: origin/main @ 3dd7ba6f
- Revert strategy: revert branch `claude/pi-087-migration`; fork packages remain published; U1 branch is local to the Pi repo.
