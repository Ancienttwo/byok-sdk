# Task Contract: runtime-input-preparation-spike

> **Status**: Active
> **Plan**: plans/plan-20260914-0140-runtime-input-preparation-spike.md
> **Task Profile**: eval-only
> **Owner**: kito
> **Capability ID**: sdk-sdk-root
> **Last Updated**: 2026-09-14
> **Review File**: `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md`
> **Notes File**: `tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md`

## Why
Host C07 must check complete runtime input before Execution creation; SDK adapter.prepare is post-offer and cannot return that input. User approved an independent contract plus minimal offline preparation/consume spike.

## Goal
Deliver a concrete SDK boundary contract proposal and a source-bound provider-free feasibility result for native Pi complete payload preparation before any SDK task submission and exact consumption at a later launch boundary, including drift rejection. A measured impossibility is a valid experiment outcome but must be reported as such.

## Scope
- Architecture adoption amendment (owner approved 2026-09-14): initialize local CodeGraph in this worktree, retain and verify the existing SDK Root umbrella, preview and adopt exact projection-owned documents, resolve matching architecture requests/candidates, then canonical acceptance. No production SDK edits, global runtime changes or provider calls. Generated-output paths must be registered from preview before apply.
- In scope: the existing approved S0 design translated into this SDK research contract; one standalone native Pi offline experiment; own workflow/evidence. Local Pi 0.85.1 is external test subject, not a repository dependency.
- Approved prerequisite amendment (2026-09-14, owner `go on`): remove the unowned retired architecture template node through a typed, previewed ChangeSet; inspect projection effects before extending the exact generated-output scope. The proposed product capability metadata update was rejected by the installed tool write allowlist and remains unapplied. This is a bounded architecture metadata repair, not SDK product implementation.
- Out of scope: package source/exports, production protocol or RPC, credentials/provider calls, budgets, production purity claim, authentication implementation, C05/PR183 fixes, deploy/push/merge.
- Isolation: new worktree /Users/kito/Projects/byok-sdk-wt-c07-runtime-input-spike, branch codex/c07-runtime-input-spike, base f811634c8c9ac6a16891c354eaf0adcb869004a2. Prior worktrees read-only.
- Taste constraints: one native serializer; no Host prompt clone, fallback input reassembly, new execution state machine or default config writes.

## Stop Conditions
- Stop if experiment needs real credentials/provider traffic, production edits or a different runtime installation.
- Stop after three repair rounds per experiment issue and retain failed evidence.
- Stop before changing anything outside the exact paths below.

## Falsifier
The consume path cannot deliver the captured request bytes at the actual provider boundary, or changed target/input/artifact still dispatches; either disproves the proposed seam. Cheapest proof is two isolated native CLI processes plus interception at the true request boundary with external networking blocked.

## Workflow Inventory
- Source plan: plans/plan-20260914-0140-runtime-input-preparation-spike.md
- Deferred ledger: tasks/todos.md
- Contract / notes / review: the matching stem under tasks/.
- Check evidence: .ai/harness/checks/latest.json and .ai/harness/runs/.
- Exact scope: allowed_paths below; only the new worktree is activated.
- This is an experiment deliverable, not production SDK acceptance.

## Change Assessment
```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy
```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths
```yaml
allowed_paths:
  - .ai/harness/policy.json
  - plans/plan-20260914-0140-runtime-input-preparation-spike.md
  - tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md
  - tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md
  - tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md
  - tasks/todos.md
  - docs/researches/runtime-input-preparation-contract.md
  - scripts/experiments/runtime-input-preparation-spike.mjs
  - .archcontext/model/nodes/capability.architecture-context.yaml
  - docs/architecture/.projection-manifest.json
  - docs/architecture/changelog.md
  - docs/architecture/decisions/index.md
  - docs/architecture/diagrams/architecture.likec4
  - docs/architecture/diagrams/architecture.mmd
  - docs/architecture/diagrams/architecture.structurizr.json
  - docs/architecture/index.md
  - docs/architecture/modules/sdk/sdk-root.md
  - .archcontext/model/nodes/capability.sdk.sdk-root.yaml
  - .archcontext/model/flows/flow.sdk.task-input.yaml
  - .archcontext/model/nodes/module.sdk.task-runner.yaml
  - .archcontext/model/nodes/component.sdk.offer-validation.yaml
  - .archcontext/model/nodes/module.sdk.runtime-start.yaml
  - .archcontext/model/relations/relation.sdk.offer-validation.yaml
  - .archcontext/model/relations/relation.sdk.owned-runtime-start.yaml
  - packages/AGENTS.md
  - packages/CLAUDE.md
  - docs/architecture/requests/root.md
  - docs/architecture/requests/archive/2026/20260914-033645-root.md
```

## Evidence Requirements
```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)
```yaml
exit_criteria:
  files_exist:
    - docs/researches/runtime-input-preparation-contract.md
    - scripts/experiments/runtime-input-preparation-spike.mjs
    - tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md
  artifacts_exist:
    - _ops/c07-runtime-input/result.json
```

## Verification Plan
```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "offline-spike",
      "kind": "command",
      "command": "node scripts/experiments/runtime-input-preparation-spike.mjs",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Direct native Pi payload prepare/consume equivalence and drift refusal, external network denied.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Owned document and experiment whitespace.",
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
      "necessity": "Independent plan and exact contract scope registration.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "model",
      "kind": "command",
      "command": "node /Users/kito/.bun/install/global/node_modules/archctx/bin/archctx.mjs validate --format json",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate adopted model through the exact installed provider.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "capabilities",
      "kind": "command",
      "command": "repo-harness run -- capability-resolver validate --repo . --format text",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Confirm retained SDK capability authority and source resolution.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "architecture",
      "kind": "command",
      "command": "repo-harness architecture-projection check --json",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Require a no-drift native projection after automatic materialization.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "architecture-state",
      "kind": "command",
      "command": "repo-harness architecture-projection status --json | jq -e '.acceptance.unresolvedCandidates == 0 and .acceptance.invalidArtifacts == 0'",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Require all historical candidate obligations resolved and valid.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "architecture-sync",
      "kind": "command",
      "command": "repo-harness run -- check-architecture-sync --mode strict --target f811634c8c9ac6a16891c354eaf0adcb869004a2 --format json",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Require no blocking architecture requests in the actual bounded diff.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "production-unchanged",
      "kind": "command",
      "command": "git diff --exit-code f811634c8c9ac6a16891c354eaf0adcb869004a2 -- packages package.json bun.lock bun.lockb ':(exclude)packages/AGENTS.md' ':(exclude)packages/CLAUDE.md'",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Guard unchanged production source and dependencies; only two context projections are excluded.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Target

Pin only this worktree policy worktree_strategy.review_base to f811634c8c9ac6a16891c354eaf0adcb869004a2, the declared C07 starting revision. The inherited origin/main target incorrectly includes C05 production changes. Keep base_branch, merge_back and all gate policies unchanged. This is a scoped evidence-target correction; no global policy change.

## Architecture Adoption Verification

The output list is derived from the owned provider preview. Preserve the existing index prefix and historical architecture design documents. The required flow will be a representative source-proved path, not a claim about every package/runtime. Package context outputs and the matching request archive are authorized deterministic adoption effects. The archive helper chose 20260914-033645-root.md; all prior archive hashes were verified unchanged and the allowed path is now that exact new file. No global policy changes, product.yaml mutation, new package dependency or publication is in scope.

## Acceptance Notes
The user authorized a minimal offline spike. No package source, build artifact, public API, version authority or dependencies change. Full root build/typecheck/test/API/version suites are production implementation gates and are not reproduced for this experiment; the direct native boundary oracle and unchanged-package proof cover this named deliverable. No acceptance claim for transport authentication, persistent artifact lifecycle, complete input counter or C07 production readiness. One read-only verifier may inspect this bounded experiment; no Claude review invocation is authorized.

## Rollback Point
Base f811634c. Remove/revert only task-owned added files on explicit rollback; preserve C05 branch and all user WIP.
