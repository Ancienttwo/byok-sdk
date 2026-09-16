# Plan: C07 SDK Pi runtime launch and provenance contract

> **Status**: Draft
> **Created**: 20260916-1003
> **Slug**: c07-pi-runtime-launch
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: /Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md §77 §78
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved conditional O1 and named this SDK contract the first slice, covering all three final Pi spawn consumers
> **Verification Boundary**: Probe evidence plus SDK-side launch/provenance implementation and its negative controls; no push, merge, publish, real install or F numbers, and bundle closure is not claimed
> **Rollback Surface**: SDK client Pi adapter/bin/identity surface, keys Pi provider launcher and its projection, tests, spec/CHANGELOG entries, and this task's own workflow files
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`
> **Task Review**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
> **Implementation Notes**: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Dual-track design decision (Track A deep-reasoner, Track B Codex) synthesized by the orchestrator and approved by the Owner; captured here as the execution source of truth.
- Source ref: /Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md §77 §78
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260916-1003-c07-pi-runtime-launch.md`
- Sprint contract: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`
- Sprint review: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
- Implementation notes: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260916-1003-c07-pi-runtime-launch.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260916-1003-c07-pi-runtime-launch.md`.

## Approach
### Strategy
One strict SDK runtime launch description, one provenance binding, one pre-spawn reverify, consumed identically by the three final Pi spawn sites. Pi starts through a trusted interpreter and a sealed entry with a fixed argv prefix; the process cwd is the sealed launch cwd and the session cwd is passed explicitly. Probes p1–p6 gate implementation.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| O1 same sealed bundle with explicit logical entries | One artifact, one install transaction, one interpreter; no new mutable wrapper | Requires the SDK launch/provenance contract first, and full bundle closure stays open | Use (Owner-approved, conditional) |
| O2 second sealed entry file | daemon and Pi can be trimmed separately | A single-artifact record cannot vouch for a second entry; prepared/keys breaks remain | Rejected for this slice |
| O3 separate fork package directory | Keeps a real npm manifest, bin and asset layout | Needs Merkle directory closure and reintroduces bare-specifier resolution | Rejected for this slice; reserved if O1 closure fails |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/sdk-reserved-helper-host.ts` | Modify | Add `SdkHelperHostConfig.entry`; `resolveSdkReservedHelperBin` returns `{command: interpreter, args: [entry, '__byok_sdk_helper', kind, ...]}`, fixing the five existing reserved helpers under S2 |
| `packages/client/src/daemon/tool-implementation-identity.ts` | Modify | Add the explicit `runtime` attestation subject and its contract, reusing the existing measurement core |
| `packages/client/src/adapters/pi/pi-adapter.ts` | Modify | Ordinary (~:511-519) and prepared (~:745-747) spawns consume the launch description; process cwd vs session cwd split; pre-spawn reverify |
| `packages/client/src/bin/byok-pi-rpc.ts` | Add | SDK-owned in-process RPC entry with inline extension factories; no bare-specifier resolution on the launch path |
| `packages/client/src/bin/byok-pi-prepared.ts` | Modify | Switch to the reserved-helper entry shape and inline extension factories |
| `packages/keys/src/bin/pi-provider-launcher.ts` | Modify | Bind the fixed entry prefix separately from task flags; reverify final env/argv/cwd at the final spawn; reuse the measurement core without importing the whole client |
| `docs/spec.md`, `CHANGELOG.md` | Modify | Record the launch-description record-shape change and the `piEntrypoint`/argv0 retirement |

### Code Snippets
Reserved-helper entry shape: `<interpreter> <entry> __byok_sdk_helper pi-rpc|pi-prepared …`.

### Data Flow
selected immutable install record → SDK runtime launch description (interpreter + entry + fixed argv prefix) → self-measured artifact/interpreter plus build-bound native identity → preparation stores the same runtime identity → admission compares and pins the release → final env/argv/cwd fixed → SDK reverify immediately before spawn → trusted interpreter + sealed entry → SDK-owned ordinary/prepared entry rechecks the contract and starts native.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Inline extension factories do not work in rpc mode or under `--session` resume | Medium | O1 entry shape fails | Probe p1 gates P1; a negative result returns to the Owner before implementation |
| Pi tools read `process.cwd()` rather than the session cwd | Medium | Sealed launch cwd changes tool behavior | Probe p2; entry-layer adaptation of native `main.ts:580` |
| photon WASM `cwd/photon_rs_bg.wasm` fallback cannot be closed inside one artifact | Medium | Weakens the single-artifact premise and reopens O1 vs O3 | Probes p4 and p5 inventory the component model before P1 |
| keys launcher rejects the fixed prefix or an explicit cwd | Medium | The third spawn lane stays unbound | Probe p6; projection rules stay exact, no wildcard credential exemption |
| Re-digesting the bundle and interpreter per task costs admission latency | Medium | Heartbeat and admission pressure at 10x | Bind on the install stat tuple and digest once per record generation, never a cached verdict |

## Task Contracts
- Contract file: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`
- Review file: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
- Implementation notes file: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Plan `plans/plan-20260916-1003-c07-pi-runtime-launch.md` with its contract is the proposed mergeable execution unit; P4 Salesko wiring is cross-repo and needs its own contract and worktree.
- **Rollback surface**: SDK client Pi adapter/bin/identity surface, keys Pi provider launcher and its projection, tests, spec/CHANGELOG entries, and this task's own workflow files
- **Verification boundary**: Probe evidence plus SDK-side launch/provenance implementation and its negative controls; no push, merge, publish, real install or F numbers, and bundle closure is not claimed
- **Review/acceptance boundary**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md` must record pass against the acceptance criteria captured below.
- **High-risk surface**: Execution identity and credential-carrying spawn paths; a wrong binding makes the attestation decorative.
- **Why not checklist row**: Owner approved conditional O1 with this SDK contract as the first slice across three spawn consumers, a record-shape change and a supersession.

## Evidence Contract

- **State/progress path**: `plans/plan-20260916-1003-c07-pi-runtime-launch.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`, `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`, and `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the contract Verification Plan
- **Evaluator rubric**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md` must record a passing independent gate recommendation
- **Stop condition**: all task breakdown items in scope are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: SDK client Pi adapter/bin/identity surface, keys Pi provider launcher and its projection, tests, spec/CHANGELOG entries, and this task's own workflow files

## Captured Planning Output

## Why
Pi currently starts from a resolved bin and an inherited cwd, so a trusted interpreter and a sealed entry are attestable but not meaningful. Three separate final spawn sites exist, and only one of them is reachable from the outer adapter check. Without one strict launch description, an S2 Pi child can differ from whatever was attested, and the keys lane spawns Pi after reading credentials with no physical reverify at all.

## P1 / P2 / P3
- P1: the Host installer and its installed record own the immutable release, artifact and interpreter. The SDK consumes that record, measures artifact/interpreter/final launch env, and binds physical execution identity into preparation and admission. The native fork and its build chain supply package/fork/prepared-contract semantic identity, bound to real bundle bytes by build provenance. `packages/keys` keeps credential and projection authority and is the third real spawn. HOME, session, models and working directory are runtime data, never code provenance; a writable HOME `package.json` never declares execution identity.
- P2: three real paths and their break points. Ordinary Pi: `pi-adapter.ts:53-56` turns the package shape into `process.execPath + entry`, not `record.interpreter.path`, with no fixed subcommand argv, and spawns at `~:511-519`. Prepared Pi: `pi-adapter.ts:393-408` skips the ordinary invocation and `~:745-747` pins `process.execPath + client dist/bin/byok-pi-prepared.js --config …`, with the entry built from the SDK package root at `~:837-838`. keys: `packages/keys/src/bin/pi-provider-launcher.ts:79-98` projects models, reads credentials, builds the final child env, then spawns with no cwd, and `pi-provider-projection.ts:57-100` rejects bare `pi` subcommands so the fixed prefix cannot be smuggled into delegated args. Across all three the spawn cwd is either the manifest cwd or the inherited parent cwd, and a writable cwd executes `bunfig.toml` preload and `.env` before any JS check inside the entry can run.
- P3: keep one artifact, one install transaction and one interpreter (O1), and pay for it with an explicit SDK launch/provenance contract rather than a second entry authority (O2) or a directory closure (O3). The invariant to preserve is that the object checked is the object spawned. The smallest coherent change is one release-derived launch description plus one reverify at the true spawn boundary, reused by all three consumers and by the existing measurement core. At 10x, per-task re-digest of the bundle and interpreter is the first thing to fail; bind on the install stat tuple and digest once per record generation, never a cached verdict.

## Frozen design points (§77 rulings 1-7)
1. Entry shape: reserved-helper form `<interpreter> <entry> __byok_sdk_helper pi-rpc|pi-prepared …` through `SdkHelperHostConfig.entry` and `resolveSdkReservedHelperBin`. This also fixes the five existing reserved helpers that under S2 produce `bun __byok_sdk_helper`, which is not a script path. The prefix is never packed into a command string and never routed through `BYOK_PI_BIN`.
2. Entries are SDK-owned and in-process with inline extension factories. No `jiti` and no `import.meta.resolve` on the launch path, which closes both the jiti escape and the `~/.bun/install/cache` resolution escape.
3. Attestation gains an explicit `runtime` subject with its own contract, reusing the `ToolImplementationAuthority` measurement core: record revision, bundle digest, interpreter digest and stat, logical entry and mode, fixed argv, launch cwd, env commitments, plus native package/fork/prepared-contract identity derived from the single exact pin, `byokFork` and build inputs. A HOME `package.json` is never a provenance source. With an authority configured, a runtime subject that is not attested declines the task, which is stricter than the MCP subject; `resolver_unconfigured` keeps the dev path.
4. Pre-launch cwd: the Pi process cwd is the sealed launch cwd, controlled before Bun initialization, and the session cwd is passed explicitly. The prepared factory already accepts a cwd; ordinary Pi reads `process.cwd()` in native `main.ts:580` and needs entry-layer adaptation. This applies to all three lanes including keys, which today inherits the parent cwd.
5. `piEntrypoint` and argv0 dispatch retire in the same train through one release-derived launch description, migrating once to the new version-digest slot with no dual read and no "argv0 failed, try the subcommand" fallback. This is a record-shape change plus a `contract:729` supersession, presented to the Owner as information inside approval ④, not as a scope reduction.
6. Component preconditions: the `utils/photon.ts:45-51` `cwd/photon_rs_bg.wasm` fallback must be closed; the interpreted-mode theme and asset layout (`config.ts:391-417`) differs from compiled and needs an inventory; `PI_PACKAGE_DIR` necessity must be established.
7. Closure: the eight dynamic constructions are unchanged by topology and stay a separate work package; no feature may be disabled to turn a check green.

## Scope and authority
Owner approved conditional O1 and named this SDK contract the first slice (§78). Worktree `/Users/kito/Projects/byok-sdk-wt-c07-pi-launch`, branch `codex/c07-pi-runtime-launch`, base `4fe4ad6f`. The running root-cause-prover on Pi cwd and bare specifiers is prior evidence and is not rerun. This approval excludes push, merge, publish, real installation and F numbers; bundle closure has not passed.

## Verification boundary
Track A items 1-8 and Track B checklist 1-9 form one matrix: forged bundle; wrong interpreter including a swap between resolve and spawn; argv0 spoof; unattested runtime declines while `resolver_unconfigured` keeps the dev path; drift artifact reverify failure; pre-entry loader-injection negative with the control that proves it is load-bearing; escaped-resolution negative with zero out-of-release modules; three final-spawn drift negatives with zero native or provider side effects; keys secret rules unchanged; byte-exact argv and cwd carrying spaces and special characters; cold install positive running the full daemon plus ordinary, prepared and keys lanes. Release-grade evidence is produced once after the real bundle, interpreter and build inputs are frozen; a candidate green is not a release claim.

## Completion and rollback
Owner-stated completion conditions: the photon cwd WASM fallback is closed, package provenance is bound, the keys final env is reverified, the first batch runs the full daemon plus Pi under the interpreter, with no compiled-only alias, no mutable wrapper and no reduction of the supported surface. Rollback is the base revision `4fe4ad6f`; revert only task-owned files and preserve all other worktrees and user WIP.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] P0-p1 Probe inline extension factories in rpc mode and under `--session` resume.
- [ ] P0-p2 Probe whether pi tools read `process.cwd()` rather than the session cwd.
- [ ] P0-p3 Probe whether `PI_PACKAGE_DIR` (a writable piRuntimeDir) is required for rpc mode.
- [ ] P0-p4 Probe the photon `cwd/photon_rs_bg.wasm` fallback trigger condition.
- [ ] P0-p5 Inventory interpreted-mode theme and asset layout requirements.
- [ ] P0-p6 Probe the keys launcher acceptance surface for a fixed entry prefix and an explicit cwd.
- [ ] P1 Implement the SDK launch description type, provenance binding and the `runtime` attestation subject, with a measurement core shared by client and keys.
- [ ] P2 Switch the three consumers (ordinary, prepared, keys) to the launch description with the process-cwd/session-cwd split and a final pre-spawn reverify.
- [ ] P3 Deliver the in-process entries `byok-pi-rpc` and `pi-prepared` with inline extension factories, removing bare-specifier resolution from the launch path.
- [ ] P4 Salesko O1 wiring: launch table `runtimes.pi`, daemon S2 exclusion removed, `piEntrypoint` retired, `main.ts` argv0 branch removed (cross-repo, separate contract and worktree).
- [ ] P5 Run the verification matrix (Track A items 1-8 and Track B checklist 1-9) including the negative controls and the cold-install positive.
- [ ] P6 Track the closure dependency (§75 fork 1006 items, the Salesko bundle `_shims` plugin, the SDK eval-free validator) as a prerequisite for full bundle closure, not owned by this contract.

## Stop conditions
- Stop before P1 if any probe p1-p6 falsifies the entry shape, the cwd split or the keys acceptance surface; report the negative result instead of designing around it.
- Stop if the photon WASM source or the interpreted asset layout cannot be sealed inside one artifact; that reopens O1 versus O3 and belongs to the Owner.
- Stop before editing any path outside the contract `allowed_paths`, and stop before any push, merge, publish or real installation.
- Stop after three repair rounds on one issue and retain the failing evidence.

## Falsifier
A Pi child starts whose interpreter, entry, argv, cwd or env differ from the attested description without a pre-spawn refusal. The cheapest proof is to mutate each of those five fields between the outer check and the final spawn on each of the three lanes and require a refusal with zero native or provider side effects.
