# Plan: S7-c npm Release Candidate

> **Status**: Executing
> **Created**: 20260809-1153
> **Slug**: s7c-npm-release
> **Artifact Level**: work-package
> **Promotion Reason**: S7-a/S7-b 与 K4/K4.1 已合入；剩余 RC 阻塞是统一 public package identity、完整 SDK umbrella、可安装 tarball、跨平台 packageability、独立安全审查与 npm registry 发布/readback。发布是不可重复的外部状态变化，必须以独立 contract 绑定 exact artifacts。
> **Verification Boundary**: 全 workspace rename/build/typecheck/test；dependency-graph、exports/files/LICENSE/README、protocol golden、conformance/dataplane、macOS/Linux/Windows pack/install smoke；fresh tarball hashes；npm ownership/auth/version readback；registry fresh install；GitHub tag/release。
> **Rollback Surface**: 发布前可整体 revert；发布后 package version 不可覆盖，只能 deprecate/bump。不得发布 `@byok-sdk/*` compatibility packages，也不得把 `@byok-sdk/keys` 纳入 umbrella dependency graph。
> **Spec**: `docs/spec.md`
> **Research**: `docs/architecture/sdk-architecture.md`、`plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` §S7/§12
> **Task Contract**: `tasks/contracts/20260809-1153-s7c-npm-release.contract.md`
> **Task Review**: `tasks/reviews/20260809-1153-s7c-npm-release.review.md`
> **Implementation Notes**: `tasks/notes/20260809-1153-s7c-npm-release.notes.md`

## Agentic Routing

- Selected route: main-thread code/release execution + independent Codex exact-SHA acceptance；Claude review 按 owner 指令暂停，不调用。
- Routing reason: package identity rename 与 publish graph 是一个原子 release unit；分开会产生 registry 上不可安装的中间状态。
- Due diligence:
  - P1 map: monorepo 当前有六个 dispatch packages（core/protocol/client/server/cloud/cloud-postgres）、一个 private conformance package和独立 `@byok-sdk/keys`。源码/测试/CI 约 300 个文件仍引用未发布的 `@byok/*` identity；根 package `byok-sdk` 当前 `private: true`，registry `byok-sdk@0.0.1` 与 `@byok-sdk/keys@0.1.0` 均由 `ancienttwo` 维护，其余 `@byok-sdk/*` 尚未发布。authority 是各 package manifest、pnpm lock、package index exports、root LICENSE、CI packageability jobs 与 npm registry readback。
  - P2 trace: consumer `npm install byok-sdk` → umbrella manifest resolves exact `@byok-sdk/*@0.1.0` dependencies → namespace exports load each package `dist/index.js`/`.d.ts` → package internal imports resolve同一 public scope。发布顺序必须先叶节点再 umbrella；每个 tarball 先本地 pack/install，再 registry publish，再用 fresh temp project exact-version install/readback。keys 走独立安装路径，不穿过 umbrella。
  - P3 decision rationale: 一次性 cutover 到 `@byok-sdk/*`，不发布旧 scope shim；umbrella 用 namespace exports 避免跨 package symbol collision，同时确实交付完整 dispatch SDK。`@byok-sdk/keys` 保持独立以保存 secret-plane dependency/security boundary。所有 public packages 统一 `0.1.0`，因为 registry 尚无 dispatch package compatibility contract；root placeholder `0.0.1` 升为 `0.1.0`。

## Workflow Inventory

- Active plan: `plans/plan-20260809-1153-s7c-npm-release.md`
- Sprint contract: `tasks/contracts/20260809-1153-s7c-npm-release.contract.md`
- Sprint review: `tasks/reviews/20260809-1153-s7c-npm-release.review.md`
- Implementation notes: `tasks/notes/20260809-1153-s7c-npm-release.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`。
- Execution isolation: branch `codex/s7c-npm-release` in the current contract worktree；S7-b archived before activation。

## Approach

1. Rename all live code/test/CI/package identities `@byok/*` → `@byok-sdk/*` and set six dispatch packages to `0.1.0`。
2. Add public `packages/sdk` as `byok-sdk@0.1.0` with typed namespace exports for core/protocol/client/server/cloud/cloudPostgres；do not depend on or export keys。
3. Complete README/LICENSE/files/publishConfig/repository metadata for every public package and root changelog covering hosted vs self-hosted semantics。
4. Add executable dependency-graph/package-metadata/pack-install invariants and extend CI packageability across Node 20/22 and macOS/Linux/Windows。
5. Freeze tarballs and hashes，run full RC gates and independent Codex exact-SHA audit，merge，then web-auth npm publish in dependency order；finish with registry metadata + fresh exact installs + tag/release readback。

## Detailed Design

### File Changes

| File | Action | Description |
| --- | --- | --- |
| `packages/{core,protocol,client,server,cloud,cloud-postgres}/**` | Modify | public identity cutover、metadata、docs and internal imports |
| `packages/sdk/**` | Add | `byok-sdk` umbrella package with namespace exports and smoke tests |
| `packages/keys/**` | Verify/Modify metadata only | preserve isolated graph；no umbrella edge |
| `scripts/release/**` | Add | deterministic graph/metadata/pack/install/registry readback checks |
| `.github/workflows/ci.yml` | Modify | RC package matrix and symbol/package checks |
| `package.json` / `pnpm-lock.yaml` | Modify | workspace scripts and exact release graph |
| `README.md` / `CHANGELOG.md` / package docs | Add/Modify | install/use/release semantics and hosted/self-hosted differences |
| architecture/sprint/plan/contract/notes/review | Modify | S7 closeout and exact release evidence |

### Data Flow

`source imports + manifests` → workspace build → per-package `npm pack` → tarball inventory/hash → isolated Node 20/22 install/import → independent audit → merge/tag → npm web auth → leaf-to-root publish → registry metadata → fresh exact install/import。

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| umbrella publishes missing/transitive files | Medium | High | tarball inventory + isolated install/import from exact tarballs |
| old/new scope mixed | Medium | High | repo-wide live-surface zero-match gate；no compatibility package |
| keys enters dispatch graph | Low | Critical | graph traversal invariant from umbrella and every dispatch package |
| partial registry publish | Medium | High | topological order、preflight all versions/ownership、frozen tarball SHA-256 + registry-compatible SHA-512 integrity、readback each publish before next |
| npm auth/2FA blocks | Medium | Medium | web auth only at final publish boundary；no token logging；do not claim completion before registry readback |
| publish artifact differs from reviewed SHA | Low | Critical | pack after code freeze；manifest records source Git SHA and exact tarball digests；registry `dist.integrity` must equal each frozen SHA-512 integrity；tag exact merged tree |

## Promotion Gate

- **Merge/PR unit**: one S7-c PR containing identity cutover、umbrella、release tooling/docs and RC evidence projection。
- **Rollback surface**: pre-publish PR revert；post-publish only new version/deprecation, never overwrite。
- **Verification boundary**: full hard-env workspace gates、RC invariants、cross-platform CI、exact tarball installs、independent Codex audit、registry readback。
- **Review/acceptance boundary**: zero HIGH/MEDIUM exact-SHA findings；Claude paused/not invoked。
- **High-risk surface**: package identity、dependency security boundary、immutable registry writes。
- **Why not checklist row**: one typo or publish-order error creates permanent public registry state and broken consumers。

## Evidence Contract

- **State/progress path**: plan Task Breakdown、contract、notes、review、sprint S7/§12 checkboxes。
- **Verification evidence**: dependency graph JSON、source Git SHA、tarball inventory/SHA-256/SHA-512 integrity、Node 20/22 install imports、CI checks、npm `dist.integrity` equality + fresh install、Git tag/release。
- **Evaluator rubric**: no live `@byok-sdk/*` identity；all dispatch packages and umbrella are public `0.1.0`；umbrella includes all six dispatch namespaces and no keys edge；fresh exact registry installs work；tag matches merged release tree。
- **Stop condition**: auth/ownership/version mismatch、tarball drift、graph violation、any hard gate/CI/review failure，或需要发布 compatibility shim。
- **Rollback surface**: preserve evidence；pre-publish revert，post-publish bump/deprecate only。

## Task Breakdown

- [x] Cut over live package identities to `@byok-sdk/*` and add complete public metadata/docs。
- [x] Add `byok-sdk@0.1.0` umbrella with all dispatch namespaces and an executable no-keys graph invariant。
- [x] Add deterministic pack/install/registry tooling、changelog and cross-platform RC CI。
- [x] Run hard-env full gates、S7.4/§12 audits and independent Codex exact-SHA acceptance；merge and read back `main`。
- [x] Authenticate through npm web auth，publish exact frozen tarballs in dependency order，verify fresh installs，create/read back release tag and GitHub release。
