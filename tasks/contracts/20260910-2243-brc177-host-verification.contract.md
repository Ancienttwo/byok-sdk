# Task Contract: Complete Issue177 with host verification

> **Status**: Active
> **Plan**: plans/plan-20260910-2243-brc177-host-verification.md
> **Task Profile**: bugfix
> **Owner**: ancienttwo
> **Capability ID**: capability.sdk.sdk-root
> **Review File**: tasks/reviews/20260910-2243-brc177-host-verification.review.md
> **Notes File**: tasks/notes/20260910-2243-brc177-host-verification.notes.md

## Why

Consumers of the published package see an incomplete namespace import and package count.

## Goal

Apply the approved two-file candidate from local commit98eaae33c46105433955c76b5b87dc5b52ac21a5 in this acquired worktree. packages/sdk/README.md must document seven namespaces including uiRuntime, preserving keys exclusion (SHA2567c65c87fa1817269a0937b21c6a539960ca7e25989839561d99ea6f3236cc8a2). packages/sdk/src/readme.test.ts must retain all assertions and add only the required-capture non-null assertion (SHA2564eb58b428fa44da938ea3f6f3fc3f1683fff05bc4066a4e97afb1f52979f93eb). The owner explicitly requires test and build execution on the host, in this isolated worktree. The live worker freezes its two-file implementation, the parent prepares canonical evidence on macOS, and the independent verifier consumes that exact result. No test, build or dependency installation may execute in the worker or verifier container.

## Scope

- In scope: Edit only the README and its package-local regression. The parent supplied the existing pre-fix regression and the already-reviewed two-file repair from PR182. Preserve all assertions; correct only its required regex capture typing. Read the two git blobs individually; do not cherry-pick parent-delivery metadata.
- Out of scope: Runtime exports, package metadata, version, campaign authority, plans or acceptance files.
- Execution: The acquired worker owns the README correction and the single ignored worker-ready coordination file below. The parent owns host-only canonical verification and host-result.json. The independent verifier reads that host-produced evidence and the Host Verification Protocol below; it must not recalculate a Linux toolchain hash for macOS execution or launch tests. This environment routing is the owner-approved task contract, including when the generic runner text describes worker self-verification.

## Falsifier

The package-local README consumer import omits a namespace exported by src/index.ts, or removes the explicit keys exclusion.

## Root Cause Evidence

- root_cause: packages/sdk/README.md:3 and its import example were not updated when packages/sdk/src/index.ts added the uiRuntime namespace; the source exports seven while the README describes six. The existing required nonempty regex capture at readme.test.ts:12 also needs a capture-specific assertion under noUncheckedIndexedAccess; CI34468443838 reports TS2532 before tests.
- repro: cd packages/sdk && bun run test src/readme.test.ts
- regression_guard: packages/sdk/src/readme.test.ts
- pre_fix_failure_artifact: tasks/evidence/brc177-pre-fix.log

## Allowed Paths

```yaml
allowed_paths:
  - packages/sdk/README.md
  - packages/sdk/src/readme.test.ts
  - .canary-scratch/brc177-host-verification/worker-ready.json
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/sdk/README.md
    - packages/sdk/src/readme.test.ts
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "readme-regression",
      "kind": "package_test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Exact Issue177 regression; pre-fix two failures recorded.",
      "inputs": {
        "env": [
          "PATH"
        ]
      },
      "path": "packages/sdk/src/readme.test.ts"
    },
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "Target AGENTS.md explicitly requires SDK build.",
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
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Target AGENTS.md required type integrity.",
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
      "necessity": "Target AGENTS.md explicitly requires its test script; run once at frozen repair.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Target AGENTS.md requires API boundary integrity.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Target AGENTS.md requires version authority integrity.",
      "inputs": {
        "env": [
          "PATH"
        ]
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
      "necessity": "Target AGENTS.md requires workflow integrity.",
      "inputs": {
        "env": [
          "PATH"
        ]
      }
    }
  ]
}
```

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: 2
    wall_time_minutes: 45
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: original_issue_scope_owner
    worker:
      mode: edit_within_allowed_paths
      purpose: apply_reviewed_sdk_readme_and_capture_typing
    verifier:
      mode: read_only
      purpose: independent_acceptance
  runner:
    preferred:
      - codex-exec
    fallback: null
    brief_is_authoritative: true
```

## Stop Conditions

Stop on a runtime/API change, protected path mutation, or required check failure outside the two approved files. Do not edit plan, contract, review, notes or acceptance policy. Do not invent a receipt or claim old PR182 CI is this campaign final. Preserve failure output; do not weaken assertions or replace an unavailable result.

## Acceptance Notes (Human Review)

The owner said “那不要用容器去测呀”. Test/build commands in the Verification Plan run only on the host. The previous settled campaign attempt has an immutable failed final caused by read-only common Git during snapshot creation; it is not reused as acceptance. This successor preserves the two-file source repair and all seven required checks. PR182 is corroborating historical evidence for its original subject.

## Host Verification Protocol

This exact protocol assigns canonical self-verification to the parent during the live worker invocation. It supersedes generic instructions to execute focused tests or prepare-acceptance inside the worker. The worker must not run a test, build, typecheck, dependency install, verify-sprint, or verification-plan command. The verifier must not run those commands either.

1. The parent creates the ignored coordination directory `.canary-scratch/brc177-host-verification` before dispatch and starts its host watcher. The worker reads its acquired HEAD and the SHA256 of this contract. Apply only `packages/sdk/README.md` and `packages/sdk/src/readme.test.ts` from local commit `98eaae33c46105433955c76b5b87dc5b52ac21a5`, using `git show <commit>:<path>` individually. Do not commit or change any workflow artifact. Check both file hashes against the Goal.
2. After both hashes match, write the allowed `worker-ready.json` once as JSON with `status: "frozen"`, `head: <actual acquired HEAD>`, `head_tree_sha: <git rev-parse HEAD^{tree}>`, `contract: "tasks/contracts/20260910-2243-brc177-host-verification.contract.md"`, `contract_sha256: <actual bare SHA256 of contract>`, and `source_sha256: {"packages/sdk/README.md":"7c65c87fa1817269a0937b21c6a539960ca7e25989839561d99ea6f3236cc8a2","packages/sdk/src/readme.test.ts":"4eb58b428fa44da938ea3f6f3fc3f1683fff05bc4066a4e97afb1f52979f93eb"}`. This is a freeze signal, not an acceptance claim.
3. Remain alive and make no further Git-visible edits. Use a bounded wait, at most twenty minutes, for `.canary-scratch/brc177-host-verification/host-result.json`. A simple read-only polling loop is permitted solely to await this real synchronization signal. Do not invoke tools that execute tests, change dependencies, alter Git history or prepare evidence. There must be no background process writing source. The existing live child supervisor renews the lease during this wait.
4. The parent validates the ready identity, candidate file bytes and complete Git-visible tree. On the host it runs `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260910-2243-brc177-host-verification.contract.md`, with `REPO_HARNESS_DIFF_BASE` equal to acquired HEAD. Required checks execute once at the frozen snapshot. Host PATH is `/tmp/campaign-reconciliation-recovery/brc177-bin:/Users/ancienttwo/.nvm/versions/node/v22.22.0/bin:/Users/ancienttwo/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`; Node22.22.0/Bun1.4.0 and harness9cc12bac are pinned. The host performs `validateMaterializedVerificationExecutionReport` in the same environment, checks unchanged snapshot and the immutable run artifact, then writes host-result.json with its actual status, hashes and artifact path. This file is read-only to the worker.
5. After the host signal arrives, the worker reads the actual canonical immutable `run_artifact`, confirms the contract, HEAD, source hashes, passing seven-check execution evaluation and host validation. If valid, write the runner-owned attempt result with `outcome: "completed"` and evidence_paths containing that actual immutable run artifact, host-result.json and the two product files. Then exit. A failure, malformed/stale signal, missing artifact or timeout must produce a truthful non-completed outcome; never manufacture a pass. Report the actual host command, exit code and executed/reused checks in the final response.
6. The independent verifier reads the complete contract and actual host artifacts, inspects the two-file diff, and confirms contract/snapshot/target/recorded host producer context and each required result. The execution producer is macOS, not the verifier's Linux process. The verifier consumes the host's canonical validated result and immutable evidence; it must not invoke a validator that recomputes Linux PATH/OS against macOS evidence and must not repeat tests. It returns a real semantic verdict. The parent subsequently records and verifies the actual AcceptanceReceipt on the same host runtime/PATH and performs required publication and closeout.

The two coordination files are non-authoritative rendezvous, never replacements for canonical execution evidence, a worker final or an AcceptanceReceipt. Allowed Paths includes the single ignored worker-owned signal solely to make its write authority explicit; product scope remains exactly the two SDK files. Keep the acquired worktree for parent publication. No merge or Issue closeout from either child.

## Rollback Point

Revert the original Issue177 repair PR on the disposable canary branch. No deployment or package release.
