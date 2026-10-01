# Task Contract: pi-fff-local-search

> **Status**: Fulfilled
> **Plan**: plans/plan-20261001-1237-pi-fff-local-search.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: sdk-sdk-root
> **Last Updated**: 2026-10-01 12:38
> **Review File**: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md`
> **Notes File**: `tasks/notes/20261001-1237-pi-fff-local-search.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Strengthen SDK local file and content search through a pinned SDK-owned ordinary Pi RPC factory. Task PermissionPolicy, authorized cwd and installed implementation identity retain their existing documented boundaries. A personal Pi install is insufficient because this host disables discovered extensions.

## Goal

Deliver @ff-labs/pi-fff@0.11.0 tools-only integration compatible with Pi 0.99.2, real search and policy/lifecycle evidence, and clean installed native dependency readback. WP1/WP2 disposable and read-only evidence must resolve compatibility before WP3 production edits. This contract authorizes local implementation and acceptance; publishing, merging and deployment are excluded.

## Scope

- In scope: client dependency/peer pins, ordinary RPC static owned factory, bundled TS and external native packages, one-authority policy mapping, native installation readback, isolated configuration/data/lifecycle, real fixture and release-pack tests, focused spec/architecture documentation.
- Out of scope: Prepared FFF admission, builtin override, public protocol changes, sibling adapters, release/version bump, npm publish, merge/deploy, unrelated capability coverage or architecture dead-letter repair.
- Taste constraints: public Pi APIs, tools-only independent names, no personal global config authority, no unproven shared indexing service, no policy bypass or silent search fallback.

## Stop Conditions

- Return concrete evidence before editing production source if real released extension API/schema/native load fails, FFF widens admitted tool permissions, or fixed SDK config/names cannot be enforced with public APIs.
- Stop and return to parent if allowed paths must widen, a required command cannot run, or ordinary native dependencies cannot load in a clean installed client or would require expansion of Prepared/attested identity.
- Do not equate a source-tree/native mock pass with clean installed SDK acceptance. Keep failed checks and untested platform claims explicit.

## Falsifier

A real Pi 0.99.2 session cannot load and execute pi-fff 0.11.0; session_start reactivates denied tools; user global/restored mode changes the admitted tool names; or a clean installed client cannot resolve and read back its native packages. Cheapest proof: isolated exact-version real find/grep plus explicit empty/deny tool selection before WP3.

## Root Cause Evidence

Not applicable: feature integration, not a bugfix claim.

## Workflow Inventory

- Source plan: `plans/plan-20261001-1237-pi-fff-local-search.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md`
- Notes file: `tasks/notes/20261001-1237-pi-fff-local-search.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"immutable-0992-repository-and-install-tests","kind":"deterministic_test","paths":["*"]},{"id":"closeout-equivalence-and-architecture-proof","kind":"deterministic_test","paths":["*"]},{"id":"immutable-0992-clean-npm-native-and-official-closure","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20261001-1237-pi-fff-local-search.md
  - tasks/contracts/20261001-1237-pi-fff-local-search.contract.md
  - tasks/reviews/20261001-1237-pi-fff-local-search.review.md
  - tasks/notes/20261001-1237-pi-fff-local-search.notes.md
  - tasks/notes/pi-fff/
  - tasks/todos.md
  - tasks/workstreams/sdk/sdk-root/
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - docs/architecture/modules/sdk/sdk-root.md
  - docs/architecture/.projection-manifest.json
  - packages/client/package.json
  - bun.lock
  - packages/client/tsup.config.ts
  - packages/client/tsup.sealed.config.ts
  - packages/client/src/bin/pi-extension-factories.js
  - packages/client/src/bin/pi-extension-factories.d.ts
  - packages/client/src/bin/pi-rpc-host.ts
  - packages/client/src/adapters/pi/fff-extension.ts
  - packages/client/src/adapters/pi/permission-mapping.ts
  - packages/client/src/__tests__/pi-fff.test.ts
  - packages/client/src/__tests__/pi-rpc-host.test.ts
  - packages/client/src/__tests__/pi-permission-mapping.test.ts
  - scripts/release/pack-and-smoke.mjs
  - CHANGELOG.md
  - README.md
  - package.json
  - packages/client/src/__tests__/fixtures/pi-compile-purity-probe.mjs
  - packages/client/src/__tests__/pi-input-preparation.test.ts
  - packages/client/src/adapters/pi/__tests__/official-pi-conformance-compat.test.ts
  - packages/client/src/adapters/pi/__tests__/official-pi-conformance-compile.test.ts
  - packages/client/src/adapters/pi/__tests__/official-pi-conformance-enforcement.test.ts
  - packages/client/src/adapters/pi/__tests__/official-pi-fixture.ts
  - packages/client/src/adapters/pi/__tests__/prepared-lane-official.test.ts
  - packages/client/src/adapters/pi/input-preparation.ts
  - packages/client/src/adapters/pi/official-pi-closure.json
  - packages/client/src/adapters/pi/pi-export-assets.source.json
  - packages/client/src/daemon/input-preparation-service.ts
  - packages/client/src/util/rpc-frame.ts
  - packages/client/vendor/THIRD-PARTY.md
  - packages/client/vendor/third-party-manifest.json
  - scripts/release/beta-release.test.mjs
  - scripts/release/pack-and-smoke.test.mjs
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
    - plans/plan-20261001-1237-pi-fff-local-search.md
    - tasks/notes/20261001-1237-pi-fff-local-search.notes.md
  artifacts_exist: []
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
      "cost": "normal",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": []
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-3e59ec51810143f3b0c9.json",
        "execution_id": "vx-3e59ec51810143f3b0c9"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": []
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-701cecdaedec45a2b24c.json",
        "execution_id": "vx-701cecdaedec45a2b24c"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "test",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": [
          "TMPDIR",
          "BYOK_TEST_BUN_BIN",
          "BYOK_REQUIRE_BUN"
        ]
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-c3b5f17e6aa1433197cf.json",
        "execution_id": "vx-c3b5f17e6aa1433197cf"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": []
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-0adecd7f759847339057.json",
        "execution_id": "vx-0adecd7f759847339057"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": []
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-c267f225272f446ab8e7.json",
        "execution_id": "vx-c267f225272f446ab8e7"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "task-workflow",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": []
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-29a4b76567b543488d89.json",
        "execution_id": "vx-29a4b76567b543488d89"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "release-pack",
      "kind": "command",
      "command": "cd \"$BYOK_FFF_PACK_CANDIDATE\" && bun run check:release-pack",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": [
          "BYOK_FFF_PACK_CANDIDATE",
          "PATH",
          "TMPDIR"
        ]
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-f5c60a1bbc0f47ed9087.json",
        "execution_id": "vx-f5c60a1bbc0f47ed9087"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "diff-check",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "baseline_with_delta",
      "necessity": "Immutable Pi0.99.2 baseline plus current document/workflow delta; this does not claim the old suite executed on the new tree.",
      "inputs": {
        "env": []
      },
      "baseline": {
        "run_file": ".ai/harness/runs/verification-vx-2d4930f9a3c24c5dbfd4.json",
        "execution_id": "vx-2d4930f9a3c24c5dbfd4"
      },
      "delta_checks": [
        "source-equality",
        "closeout-workflow",
        "closeout-diff",
        "closeout-architecture"
      ]
    },
    {
      "id": "source-equality",
      "kind": "command",
      "command": "python3 -c 'import json,os,subprocess,tempfile\nfrom pathlib import Path\nbaseline='\\''56a78bc9906a3ac3b4a95f55cb3776a8dd9e8919'\\''\nallowed=set(['\\''plans/plan-20261001-1237-pi-fff-local-search.md'\\'', '\\''tasks/contracts/20261001-1237-pi-fff-local-search.contract.md'\\'', '\\''tasks/reviews/20261001-1237-pi-fff-local-search.review.md'\\'', '\\''tasks/notes/20261001-1237-pi-fff-local-search.notes.md'\\'', '\\''docs/architecture/.projection-manifest.json'\\''])\nwith tempfile.TemporaryDirectory(prefix='\\''fff-closeout-index-'\\'') as tmp:\n env=dict(os.environ,GIT_INDEX_FILE=str(Path(tmp)/'\\''index'\\''))\n subprocess.run(['\\''git'\\'','\\''read-tree'\\'','\\''HEAD'\\''],env=env,check=True)\n subprocess.run(['\\''git'\\'','\\''add'\\'','\\''-A'\\'','\\''--'\\'','\\''.'\\''],env=env,check=True)\n tree=subprocess.check_output(['\\''git'\\'','\\''write-tree'\\''],env=env,text=True).strip()\n changed=set(filter(None,subprocess.check_output(['\\''git'\\'','\\''diff-tree'\\'','\\''--no-commit-id'\\'','\\''--name-only'\\'','\\''-r'\\'',baseline,tree],text=True).splitlines()))\n unexpected=changed-allowed\n assert not unexpected, '\\''Source delta outside exact closeout artifacts: '\\''+str(sorted(unexpected))\n print(json.dumps({'\\''baseline_tree'\\'':baseline,'\\''current_tree'\\'':tree,'\\''closeout_only_paths'\\'':sorted(changed),'\\''production_equal'\\'':True}))\n'",
      "cwd": ".",
      "phase": "preflight",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "All Git-visible files are compared with the immutable 0992 tree; only five exact approved closeout paths may differ.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "closeout-workflow",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "preflight",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Current workflow delta is valid.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "closeout-diff",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "preflight",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Current document diff remains clean.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "closeout-architecture",
      "kind": "command",
      "command": "repo-harness run check-architecture-sync",
      "cwd": ".",
      "phase": "preflight",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Current architecture projection and accepted proof are checked.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

- WP1 owns only disposable runtime/native proof. WP2 is read-only authorization and identity analysis. Parent owns workflow files and notes; WP3 source ownership is listed in the plan and frozen before dispatch. Workers are not alone and must preserve others' changes.
- Real find/grep fixtures are mandatory; existing pi-rpc-host, permission and identity tests provide regression surfaces, but do not yet cover FFF.
- Root required commands and release-pack execute once on the final candidate, with fresh short TMPDIR for tests and preserved exit codes. Planning preflight is not implementation acceptance.
- Final independent custom gatekeeper review includes all-tools/default, explicit allow, deny, readonly, empty list, resumed mode, failure, shutdown and concurrent sessions. OS/architecture claims are limited to tested targets.
- Prepared integration and any upstream public API incompatibility remain explicit unresolved/deferred boundaries until evidence resolves them.

## Rollback Point

- Commit / checkpoint: 708ed45b275d7d0cceeb6b61eb392c7d7b4efed9
- Revert strategy: discard/revert only the isolated FFF implementation diff; do not modify personal Pi state or unrelated worktrees.


## WP2 Boundary Clarification

Ordinary RPC FFF native libraries are runtime installation dependencies; existing implementation-identity does not attest their entire executable graph. This contract requires honest clean-install/native readback, not an attestation expansion. Prepared/compiler/implementation-identity source edits are excluded. Existing readonly list is preserved for the first slice; FFF is available in auto default or explicit FFF grants, with deny winning. No public tool registry or protocol redesign.

## Authorized 0.99.2 baseline correction

The user corrected the intended runtime to 0.99.2 and authorized continuation. Import the 23 already-authored upgrade files from primary branch pi-0.99.2-context-usage as a frozen inherited baseline; keep original primary WIP untouched. This is not a new Prepared/identity redesign: existing version, closure inventory, exports/vendor provenance and fixture projections are inherited verbatim; FFF introduces no extra attestation. OAR research/index and context-usage planning are excluded. Parent owns this baseline composition; workers may edit only their explicit FFF ownership. Old 0.99.1 measurements remain historical and cannot accept the corrected candidate.

## Approved formal closeout

User approved CodeGraph proof and typed receipt. The index is local/ignored; current projection is applied and old proof-only signal reconciled. Reuse the eight immutable0.99.2 executions through baseline_with_delta only after source-equality, currentworkflow, diff and architecture deltas pass. No production/dependency/test/config changes are allowed in this phase.
