# Plan: Pi FFF local search integration

> **Status**: Executing
> **Created**: 20261001-1237
> **Slug**: pi-fff-local-search
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Own pinned native search runtime admission and installed tool authorization
> **Verification Boundary**: ordinary Pi RPC search, policy, lifecycle and packed native installation
> **Rollback Surface**: isolated FFF dependency factory policy build tests documentation diff
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261001-1237-pi-fff-local-search.contract.md`
> **Task Review**: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md`
> **Implementation Notes**: `tasks/notes/20261001-1237-pi-fff-local-search.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261001-1237-pi-fff-local-search.md`
- Sprint contract: `tasks/contracts/20261001-1237-pi-fff-local-search.contract.md`
- Sprint review: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md`
- Implementation notes: `tasks/notes/20261001-1237-pi-fff-local-search.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261001-1237-pi-fff-local-search.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261001-1237-pi-fff-local-search.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261001-1237-pi-fff-local-search.md`.

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
- Contract file: `tasks/contracts/20261001-1237-pi-fff-local-search.contract.md`
- Review file: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md`
- Implementation notes file: `tasks/notes/20261001-1237-pi-fff-local-search.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261001-1237-pi-fff-local-search.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261001-1237-pi-fff-local-search.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: isolated FFF dependency factory policy build tests documentation diff
- **Verification boundary**: ordinary Pi RPC search, policy, lifecycle and packed native installation
- **Review/acceptance boundary**: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Own pinned native search runtime admission and installed tool authorization

## Evidence Contract

- **State/progress path**: `plans/plan-20261001-1237-pi-fff-local-search.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261001-1237-pi-fff-local-search.contract.md`, `tasks/reviews/20261001-1237-pi-fff-local-search.review.md`, and `tasks/notes/20261001-1237-pi-fff-local-search.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261001-1237-pi-fff-local-search.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: isolated FFF dependency factory policy build tests documentation diff

## Captured Planning Output

## Why

FFF should strengthen the SDK agent's local file-name and content search through SDK-owned tools, without turning user-installed Pi packages or global configuration into runtime authority. Adopt a pinned extension inside the ordinary Pi RPC host. Preserve the existing tool authorization and installed implementation-identity boundaries.

## Goal

Integrate @ff-labs/pi-fff@0.11.0 into @byok-sdk/client ordinary Pi RPC sessions, with tools-only behavior and real local search evidence, after proving compatibility with Pi 0.99.2. Deliver a reviewable isolated implementation and clean-install verification. Publication and deployment are separate actions.

## P1: Architecture Map

- Owner: packages/client; matched capability sdk-sdk-root, architecture module docs/architecture/modules/sdk/sdk-root.md. Existing packages umbrella is sufficient for this integration; do not create a capability merely for a dependency.
- Input authority: task PermissionPolicy and authorized cwd passed by PiAdapter to bound Pi RPC config. Runtime assembly lives in src/bin/pi-rpc-host.ts and pi-session-runtime.ts; static extension source boundary is pi-extension-factories.js/.d.ts.
- Build boundaries: tsup.config.ts and tsup.sealed.config.ts; native bindings remain runtime packages, TS extension source is bundled. package.json and bun.lock hold dependency pins.
- Implementation identity and distribution have different boundaries: ordinary FFF native packages are installed dependencies, not automatically attested by implementation-identity. Verify clean-install dependency/native readback; do not expand Prepared/compiler identity in this slice.
- Prepared sessions own a counted tool surface and byte-verified request; FFF admission into that lane is deferred. Codex/Claude adapters and public protocol remain outside scope.

## P2: Concrete Trace

Task policy/cwd -> PiAdapter admission -> bound RPC launch config -> runPiRpcHost -> runPiSessionRuntime -> createAgentSessionServices(resourceLoaderOptions) -> explicit extensionFactories -> AgentSession tool registry -> model tool call -> FFF native finder over the authorized workspace -> local result. The host uses noExtensions:true; personal pi install state is not the loader authority.

Pressure points: upstream registers tool names early and calls setActiveTools at session_start/before_agent_start; it reads global pi-fff config and can restore session mode. It initializes native search, databases and auxiliary path indexes and destroys them at session_shutdown. Verify each crossed boundary instead of assuming that adding a factory preserves policy or lifecycle.

## P3: Decision and Falsifier

- [ASSUMED] tools-only with independent fffind/ffgrep names is the first integration target, following the discussed recommendation. Do not replace builtin find/grep schemas or semantics.
- Ordinary auto/default sessions gain the FFF search tools. Explicit allow/deny and readonly continue to be authoritative; preserve the existing readonly tool names for this initial slice. Do not append search grants to an empty allowlist. If readonly is to expose the new search names, update the one authoritative policy mapping with tests rather than bypassing it inside the extension.
- SDK fixes the mode and owns configuration/data paths. User flags, global JSON or restored mode must not change the admitted tool names. Choose the smallest coherent wrapper supported by public Pi APIs; if upstream cannot meet that boundary without a fork, stop with evidence before production edits.
- At 10x concurrent sessions, scan duplication and native database contention fail before search CPU. Probe two concurrent sessions and deterministic cleanup; avoid an unmeasured shared indexing service.
- Options: personal pi install is unsuitable for SDK delivery; direct factory registration is small but insufficient without policy/config proof; a bounded SDK-owned factory with pinned upstream is the chosen hypothesis.
- Falsifier: real 0.99.1 session cannot register/execute the released extension, or FFF reactivates denied tools/changes frozen mode, or native packages cannot be resolved/read back in a clean installed client. Cheapest proof: disposable exact-version session plus real find/grep, empty allowlist and deny cases before source changes.
- [UNKNOWN] exact native closure inventory, peer-schema compatibility, concurrent LMDB behavior and final public API wrapper feasibility; WP1/WP2 resolve these before WP3.

## Scope

- In scope: exact dependency/peer pins, static extension bundling, ordinary RPC owned FFF factory, policy mapping when necessary, native installation readback, lifecycle/config isolation, tests and release-pack smoke, relevant spec/architecture prose.
- Out of scope: Prepared FFF admission, builtin override, public protocol changes, external package-manager plugin registry, provider-registry singleton remediation, performance promises, release/version bump, npm publish, merge/deploy, unrelated architecture coverage/dead-letter repair.

## Task Breakdown

- [x] WP1 — runtime proof owner: fff_probe_worker (custom deep-worker). Disposable /tmp package only; no repo implementation edits. Load real pi-fff 0.11.0 with Pi 0.99.1; exercise real file/content search, session disposal, peer compatibility, two-session database behavior and supported native load; Node minimum-version acceptance remains required. Return commands, exit codes, fixture results and exact limitations.
- [x] WP2 — policy/identity trace owner: fff_policy_explorer (custom explorer). Read-only repo and exact npm artifacts. Trace allow/deny/readonly/zero-tool enforcement and native dependency identity, inspect shared sealed/Prepared build exposure. Produce concrete file ownership and acceptance matrix.
- [x] WP3 — implementation/feasibility owner: fff_integration_worker, dispatched after preliminary WP1/WP2 readback; no production edits until config-authority proof resolves the falsifier. Own packages/client/package.json, bun.lock, packages/client/tsup*.config.ts, pi-extension-factories.js/.d.ts, new owned factory, pi-rpc-host.ts and necessary permission mapping; implementation-identity source is excluded. Use the contract worktree; do not edit sibling adapters or Prepared tool surface. Produce real integration and policy/lifecycle tests.
- [x] WP4 — acceptance owner: independent custom gatekeeper after WP3. Review final diff and run/review required commands plus clean packed install with actual native search; no editing or shipping. Parent owns fixes, plan status and final acceptance.

- [x] WP5 — Pi 0.99.2 composition acceptance: inherited 23-file upgrade baseline + FFF, client scoped Node 22 probes, root required checks and isolated packed consumer readback; parent owns baseline/workflow, worker owns FFF tests, independent gatekeeper owns final review. No inherited upgrade source is rewritten by workers.

## Workflow Inventory

- Active plan: this captured FFF work-package; execution lives only in its Task Breakdown.
- Contract/review/notes: tasks/contracts/<captured-stem>.contract.md, tasks/reviews/<captured-stem>.review.md, tasks/notes/<captured-stem>.notes.md.
- Deferred-goal ledger: tasks/todos.md; record only Prepared FFF support as a deferred goal with its admission trigger.
- Checks: .ai/harness/checks/latest.json; runs: .ai/harness/runs/.
- Allowed-path owner: parent freezes the contract before WP3; workers have disjoint responsibilities and must not revert another worker's edits.
- Isolation: plan-to-todo / contract-worktree creates an isolated codex FFF worktree from the observed clean main 708ed45b275d7d0cceeb6b61eb392c7d7b4efed9. No production edits on primary checkout. Current canonical resolver reports idle, no authoritative plan; stale tasks/current.md is recovery only.
- Next workflow action: repo-harness-check after contract preflight and again at implementation acceptance.

## Verification

Real fixture acceptance: create a small Git repo with known files, exact unique content and a typo-compatible filename query; verify actual FFF results without model credentials. Cover all-tools/default, explicit FFF allow, denied search, empty allow, readonly, resumed session mode, startup failure, disposal and concurrent sessions. No mocked native finder as the only acceptance proof.

Run build, typecheck, test, check:api-surface, check:version-authority, repo-harness run check-task-workflow --strict, git diff --check and check:release-pack on the implementation candidate. Preserve per-command exit codes. Use a fresh short TMPDIR for required tests as mandated by the observed deferred test infrastructure issue. Record baseline failures separately; do not weaken checks or fabricate pass results. Clean npm install must resolve native artifacts and actual search inside installed client; source-tree execution alone does not prove delivery. Platform claims are limited to tested OS/architecture; untested target platforms remain explicitly unverified.

## Evidence Contract

- State/progress path: this plan Task Breakdown and matching tasks/notes file, linked to worker results.
- Verification evidence: exact npm versions, immutable base SHA, command exit codes, real fixture output, policy negative cases, install/native readback and final diff-bound acceptance.
- Evaluator rubric: search tools work locally and obey policy/config authority, disposal releases resources, native package readback is complete and its attestation limit is explicit, required checks pass.
- Stop condition: incompatible public API/schema, widened authorization, unowned config authority, native identity gap or required command failure; record evidence and do not promote the failing slice.
- Rollback surface: revert only the isolated FFF dependency/factory/policy/build/test/docs change; temporary proof directories are disposable and user Pi state is untouched.

## Promotion Gate

- Merge/PR unit: one ordinary Pi RPC FFF integration candidate after evidence gates; no automatic merge or publish.
- Rollback surface: isolated FFF worktree diff and dependency lock delta.
- Verification boundary: ordinary RPC real search, tool policy, lifecycle, installation/native closure and root required checks.
- Review/acceptance boundary: independent final-subject gatekeeper; approval of this plan does not mark implementation accepted.
- High-risk surface: model-visible tool authorization, session resource/config authority and executable native dependency closure.
- Why not checklist row: no active implementation plan exists, and this dependency creates its own runtime/installation acceptance and rollback surface.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## WP1/WP2 Preliminary Readback

WP1 isolated real npm install and TS bundle succeeded; Node macOS arm64 real grep/find, ignored-file negative case, empty/deny registry and explicit shutdown/reopen passed. Upstream strict source typecheck against Pi 0.99.1 reports optional-string errors; bundling runtime success is not a source typecheck claim. Two-session proof pending. WP2 confirms Pi registry filters apply to extension tools even after setActiveTools. Ordinary native dependencies are not automatically attested by SDK identity; keep native install readback explicit and exclude identity/compiler edits. SDK-fixed configuration and restored-mode control still require a public-API feasibility proof before WP3 production edits.

## Dispatch Status

WP1 /root/fff_probe_worker is completing real concurrent/native proof. WP2 /root/fff_policy_explorer completed read-only trace; final evidence is tasks/notes/pi-fff/wp2-policy-identity.md. WP3 /root/fff_integration_worker has been dispatched to produce a public-API configuration/resume-mode feasibility note only before production changes; its ownership is tasks/notes/pi-fff/wp3-feasibility.md plus disposable probes. WP4 is sequenced after implementation and is not running. Existing native filesystem access is not a sandbox; compare FFF outside-workspace behavior to that existing contract rather than inventing confinement claims.

WP1 follow-up: shared DB two-session probe exit 0; raw restored override demonstrably supersedes tools-only. Default two tools; multi-grep requires PI_FFF_MULTIGREP=1. Bundling is required because direct Node node_modules TS import fails. Node 26/macOS arm64 proof does not replace Node 22.22 minimum-version acceptance.

## Implementation Authorization

On 2026-10-01 the user explicitly approved continuation. Parent read back WP1/WP2 and WP3 public-API feasibility and authorized the bounded facade, synchronous documented env redirection with exact finally restore, filtered FFF-only history view and independent ephemeral databases. WP3 implementation is running in the isolated worktree; WP4 distribution worker owns scripts/release/pack-and-smoke.mjs and its note, and must wait for WP3 build completion before running aggregate packaging. Final independent gatekeeper follows the frozen candidate. Ephemeral databases deliberately do not retain cross-session frecency/history.

## Historical 0.99.1 delivery state (superseded)

FFF ordinary RPC implementation and scoped acceptance are complete. Whole repository required build/typecheck/test/API/version/strict-workflow commands and diff-check returned exit 0 on stable snapshot 6beed8152d839b1f9263145519e6699f3bc716ed. Installed Node 22.22/macOS arm64 FFF native readback, fixed TUI 0.99.1 bundle provenance, real find/grep/ignored-file control and shutdown all passed. Full release-pack remains exit 1 at the existing Pi launcher telemetry identity gate; unchanged 708ed45 main fails at the same gate and already installs mixed Pi family versions. Independent gatekeeper overall verdict is BLOCKED; no merge/publication or final typed acceptance claim. Architecture projection also awaits ready CodeGraph proof.

Next bounded work-package: restore clean consumer official Pi 0.99.1 closure while retaining the existing transitive-only, identity, native purity and SEA boundaries. Do not add native peers or official direct siblings merely to bypass scanners; P3 review confirmed current identity contract forbids that shortcut. Entry: scripts/release/pi-runtime-identity.mjs and bun run check:release-pack. FFF acceptance resumes after that gate is green.

## Current authoritative baseline: Pi 0.99.2

User correction and continuation supersede the old 0.99.1 closure-repair recommendation above. The primary uncommitted pi-0.99.2-context-usage upgrade is the source for 23 version/provenance/fixture/doc files; its original files are untouched. FFF factory/host/build/smoke changes are composed through three-way merge, with lock regenerated against the 0.99.2 source. Exclude OAR research and unimplemented context-usage plans. Import manifest: /tmp/byok-fff-0992-baseline-import.json; exact closureDigest 8d614f74c775cab980f72bfce88de75583ad43e69d870df0134f3dbd7b622124, upstream 005af57d88ee23b33778f343a9595b32e67ff788. SDK release version stays 0.24.0-rc.1; Prepared compiler stays 4.

- Current map: same client ordinary RPC factory and native dependencies; inherited official Pi closure is now 0.99.2.
- Current trace: version pin -> official closure/export/vendor inventory -> build/real session -> FFF tool registry/search -> drain/shutdown -> packed npm consumer verification.
- Decision: keep the public facade unchanged because runner/session-manager/runtime-dispose APIs are identical; re-prove rather than reuse 0.99.1 compatibility/install outcomes.
- Current execution: scoped 0.99.2 build/native tests, then freeze exact composed source and execute root required checks + clean installed release-pack; independent final review follows. Old blockers are historical until reproduced on 0.99.2.

## Pi 0.99.2 final functional acceptance

Frozen composed source 9f9d69cd31b50622b7f62db0d8f13c4dabb1fd6f: all eight canonical checks passed with snapshot stable, including six root required checks, clean installed release-pack and diff-check. Independent gatekeeper returned PASS after full 45-file review. Installed FFF native/TUI0.99.2/search/cleanup and existing all-installed official Pi version/integrity/file-set assertions passed without weakening. The old0.99.1 telemetry failure is superseded and must not drive a downgrade or closure-repair recommendation.

Formal workflow state remains Review: architecture acceptance still has one unresolved CodeGraph-proof candidate and no final typed AcceptanceReceipt. No CodeGraph index, public commit, merge, publish or deploy is performed. Next bounded slice is the architecture proof/receipt closeout, not Pi version repair.

## Approved architecture/typed closeout

User approved on2026-10-01. CodeGraph init indexed1155files/33607nodes/106349edges, projection applied and proof-only signal407cba56... reconciled. The current contract uses eight immutable0992 baselines and exact currentcloseout-only delta checks. Complete metadata before final receipt and do not mutateproduction or baseline executables.

## Formal closeout result

CodeGraph proof is ready; architecture pending/running/dead-letter/human-action/blocking counts are zero and old candidate is reconciled. Prepared canonical evidence accepts eight immutable0992 executions plus four currentcloseout deltas. Independent Codex review passes the exact normalizedsubject756c2314...; authority-issued external_pass receipt is verified and verify-sprint finalizes without rerunning fullverification. This supersedes all historical CodeGraph/typedreceipt pendingnotes above. Local commits only; publication and merge remain separate useractions.
