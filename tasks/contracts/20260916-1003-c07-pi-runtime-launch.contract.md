# Task Contract: c07-pi-runtime-launch

> **Status**: Active
> **Plan**: plans/plan-20260916-1003-c07-pi-runtime-launch.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: sdk-sdk-root
> **Last Updated**: 2026-09-16
> **Review File**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
> **Notes File**: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`

## Why

Pi is spawned from three independent final sites, and the outer adapter check reaches only one of them. The ordinary path rebuilds a command from the package shape instead of the installed record's interpreter, prepared pins its own entry from the SDK package root, and the keys launcher spawns Pi after reading credentials with no cwd and no physical reverify. The spawn cwd is writable by the agent, so `bunfig.toml` preload and `.env` execute before any check inside the entry. Without one strict launch description and a reverify at the true spawn boundary, a trusted interpreter and a sealed entry are attestable but not meaningful, and Pi cannot run under S2 at all.

## Goal

Deliver one strict SDK runtime launch description, one provenance binding and one pre-spawn reverify, consumed identically by the three final Pi spawn consumers: ordinary `packages/client/src/adapters/pi/pi-adapter.ts` (~:511-519), prepared `pi-adapter.ts` (~:745-747) with `packages/client/src/bin/byok-pi-prepared.ts`, and keys `packages/keys/src/bin/pi-provider-launcher.ts` (~:79-98). Pi under S2, and S1 in the same train, must start through a trusted interpreter and a sealed entry with a fixed argv prefix, with the process cwd equal to the sealed launch cwd and the session cwd passed explicitly.

## Scope

- In scope: probes p1-p6 as the evidence gate; the SDK launch description type, provenance binding and explicit `runtime` attestation subject reusing the `ToolImplementationAuthority` measurement core; the three consumers switched with the process-cwd/session-cwd split and final reverify; SDK-owned in-process entries `byok-pi-rpc` and `pi-prepared` with inline extension factories; retirement of `piEntrypoint` and argv0 dispatch through one release-derived launch description; the verification matrix and its negative controls.
- Out of scope: Salesko O1 wiring (P4) is cross-repo and needs its own contract and worktree; the §75 closure work package (fork 1006 items, Salesko bundle `_shims` plugin, SDK eval-free validator) is tracked as a prerequisite for full bundle closure but is not owned here; MCP server surface; push, merge, publish, real installation and F numbers.
- Taste constraints: one launch description authority; no dual read, no "argv0 failed, try the subcommand" fallback, no compiled-only alias, no mutable wrapper, no reduction of the supported surface, no wildcard credential exemption in the keys projection, and no bare-specifier resolution on the launch path.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop before P1 if any probe p1-p6 falsifies the entry shape, the cwd split or the keys acceptance surface; report the negative rather than designing around it.
- Stop if the photon WASM source or the interpreted asset layout cannot be sealed inside one artifact; that reopens O1 versus O3 and is an Owner decision.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop after three repair rounds on one issue and retain the failing evidence.
- Stop before any push, merge, publish or real installation.

## Falsifier

A Pi child starts whose interpreter, entry, argv, cwd or env differ from the attested description without a pre-spawn refusal. Cheapest proof: mutate each of those five fields between the outer check and the final spawn, on each of the three lanes, and require a refusal with zero native or provider side effects.

## Completion Conditions (Owner)

The Owner's three stated completion conditions, carried verbatim in intent from the approval and not restated as generalities:

1. The photon cwd WASM fallback is closed — a `photon_rs_bg.wasm` planted in the Pi child's process cwd is never the file that loads, because the wasm is a sealed release asset and the child's cwd is the sealed launch cwd.
2. Package provenance is bound — the release's package/fork/prepared-contract identity comes only from the single exact pin, `byokFork` and build inputs, bound into the runtime subject together with the sealed `assets` component digests; a HOME `package.json` is never a provenance source.
3. The keys final env is reverified — the keys launcher re-measures the final env, argv and cwd at its own spawn boundary, after credential resolution and immediately before the child starts.

These are in addition to the first batch running the full daemon plus Pi under the interpreter, with no compiled-only alias, no mutable wrapper and no reduction of the supported surface.

## Root Cause Evidence

Not applicable; Task Profile is `code-change`.

## Workflow Inventory

- Source plan: `plans/plan-20260916-1003-c07-pi-runtime-launch.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
- Notes file: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.
- Isolation: worktree `/Users/kito/Projects/byok-sdk-wt-c07-pi-launch`, branch `codex/c07-pi-runtime-launch`, base `4fe4ad6f`. All other worktrees are read-only.

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
  - plans/plan-20260916-1003-c07-pi-runtime-launch.md
  - tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md
  - tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md
  - tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md
  - tasks/todos.md
  - docs/researches/20260916-c07-pi-under-s2-track-b.md
  - docs/spec.md
  - CHANGELOG.md
  - packages/implementation-identity/
  - packages/client/tsup.config.ts
  - packages/client/package.json
  - packages/keys/package.json
  - packages/client/src/index.ts
  - packages/client/src/types.ts
  - packages/client/src/adapters/provider-credential-environment.ts
  - packages/client/src/daemon/environment.ts
  - packages/client/src/daemon/trusted-launch-cwd.ts
  - api-surface/implementation-identity.d.ts
  - api-surface/keys.d.ts
  - scripts/api-surface/
  - scripts/release/
  - bun.lock
  - package.json
  - docs/architecture/sdk-architecture.md
  - packages/client/src/adapters/pi/
  - packages/client/src/bin/
  - packages/client/src/sdk-reserved-helper-host.ts
  - packages/client/src/daemon/tool-implementation-identity.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/prepared-tool-surface.ts
  - packages/client/src/__tests__/
  - api-surface/client.d.ts
  - packages/keys/src/bin/pi-provider-launcher.ts
  - packages/keys/src/pi-provider-launcher-core.ts
  - packages/keys/src/pi-provider-projection.ts
  - packages/keys/src/*.test.ts
  - .github/workflows/ci.yml
  - packages/protocol/src/
  - tests/
```

Path notes: `.github/workflows/ci.yml` is limited to the existing Windows lowpriv lane running real keys projection ACL positive/negative tests (supervisor condition, no push authorization).

 the keys launcher core and projection live at `packages/keys/src/pi-provider-launcher-core.ts` and `packages/keys/src/pi-provider-projection.ts`, not under `packages/keys/src/bin/`; only `pi-provider-launcher.ts` sits in `bin/`, and the earlier `bin/pi-provider-projection.ts` entry named a path that does not exist. `packages/client/src/bin/` is limited to `byok-pi-*.ts`, their Pi runtime host modules and pi-extension-factories.js/.d.ts ABI boundary, and `sdk-reserved-helper-runners.ts` for the two callable Pi kinds (existing MCP helper behavior unchanged); `packages/client/tsup.config.ts` is limited to registering the new Pi entry in the existing build; `packages/client/src/daemon/task-runner.ts` is limited to the runtime-subject admission and decline path; `packages/client/src/daemon/prepared-tool-surface.ts` also applies the same approved credential-free Pi MCP projection once before stage-1 measurement; stage-2 consumes that exact stored environment; `api-surface/client.d.ts` is regenerated output only, never hand-edited; `packages/protocol/src/` is only in scope if the wire record shape is actually touched by the `piEntrypoint` retirement. MCP tools/policy/identity semantics remain out of scope; the supervisor-approved credential-free explicit mcpEnv source correction is included.

## Evidence Requirements

```yaml
evidence_requirements:
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
    - docs/researches/20260916-c07-pi-under-s2-track-b.md
    - tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md
    - plans/plan-20260916-1003-c07-pi-runtime-launch.md
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
      "evidence_policy": "current_exact",
      "necessity": "The launch description ships in dist; the entries must actually build.",
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
      "necessity": "The launch description type is shared by client and keys; a shape drift must fail here.",
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
      "necessity": "Carries the three final-spawn drift negatives, the loader-injection negative with its control, the escaped-resolution negative and the unchanged keys secret rules. The P0 regression guards packages/client/src/__tests__/pi-runtime-launch-cwd.test.ts (loader-injection negative plus its load-bearing control) and packages/client/src/__tests__/pi-s2-bundle-resolution.test.ts (escaped-resolution negative) land red ahead of the fix and must be green, control included and unweakened, before P2 and P3 close.",
      "inputs": {
        "env": []
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
      "necessity": "The reserved-helper entry shape and the runtime subject change exported surface.",
      "inputs": {
        "env": []
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
      "necessity": "Provenance comes from the single exact pin; a second version authority must fail closed.",
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
      "necessity": "Plan and contract registration for this independent slice.",
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
      "necessity": "Owned document and source whitespace.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: Pi launch moves from a resolved bin plus inherited cwd to a release-derived launch description with a pre-spawn reverify on all three lanes. No existing test covers the keys final spawn or the pre-entry loader-injection surface; both need new negative controls with a load-bearing control case.
- New test case/file rationale, or why existing coverage is sufficient: the falsifier requires mutating interpreter, entry, argv, cwd and env between the outer check and the final spawn on each lane, which no current test performs.
- Selected check IDs and why their coverage is sufficient; omitted coverage: build, typecheck, test, api-surface, version-authority, workflow, whitespace are the repository's required checks and carry the negatives. The cold-install positive and the release-grade evidence chain are deliberately omitted here because this approval excludes real installation and publication; they run once against a frozen bundle and interpreter in a later slice.
- Full/expensive check justification and expected cost, if applicable: none beyond the standard required suite.
- Execution/baseline references, subject, current delta and disposition: base `4fe4ad6f`; delta is this worktree only.
- Residual risks and incomplete observations: probes p1-p6 are unproven at registration time and gate P1. Full bundle closure (§75) has not passed and is not claimed. The `piEntrypoint` and argv0 retirement is a record-shape change plus a `contract:729` supersession, presented to the Owner as information inside approval ④.

## Rollback Point

- Commit / checkpoint: `4fe4ad6f`
- Revert strategy: revert only task-owned files in this worktree; preserve every other worktree and all user WIP.

## Owner-approved measurement workspace slice (2026-09-16, handoff §86)

Owner approved `@byok-sdk/implementation-identity` / `packages/implementation-identity`: one Node-only measurement authority, aligned SDK train, keys and client packed exact same version; umbrella stays seven namespaces. Publication remains separately approved. Current execution base is `f25447d7` (P1 gate PASS), on rebased integration base `dca26ffc`; historical `4fe4ad6f` references above describe initial registration only.

Scope first: move measurement/parser/reverify/assert and pure types, fixed credential exclusion inventory and loader classification; keep client runtime launch business, allowlist/stripping actions and helper host. No reverse dependency, no copied validator. The only source package import edges newly allowed are client/keys to the new package. Manifests, workspace lock, build/API/release inventory and architecture descriptions may change only to register and validate this package. `scripts/api-surface/` and `scripts/release/` allowlists are limited to shared-package inventory, aligned version/packed-edge validation and their meaningful negative tests. Keys common tests are colocated `src/*.test.ts`; no production keys spawn wiring in this migration slice.

Independent migration acceptance: P1 three known failing guards retain exact ownership, their control stays green; client existing public identity names/shapes unchanged (re-export source changes only), new package golden added; actual dist-subpath-closure passes with shared external; fixed digest vectors preserve bytes; imports only node fs (including promises)/crypto/path; shared shipped code zero scanner-semantics findings under existing a1–a18 rules; packed client/keys exact-edge assertion and mismatched-version negative. Required checks retain known guard failures explicitly. P2 final spawn wiring is a separate subsequent slice.

Publication order: the shared package must be available before dependent client/keys in the aligned train; keys next publication couples once to this train, as with its core edge. Source workspace:* follows current convention; published ranges are disallowed. Total graph becomes ten aligned manifests and eleven public packages.
