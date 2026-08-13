# Plan: Prepared Runtime Operation Manifest

> **Status**: Completed
> **Created**: 20260814-0007
> **Slug**: prepared-runtime-operation-manifest
> **Planning Source**: waza-think
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Prepared runtime operation manifest + pre-claim admission cut
> **Artifact Level**: work-package
> **Execution Mode**: contract-worktree
> **Promotion Reason**: Current TaskRunner admission reads adapter capabilities more than once, evaluates environment requirements after claim, and lets adapter-specific permanent rejections occur after claim; the public RuntimeAdapter cut spans all three bundled adapters and every custom-adapter test fake, so it is an independently reviewable breaking merge unit.
> **Verification Boundary**: Run client typecheck/test/build, adapter built-entry smoke, workspace typecheck/test/build, release package-graph check, and strict contract/workflow verification; negative tests must prove zero claim/start/spawn/workspace side effects before admission.
> **Rollback Surface**: Revert the single 0.4.0 RuntimeAdapter contract commit and its coordinated client/sdk manifest, release-script, docs, adapter, daemon, fixture, and test changes; do not retain an old/new dual adapter path.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md`
> **Task Review**: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md`
> **Implementation Notes**: `tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Prepared runtime operation manifest + pre-claim admission cut
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260814-0007-prepared-runtime-operation-manifest.md`
- Sprint contract: `tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md`
- Sprint review: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md`
- Implementation notes: `tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260814-0007-prepared-runtime-operation-manifest.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260814-0007-prepared-runtime-operation-manifest.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md`
- Review file: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md`
- Implementation notes file: `tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260814-0007-prepared-runtime-operation-manifest.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the single 0.4.0 RuntimeAdapter contract commit and its coordinated client/sdk manifest, release-script, docs, adapter, daemon, fixture, and test changes; do not retain an old/new dual adapter path.
- **Verification boundary**: Run client typecheck/test/build, adapter built-entry smoke, workspace typecheck/test/build, release package-graph check, and strict contract/workflow verification; negative tests must prove zero claim/start/spawn/workspace side effects before admission.
- **Review/acceptance boundary**: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Current TaskRunner admission reads adapter capabilities more than once, evaluates environment requirements after claim, and lets adapter-specific permanent rejections occur after claim; the public RuntimeAdapter cut spans all three bundled adapters and every custom-adapter test fake, so it is an independently reviewable breaking merge unit.

## Evidence Contract

- **State/progress path**: `plans/plan-20260814-0007-prepared-runtime-operation-manifest.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md`, `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md`, and `tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the single 0.4.0 RuntimeAdapter contract commit and its coordinated client/sdk manifest, release-script, docs, adapter, daemon, fixture, and test changes; do not retain an old/new dual adapter path.

## Captured Planning Output

## Recommendation

Make one explicit pre-1.0 breaking cut on the frozen 0.3.0 release base: replace the callable `id`/`capabilities()`/optional `environmentRequirements()`/`supportsDispatchSelection` plus direct `start()` surface with a frozen descriptor and a side-effect-free per-offer preparation step that returns one prepared operation. TaskRunner then seals one immutable operation manifest and uses it for admission, claim, environment construction, and spawn. Do not keep an optional prepare hook or a legacy direct-start fallback.

This is the minimum coherent extraction from DeepSeek Harness. It fixes three observed duplicate-authority paths in byok-sdk without importing a plugin loader, LLM registry, event store, or provider wire.

## P1: Architecture Map

- Public boundary: `packages/client/src/types.ts` exports `RuntimeAdapter`, `RuntimeCapabilities`, `RuntimeEnvironmentRequirements`, `TaskContext`, and `Session`; `packages/client/src/index.ts` and `packages/client/src/adapters/index.ts` re-export the adapter surface.
- Admission owner: `packages/client/src/daemon/task-runner.ts`. `pickAdapter()` uses adapter id/capabilities/presence, `handleOffer()` computes policy, acquires workspace ownership, emits claim, builds environment/context, calls `start()`, publishes task.started, then registers the active task.
- Discovery owner: `packages/client/src/daemon/create-daemon.ts` and `packages/client/src/bin/runtime-probe.ts` independently read adapter id/capabilities/detect results for conn.hello, device flags, status, and diagnostics.
- Provider-specific owners: Pi, Claude, and Codex adapters validate instruction shape, effective policy, lane/runtime/model, launcher availability, session identity, command arguments, and credential stripping inside their own start paths.
- Verification owners: adapter unit tests, `task-runner-environment.test.ts`, daemon capability tests, custom `StubRuntimeAdapter`, `packages/client/scripts/adapter-task-smoke.mjs`, release package-graph scripts, and the workspace required checks.
- Strong dependencies: protocol `TaskOfferPayload`/`RuntimeCapabilities` wire shapes remain unchanged; Pi remains provider/model/transport/loop authority.
- Explicitly out of scope: `packages/protocol` schema/golden changes, new runtime ids, event/receipt redesign, process-tree quiescence implementation, and the control-endpoint/daemon-owner ordering owned by the separate shutdown worktree.

## P2: Concrete Trace and Pressure Point

Current explicit-runtime offer path:

1. TaskRunner checks the raw offer and resolves toolsets.
2. `pickAdapter()` reads `adapter.id`, calls `adapter.capabilities()` for policy/toolset gating, and calls `adapter.detect()`.
3. TaskRunner computes effective policy and may acquire a Git workspace lease.
4. TaskRunner emits `task.claim`; it calls `pick.adapter.capabilities()` again for the claim snapshot.
5. After claim, TaskRunner calls `pick.adapter.environmentRequirements?.()` and builds the task environment.
6. Adapter `start()` revalidates instruction, policy, lane/runtime/model, and local launcher requirements; it can reject permanently only now, after claim and workspace work.
7. On start error, TaskRunner treats only `PolicyUnsupportedError` as non-retryable; all other errors become retryable.

Observed falsifiers of the current shape:

- A custom adapter whose second capabilities call returns a different value can be selected under one truth and claimed under another.
- Pi advertises dispatch-selection support even when the selected BYOK lane has no custody launcher; the permanent rejection occurs after claim.
- `environmentRequirements()` can throw or change after claim; the environment used for spawn is not bound to the capability truth sent in claim.
- Adapter-specific validation is duplicated across three start paths, so TaskRunner cannot prove semantic admission completed before resource publication.

Target path:

1. Compute effective policy and resolve local toolset metadata without side effects.
2. Read one frozen adapter descriptor for the candidate; use the same descriptor for capability gating and discovery projection.
3. Run adapter preparation before claim, workspace mutation, temp-file creation, session-id allocation, or runtime spawn. Expected unsupported/unavailable outcomes are explicit admission decisions, not message-parsed exceptions.
4. Resolve the authoritative session/workspace mapping, acquire the lease, build the filtered environment, and seal one immutable operation manifest. The manifest contains runtime/lane/provider/model, descriptor capabilities, selected toolset ids, effective policy, requested authoritative session, workspace/lease identity, and forwarded environment variable names; it never contains credential values.
5. Emit claim from the manifest, then resolve instruction bytes and prepare the workspace.
6. Start only through the prepared operation. It may consume resolved instruction/workspace/env/local approval handles but may not recompute semantic selection or capabilities.
7. Publish task.started and the active Session only after start succeeds.

## P3: Decision Rationale

### Chosen contract

- A required immutable adapter descriptor replaces repeated methods for id, capabilities, environment requirements, and dispatch-selection support. Descriptor values are deep-frozen at the SDK boundary and are safe to reuse across discovery and one offer.
- A required side-effect-free preparation method validates the raw instruction shape, effective permission policy, dispatch lane/runtime/provider/model, local launcher/config availability, session intent, and toolset support. It returns either an explicit admission rejection or a prepared operation.
- The prepared operation owns provider-specific pinned command/argument/model/selection decisions but owns no process, temp directory, workspace mutation, or session id before start.
- TaskRunner owns the final operation manifest because it alone knows the task id, authoritative session/workspace record, filtered environment, workspace lease, and claim fields. The adapter-provided prepared operation and TaskRunner manifest are bound once before claim.
- The manifest is immutable in memory and safe metadata only. Credential values remain in the filtered start environment and are neither logged nor serialized into the manifest.
- Existing protocol task claim and runtime capability wire shapes remain byte-compatible; this is a public TypeScript API break, not a protocol-v1 break.
- All workspace packages and release scripts move from 0.3.0 to 0.4.0 together after 0.3.0 is published. No publish occurs in this work package; the final Sprint row owns release evidence.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Add optional `prepare()` and fall back to `start()` | Creates permanent old/new semantic paths and lets custom adapters bypass the invariant. |
| Snapshot only `capabilities()` inside TaskRunner | Fixes one repeated read but leaves late provider/model/launcher rejection and environment drift after claim. |
| Cache descriptor once for the daemon lifetime | Makes live config changes ambiguous and does not bind one offer's selection/workspace/session; per-offer snapshot is the needed authority. |
| Move all provider validation into TaskRunner | Recreates a second provider/model registry and violates Pi/vendor ownership. |
| Add a generic plugin/service container | No same-process HMR/plugin consumer exists; it adds authority rather than removing it. |
| Combine failure taxonomy and process-tree disposal in this cut | Both depend on the prepared-operation boundary but have distinct failure/rollback surfaces; combining them makes a public API migration inseparable from OS lifecycle changes. |

## File and Ownership Plan

| Surface | Change |
|---|---|
| `packages/client/src/types.ts` | Define the frozen descriptor, preparation input/decision, prepared operation, safe manifest, and start input; replace the old adapter surface in one cut. |
| `packages/client/src/index.ts`, `packages/client/src/adapters/index.ts` | Export only the new public contract; no legacy aliases. |
| `packages/client/src/daemon/task-runner.ts` | Reorder pure policy/toolset checks and prepare before claim; seal/reuse manifest; keep workspace/process publication ordering explicit. |
| `packages/client/src/daemon/create-daemon.ts`, `packages/client/src/bin/runtime-probe.ts`, diagnostics | Read descriptor authority rather than recomputing capabilities. |
| Pi/Claude/Codex adapter modules | Move static semantic validation/pinning into prepare; start consumes only the prepared decision plus runtime resources. |
| Client test fixtures and adapter/task-runner/diagnostic tests | Atomically migrate every RuntimeAdapter implementation and add drift/zero-side-effect guards. |
| `packages/client/scripts/adapter-task-smoke.mjs` | Add pre-spawn negative admission scenarios through the built package and real server; quiescent process-tree assertions stay for Sprint Row 3. |
| Dispatch package manifests, `pnpm-lock.yaml`, release scripts, changelog | Move aligned dispatch train to 0.4.0 and document the one-shot custom-adapter migration; keys remains on its independent version. |
| `docs/spec.md`, `docs/security.md`, `docs/architecture/sdk-architecture.md` | Record operation authority, pre-claim purity, credential-free manifest, and no-fallback migration boundary. |

Concurrent write ownership is prohibited for this row: the public type cut, TaskRunner migration, and three adapter migrations share compile-time contracts and must be handled by one implementation worker. Read-only review may run separately after code freeze.

## Test and Verification Design

- Compile-time contract fixture: an adapter with the old direct-start surface fails typecheck; all shipped/test adapters implement descriptor + prepare + prepared start.
- Descriptor drift test: a deliberately mutable source object is changed after preparation; claim, environment names, and start still observe the frozen original snapshot.
- Call-count/authority test: policy gate and claim are asserted against the same descriptor instance; no second capability authority exists.
- Zero-side-effect admission matrix: unsupported instruction shape, permission mode, lane/runtime/model, missing Pi custody launcher, unavailable required toolsets, and rejected session intent each produce decline before claim/start/workspace/temp/spawn.
- Environment test: only names from the manifest descriptor plus local allowlist reach the filtered start environment; `BYOK_*` remains hard-denied and credential values never appear in manifest/log output.
- Positive matrix: Pi BYOK, Claude subscription, and Codex subscription selections reach start with exactly the pinned model/provider/lane and unchanged wire claim shape.
- Built-entry smoke: built client + real server proves at least one permanent rejection is pre-spawn and a valid task still completes for all three adapters.
- Required commands: client typecheck/test/build, client adapter smoke, workspace typecheck/test/build, release package graph, strict workflow check, and strict contract verification.

## Rollout and Rollback

- Release-base evidence (verified 2026-08-14): `v0.3.0^{}` = `a119b5cf4247278a456c285cbc6470d8e3b9815c`; current main `8c855586ab681537fea574074ab1f72a72f82b72` descends from it; npm readback reports `@byok-sdk/client@0.3.0` integrity `sha512-+ygEczMOvcbboTZXn1fuWsafMTB56bBTalC1746wlEdPr6NOztfsRJNv488iABicaas4hC9v17I1bZ6nbh/ZJQ==` and `byok-sdk@0.3.0` integrity `sha512-seiSmlmvlu1LyyfDu0bC7Dv8DuysGLAi5wmrRQtCSlosBlty1hA0h3s8/IgzVLYUKrvh2n6Ggo13H8Xm/H9E2A==`.
- Gate: the release prerequisite is satisfied. After design approval, the contract worktree must start from a commit descending from `v0.3.0^{}`; do not rebase it across a different public-release authority.
- Rollout: land as the first 0.4.0 Sprint commit with a migration note for custom adapter authors. Subsequent rows consume only the new surface.
- Rollback: revert the whole row. Do not restore direct start alongside prepared operations, add overloads, or accept both descriptor shapes.
- Failure at 10x: custom adapters that allocate resources during prepare would produce the first leaks. Tests therefore instrument spawn, temp/workspace writes, and session publication, not merely returned values.

## Approval Boundary

This plan stays Draft. Approval means accepting: the 0.4.0 breaking API cut, the descriptor/prepare/prepared-operation ownership split, the exact non-goals, and the release dependency. Approval does not authorize Rows 2-3 or npm publication.

## Task Breakdown

- [x] Freeze the 0.3.0 release commit/publication evidence and record it as this plan's base prerequisite (`v0.3.0^{}` = `a119b5cf4247278a456c285cbc6470d8e3b9815c`; npm client/umbrella 0.3.0 readback verified 2026-08-14).
- [x] Cut the public RuntimeAdapter types to descriptor + prepare + prepared operation, with no legacy path.
- [x] Reorder TaskRunner admission and seal one credential-free immutable operation manifest before claim.
- [x] Migrate Pi, Claude, and Codex validation/start paths without moving provider/model authority into TaskRunner.
- [x] Migrate discovery, diagnostics, exports, every test fake, and all compile-time consumers.
- [x] Add zero-side-effect rejection, snapshot drift, environment secrecy, claim/start consistency, and positive adapter tests.
- [x] Extend the built-entry adapter smoke with a pre-spawn rejection scenario.
- [x] Move the aligned dispatch release train metadata to 0.4.0 and add the custom-adapter migration note; do not publish.
- [x] Update spec/security/architecture truth and run the complete verification boundary.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze the 0.3.0 release commit/publication evidence and record it as this plan's base prerequisite (`v0.3.0^{}` = `a119b5cf4247278a456c285cbc6470d8e3b9815c`; npm client/umbrella 0.3.0 readback verified 2026-08-14).
- [x] Cut the public RuntimeAdapter types to descriptor + prepare + prepared operation, with no legacy path.
- [x] Reorder TaskRunner admission and seal one credential-free immutable operation manifest before claim.
- [x] Migrate Pi, Claude, and Codex validation/start paths without moving provider/model authority into TaskRunner.
- [x] Migrate discovery, diagnostics, exports, every test fake, and all compile-time consumers.
- [x] Add zero-side-effect rejection, snapshot drift, environment secrecy, claim/start consistency, and positive adapter tests.
- [x] Extend the built-entry adapter smoke with a pre-spawn rejection scenario.
- [x] Move the aligned dispatch release train metadata to 0.4.0 and add the custom-adapter migration note; do not publish.
- [x] Update spec/security/architecture truth and run the complete verification boundary.
